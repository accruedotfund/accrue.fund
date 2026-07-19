// Uniswap V3 on Robinhood Chain.
// Direct USDG/stock books are often dust. Deep path: USDG → WETH → stock.
// Official RH deployments (developers.uniswap.org v3-robinhood-chain-deployments).

import { encodeFunctionData, encodePacked, type Address } from 'viem'
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
/** Official WETH9 on Robinhood Chain. */
export const WETH =
  '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as Address

const FEE_TIERS = [100, 500, 3000, 10000] as const
const SWAP_GAS = 650_000n

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
  {
    type: 'function',
    name: 'quoteExactInput',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'path', type: 'bytes' },
      { name: 'amountIn', type: 'uint256' },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96AfterList', type: 'uint160[]' },
      { name: 'initializedTicksCrossedList', type: 'uint32[]' },
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
    name: 'exactInput',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'path', type: 'bytes' },
          { name: 'recipient', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
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
  /** Single-hop fee, or 0 when multi-hop path is set */
  fee: number
  amountOut: bigint
  /** Encoded multi-hop path (USDG→WETH→stock) when used */
  path?: `0x${string}`
  kind: 'single' | 'multi'
}

function minAfterBps(amount: bigint, bps: bigint): bigint {
  return (amount * (10_000n - bps)) / 10_000n
}

function encodeMultiPath(
  a: Address,
  fee1: number,
  b: Address,
  fee2: number,
  c: Address,
): `0x${string}` {
  return encodePacked(
    ['address', 'uint24', 'address', 'uint24', 'address'],
    [a, fee1, b, fee2, c],
  )
}

async function poolHasLiq(tokenA: Address, tokenB: Address, fee: number) {
  try {
    const pool = await publicClient.readContract({
      address: V3_FACTORY,
      abi: factoryAbi,
      functionName: 'getPool',
      args: [tokenA, tokenB, fee],
    })
    if (!pool || pool === '0x0000000000000000000000000000000000000000') {
      return false
    }
    const liq = await publicClient.readContract({
      address: pool,
      abi: poolAbi,
      functionName: 'liquidity',
    })
    return liq > 0n
  } catch {
    return false
  }
}

/** True if cash→stock is buyable (direct V3 or USDG→WETH→stock). */
export async function hasV3Liquidity(
  tokenA: Address,
  tokenB: Address,
): Promise<boolean> {
  const route = await quoteBestExactIn(tokenA, tokenB, 100_000n) // $0.10
  return Boolean(route && route.amountOut > 0n)
}

/**
 * Best exact-in quote: try direct single-hop all fees, then multi-hop via WETH.
 */
export async function quoteBestExactIn(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
): Promise<V3Route | null> {
  if (amountIn === 0n) return null
  let best: V3Route | null = null

  // 1) Direct
  for (const fee of FEE_TIERS) {
    try {
      if (!(await poolHasLiq(tokenIn, tokenOut, fee))) continue
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
        best = { fee, amountOut, kind: 'single' }
      }
    } catch {
      /* empty */
    }
  }

  // 2) Multi-hop USDG → WETH → stock (deep books on RH)
  if (tokenIn.toLowerCase() !== WETH.toLowerCase()) {
    for (const f1 of FEE_TIERS) {
      for (const f2 of FEE_TIERS) {
        try {
          if (!(await poolHasLiq(tokenIn, WETH, f1))) continue
          if (!(await poolHasLiq(WETH, tokenOut, f2))) continue
          const path = encodeMultiPath(tokenIn, f1, WETH, f2, tokenOut)
          const { result } = await publicClient.simulateContract({
            address: V3_QUOTER,
            abi: quoterAbi,
            functionName: 'quoteExactInput',
            args: [path, amountIn],
          })
          const amountOut = result[0]
          if (amountOut === 0n) continue
          if (!best || amountOut > best.amountOut) {
            best = { fee: 0, amountOut, path, kind: 'multi' }
          }
        } catch {
          /* no route */
        }
      }
    }
  }

  return best
}

