/**
 * Create a Crossmint onramp order (fiat → Base USDC).
 * POST /api/crossmint-order
 * Authorization: Bearer <privy access token> (optional verify)
 *
 * Body: { walletAddress, amount, receiptEmail, kind?: "onramp" | "offramp" }
 *
 * Server-only:
 *   CROSSMINT_SERVER_SIDE_API_KEY  — sk_production_… / sk_staging_…
 *   CROSSMINT_ENV                  — "production" | "staging" (default: from key prefix)
 *
 * Client uses returned orderId + clientSecret with CrossmintEmbeddedCheckout.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'

const PRIVY_APP_ID =
  process.env.PRIVY_APP_ID || process.env.VITE_PRIVY_APP_ID || ''
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET || ''

const SERVER_KEY = (process.env.CROSSMINT_SERVER_SIDE_API_KEY || '').trim()

/** Base mainnet USDC — Accrue deposit leg origin. */
const BASE_USDC = 'base:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
/** Base Sepolia USDC (staging). */
const BASE_SEPOLIA_USDC =
  'base-sepolia:0x036CbD53842c5426634e7929541eC2318f3dCF7e'

function apiBase(): string {
  const env = (process.env.CROSSMINT_ENV || '').toLowerCase()
  if (env === 'staging' || SERVER_KEY.startsWith('sk_staging')) {
    return 'https://staging.crossmint.com'
  }
  return 'https://www.crossmint.com'
}

function tokenLocator(): string {
  if (SERVER_KEY.startsWith('sk_staging') || process.env.CROSSMINT_ENV === 'staging') {
    return BASE_SEPOLIA_USDC
  }
  return BASE_USDC
}

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
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization',
  )
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' })
  }

  if (!SERVER_KEY) {
    return res.status(503).json({
      error: 'crossmint_not_configured',
      message: 'Card/bank is not available yet. Try again later.',
    })
  }

  const auth = String(req.headers.authorization || '')
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (bearer && PRIVY_APP_SECRET) {
    const claims = await verifyPrivyToken(bearer)
    if (!claims) {
      return res.status(401).json({ error: 'unauthorized' })
    }
  }

  const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) ||
    {}
  const walletAddress = String(body.walletAddress || '').trim()
  const amount = String(body.amount || '').trim()
  const receiptEmail = String(body.receiptEmail || body.email || '')
    .trim()
    .toLowerCase()
  const kind = body.kind === 'offramp' ? 'offramp' : 'onramp'

  if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
    return res.status(400).json({ error: 'bad_wallet' })
  }
  const amt = Number(amount)
  if (!Number.isFinite(amt) || amt < 5) {
    return res.status(400).json({ error: 'bad_amount', message: 'Minimum is $5.' })
  }
  if (!receiptEmail || !receiptEmail.includes('@')) {
    return res.status(400).json({
      error: 'bad_email',
      message: 'A receipt email is required for card/bank.',
    })
  }

  // Offramp: same order API shape is not universal — return not_implemented
  // and let client fall back to CDP / Relay for cash-out until sell is wired.
  if (kind === 'offramp') {
    return res.status(501).json({
      error: 'offramp_via_partner',
      message:
        'Bank cash-out uses the partner flow after dollars settle to cash.',
    })
  }

  try {
    // Link external deposit address to the user (best-effort; required for EOAs).
    try {
      const userLocator = `email:${encodeURIComponent(receiptEmail)}`
      await fetch(
        `${apiBase()}/api/2025-06-09/users/${userLocator}/linked-wallets/${walletAddress}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': SERVER_KEY,
          },
          body: JSON.stringify({ chain: 'base' }),
        },
      )
    } catch {
      /* non-fatal under $1k thresholds */
    }

    const response = await fetch(`${apiBase()}/api/2022-06-09/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': SERVER_KEY,
      },
      body: JSON.stringify({
        lineItems: [
          {
            tokenLocator: tokenLocator(),
            executionParameters: {
              mode: 'exact-in',
              amount: String(amt),
            },
          },
        ],
        payment: {
          method: 'card',
          receiptEmail,
        },
        recipient: {
          walletAddress,
        },
      }),
    })

    const data = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >
    if (!response.ok) {
      const msg =
        (data.message as string) ||
        (data.error as string) ||
        `Crossmint order failed (${response.status})`
      return res.status(response.status >= 400 ? response.status : 502).json({
        error: 'crossmint_order_failed',
        message: msg,
      })
    }

    // Shape: { order: { orderId, ... }, clientSecret } or nested variants
    const order = (data.order as Record<string, unknown>) || data
    const orderId =
      (order.orderId as string) ||
      (data.orderId as string) ||
      (order.id as string)
    const clientSecret =
      (data.clientSecret as string) ||
      (order.clientSecret as string) ||
      ''

    if (!orderId || !clientSecret) {
      return res.status(502).json({
        error: 'crossmint_bad_response',
        message: 'Payment session incomplete — try again.',
        raw: process.env.NODE_ENV === 'development' ? data : undefined,
      })
    }

    return res.status(200).json({
      orderId,
      clientSecret,
      env: SERVER_KEY.startsWith('sk_staging') ? 'staging' : 'production',
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Crossmint error'
    return res.status(500).json({ error: 'crossmint_error', message })
  }
}
