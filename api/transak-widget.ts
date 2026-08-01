/**
 * Create a Transak on/off-ramp widget session (merchant integration).
 * POST /api/transak-widget
 *
 * Body: {
 *   walletAddress, amount, email?,
 *   productsAvailed?: "BUY" | "SELL",
 *   fiatCurrency?: "USD" | "CAD" | …
 * }
 *
 * Server-only env:
 *   TRANSAK_API_KEY      — Partner API key (dashboard.transak.com)
 *   TRANSAK_API_SECRET   — Partner API secret (never VITE_*)
 *   TRANSAK_ENV          — "production" | "staging" (default production if key looks live)
 *
 * Returns: { widgetUrl, env }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'

const API_KEY = (process.env.TRANSAK_API_KEY || '').trim()
const API_SECRET = (process.env.TRANSAK_API_SECRET || '').trim()

function isStaging(): boolean {
  const env = (process.env.TRANSAK_ENV || '').toLowerCase()
  if (env === 'staging' || env === 'stg') return true
  if (env === 'production' || env === 'prod') return false
  // Heuristic: staging keys often contain stg / staging
  return /stg|staging|test/i.test(API_KEY)
}

function refreshTokenUrl(): string {
  return isStaging()
    ? 'https://api-stg.transak.com/partners/api/v2/refresh-token'
    : 'https://api.transak.com/partners/api/v2/refresh-token'
}

function sessionUrl(): string {
  return isStaging()
    ? 'https://api-gateway-stg.transak.com/api/v2/auth/session'
    : 'https://api-gateway.transak.com/api/v2/auth/session'
}

/** Cache access token in-memory per lambda instance (7d TTL from Transak). */
let cachedToken: { token: string; exp: number } | null = null

async function partnerAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  if (cachedToken && cachedToken.exp > now + 60) return cachedToken.token

  const res = await fetch(refreshTokenUrl(), {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'api-secret': API_SECRET,
    },
    body: JSON.stringify({ apiKey: API_KEY }),
  })
  const json = (await res.json().catch(() => ({}))) as {
    data?: { accessToken?: string; expiresAt?: number }
    message?: string
    error?: { message?: string }
  }
  if (!res.ok || !json.data?.accessToken) {
    const msg =
      json.message ||
      json.error?.message ||
      `Transak auth failed (${res.status})`
    throw new Error(msg)
  }
  cachedToken = {
    token: json.data.accessToken,
    exp: json.data.expiresAt ?? now + 6 * 24 * 3600,
  }
  return cachedToken.token
}

/** Legacy/query fallback when secret not set (staging/dev only). */
function legacyWidgetUrl(params: Record<string, string>): string {
  const host = isStaging()
    ? 'https://global-stg.transak.com'
    : 'https://global.transak.com'
  const q = new URLSearchParams(params)
  return `${host}/?${q.toString()}`
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

  if (!API_KEY) {
    return res.status(503).json({
      error: 'transak_not_configured',
      message:
        'Card/bank (Transak) is not set up. Use crypto send, or add TRANSAK_API_KEY on the server.',
    })
  }

  const body =
    (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) || {}
  const walletAddress = String(body.walletAddress || '').trim()
  const amount = Number(body.amount)
  const email = String(body.email || '').trim().toLowerCase()
  const productsAvailed =
    body.productsAvailed === 'SELL' ? 'SELL' : 'BUY'
  const fiatCurrency = String(body.fiatCurrency || 'USD')
    .trim()
    .toUpperCase()
    .slice(0, 3)

  if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
    return res.status(400).json({ error: 'bad_wallet' })
  }
  if (!Number.isFinite(amount) || amount < 5) {
    return res.status(400).json({
      error: 'bad_amount',
      message: 'Minimum is $5.',
    })
  }

  const referrerDomain =
    (process.env.TRANSAK_REFERRER_DOMAIN || 'accrue.fund').replace(
      /^https?:\/\//,
      '',
    )

  const widgetParams: Record<string, string | number | boolean> = {
    apiKey: API_KEY,
    referrerDomain,
    productsAvailed,
    cryptoCurrencyCode: 'USDC',
    network: 'base',
    walletAddress,
    disableWalletAddressForm: true,
    fiatCurrency,
    fiatAmount: amount,
    themeColor: '1a4d3a',
    hideMenu: true,
    redirectURL: 'https://accrue.fund/?fund=1',
  }
  if (email && email.includes('@')) {
    widgetParams.email = email
  }

  // Preferred: signed session (requires API secret)
  if (API_SECRET) {
    try {
      const accessToken = await partnerAccessToken()
      const sess = await fetch(sessionUrl(), {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'access-token': accessToken,
          // Some Transak docs also accept x-api-key
          'x-api-key': API_KEY,
        },
        body: JSON.stringify({ widgetParams }),
      })
      const data = (await sess.json().catch(() => ({}))) as {
        data?: { widgetUrl?: string }
        message?: string
        error?: { message?: string }
      }
      if (!sess.ok || !data.data?.widgetUrl) {
        const msg =
          data.message ||
          data.error?.message ||
          `Transak session failed (${sess.status})`
        // Fall through to legacy if session API rejects
        if (sess.status >= 500 || sess.status === 404) {
          throw new Error(msg)
        }
        return res.status(sess.status >= 400 ? sess.status : 502).json({
          error: 'transak_session_failed',
          message: msg,
        })
      }
      return res.status(200).json({
        widgetUrl: data.data.widgetUrl,
        env: isStaging() ? 'staging' : 'production',
        mode: 'session',
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Transak error'
      // Try legacy only in staging
      if (!isStaging()) {
        return res.status(502).json({ error: 'transak_error', message })
      }
    }
  }

  // Fallback: query-param widget (works with public API key on many accounts)
  const flat: Record<string, string> = {}
  for (const [k, v] of Object.entries(widgetParams)) {
    flat[k] = String(v)
  }
  return res.status(200).json({
    widgetUrl: legacyWidgetUrl(flat),
    env: isStaging() ? 'staging' : 'production',
    mode: 'legacy',
    warning: API_SECRET
      ? undefined
      : 'Using legacy widget URL — set TRANSAK_API_SECRET for secure sessions.',
  })
}
