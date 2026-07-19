// Robinhood mainnet gas is separate from Base ETH. Privy does not sponsor RH.
// When the user has Base ETH but zero RH ETH, top up via Relay (Base → RH).

import {
  createPublicClient,
  fallback,
  formatEther,
  http,
  parseEther,
  zeroAddress,
  type Address,
} from 'viem'
import { base } from 'viem/chains'
import { BASE_CHAIN_ID, CHAIN_ID } from './rails'
import { fetchRelayIntentStatus } from './relay'
import { publicClient, type Progress, type Sender } from './vault'

const RELAY_QUOTE_URL =
  import.meta.env.VITE_RELAY_QUOTE_URL ?? 'https://api.relay.link/quote/v2'

/** Enough for create + approve + deposit (RH gas is cheap). */
const MIN_RH_WEI = parseEther('0.00005')
/** Floor: ~$0.25–0.40 depending on ETH price — must be ≤ typical “$1 of ETH”. */
const MIN_BRIDGE_WEI = parseEther('0.0001')
/** Preferred top-up when they have more. */
const PREFERRED_BRIDGE_WEI = parseEther('0.00025')

const baseClient = createPublicClient({
  chain: base,
  transport: fallback(
    [
      http('https://mainnet.base.org', { timeout: 12_000 }),
      http('https://base.publicnode.com', { timeout: 12_000 }),
      http('https://base.llamarpc.com', { timeout: 12_000 }),
    ],
    { rank: false },
  ),
})

export async function rhEthBalance(owner: Address): Promise<bigint> {
  return publicClient.getBalance({ address: owner })
}

export async function baseEthBalance(owner: Address): Promise<bigint> {
  return baseClient.getBalance({ address: owner })
}

function fmtEth(wei: bigint): string {
  const s = formatEther(wei)
  const n = Number(s)
  if (!Number.isFinite(n)) return s
  if (n === 0) return '0'
  if (n < 0.000001) return s
  return n.toFixed(6).replace(/\.?0+$/, '')
}

/**
 * Ensure the user can pay RH network fees. If RH ETH is low and Base ETH is
 * available, Relay-bridge a scrap of ETH Base → RH (same address).
 *
 * Uses adaptive amount: bridge preferred if they have it, else whatever they
 * hold above MIN_BRIDGE (so ~$0.90 of ETH is not rejected by a 0.0003 floor).
 */
export async function ensureRhGas({
  owner,
  send,
  progress,
}: {
  owner: Address
  send: Sender
  progress: Progress
}): Promise<void> {
  const rh = await rhEthBalance(owner)
  if (rh >= MIN_RH_WEI) return

  const onBase = await baseEthBalance(owner)

  if (onBase < MIN_BRIDGE_WEI) {
    throw new Error(
      `GAS_TOPUP_NEEDED:${owner}:You have ${fmtEth(onBase)} ETH on Base — need at least ~${fmtEth(MIN_BRIDGE_WEI)} ETH on Base (about $0.30+) to open standard growth. Send ETH on Base to the address below, then try again. Your dollars are safe.`,
    )
  }

  // Bridge preferred amount, or everything they have if between min and preferred.
  const bridgeAmount =
    onBase >= PREFERRED_BRIDGE_WEI ? PREFERRED_BRIDGE_WEI : onBase

  progress(
    `Moving ${fmtEth(bridgeAmount)} ETH from Base for network fees…`,
  )

  const quoteRes = await fetch(RELAY_QUOTE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      user: owner,
      recipient: owner,
      refundTo: owner,
      originChainId: BASE_CHAIN_ID,
      destinationChainId: CHAIN_ID,
      originCurrency: zeroAddress,
      destinationCurrency: zeroAddress,
      amount: bridgeAmount.toString(),
      tradeType: 'EXACT_INPUT',
      useDepositAddress: true,
    }),
  })
  const quote = (await quoteRes.json().catch(() => ({}))) as {
    steps?: Array<{
      kind?: string
      requestId?: string
      depositAddress?: string
      items?: Array<{ data?: { to?: string; value?: string; chainId?: number } }>
    }>
    message?: string
    error?: string
  }
  if (!quoteRes.ok) {
    throw new Error(
      quote.message ||
        quote.error ||
        'Could not prepare network-fee top-up. Try again in a moment.',
    )
  }

  const step = quote.steps?.[0]
  const item = step?.items?.[0]?.data
  const depositAddress = (step?.depositAddress || item?.to) as
    | Address
    | undefined
  // Prefer quote’s exact value (includes any fee encoding Relay expects).
  let value = item?.value ? BigInt(item.value) : bridgeAmount
  // Never try to send more than the wallet holds.
  if (value > onBase) value = onBase

  if (
    !step?.requestId ||
    !depositAddress ||
    !depositAddress.startsWith('0x') ||
    value < MIN_BRIDGE_WEI
  ) {
    throw new Error('Could not prepare network-fee top-up route.')
  }

  const hash = await send({
    to: depositAddress,
    value,
    chainId: BASE_CHAIN_ID,
  })
  const receipt = await baseClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') {
    throw new Error('Network-fee top-up transaction failed on Base.')
  }

  progress('Waiting for network fee to land on your account…')
  const before = rh
  for (let i = 0; i < 50; i++) {
    try {
      const status = await fetchRelayIntentStatus(step.requestId)
      if (status === 'success') break
      if (status === 'failure' || status === 'refund') {
        throw new Error(
          'Network-fee top-up did not complete. Your Base ETH may be refunded — try again.',
        )
      }
    } catch (e) {
      if (e instanceof Error && /did not complete|refunded/i.test(e.message)) {
        throw e
      }
    }
    const now = await rhEthBalance(owner)
    if (now >= MIN_RH_WEI) return
    if (now > before && i > 8) {
      // Partial land — often enough for one create+deposit
      if (now >= parseEther('0.00003')) return
    }
    await new Promise((r) => setTimeout(r, 2000))
  }

  const final = await rhEthBalance(owner)
  if (final < MIN_RH_WEI && final <= before) {
    throw new Error(
      `GAS_TOPUP_NEEDED:${owner}:Network fee is still settling (Base ETH left: check your wallet). Wait 30s and try again. Address: ${owner}`,
    )
  }
}
