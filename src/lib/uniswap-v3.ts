// Uniswap V3 on Robinhood Chain — stock liquidity lives here, not V2.
// Official RH deployments (developers.uniswap.org v3-robinhood-chain-deployments).

import { encodeFunctionData, type Address } from 'viem'
import { publicClient, sendAndWait, type Progress, type Sender } from './vault'
import { ensureAllowance } from './vault'

export const V3_FACTORY =
  '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA' as Address
export const V3_QUOTER =
  '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7' as Address
export const V3_SWAP_ROUTER =
  '0xcaf681a66d020601342297493863e78c959e5cb2' as Address

/** Prefer tighter fees first (NVDA has deep 1bps book). */
const FEE_TIERS = [100, 500, 3000, 10000] as const

const factoryAbi = [
  {
    type: 'function',
    name: 'getPool',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
      { name: 'fee', type: 'uint24' },
    ],
    outputs: [{ type: 'address' }],
  },
] as const

const poolAbi = [
  {
    type: 'function',
    name: 'liquidity',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint128' }],
  },
] as const

const quoterAbi = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'fee', type: 'uint24' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96After', type: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
] as const

const swapRouterAbi = [
  {
    type: 'function',
    name: 'exactInputSingle',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'recipient', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const

export type V3Route = {
  fee: number
  amountOut: bigint
  pool: Address
}

/** True if any fee tier has non-zero V3 liquidity for the pair. */
export async function hasV3Liquidity(
  tokenA: Address,
  tokenB: Address,
): Promise<boolean> {
  for (const fee of FEE_TIERS) {
    try {
      const pool = await publicClient.readContract({
        address: V3_FACTORY,
        abi: factoryAbi,
        functionName: 'getPool',
        args: [tokenA, tokenB, fee],
      })
      if (!pool || pool === '0x0000000000000000000000000000000000000000') {
        continue
      }
      const liq = await publicClient.readContract({
        address: pool,
        abi: poolAbi,
        functionName: 'liquidity',
      })
      if (liq > 0n) return true
    } catch {
      /* try next fee */
    }
  }
  return false
}

/**
 * Best exact-in quote across fee tiers. Uses QuoterV2 simulate (reverts with result).
 */
export async function quoteBestExactIn(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
): Promise<V3Route | null> {
  if (amountIn === 0n) return null
  let best: V3Route | null = null
  for (const fee of FEE_TIERS) {
    try {
      const pool = await publicClient.readContract({
        address: V3_FACTORY,
        abi: factoryAbi,
        functionName: 'getPool',
        args: [tokenIn, tokenOut, fee],
      })
      if (!pool || pool === '0x0000000000000000000000000000000000000000') {
        continue
      }
      const { result } = await publicClient.simulateContract({
        address: V3_QUOTER,
        abi: quoterAbi,
        functionName: 'quoteExactInputSingle',
        args: [
          {
            tokenIn,
            tokenOut,
            amountIn,
            fee,
            sqrtPriceLimitX96: 0n,
          },
        ],
      })
      const amountOut = result[0]
      if (amountOut === 0n) continue
      if (!best || amountOut > best.amountOut) {
        best = { fee, amountOut, pool }
      }
    } catch {
      /* empty / uninitialized tier */
    }
  }
  return best
}

export async function swapExactInV3({
  tokenIn,
  tokenOut,
  amountIn,
  amountOutMinimum,
  fee,
  recipient,
  send,
  progress,
}: {
  tokenIn: Address
  tokenOut: Address
  amountIn: bigint
  amountOutMinimum: bigint
  fee: number
  recipient: Address
  send: Sender
  progress?: Progress
}): Promise<void> {
  progress?.('Balancing your Growth position…')
  await ensureAllowance(tokenIn, recipient, V3_SWAP_ROUTER, amountIn, send, progress ?? (() => {}))
  // SwapRouter02 (periphery) exactInputSingle — no deadline field in this build
  await sendAndWait(send, {
    to: V3_SWAP_ROUTER,
    data: encodeFunctionData({
      abi: swapRouterAbi,
      functionName: 'exactInputSingle',
      args: [
        {
          tokenIn,
          tokenOut,
          fee,
          recipient,
          amountIn,
          amountOutMinimum,
          sqrtPriceLimitX96: 0n,
        },
      ],
    }),
  })
}
