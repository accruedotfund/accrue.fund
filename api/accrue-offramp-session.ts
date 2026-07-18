/**
 * Bank cashout session seam for Accrue.
 * POST /api/accrue-offramp-session
 * Authorization: Bearer <privy access token>
 *
 * Env (Vercel project, server-only):
 *   PRIVY_APP_ID, PRIVY_APP_SECRET — verify bearer
 *   ACCRUE_OFFRAMP_URL — optional HTTPS bank partner URL
 * Without ACCRUE_OFFRAMP_URL → { mode: "relay" } so the app settles on-device.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'

const PRIVY_APP_ID =
  process.env.PRIVY_APP_ID || process.env.VITE_PRIVY_APP_ID || ''
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET || ''

async function verifyPrivyToken(
  token: string,
): Promise<{ userId: string } | null> {
  if (!PRIVY_APP_SECRET || !PRIVY_APP_ID) return null
  try {
    const { PrivyClient } = await import('@privy-io/server-auth')
    const privy = new PrivyClient(PRIVY_APP_ID, PRIVY_APP_SECRET)
    const claims = await privy.verifyAuthToken(token)
    return { userId: claims.userId }
  } catch {
    return null
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization')
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' })
  }

  const auth = req.headers.authorization || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!token) return res.status(401).json({ error: 'missing bearer token' })

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body
  const amount = Number(body?.amount)
  const currency = String(body?.currency || 'USD')
  const address = String(body?.address || '')
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'invalid amount' })
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return res.status(400).json({ error: 'invalid address' })
  }
  if (currency !== 'USD') {
    return res.status(400).json({ error: 'only USD cashout is live' })
  }

  if (PRIVY_APP_SECRET) {
    const verified = await verifyPrivyToken(token)
    if (!verified) return res.status(401).json({ error: 'invalid session' })
  }

  const bankUrl = process.env.ACCRUE_OFFRAMP_URL?.trim()
  if (bankUrl && /^https:\/\//.test(bankUrl)) {
    const url = new URL(bankUrl)
    url.searchParams.set('amount', String(amount))
    url.searchParams.set('currency', currency)
    url.searchParams.set('address', address)
    return res.status(200).json({ mode: 'bank', url: url.toString() })
  }

  return res.status(200).json({
    mode: 'relay',
    message:
      'No bank cashout partner configured. Client settles via Relay to Base USDC.',
  })
}
