/**
 * Bank cashout session for Accrue.
 * POST /api/accrue-offramp-session
 * Authorization: Bearer <privy access token>
 *
 * Server-only env (never VITE_*):
 *   CDP_API_KEY_ID / CDP_API_KEY_SECRET — Coinbase Developer Secret API Key
 *   ACCRUE_OFFRAMP_REDIRECT_URL — post-sell redirect (default https://accrue.fund)
 *   PRIVY_APP_ID + PRIVY_APP_SECRET — optional bearer verify
 *   ACCRUE_OFFRAMP_URL — legacy generic partner URL fallback
 *
 * Prefer CDP: mint session token → Coinbase sell URL (Base USDC → bank/ACH).
 * Without CDP keys → { mode: "relay" } so the client settles on-device only.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'

const PRIVY_APP_ID =
  process.env.PRIVY_APP_ID || process.env.VITE_PRIVY_APP_ID || ''
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET || ''

const CDP_API_KEY_ID = (process.env.CDP_API_KEY_ID || '').trim()
const CDP_API_KEY_SECRET = (process.env.CDP_API_KEY_SECRET || '')
  .trim()
  .replace(/\\n/g, '\n')

const REDIRECT =
  (process.env.ACCRUE_OFFRAMP_REDIRECT_URL || 'https://accrue.fund').trim()

const CDP_HOST = 'api.developer.coinbase.com'
const CDP_TOKEN_PATH = '/onramp/v1/token'

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

function clientIpFrom(req: VercelRequest, bodyIp?: string): string {
  const fromBody = typeof bodyIp === 'string' ? bodyIp.trim() : ''
  if (fromBody && /^\d{1,3}(\.\d{1,3}){3}$/.test(fromBody)) return fromBody
  // Vercel sets these; Coinbase wants a real end-user IP when possible.
  const h = req.headers
  const xf = String(h['x-forwarded-for'] || h['x-real-ip'] || '')
  const first = xf.split(',')[0]?.trim()
  if (first && first !== '::1' && first !== '127.0.0.1') return first
  return '192.0.2.1'
}

/** Short stable partner ref for Coinbase status APIs (max 50 chars). */
function partnerRef(address: string, email?: string): string {
  const base = (email || address).toLowerCase().replace(/[^a-z0-9]/g, '')
  const slice = base.slice(0, 32) || address.slice(2, 18).toLowerCase()
  return `accrue-${slice}`.slice(0, 50)
}

async function createCoinbaseSellUrl(opts: {
  address: string
  amount: number
  currency: string
  clientIp: string
  email?: string
}): Promise<string> {
  const { generateJwt } = await import('@coinbase/cdp-sdk/auth')
  const jwt = await generateJwt({
    apiKeyId: CDP_API_KEY_ID,
    apiKeySecret: CDP_API_KEY_SECRET,
    requestMethod: 'POST',
    requestHost: CDP_HOST,
    requestPath: CDP_TOKEN_PATH,
    expiresIn: 120,
  })

  const tokenRes = await fetch(`https://${CDP_HOST}${CDP_TOKEN_PATH}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${jwt}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      addresses: [
        {
          address: opts.address,
          blockchains: ['base'],
        },
      ],
      assets: ['USDC'],
      clientIp: opts.clientIp,
    }),
  })

  const tokenBody = (await tokenRes.json().catch(() => ({}))) as {
    token?: string
    message?: string
    error?: string
  }
  if (!tokenRes.ok || !tokenBody.token) {
    throw new Error(
      tokenBody.message ||
        tokenBody.error ||
        `Coinbase session failed (${tokenRes.status})`,
    )
  }

  const url = new URL('https://pay.coinbase.com/v3/sell/input')
  url.searchParams.set('sessionToken', tokenBody.token)
  url.searchParams.set('partnerUserRef', partnerRef(opts.address, opts.email))
  url.searchParams.set('redirectUrl', REDIRECT)
  url.searchParams.set('defaultNetwork', 'base')
  url.searchParams.set('defaultAsset', 'USDC')
  url.searchParams.set('presetCryptoAmount', String(opts.amount))
  url.searchParams.set('fiatCurrency', opts.currency === 'USD' ? 'USD' : opts.currency)
  url.searchParams.set('defaultCashoutMethod', 'ACH_BANK_ACCOUNT')
  return url.toString()
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
  const email =
    typeof body?.email === 'string' ? body.email.trim() : undefined

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

  // Prefer Coinbase Developer Offramp (sell Base USDC → bank / ACH).
  if (CDP_API_KEY_ID && CDP_API_KEY_SECRET) {
    try {
      const url = await createCoinbaseSellUrl({
        address,
        amount,
        currency,
        clientIp: clientIpFrom(req, body?.clientIp),
        email,
      })
      return res.status(200).json({
        mode: 'coinbase',
        url,
        // Client should Relay USDG → Base USDC first, then open this URL.
        settleFirst: 'relay_base_usdc',
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Coinbase offramp failed'
      return res.status(502).json({ error: msg, mode: 'coinbase_error' })
    }
  }

  // Legacy generic partner URL
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
      'No Coinbase CDP keys configured. Client settles via Relay to Base USDC only.',
  })
}
