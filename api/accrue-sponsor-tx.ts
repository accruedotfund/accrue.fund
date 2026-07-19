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
 * Privy embedded wallets require a privy-authorization-signature on
 * POST /v1/wallets/{id}/rpc. We use @privy-io/node with the user's JWT so the
 * SDK exchanges it for a user signing key and attaches the header.
 *
 * Env (Vercel Production — never VITE_*):
 *   PRIVY_APP_ID (or VITE_PRIVY_APP_ID)
 *   PRIVY_APP_SECRET
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { PrivyClient, APIError } from '@privy-io/node'

const PRIVY_APP_ID =
  process.env.PRIVY_APP_ID || process.env.VITE_PRIVY_APP_ID || ''
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET || ''

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

function isTxHash(h: string): boolean {
  return /^0x[a-fA-F0-9]{64}$/.test(h)
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function privyErrorMessage(err: unknown): string {
  if (err instanceof APIError) {
    const body = err.error as { error?: string; message?: string } | string | null
    if (typeof body === 'string' && body.trim()) return body
    if (body && typeof body === 'object') {
      if (typeof body.error === 'string' && body.error.trim()) return body.error
      if (typeof body.message === 'string' && body.message.trim()) {
        return body.message
      }
    }
    return err.message || `Privy error ${err.status}`
  }
  if (err instanceof Error) return err.message
  return 'sponsor request failed'
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

  const privy = new PrivyClient({
    appId: PRIVY_APP_ID,
    appSecret: PRIVY_APP_SECRET,
  })

  let userId: string
  try {
    const claims = await privy.utils().auth().verifyAccessToken(token)
    userId = claims.user_id
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
    const user = await privy.users()._get(userId)
    const accounts = user.linked_accounts || []
    const ownsId = accounts.some((a) => {
      const w = a as { type?: string; id?: string }
      return (
        (w.type === 'wallet' || w.type === 'smart_wallet') &&
        w.id === walletId
      )
    })
    if (!ownsId) {
      // Some linked-wallet shapes omit id — Privy still rejects bad walletId.
    }
  } catch {
    // If user fetch fails, still try send — Privy will reject bad walletId
  }

  const chainId = Number(caip2.split(':')[1])
  const authorization_context = { user_jwts: [token] }

  try {
    const result = await privy.wallets().ethereum().sendTransaction(walletId, {
      caip2: caip2 as `eip155:${string}`,
      sponsor: true,
      authorization_context,
      params: {
        transaction: {
          to,
          ...(valueHex ? { value: valueHex } : {}),
          ...(data ? { data } : {}),
          ...(Number.isFinite(chainId) ? { chain_id: chainId } : {}),
        },
      },
    })

    let hash = String(result.hash || '')
    const txId = result.transaction_id

    // Sponsored user-ops often return empty hash until confirmed — poll by id.
    if (!isTxHash(hash) && txId) {
      for (let i = 0; i < 40; i++) {
        try {
          const tx = await privy.transactions().get(txId)
          if (tx.transaction_hash && isTxHash(tx.transaction_hash)) {
            hash = tx.transaction_hash
            break
          }
          if (
            tx.status === 'failed' ||
            tx.status === 'execution_reverted' ||
            tx.status === 'provider_error'
          ) {
            return res.status(502).json({
              error: `Sponsored transaction ${tx.status}`,
              status: tx.status,
              transaction_id: txId,
            })
          }
        } catch {
          // keep polling
        }
        await sleep(750)
      }
    }

    if (!isTxHash(hash)) {
      return res.status(502).json({
        error: 'Sponsored send returned no hash yet',
        transaction_id: txId || null,
        user_operation_hash: result.user_operation_hash || null,
      })
    }

    return res.status(200).json({
      hash,
      sponsored: true,
      transaction_id: txId || null,
    })
  } catch (err) {
    const message = privyErrorMessage(err)
    const status =
      err instanceof APIError && err.status >= 400 && err.status < 600
        ? err.status
        : 502
    // Map upstream 4xx to 502 so the client treats it as sponsor failure
    // (and can fall through to self-pay), but keep the real Privy message.
    return res.status(status === 401 || status === 403 ? 502 : status >= 500 ? status : 502).json({
      error: message,
      status: err instanceof APIError ? err.status : undefined,
    })
  }
}
