/**
 * Create a Transak on-ramp widget session (merchant).
 * POST /api/transak-widget
 *
 * Docs (Create Widget URL):
 *   POST https://api-gateway.transak.com/api/v2/auth/session
 *   Headers (all required):
 *     access-token  — partner JWT from refresh-token
 *     x-api-key     — partner API key
 *     x-user-ip     — end-user IP (not server IP)
 *
 * Docs (Refresh Access Token):
 *   POST https://api.transak.com/partners/api/v2/refresh-token
 *   Headers: api-secret, x-api-key, content-type
 *   Body: { apiKey }
 *
 * IMPORTANT: Transak must whitelist this backend's static egress IPs.
 * Vercel serverless has dynamic IPs — if session returns 401, either:
 *   1) Add fixed egress / submit Transak partner security checklist, or
 *   2) Client falls back to hosted widget with public apiKey (if dashboard allows).
 *
 * Env (server only): TRANSAK_API_KEY, TRANSAK_API_SECRET, TRANSAK_ENV, TRANSAK_REFERRER_DOMAIN
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'

const API_KEY = (process.env.TRANSAK_API_KEY || '').trim()
const API_SECRET = (process.env.TRANSAK_API_SECRET || '').trim()

function isStaging(): boolean {
  const env = (process.env.TRANSAK_ENV || '').toLowerCase()
  if (env === 'staging' || env === 'stg') return true
  if (env === 'production' || env === 'prod') return false
  return false
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

function widgetHost(): string {
  return isStaging()
    ? 'https://global-stg.transak.com'
    : 'https://global.transak.com'
}

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
      'x-api-key': API_KEY,
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

function clientIp(req: VercelRequest, bodyIp?: string): string {
  if (bodyIp) {
    const t = bodyIp.trim()
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t)) return t
    if (t.includes(':')) return t // ipv6
  }
  const h = req.headers
  const candidates = [
    h['cf-connecting-ip'],
    h['x-real-ip'],
    String(h['x-forwarded-for'] || '').split(',')[0],
    h['x-vercel-forwarded-for'],
  ]
  for (const c of candidates) {
    const v = String(c || '').trim()
    if (!v || v === '::1' || v === '127.0.0.1') continue
    const m = v.match(/(\d{1,3}(?:\.\d{1,3}){3})/)
    if (m) return m[1]
    if (v.includes(':')) return v
  }
  return '192.0.2.1'
}

function legacyWidgetUrl(
  params: Record<string, string | number | boolean>,
): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    q.set(k, String(v))
  }
  return `${widgetHost()}/?${q.toString()}`
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS: only our domains (Transak security checklist)
  const origin = String(req.headers.origin || '')
  const allowed = [
    'https://accrue.fund',
    'https://www.accrue.fund',
    'https://accruefund.vercel.app',
    'http://localhost:5173',
    'http://localhost:4173',
    'http://127.0.0.1:5173',
  ]
  if (allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization',
  )
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' })
  }

  if (!API_KEY || !API_SECRET) {
    return res.status(503).json({
      error: 'transak_not_configured',
      message:
        'Transak keys missing. Use Send USDC (crypto) or set TRANSAK_API_KEY + TRANSAK_API_SECRET.',
    })
  }

  const body =
    (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) || {}
  const walletAddress = String(body.walletAddress || '').trim()
  const amount = Number(body.amount)
  const email = String(body.email || '').trim().toLowerCase()
  const productsAvailed = body.productsAvailed === 'SELL' ? 'SELL' : 'BUY'
  const fiatCurrency = String(body.fiatCurrency || 'USD')
    .trim()
    .toUpperCase()
    .slice(0, 3)
  const userIp = clientIp(req, body.clientIp)

  if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
    return res.status(400).json({ error: 'bad_wallet' })
  }
  if (!Number.isFinite(amount) || amount < 5) {
    return res.status(400).json({
      error: 'bad_amount',
      message: 'Minimum is $5.',
    })
  }

  const referrerDomain = (
    process.env.TRANSAK_REFERRER_DOMAIN || 'accrue.fund'
  ).replace(/^https?:\/\//, '')

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
  if (email.includes('@')) {
    widgetParams.email = email
  }

  try {
    const accessToken = await partnerAccessToken()
    const sess = await fetch(sessionUrl(), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'access-token': accessToken,
        'x-api-key': API_KEY,
        'x-user-ip': userIp,
      },
      body: JSON.stringify({ widgetParams }),
    })
    const data = (await sess.json().catch(() => ({}))) as {
      data?: { widgetUrl?: string }
      message?: string
      error?: { message?: string; statusCode?: number; errorCode?: number }
    }

    if (sess.ok && data.data?.widgetUrl) {
      return res.status(200).json({
        widgetUrl: data.data.widgetUrl,
        env: isStaging() ? 'staging' : 'production',
        mode: 'session',
      })
    }

    // 401 often means partner IP not whitelisted for Create Widget URL
    // Fall back to hosted widget URL (public apiKey) so onramp still opens.
    const msg =
      data.error?.message ||
      data.message ||
      `Transak session failed (${sess.status})`

    const legacy = legacyWidgetUrl(widgetParams)
    return res.status(200).json({
      widgetUrl: legacy,
      env: isStaging() ? 'staging' : 'production',
      mode: 'legacy',
      warning: msg,
      hint:
        'If the widget fails to load: in Transak Partner Dashboard whitelist your backend egress IPs (Vercel) and set referrer domain to accrue.fund. Refresh-token works; Create Widget URL requires IP allowlist.',
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Transak error'
    // Still try legacy open
    try {
      return res.status(200).json({
        widgetUrl: legacyWidgetUrl(widgetParams),
        env: isStaging() ? 'staging' : 'production',
        mode: 'legacy',
        warning: message,
      })
    } catch {
      return res.status(502).json({ error: 'transak_error', message })
    }
  }
}
