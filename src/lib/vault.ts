import {
  createPublicClient,
  encodeFunctionData,
  fallback,
  http,
  type Address,
  type Hash,
  type Transport,
} from 'viem'
import type { TransactionRequest } from './auth'
import { RH_RPC_URLS, type Rail } from './rails'

/** Multi-RPC transport: PublicNode → Blockscout → official (or env overrides). */
export function rhTransport(): Transport {
  return fallback(
    RH_RPC_URLS.map((url) =>
      http(url, {
        timeout: 12_000,
        retryCount: 1,
        retryDelay: 250,
      }),
    ),
    { rank: false },
  )
}

const erc20Abi = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const

const vaultAbi = [
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'assets', type: 'uint256' },
      { name: 'receiver', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'redeem',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'shares', type: 'uint256' },
      { name: 'receiver', type: 'address' },
      { name: 'owner', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const

export const publicClient = createPublicClient({ transport: rhTransport() })

export type Sender = (tx: TransactionRequest) => Promise<Hash>
export type Progress = (message: string) => void

export async function sendAndWait(send: Sender, tx: TransactionRequest) {
  const hash = await send(tx)
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error('Transaction was reverted')
  return receipt
}

export async function tokenBalance(token: Address, owner: Address) {
  return publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner],
  })
}

export async function ensureAllowance(
  token: Address,
  owner: Address,
  spender: Address,
  amount: bigint,
  send: Sender,
  progress: Progress,
) {
  const allowance = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, spender],
  })
  if (allowance >= amount) return
  progress('Confirm access to this balance…')
  await sendAndWait(send, {
    to: token,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [spender, amount],
    }),
  })
}

export async function depositAvailable(
  rail: Rail,
  owner: Address,
  send: Sender,
  progress: Progress,
) {
  if (!rail.stable) throw new Error('This account is not set up for deposits yet')
  if (!rail.wrapper) {
    throw new Error(
      'Standard growth is not open yet — open it once, then move your available balance.',
    )
  }
  const amount = await tokenBalance(rail.stable, owner)
  if (amount === 0n) throw new Error('No available balance')
  await ensureAllowance(rail.stable, owner, rail.wrapper, amount, send, progress)
  progress('Moving balance into your standard account…')
  await sendAndWait(send, {
    to: rail.wrapper,
    data: encodeFunctionData({
      abi: vaultAbi,
      functionName: 'deposit',
      args: [amount, owner],
    }),
  })
}

export async function redeemStandard(
  rail: Rail,
  owner: Address,
  send: Sender,
  progress: Progress,
) {
  if (!rail.wrapper) {
    throw new Error('No standard balance on this account yet.')
  }
  const shares = await tokenBalance(rail.wrapper, owner)
  if (shares === 0n) throw new Error('No standard balance')
  progress('Making your balance available…')
  await sendAndWait(send, {
    to: rail.wrapper,
    data: encodeFunctionData({
      abi: vaultAbi,
      functionName: 'redeem',
      args: [shares, owner, owner],
    }),
  })
}

