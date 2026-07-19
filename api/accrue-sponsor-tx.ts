/**
 * Server-side gas sponsorship for Accrue.
 * POST /api/accrue-sponsor-tx
 * Authorization: Bearer <privy user access token>
 *
 * Body: {
 *   walletId: string
 *   caip2: "eip155:8453" | ...
 *   transaction: { to, data?, value? }
 * }
 *
 * User embedded wallets require `privy-authorization-signature` on wallet RPC.
 * Flow:
 *  1) Verify user access token
 *  2) Exchange JWT → user authorization key (via @privy-io/node)
 *  3) Sign the exact RPC payload
 *  4) POST /v1/wallets/{id}/rpc with Basic + signature + sponsor:true
 *
 * Env:
 *   PRIVY_APP_ID (or VITE_PRIVY_APP_ID)
 *   PRIVY_APP_SECRET
 * Optional:
 *   PRIVY_AUTHORIZATION_PRIVATE_KEY — app owner key if wallet is app-owned
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import {
  PrivyClient,
  APIError,
  formatRequestForAuthorizationSignature,
  generateAuthorizationSignature,
  generateAuthorizationSignatures,
} from '@privy-io/node'

const PRIVY_APP_ID =
  process.env.PRIVY_APP_ID || process.env.VITE_PRIVY_APP_ID || ''
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET || ''
const PRIVY_AUTH_KEY = (process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY || '').trim()
const PRIVY_API = 'https://api.privy.io'

/** Only Base (and other Privy-listed app-pays chains). RH mainnet is not listed. */
const SPONSORABLE = new Set([
  'eip155:1',
  'eip155:8453',
  'eip155:10',
  'eip155:137',
  'eip155:42161',
  'eip155:56',
])

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
    const body = err.error as
      | { error?: string; message?: string; code?: string }
      | string
      | null
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

  try {
    await privy.utils().auth().verifyAccessToken(token)
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
  if (!SPONSORABLE.has(caip2)) {
    return res.status(400).json({
      error: `Gas sponsorship is not available on ${caip2}. Use Base (eip155:8453) for fee top-up.`,
      caip2,
    })
  }

  const chainId = Number(caip2.split(':')[1])
  const requestExpiry = String(Date.now() + 15 * 60 * 1000)

  const rpcBody = {
    method: 'eth_sendTransaction' as const,
    caip2,
    chain_type: 'ethereum' as const,
    sponsor: true,
    params: {
      transaction: {
        to,
        ...(valueHex ? { value: valueHex } : {}),
        ...(data ? { data } : {}),
        ...(Number.isFinite(chainId) ? { chain_id: chainId } : {}),
      },
    },
  }

  const url = `${PRIVY_API}/v1/wallets/${encodeURIComponent(walletId)}/rpc`

  try {
    // Build authorization signatures: user JWT (embedded wallets) + optional app key
    const authorizationContext = {
      user_jwts: [token],
      ...(PRIVY_AUTH_KEY
        ? { authorization_private_keys: [PRIVY_AUTH_KEY] }
        : {}),
    }

    let signatures: string[]
    try {
      signatures = await generateAuthorizationSignatures(privy, {
        authorizationContext,
        input: {
          version: 1,
          method: 'POST',
          url,
          body: rpcBody,
          headers: {
            'privy-app-id': PRIVY_APP_ID,
            'privy-request-expiry': requestExpiry,
          },
        },
      })
    } catch (signErr) {
      // Fallback: try SDK sendTransaction (also signs) for clearer errors
      try {
        const result = await privy.wallets().ethereum().sendTransaction(walletId, {
          caip2: caip2 as `eip155:${string}`,
          sponsor: true,
          authorization_context: authorizationContext,
          params: {
            transaction: {
              to,
              ...(valueHex ? { value: valueHex } : {}),
              ...(data ? { data } : {}),
              ...(Number.isFinite(chainId) ? { chain_id: chainId } : {}),
            },
          },
        })
        return await finishWithHash(res, privy, result)
      } catch (sdkErr) {
        return res.status(502).json({
          error: privyErrorMessage(signErr) || privyErrorMessage(sdkErr),
          step: 'authorization_signature',
        })
      }
    }

    const sigHeader = signatures.filter(Boolean).join(',')
    if (!sigHeader) {
      // Last-ditch: if only app key is set, sign with it directly
      if (PRIVY_AUTH_KEY) {
        const payload = formatRequestForAuthorizationSignature({
          version: 1,
          method: 'POST',
          url,
          body: rpcBody,
          headers: {
            'privy-app-id': PRIVY_APP_ID,
            'privy-request-expiry': requestExpiry,
          },
        })
        const one = generateAuthorizationSignature({
          authorizationPrivateKey: PRIVY_AUTH_KEY,
          input: payload,
        })
        if (!one) {
          return res.status(502).json({
            error:
              'Could not build Privy authorization signature (empty). Enable server wallet access / check PRIVY_APP_SECRET matches the app.',
            step: 'empty_signature',
          })
        }
        return await postRpc(res, privy, walletId, url, rpcBody, one, requestExpiry)
      }
      return res.status(502).json({
        error:
          'Could not build Privy authorization signature from user session. Re-login and retry, or set PRIVY_AUTHORIZATION_PRIVATE_KEY for app-owned wallets.',
        step: 'empty_signature',
      })
    }

    return await postRpc(res, privy, walletId, url, rpcBody, sigHeader, requestExpiry)
  } catch (err) {
    return res.status(502).json({
      error: privyErrorMessage(err),
      status: err instanceof APIError ? err.status : undefined,
      step: 'send',
    })
  }
}

