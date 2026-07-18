// Relay is used strictly as the behind-the-scenes settlement leg for deposits:
// a regulated provider sends USDC on Base to a Relay deposit address, then
// Relay fills the selected asset on Robinhood Chain. The consumer UI must not
// expose chain terminology; this module validates every quote before a payment
// provider is given its destination address.

import { formatUnits, isAddress, type Address } from 'viem'
import { CHAIN_ID } from './rails'

export const RELAY_ORIGIN_CHAIN_ID = 8453 // Base
export const RELAY_ORIGIN_ASSET =
  '0x833589fCD6eDb6E08f4c7C32D4f71b54bDa02913' as Address // Base USDC

const RELAY_QUOTE_URL =
  import.meta.env.VITE_RELAY_QUOTE_URL ?? 'https://api.relay.link/quote/v2'
const RELAY_STATUS_URL =
  import.meta.env.VITE_RELAY_STATUS_URL ??
  'https://api.relay.link/intents/status/v3'

type RelayCurrency = {
  chainId?: number
  address?: string
  decimals?: number
}

type RelayQuotePayload = {
  steps?: Array<{
    requestId?: string
    depositAddress?: string
    kind?: string
  }>
  details?: {
    currencyIn?: { currency?: RelayCurrency }
    currencyOut?: {
      currency?: RelayCurrency
      amount?: string
      minimumAmount?: string
    }
  }
  message?: string
  error?: string
}

export interface RelayDepositRoute {
  /** Address to give the regulated onramp on Base. */
  depositAddress: Address
  requestId: string
  /** Decimal string, precise to the destination asset's decimals. */
  quotedReceived: string
  /** Decimal string, calculated by Relay after its route/slippage allowance. */
  minimumReceived: string
}

export type RelayIntentStatus =
  | 'waiting'
  | 'pending'
  | 'success'
  | 'failure'
  | 'refund'
  | 'unknown'

const sameAddress = (a: string | undefined, b: Address): boolean =>
  Boolean(a && a.toLowerCase() === b.toLowerCase())

export function toUnits(value: string, decimals: number): string {
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value)
  if (!match) throw new Error('Enter a valid amount')
  const [, whole, fraction = ''] = match
  if (fraction.length > decimals) throw new Error('Amount has too many decimals')
  const units = BigInt(whole) * 10n ** BigInt(decimals)
  const subunits = BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals))
  if (units + subunits <= 0n) throw new Error('Enter an amount above zero')
  return (units + subunits).toString()
}

function decimalAmount(
  value: string | undefined,
  decimals: number | undefined,
): string {
  if (
    !value ||
    !/^\d+$/.test(value) ||
    decimals === undefined ||
    !Number.isInteger(decimals)
  ) {
    throw new Error('Relay returned an invalid amount')
  }
  return formatUnits(BigInt(value), decimals)
}

/**
 * Create an open Relay deposit address. Open addresses safely handle a payment
 * provider changing the final amount: Relay re-quotes at fill time and sends a
 * refund to the customer's EVM address if the route cannot settle.
 */
export async function prepareRelayDepositRoute({
  recipient,
  destinationAsset,
  amount,
}: {
  recipient: Address
  destinationAsset: Address
  amount: string
}): Promise<RelayDepositRoute> {
  if (!isAddress(recipient) || !isAddress(destinationAsset)) {
    throw new Error('Your account is not ready')
  }

  const response = await fetch(RELAY_QUOTE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      user: recipient,
      recipient,
      // A failed Base-side settlement is returned to the customer's EVM
      // address, never to an Accrue-controlled address.
      refundTo: recipient,
      originChainId: RELAY_ORIGIN_CHAIN_ID,
      destinationChainId: CHAIN_ID,
      originCurrency: RELAY_ORIGIN_ASSET,
      destinationCurrency: destinationAsset,
      amount: toUnits(amount, 6),
      tradeType: 'EXACT_INPUT',
      useDepositAddress: true,
    }),
  })

  const payload = (await response.json().catch(() => ({}))) as RelayQuotePayload
  if (!response.ok) {
    throw new Error(payload.message || payload.error || `Relay quote ${response.status}`)
  }

  const step = payload.steps?.[0]
  const input = payload.details?.currencyIn?.currency
  const output = payload.details?.currencyOut
  const outputCurrency = output?.currency
  if (
    step?.kind !== 'transaction' ||
    !step.requestId ||
    !/^0x[0-9a-f]{64}$/i.test(step.requestId) ||
    !step.depositAddress ||
    !isAddress(step.depositAddress) ||
    input?.chainId !== RELAY_ORIGIN_CHAIN_ID ||
    !sameAddress(input.address, RELAY_ORIGIN_ASSET) ||
    outputCurrency?.chainId !== CHAIN_ID ||
    !sameAddress(outputCurrency.address, destinationAsset)
  ) {
    throw new Error('Relay returned a route that does not match your account')
  }

  const quotedReceived = decimalAmount(output?.amount, outputCurrency.decimals)
  const minimumReceived = decimalAmount(
    output?.minimumAmount,
    outputCurrency.decimals,
  )

  return {
    depositAddress: step.depositAddress as Address,
    requestId: step.requestId,
    quotedReceived,
    minimumReceived,
  }
}