/**
 * Buy tokenOut with tokenIn. Uses multi-hop when direct books are dead.
 * Caps size via eth_estimateGas binary search when needed.
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

  let sized = amountIn
  let route = await quoteBestExactIn(tokenIn, tokenOut, sized)

  // If large quote fails, find max estimateGas-safe size
  if (!route) {
    // probe small
    route = await quoteBestExactIn(tokenIn, tokenOut, 100_000n)
    if (!route) {
      throw new Error(
        'No path to buy the Growth risk leg (USDG→stock). Try Steady.',
      )
    }
    // binary search max size that still quotes
    let lo = 100_000n
    let hi = amountIn
    while (lo + 10_000n < hi) {
      const mid = (lo + hi) / 2n
      const q = await quoteBestExactIn(tokenIn, tokenOut, mid)
      if (q && q.amountOut > 0n) lo = mid
      else hi = mid
    }
    sized = lo
    route = await quoteBestExactIn(tokenIn, tokenOut, sized)
    if (!route) {
      throw new Error(
        'Growth stock path too thin for this size. Try Steady or a smaller balance.',
      )
    }
  }

  // Further cap by estimateGas on the encoded multicall
  const encodeSwap = (amt: bigint, minOut: bigint, r: V3Route) => {
    if (r.kind === 'multi' && r.path) {
      return encodeFunctionData({
        abi: swapRouterAbi,
        functionName: 'exactInput',
        args: [
          {
            path: r.path,
            recipient,
            amountIn: amt,
            amountOutMinimum: minOut,
          },
        ],
      })
    }
    return encodeFunctionData({
      abi: swapRouterAbi,
      functionName: 'exactInputSingle',
      args: [
        {
          tokenIn,
          tokenOut,
          fee: r.fee,
          recipient,
          amountIn: amt,
          amountOutMinimum: minOut,
          sqrtPriceLimitX96: 0n,
        },
      ],
    })
  }

  const canEstimate = async (amt: bigint, r: V3Route) => {
    const inner = encodeSwap(amt, 0n, r)
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

  if (!(await canEstimate(sized, route))) {
    let lo = 50_000n
    let hi = sized
    if (!(await canEstimate(lo, route))) {
      throw new Error(
        'Growth path exists but the network rejects the swap size. Try again shortly.',
      )
    }
    while (lo + 10_000n < hi) {
      const mid = (lo + hi) / 2n
      const r = await quoteBestExactIn(tokenIn, tokenOut, mid)
      if (r && (await canEstimate(mid, r))) lo = mid
      else hi = mid
    }
    sized = lo
    route = (await quoteBestExactIn(tokenIn, tokenOut, sized)) ?? route
  }

  // Final quote
  const finalRoute = await quoteBestExactIn(tokenIn, tokenOut, sized)
  if (!finalRoute || finalRoute.amountOut === 0n) {
    throw new Error('Growth market quote failed. Try Steady or retry shortly.')
  }

  await ensureAllowance(
    tokenIn,
    recipient,
    V3_SWAP_ROUTER,
    sized,
    send,
    p,
  )

  const amountOutMinimum = minAfterBps(finalRoute.amountOut, slippageBps)
  const inner = encodeSwap(sized, amountOutMinimum, finalRoute)
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
    if (/insufficient funds|intrinsic gas|gas required/i.test(m)) {
      throw new Error(
        'Not enough Robinhood network fee for Growth. Fund Base ETH and retry.',
      )
    }
    p('Market moved — retrying Growth swap…')
    const retry = await quoteBestExactIn(tokenIn, tokenOut, sized)
    if (!retry) {
      throw new Error(
        'Growth swap failed. Your dollars are still in your account — try again.',
      )
    }
    const inner2 = encodeSwap(
      sized,
      minAfterBps(retry.amountOut, 1500n),
      retry,
    )
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
        'Growth swap failed after retry. Dollars stay in your account — try Steady or retry Growth.',
      )
    }
  }

  return { amountIn: sized, amountOutMin: amountOutMinimum }
}