async function postRpc(
  res: VercelResponse,
  privy: PrivyClient,
  _walletId: string,
  url: string,
  rpcBody: Record<string, unknown>,
  signature: string,
  requestExpiry: string,
) {
  const basic = Buffer.from(`${PRIVY_APP_ID}:${PRIVY_APP_SECRET}`).toString(
    'base64',
  )

  const rpcRes = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'privy-app-id': PRIVY_APP_ID,
      'privy-authorization-signature': signature,
      'privy-request-expiry': requestExpiry,
      'content-type': 'application/json',
    },
    body: JSON.stringify(rpcBody),
  })

  const rpcJson = (await rpcRes.json().catch(() => ({}))) as Record<
    string,
    unknown
  >

  if (!rpcRes.ok) {
    const errField = rpcJson.error
    let message = `Privy sponsor ${rpcRes.status}`
    if (typeof errField === 'string' && errField.trim()) {
      message = errField
    } else if (errField && typeof errField === 'object' && 'message' in errField) {
      const m = (errField as { message?: unknown }).message
      if (typeof m === 'string' && m.trim()) message = m
    } else if (typeof rpcJson.message === 'string' && rpcJson.message.trim()) {
      message = rpcJson.message
    }
    return res.status(502).json({
      error: message,
      status: rpcRes.status,
      step: 'privy_rpc',
    })
  }

  const dataObj = (rpcJson.data || rpcJson) as Record<string, unknown>
  let hash = String(
    dataObj.hash ||
      dataObj.transaction_hash ||
      dataObj.transactionHash ||
      '',
  )
  const txId = String(
    dataObj.transaction_id || dataObj.transactionId || '',
  )

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
            step: 'poll',
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
      user_operation_hash: dataObj.user_operation_hash || null,
      step: 'no_hash',
    })
  }

  return res.status(200).json({
    hash,
    sponsored: true,
    transaction_id: txId || null,
  })
}

async function finishWithHash(
  res: VercelResponse,
  privy: PrivyClient,
  result: {
    hash?: string
    transaction_id?: string
    user_operation_hash?: string
  },
) {
  let hash = String(result.hash || '')
  const txId = result.transaction_id

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
            step: 'poll',
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
      step: 'no_hash',
    })
  }

  return res.status(200).json({
    hash,
    sponsored: true,
    transaction_id: txId || null,
  })
}
