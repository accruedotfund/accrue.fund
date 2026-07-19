// Robinhood mainnet gas is separate from Base ETH. Privy does not sponsor RH.
// When the user has Base ETH but zero RH ETH, top up via Relay (Base → RH).

import {
  createPublicClient,
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

/** Enough for create + approve + deposit with headroom. */
const MIN_RH_WEI = parseEther('0.00008')
/** Bridge this much Base ETH → RH when top-up is needed (~cents of fee). */
const BRIDGE_WEI = parseEther('0.0003')

const baseClient = createPublicClient({
  chain: base,
  transport: http(undefined, { timeout: 15_000 }),
})

export async function rhEthBalance(owner: Address): Promise<bigint> {
  return publicClient.getBalance({ address: owner })
}

export async function baseEthBalance(owner: Address): Promise<bigint> {
  return baseClient.getBalance({ address: owner })
}

/**
 * Ensure the user can pay RH network fees. If RH ETH is low and Base ETH is
 * available, Relay-bridge a scrap of ETH Base → RH (same address).
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
  if (onBase < BRIDGE_WEI) {
    throw new Error(
      'Not enough network fee on Robinhood, and not enough Base ETH to top it up automatically. Add a little ETH on Base (same address), then try again. Your dollars are safe.',
    )
  }

  progress('Moving a tiny network fee from Base onto your account…')

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
      amount: BRIDGE_WEI.toString(),
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
  const valueRaw = item?.value ?? BRIDGE_WEI.toString()
  const value = BigInt(valueRaw)

  if (
    !step?.requestId ||
    !depositAddress ||
    !depositAddress.startsWith('0x') ||
    value <= 0n
  ) {
    throw new Error('Could not prepare network-fee top-up route.')
  }

  // Base-side send (gas can be sponsored on Base).
  const hash = await send({
    to: depositAddress,
    value,
    chainId: BASE_CHAIN_ID,
  })
  const receipt = await baseClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') {
    throw new Error('Network-fee top-up transaction failed on Base.')
  }

  progress('Waiting for network fee to land…')
  const before = rh
  for (let i = 0; i < 45; i++) {
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
    if (now >= MIN_RH_WEI || now > before) {
      // landed (or enough bump)
      if (now >= MIN_RH_WEI) return
    }
    await new Promise((r) => setTimeout(r, 2000))
  }

  const final = await rhEthBalance(owner)
  if (final < MIN_RH_WEI) {
    throw new Error(
      'Network fee is still settling. Wait a few seconds and try again — or check that Base ETH left your wallet.',
    )
  }
}
