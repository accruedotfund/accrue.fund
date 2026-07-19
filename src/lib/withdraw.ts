// Wind-down: free cash on RH → Relay deposit → Base USDC at the same EVM address.
// Mirror of deposit (Base USDC → Relay → RH USDG). Bank/Coinbase cashout is an
// optional second hop after Base USDC lands (VITE_API_BASE / CDP).

import { encodeFunctionData, type Address, parseUnits } from 'viem'
import {
  prepareRelayWithdrawRoute,
  fetchRelayIntentStatus,
  type RelayWithdrawRoute,
} from './relay'
import {
  redeemStandard,
  sendAndWait,
  tokenBalance,
  type Progress,
  type Sender,
} from './vault'
import type { Rail } from './rails'

const erc20Abi = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const

export async function withdrawAvailableViaRelay({
  rail,
  owner,
  amount,
  send,
  progress,
}: {
  rail: Rail
  owner: Address
  amount: string
  send: Sender
  progress: Progress
}): Promise<RelayWithdrawRoute> {
  if (!rail.stable) throw new Error('This account is not configured')
  const units = parseUnits(amount, rail.decimals)
  const available = await tokenBalance(rail.stable, owner)
  if (available < units) {
    throw new Error('Not enough available balance — free standard balance first')
  }

  progress('Preparing your cash-out route…')
  const route = await prepareRelayWithdrawRoute({
    recipient: owner,
    originAsset: rail.stable,
    amount,
    decimals: rail.decimals,
  })

  // Relay open deposit address: push origin asset (RH USDG) → Relay fills Base USDC.
  progress('Moving dollars off your account…')
  await sendAndWait(send, {
    to: rail.stable,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [route.depositAddress, units],
    }),
  })

  progress('Confirming settlement to cash…')
  for (let i = 0; i < 40; i++) {
    const status = await fetchRelayIntentStatus(route.requestId)
    if (status === 'success') return route
    if (status === 'failure' || status === 'refund') {
      throw new Error('Withdrawal could not complete — your balance may be refunded')
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
  // Do not fail hard after timeout: payment left the wallet; Relay may still settle.
  return route
}

/**
 * Full wind-down: free standard → available if needed, then RH USDG → Base USDC
 * via Relay at the same EVM address. Call bank/CDP hop after this returns.
 */
export async function windDownViaRelay({
  rail,
  owner,
  amount,
  send,
  progress,
}: {
  rail: Rail
  owner: Address
  amount: string
  send: Sender
  progress: Progress
}): Promise<RelayWithdrawRoute> {
  if (!rail.stable) throw new Error('This account is not configured')
  const units = parseUnits(amount, rail.decimals)
  let available = await tokenBalance(rail.stable, owner)

  if (available < units && rail.wrapper) {
    progress('Freeing standard balance…')
    await redeemStandard(rail, owner, send, progress)
    available = await tokenBalance(rail.stable, owner)
  }

  if (available < units) {
    throw new Error('Not enough balance to cash out that amount')
  }

  return withdrawAvailableViaRelay({
    rail,
    owner,
    amount,
    send,
    progress,
  })
}
