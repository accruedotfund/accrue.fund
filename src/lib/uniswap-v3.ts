// Uniswap V3 on Robinhood Chain — stock liquidity lives here, not V2.
// Official RH deployments (developers.uniswap.org v3-robinhood-chain-deployments).
//
// RH stock books are often dust. We still OPEN Growth when a route exists so
// the first user can seed Accrue’s V2 Boost pair:
//  - cap swap size to pool depth + estimateGas-safe max
//  - send via multicall + explicit gas (thin books break bare estimateGas)

import { encodeFunctionData, type Address } from 'viem'
import type { TransactionRequest } from './auth'
import {
  ensureAllowance,
  publicClient,
  sendAndWait,
  type Progress,
  type Sender,
} from './vault'

export const V3_FACTORY =
  '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA' as Address
export const V3_QUOTER =
  '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7' as Address
export const V3_SWAP_ROUTER =
  '0xcaf681a66d020601342297493863e78c959e5cb2' as Address

/** Prefer tighter fees first (NVDA has a 1bps book). */
const FEE_TIERS = [100, 500, 3000, 10000] as const

/** Any non-zero V3 liquidity is enough to attempt a seed swap. */
const MIN_LIQ = 1n

/** SwapRouter02 exactInputSingle needs a generous fixed gas on RH. */
const SWAP_GAS = 450_000n

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

const erc20Abi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'a', type: 'address' }],
    outputs: [{ type: 'uint256' }],
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
  {
    type: 'function',
    name: 'multicall',
    stateMutability: 'payable',
    inputs: [{ name: 'data', type: 'bytes[]' }],
    outputs: [{ type: 'bytes[]' }],
  },
] as const

export type V3Route = {
  fee: number
  amountOut: bigint
  pool: Address
  /** USDG (or tokenIn) balance sitting in the pool */
  cashInPool: bigint
}

function minAfterBps(amount: bigint, bps: bigint): bigint {
  return (amount * (10_000n - bps)) / 10_000n
}

async function poolCashBalance(
  pool: Address,
  cashToken: Address,
): Promise<bigint> {
  try {
    return await publicClient.readContract({
      address: cashToken,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [pool],
    })
  } catch {
    return 0n
  }
}

/**
 * True if we can buy tokenB with tokenA on V3 (any fee tier).
 * Used to enable Growth Turn on so first users can seed our V2 Boost pair.
 */
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
      if (liq >= MIN_LIQ) return true
      // liq can read 0 while residual balances still quote
      const cash = await poolCashBalance(pool, tokenA)
      if (cash > 0n) return true
    } catch {
      /* try next fee */
    }
  }
  // Last resort: can we quote a micro buy?
  const q = await quoteBestExactIn(tokenA, tokenB, 50_000n) // $0.05
  return Boolean(q && q.amountOut > 0n)
}

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
      const cashInPool = await poolCashBalance(pool, tokenIn)
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
        best = { fee, amountOut, pool, cashInPool }
      }
    } catch {
      /* empty tier */
    }
  }
  return best
}

/**
 * Largest amountIn that RH eth_estimateGas accepts for this swap.
 * Thin V3 books eth_call large swaps but estimateGas reverts past ~pool depth.
 */
export async function maxSwappableExactIn(
  tokenIn: Address,
  tokenOut: Address,
  fee: number,
  recipient: Address,
  upperBound: bigint,
): Promise<bigint> {
  if (upperBound <= 0n) return 0n

  const tryAmount = async (amountIn: bigint): Promise<boolean> => {
    if (amountIn <= 0n) return false
    const inner = encodeFunctionData({
      abi: swapRouterAbi,
      functionName: 'exactInputSingle',
      args: [
        {
          tokenIn,
          tokenOut,
          fee,
          recipient,
          amountIn,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0n,
        },
      ],
    })
    const data = encodeFunctionData({
      abi: swapRouterAbi,
      functionName: 'multicall',
      args: [[inner]],
    })
    try {
      await publicClient.estimateGas({
        account: recipient,
        to: V3_SWAP_ROUTER,
        data,
      })
      return true
    } catch {
      return false
    }
  }

  // Fast path
  if (await tryAmount(upperBound)) return upperBound
  if (!(await tryAmount(1n))) return 0n

  let lo = 1n
  let hi = upperBound
  while (lo + 1n < hi) {
    const mid = (lo + hi) / 2n
    if (await tryAmount(mid)) lo = mid
    else hi = mid
  }
  return lo
}

