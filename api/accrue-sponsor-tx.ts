/**
 * Server-side gas sponsorship for Accrue.
 * POST /api/accrue-sponsor-tx
 * Authorization: Bearer <privy user access token>
 *
 * Body: {
 *   walletId: string
 *   caip2: "eip155:8453" | "eip155:4663" | ...
 *   transaction: { to, data?, value? }  // value as decimal string or 0x hex
 * }
 *
 * Uses PRIVY_APP_SECRET (server-only) so App-pays sponsorship works when the
 * client SDK returns "App secret is required for gas sponsored transactions".
 *
 * Env (Vercel Production — never VITE_*):
 *   PRIVY_APP_ID (or VITE_PRIVY_APP_ID)
 *   PRIVY_APP_SECRET
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'

const PRIVY_APP_ID =
  process.env.PRIVY_APP_ID || process.env.VITE_PRIVY_APP_ID || ''
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET || ''
const PRIVY_API = 'https://api.privy.io'

type Body = {
  walletId?: string
  caip2?: string
  transaction?: {
    to?: string
    data?: string
    value?: string
  }
}

function toHexQuantity(value: string | undefined): string | undefined {
  if (value == null || value === '') return undefined
  if (value.startsWith('0x') || value.startsWith('0X')) return value
  try {
    return `0x${BigInt(value).toString(16)}`
  } catch {
    return undefined
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

  if (!PRIVY_APP_ID || !PRIVY_APP_SECRET) {
    return res.status(503).json({
      error:
        'Set PRIVY_APP_SECRET (and PRIVY_APP_ID) on Vercel for sponsored txs.',
    })
  }

  const auth = req.headers.authorization || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!token) return res.status(401).json({ error: 'missing bearer token' })

  let userId: string
  try {
    const { PrivyClient } = await import('@privy-io/server-auth')
    const privy = new PrivyClient(PRIVY_APP_ID, PRIVY_APP_SECRET)
    const claims = await privy.verifyAuthToken(token)
    userId = claims.userId
  } catch {
    return res.status(401).json({ error: 'invalid session' })
  }

  const body = (
    typeof req.body === 'string' ? JSON.parse(req.body) : req.body
  ) as Body

  const walletId = String(body?.walletId || '').trim()
  const caip2 = String(body?.caip2 || '').trim()
  const to = String(body?.transaction?.to || '').trim()
  const valueHex = toHexQuantity(body?.transaction?.value)
  const dataRaw = body?.transaction?.data
  const data =
    dataRaw && /^0x[0-9a-fA-F]*$/.test(dataRaw) ? dataRaw : undefined

  if (!walletId) return res.status(400).json({ error: 'invalid walletId' })
  if (!/^eip155:\d+$/.test(caip2)) {
    return res.status(400).json({ error: 'invalid caip2' })
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(to)) {
    return res.status(400).json({ error: 'invalid to' })
  }

  // Confirm wallet is linked to this user (best-effort).
  try {
    const { PrivyClient } = await import('@privy-io/server-auth')
    const privy = new PrivyClient(PRIVY_APP_ID, PRIVY_APP_SECRET)
    const user = await privy.getUserById(userId)
    const accounts = user.linkedAccounts || []
    const owns = accounts.some((a) => {
      if (a.type !== 'wallet') return false
      const w = a as { id?: string; address?: string }
      return (
        w.id === walletId ||
        (w.address && w.address.toLowerCase() === to.toLowerCase())
      )
    })
    // Also match when `to` is Relay deposit (not the user wallet) — check id only
    const ownsId = accounts.some((a) => {
      if (a.type !== 'wallet') return false
      return (a as { id?: string }).id === walletId
    })
    if (!owns && !ownsId) {
      return res.status(403).json({ error: 'wallet not on this account' })
    }
  } catch {
    // If user fetch fails, still try send — Privy will reject bad walletId
  }

  const basic = Buffer.from(`${PRIVY_APP_ID}:${PRIVY_APP_SECRET}`).toString(
    'base64',
  )

  const rpcBody = {
    method: 'eth_sendTransaction',
    caip2,
    chain_type: 'ethereum',
    sponsor: true,
    params: {
      transaction: {
        to,
        ...(valueHex ? { value: valueHex } : {}),
        ...(data ? { data } : {}),
      },
    },
  }

  try {
    const rpcRes = await fetch(
      `${PRIVY_API}/v1/wallets/${encodeURIComponent(walletId)}/rpc`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'privy-app-id': PRIVY_APP_ID,
          'content-type': 'application/json',
        },
        body: JSON.stringify(rpcBody),
      },
    )
    const rpcJson = (await rpcRes.json().catch(() => ({}))) as Record<
      string,
      unknown
    >

    if (!rpcRes.ok) {
      const errMsg =
        (rpcJson.error as { message?: string } | string | undefined) ||
        rpcJson.message ||
        `Privy sponsor ${rpcRes.status}`
      const message =
        typeof errMsg === 'string'
          ? errMsg
          : errMsg?.message || JSON.stringify(errMsg)
      return res.status(502).json({ error: message, status: rpcRes.status })
    }

    // Response shapes vary: { data: { hash } } | { hash } | { data: { transaction_hash } }
    const dataObj = (rpcJson.data || rpcJson) as Record<string, unknown>
    const hash = String(
      dataObj.hash ||
        dataObj.transaction_hash ||
        dataObj.transactionHash ||
        '',
    )
    if (!/^0x[a-fA-F0-9]{64}$/.test(hash)) {
      return res.status(502).json({
        error: 'Sponsored send returned no hash',
        raw: rpcJson,
      })
    }

    return res.status(200).json({ hash, sponsored: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'sponsor request failed'
    return res.status(502).json({ error: msg })
  }
}
