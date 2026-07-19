// Canonical USD wrapper discovery + one-time permissionless create.
// EUR/GBP/gold stay tabled until Robinhood lists those underlyings.

import { encodeFunctionData, isAddress, type Address, zeroAddress } from 'viem'
import {
  publicClient,
  sendAndWait,
  type Progress,
  type Sender,
} from './vault'
import { USD_STABLE, WRAPPER_FACTORY } from './rails'

const factoryAbi = [
  {
    type: 'function',
    name: 'wrapperOf',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'create',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'entryFeePpm', type: 'uint256' },
      { name: 'exitFeePpm', type: 'uint256' },
      { name: 'transferFeePpm', type: 'uint256' },
    ],
    outputs: [{ name: 'wrapper', type: 'address' }],
  },
] as const

/** 1 bps = 100 ppm — matches factory STD_FEE_PPM for official rails. */
export const USD_WRAPPER_FEE_PPM = 100n

export async function readUsdWrapper(): Promise<Address | undefined> {
  if (!WRAPPER_FACTORY || !USD_STABLE) return undefined
  const wrapper = await publicClient.readContract({
    address: WRAPPER_FACTORY,
    abi: factoryAbi,
    functionName: 'wrapperOf',
    args: [USD_STABLE],
  })
  if (!wrapper || wrapper === zeroAddress || !isAddress(wrapper)) return undefined
  return wrapper
}

/**
 * Ensure the canonical wUSDG vault exists. Permissionless create once.
 *
 * Prefer readUsdWrapper() on boot — do NOT auto-create. Privy native gas
 * sponsorship does not cover Robinhood mainnet; create needs real RH ETH
 * (or a future RH gas tank). Deposit path is Base → Relay → USDG and needs
 * no vault create.
 */
export async function ensureUsdWrapper(
  send: Sender,
  progress: Progress,
): Promise<Address> {
  const existing = await readUsdWrapper()
  if (existing) return existing
  if (!WRAPPER_FACTORY || !USD_STABLE) {
    throw new Error('Dollar rail factory is not configured')
  }
  progress('Opening your dollar account on the network…')
  // RH txs: no Privy sponsor (see auth.tsx). Caller must have RH gas or fail.
  await sendAndWait(send, {
    to: WRAPPER_FACTORY,
    data: encodeFunctionData({
      abi: factoryAbi,
      functionName: 'create',
      args: [
        USD_STABLE,
        USD_WRAPPER_FEE_PPM,
        USD_WRAPPER_FEE_PPM,
        USD_WRAPPER_FEE_PPM,
      ],
    }),
  })
  const created = await readUsdWrapper()
  if (!created) throw new Error('Dollar account setup did not finish')
  return created
}
