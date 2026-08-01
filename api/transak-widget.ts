/**
 * Create a Transak on-ramp widget session (merchant).
 * POST /api/transak-widget
 *
 * Docs:
 *   Staging:    https://api-gateway-stg.transak.com/api/v2/auth/session
 *   Production: https://api-gateway.transak.com/api/v2/auth/session
 * Headers: access-token, x-api-key, x-user-ip (required)
 * Body: { widgetParams: { apiKey, referrerDomain, ... } }
 *
 * Access token:
 *   Staging:    POST https://api-stg.transak.com/partners/api/v2/refresh-token
 *   Production: POST https://api.transak.com/partners/api/v2/refresh-token
 *   Headers: api-secret, content-type
 *   Body: { apiKey }
 *
 * Server-only env:
 *   TRANSAK_API_KEY, TRANSAK_API_SECRET
 *   TRANSAK_ENV = production | staging
 *   TRANSAK_REFERRER_DOMAIN = accrue.fund
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'

const API_KEY = (process.env.TRANSAK_API_KEY || '').trim()
const API_SECRET = (process.env.TRANSAK_API_SECRET || '').trim()

function isStaging(): boolean {
  const env = (process.env.TRANSAK_ENV || '').toLowerCase()
  if (env === 'staging' || env === 'stg') return true
  if (env === 'production' || env === 'prod') return false
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

function clientIp(req: VercelRequest, bodyIp?: string): string {
  if (bodyIp && /^\d{1,3}(\.\d{1,3}){3}$/.test(bodyIp.trim())) {
    return bodyIp.trim()
  }
  const xf = String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '')
  const first = xf.split(',')[0]?.trim()
  if (first && first !== '::1' && first !== '127.0.0.1') {
    // Prefer IPv4 if present
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(first)) return first
    // Strip IPv6 mapped :ffff:x.x.x.x
    const m = first.match(/(\d{1,3}(?:\.\d{1,3}){3})$/)
    if (m) return m[1]
    return first
  }
  // Transak requires an end-user IP; TEST-NET-1 as last resort for local dev
  return '192.0.2.1'
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

  if (!API_KEY || !API_SECRET) {
    return res.status(503).json({
      error: 'transak_not_configured',
      message:
        'Transak merchant keys missing. Use Send USDC (crypto), or set TRANSAK_API_KEY + TRANSAK_API_SECRET.',
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
      error?: { message?: string }
      meta?: { message?: string }
    }
    if (!sess.ok || !data.data?.widgetUrl) {
      const msg =
        data.message ||
        data.error?.message ||
        data.meta?.message ||
        `Transak session failed (${sess.status})`
      return res.status(sess.status >= 400 && sess.status < 600 ? sess.status : 502).json({
        error: 'transak_session_failed',
        message: msg,
        // IP whitelist / partner setup hints for ops
        hint:
          sess.status === 401 || sess.status === 403
            ? 'Check API key/secret, partner access token, and that Vercel egress IPs (or 0.0.0.0) are whitelisted in Transak dashboard.'
            : undefined,
      })
    }
    return res.status(200).json({
      widgetUrl: data.data.widgetUrl,
      env: isStaging() ? 'staging' : 'production',
      mode: 'session',
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Transak error'
    return res.status(502).json({ error: 'transak_error', message })
  }
}