/**
 * Approve router, size to book depth, multicall exactInputSingle with fixed gas.
 */
export async function swapExactInV3({
  tokenIn,
  tokenOut,
  amountIn,
  recipient,
  send,
  progress,
  slippageBps = 500n,
}: {
  tokenIn: Address
  tokenOut: Address
  amountIn: bigint
  recipient: Address
  send: Sender
  progress?: Progress
  slippageBps?: bigint
}): Promise<{ amountIn: bigint; amountOutMin: bigint }> {
  const p = progress ?? (() => {})
  p('Balancing your Growth position…')

  // Probe route at a tiny size first so we know fee tier + pool cash.
  const probeSize = amountIn < 100_000n ? amountIn : 100_000n
  let route = await quoteBestExactIn(tokenIn, tokenOut, probeSize)
  if (!route) {
    throw new Error(
      'No live stock market quote right now. Try Steady, or check back later.',
    )
  }

  // Cap to ~70% of cash sitting in the pool (estimateGas dies past thin depth).
  const depthCap =
    route.cashInPool > 0n ? (route.cashInPool * 70n) / 100n : amountIn
  let sized = amountIn < depthCap ? amountIn : depthCap

  // Further cap to what the node will estimateGas for.
  const maxEst = await maxSwappableExactIn(
    tokenIn,
    tokenOut,
    route.fee,
    recipient,
    sized,
  )
  if (maxEst < 10_000n) {
    // <$0.01 — truly unusable
    throw new Error(
      'Could not buy the Growth risk leg — external stock book has no room. Try again later.',
    )
  }
  sized = sized < maxEst ? sized : maxEst

  // Re-quote at final size
  route = await quoteBestExactIn(tokenIn, tokenOut, sized)
  if (!route || route.amountOut === 0n) {
    throw new Error(
      'Growth market quote failed at this size. Try a smaller balance or Steady.',
    )
  }

  await ensureAllowance(
    tokenIn,
    recipient,
    V3_SWAP_ROUTER,
    sized,
    send,
    p,
  )

  const amountOutMinimum = minAfterBps(route.amountOut, slippageBps)
  const inner = encodeFunctionData({
    abi: swapRouterAbi,
    functionName: 'exactInputSingle',
    args: [
      {
        tokenIn,
        tokenOut,
        fee: route.fee,
        recipient,
        amountIn: sized,
        amountOutMinimum,
        sqrtPriceLimitX96: 0n,
      },
    ],
  })
  // multicall is more reliable for estimateGas on RH than bare exactInputSingle
  const data = encodeFunctionData({
    abi: swapRouterAbi,
    functionName: 'multicall',
    args: [[inner]],
  }) as `0x${string}`

  const tx: TransactionRequest = {
    to: V3_SWAP_ROUTER,
    data,
    gas: SWAP_GAS,
  }

  try {
    await sendAndWait(send, tx)
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e)
    if (/insufficient funds|gas required|intrinsic gas/i.test(m)) {
      throw new Error(
        'Not enough Robinhood network fee for the Growth swap. Fund Base ETH and retry.',
      )
    }
    if (/allowance|STF|transfer from/i.test(m)) {
      throw new Error(
        'Could not spend dollars for Growth — re-approve and try again.',
      )
    }
    // One wider retry at 15% slip, same size
    p('Market moved — retrying Growth swap…')
    const route2 = await quoteBestExactIn(tokenIn, tokenOut, sized)
    if (!route2) {
      throw new Error(
        'Growth swap failed. Stock market too thin — use Steady for now.',
      )
    }
    const inner2 = encodeFunctionData({
      abi: swapRouterAbi,
      functionName: 'exactInputSingle',
      args: [
        {
          tokenIn,
          tokenOut,
          fee: route2.fee,
          recipient,
          amountIn: sized,
          amountOutMinimum: minAfterBps(route2.amountOut, 1500n),
          sqrtPriceLimitX96: 0n,
        },
      ],
    })
    try {
      await sendAndWait(send, {
        to: V3_SWAP_ROUTER,
        data: encodeFunctionData({
          abi: swapRouterAbi,
          functionName: 'multicall',
          args: [[inner2]],
        }) as `0x${string}`,
        gas: SWAP_GAS,
      })
    } catch {
      throw new Error(
        'Growth stock market is too thin or moved. Your dollars are safe in your account — try Steady, or Growth later.',
      )
    }
  }

  return { amountIn: sized, amountOutMin: amountOutMinimum }
}
