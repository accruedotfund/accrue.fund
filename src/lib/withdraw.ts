// Outbound cash movement: available USDG → Relay deposit on Robinhood →
// Base USDC at the same EVM address. Bank cashout (Stripe/MoonPay URL) is an
// optional second hop when VITE_API_BASE is configured.

import { encodeFunctionData, type Address, parseUnits } from 'viem'
import {
  prepareRelayWithdrawRoute,
  fetchRelayIntentStatus,
  type RelayWithdrawRoute,
} from './relay'
import {
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
    throw new Error('Not enough available balance — make standard balance available first')
  }

  progress('Preparing your withdrawal route…')
  const route = await prepareRelayWithdrawRoute({
    recipient: owner,
    originAsset: rail.stable,
    amount,
    decimals: rail.decimals,
  })

  // Some Relay deposit addresses require an ERC-20 transfer (not approve+pull).
  // Transfer is the safe default for open deposit addresses.
  progress('Sending your available balance…')
  await sendAndWait(send, {
    to: rail.stable,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [route.depositAddress, units],
    }),
  })

  progress('Confirming settlement…')
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