/**
 * Read-only status for a Relay intent. Used after the payment provider has
 * been given the deposit address so the app can tell waiting vs settled.
 */
export async function fetchRelayIntentStatus(
  requestId: string,
): Promise<RelayIntentStatus> {
  if (!/^0x[0-9a-f]{64}$/i.test(requestId)) {
    throw new Error('Invalid deposit reference')
  }
  const response = await fetch(
    `${RELAY_STATUS_URL}?requestId=${encodeURIComponent(requestId)}`,
  )
  if (!response.ok) {
    throw new Error(`Relay status ${response.status}`)
  }
  const payload = (await response.json().catch(() => ({}))) as {
    status?: string
  }
  const status = String(payload.status ?? '').toLowerCase()
  if (
    status === 'waiting' ||
    status === 'pending' ||
    status === 'success' ||
    status === 'failure' ||
    status === 'refund'
  ) {
    return status
  }
  return 'unknown'
}

export interface RelayWithdrawRoute {
  /** Address the app sends the Robinhood asset to. */
  depositAddress: Address
  requestId: string
  quotedReceived: string
  minimumReceived: string
  /** Exact base units the user must transfer. */
  amountUnits: string
}

/**
 * Reverse of deposit: quote Robinhood USDG (or other rail asset) → Base USDC
 * at the customer's same EVM address. The app transfers the origin asset to
 * the returned deposit address; Relay fills Base USDC.
 */
export async function prepareRelayWithdrawRoute({
  recipient,
  originAsset,
  amount,
  decimals = 6,
}: {
  recipient: Address
  originAsset: Address
  amount: string
  decimals?: number
}): Promise<RelayWithdrawRoute> {
  if (!isAddress(recipient) || !isAddress(originAsset)) {
    throw new Error('Your account is not ready')
  }
  const amountUnits = toUnits(amount, decimals)

  const response = await fetch(RELAY_QUOTE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      user: recipient,
      recipient,
      refundTo: recipient,
      originChainId: CHAIN_ID,
      destinationChainId: RELAY_ORIGIN_CHAIN_ID,
      originCurrency: originAsset,
      destinationCurrency: RELAY_ORIGIN_ASSET,
      amount: amountUnits,
      tradeType: 'EXACT_INPUT',
      useDepositAddress: true,
    }),
  })

  const payload = (await response.json().catch(() => ({}))) as RelayQuotePayload
  if (!response.ok) {
    throw new Error(payload.message || payload.error || `Relay quote ${response.status}`)
  }

  const step = payload.steps?.[0]
  const input = payload.details?.currencyIn?.currency
  const output = payload.details?.currencyOut
  const outputCurrency = output?.currency
  if (
    step?.kind !== 'transaction' ||
    !step.requestId ||
    !/^0x[0-9a-f]{64}$/i.test(step.requestId) ||
    !step.depositAddress ||
    !isAddress(step.depositAddress) ||
    input?.chainId !== CHAIN_ID ||
    !sameAddress(input.address, originAsset) ||
    outputCurrency?.chainId !== RELAY_ORIGIN_CHAIN_ID ||
    !sameAddress(outputCurrency.address, RELAY_ORIGIN_ASSET)
  ) {
    throw new Error('Relay returned a route that does not match your account')
  }

  return {
    depositAddress: step.depositAddress as Address,
    requestId: step.requestId,
    quotedReceived: decimalAmount(output?.amount, outputCurrency.decimals),
    minimumReceived: decimalAmount(output?.minimumAmount, outputCurrency.decimals),
    amountUnits,
  }
}
