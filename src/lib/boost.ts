// Boost enter/exit for two tiers:
//   Steady — LP cash (USDG) + cash wrapper (wUSDG)
//   Growth — swap half cash into a curated stock, LP cash + stock
//
// Consumer code never sees token symbols; it only names Steady / Growth.

import {
  encodeFunctionData,
  formatUnits,
  type Address,
  zeroAddress,
} from 'viem'
import { BOOST_ROUTER } from './rails'
import {
  CASH_DECIMALS,
  CASH_TOKEN,
  GROWTH_CANDIDATES,
  PAIR_FACTORY,
  cashWrapper,
  steadyPairOverride,
  type BoostTier,
  type GrowthCandidate,
} from './strategies'
import {
  ensureAllowance,
  publicClient,
  sendAndWait,
  tokenBalance,
  type Progress,
  type Sender,
} from './vault'

const pairAbi = [
  {
    type: 'function',
    name: 'token0',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'getReserves',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'reserve0', type: 'uint112' },
      { name: 'reserve1', type: 'uint112' },
      { name: 'blockTimestampLast', type: 'uint32' },
    ],
  },
  {
    type: 'function',
    name: 'totalSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const

const factoryAbi = [
  {
    type: 'function',
    name: 'getPair',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
    ],
    outputs: [{ type: 'address' }],
  },
] as const

const vaultAbi = [
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
] as const

const routerAbi = [
  {
    type: 'function',
    name: 'addLiquidity',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
      { name: 'amountADesired', type: 'uint256' },
      { name: 'amountBDesired', type: 'uint256' },
      { name: 'amountAMin', type: 'uint256' },
      { name: 'amountBMin', type: 'uint256' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [
      { name: 'amountA', type: 'uint256' },
      { name: 'amountB', type: 'uint256' },
      { name: 'liquidity', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'removeLiquidity',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
      { name: 'liquidity', type: 'uint256' },
      { name: 'amountAMin', type: 'uint256' },
      { name: 'amountBMin', type: 'uint256' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [
      { name: 'amountA', type: 'uint256' },
      { name: 'amountB', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'swapExactTokensForTokens',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
  {
    type: 'function',
    name: 'getAmountsOut',
    stateMutability: 'view',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'path', type: 'address[]' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
] as const

export const minAfterSlippage = (amount: bigint) => (amount * 98n) / 100n
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 20 * 60)

export function balanceIncrease(after: bigint, before: bigint): bigint {
  if (after < before) throw new Error('Balance changed unexpectedly')
  return after - before
}

export function optimalAmounts(
  a: bigint,
  b: bigint,
  reserveA: bigint,
  reserveB: bigint,
) {
  if (reserveA === 0n || reserveB === 0n) return { a, b }
  const bOptimal = (a * reserveB) / reserveA
  if (bOptimal <= b) return { a, b: bOptimal }
  return {
    a: (b * reserveA) / reserveB,
    b,
  }
}

export interface ResolvedPool {
  tier: BoostTier
  strategyId: string
  pair: Address
  cash: Address
  risk: Address
  riskDecimals: number
  cashReserve: bigint
  riskReserve: bigint
  totalSupply: bigint
  /** Growth only — which candidate won. */
  candidate?: GrowthCandidate
}

async function readPairSides(
  pair: Address,
  cash: Address,
): Promise<{
  cashReserve: bigint
  riskReserve: bigint
  risk: Address
  totalSupply: bigint
}> {
  const [token0, reserves, totalSupply] = await Promise.all([
    publicClient.readContract({
      address: pair,
      abi: pairAbi,
      functionName: 'token0',
    }),
    publicClient.readContract({
      address: pair,
      abi: pairAbi,
      functionName: 'getReserves',
    }),
    publicClient.readContract({
      address: pair,
      abi: pairAbi,
      functionName: 'totalSupply',
    }),
  ])
  const cashIs0 = token0.toLowerCase() === cash.toLowerCase()
  return {
    cashReserve: cashIs0 ? reserves[0] : reserves[1],
    riskReserve: cashIs0 ? reserves[1] : reserves[0],
    risk: (cashIs0 ? await token1(pair) : token0) as Address,
    totalSupply,
  }
}

async function token1(pair: Address): Promise<Address> {
  // token1() selector via token0 we already have order — read token1
  return publicClient.readContract({
    address: pair,
    abi: [
      {
        type: 'function',
        name: 'token1',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ type: 'address' }],
      },
    ] as const,
    functionName: 'token1',
  })
}

async function resolvePair(
  cash: Address,
  risk: Address,
  override?: Address,
): Promise<Address | undefined> {
  if (override && override !== zeroAddress) return override
  const pair = await publicClient.readContract({
    address: PAIR_FACTORY,
    abi: factoryAbi,
    functionName: 'getPair',
    args: [cash, risk],
  })
  if (!pair || pair === zeroAddress) return undefined
  return pair
}

/** Steady pool = cash ↔ cash-wrapper when both exist and the pair has liquidity. */
export async function resolveSteadyPool(): Promise<ResolvedPool | null> {
  const cash = CASH_TOKEN
  const wrapper = cashWrapper()
  if (!cash || !wrapper || !BOOST_ROUTER) return null
  const pair = await resolvePair(cash, wrapper, steadyPairOverride())
  if (!pair) return null
  const sides = await readPairSides(pair, cash)
  if (sides.cashReserve === 0n || sides.riskReserve === 0n) return null
  return {
    tier: 'steady',
    strategyId: 'steady',
    pair,
    cash,
    risk: wrapper,
    riskDecimals: CASH_DECIMALS,
    cashReserve: sides.cashReserve,
    riskReserve: sides.riskReserve,
    totalSupply: sides.totalSupply,
  }
}

/**
 * Growth pool = deepest live USDG↔stock pair among curated candidates.
 * Returns null when nothing is liquid yet (UI shows "opening soon").
 */
export async function resolveGrowthPool(): Promise<ResolvedPool | null> {
  const cash = CASH_TOKEN
  if (!cash || !BOOST_ROUTER) return null

  let best: ResolvedPool | null = null
  let bestScore = 0n

  for (const candidate of GROWTH_CANDIDATES) {
    try {
      const pair = await resolvePair(cash, candidate.token, candidate.pair)
      if (!pair) continue
      const sides = await readPairSides(pair, cash)
      if (sides.cashReserve === 0n || sides.riskReserve === 0n) continue
      // Prefer deepest cash reserve (dollar depth for user-sized entries).
      const score = sides.cashReserve
      if (score > bestScore) {
        bestScore = score
        best = {
          tier: 'growth',
          strategyId: 'growth',
          pair,
          cash,
          risk: candidate.token,
          riskDecimals: candidate.decimals,
          cashReserve: sides.cashReserve,
          riskReserve: sides.riskReserve,
          totalSupply: sides.totalSupply,
          candidate,
        }
      }
    } catch {
      // skip unreachable candidates
    }
  }
  return best
}

export async function resolvePool(
  tier: BoostTier,
): Promise<ResolvedPool | null> {
  return tier === 'steady' ? resolveSteadyPool() : resolveGrowthPool()
}

export interface BoostPosition {
  tier: BoostTier
  strategyId: string
  pair: Address
  lpUnits: bigint
  /** Approximate cash-side value (cash units only; conservative). */
  cashValue: number
  /** Full mark: cash portion + risk portion valued at pool ratio in cash terms. */
  markValue: number
}

/** Read Steady + Growth LP positions for a wallet. */
export async function fetchBoostPositions(
  owner: Address,
): Promise<BoostPosition[]> {
  const out: BoostPosition[] = []
  for (const tier of ['steady', 'growth'] as const) {
    try {
      const pool = await resolvePool(tier)
      if (!pool || pool.totalSupply === 0n) continue
      const lp = await publicClient.readContract({
        address: pool.pair,
        abi: pairAbi,
        functionName: 'balanceOf',
        args: [owner],
      })
      if (lp === 0n) continue
      const cashPortion = (pool.cashReserve * lp) / pool.totalSupply
      const riskPortion = (pool.riskReserve * lp) / pool.totalSupply
      // Mark risk at pool spot: risk * (cashReserve/riskReserve)
      const riskInCash =
        pool.riskReserve > 0n
          ? (riskPortion * pool.cashReserve) / pool.riskReserve
          : 0n
      out.push({
        tier,
        strategyId: pool.strategyId,
        pair: pool.pair,
        lpUnits: lp,
        cashValue: Number(formatUnits(cashPortion, CASH_DECIMALS)),
        markValue: Number(
          formatUnits(cashPortion + riskInCash, CASH_DECIMALS),
        ),
      })
    } catch {
      // pool not live
    }
  }
  return out
}

/** Free USDG for Boost: available wallet cash + redeemable standard shares. */
async function freeCashForBoost(owner: Address): Promise<{
  available: bigint
  shares: bigint
  wrapper?: Address
}> {
  const cash = CASH_TOKEN
  const wrapper = cashWrapper()
  if (!cash) throw new Error('Dollar account is not ready')
  const available = await tokenBalance(cash, owner)
  const shares = wrapper ? await tokenBalance(wrapper, owner) : 0n
  return { available, shares, wrapper }
}

/**
 * Ensure the wallet holds `need` units of cash. Redeems standard shares first
 * (whole position if needed), never invents balances.
 */
async function ensureCash(
  owner: Address,
  need: bigint,
  send: Sender,
  progress: Progress,
): Promise<void> {
  const cash = CASH_TOKEN!
  let have = await tokenBalance(cash, owner)
  if (have >= need) return
  const wrapper = cashWrapper()
  if (!wrapper) throw new Error('No standard balance to draw from')
  const shares = await tokenBalance(wrapper, owner)
  if (shares === 0n) throw new Error('Fund your dollar account first')
  progress('Moving standard balance into available…')
  await sendAndWait(send, {
    to: wrapper,
    data: encodeFunctionData({
      abi: vaultAbi,
      functionName: 'redeem',
      args: [shares, owner, owner],
    }),
  })
  have = await tokenBalance(cash, owner)
  if (have < need) throw new Error('Not enough balance to boost')
}

export async function enterBoost(
  tier: BoostTier,
  owner: Address,
  send: Sender,
  progress: Progress,
) {
  if (tier === 'steady') return enterSteady(owner, send, progress)
  return enterGrowth(owner, send, progress)
}

async function enterSteady(
  owner: Address,
  send: Sender,
  progress: Progress,
) {
  const pool = await resolveSteadyPool()
  if (!pool) throw new Error('Steady Boost is not open yet')
  const wrapper = cashWrapper()
  if (!wrapper || !BOOST_ROUTER) throw new Error('Steady Boost is not configured')

  const [shares, cashBefore] = await Promise.all([
    tokenBalance(wrapper, owner),
    tokenBalance(pool.cash, owner),
  ])
  if (shares < 2n && cashBefore === 0n) {
    throw new Error('No standard balance to boost')
  }

  // Prefer standard shares: redeem half into cash, LP cash + remaining shares.
  if (shares >= 2n) {
    progress('Preparing equal parts of your balance…')
    await sendAndWait(send, {
      to: wrapper,
      data: encodeFunctionData({
        abi: vaultAbi,
        functionName: 'redeem',
        args: [shares / 2n, owner, owner],
      }),
    })
  }

  const [cashAfter, wrapperBal] = await Promise.all([
    tokenBalance(pool.cash, owner),
    tokenBalance(wrapper, owner),
  ])
  const cashForBoost =
    shares >= 2n ? balanceIncrease(cashAfter, cashBefore) : cashAfter
  if (cashForBoost <= 0n || wrapperBal === 0n) {
    throw new Error('The balance could not be prepared for Steady Boost')
  }

  const amounts = optimalAmounts(
    cashForBoost,
    wrapperBal,
    pool.cashReserve,
    pool.riskReserve,
  )
  await ensureAllowance(pool.cash, owner, BOOST_ROUTER, amounts.a, send, progress)
  await ensureAllowance(wrapper, owner, BOOST_ROUTER, amounts.b, send, progress)
  progress('Turning on Steady Boost…')
  await sendAndWait(send, {
    to: BOOST_ROUTER,
    data: encodeFunctionData({
      abi: routerAbi,
      functionName: 'addLiquidity',
      args: [
        pool.cash,
        wrapper,
        amounts.a,
        amounts.b,
        minAfterSlippage(amounts.a),
        minAfterSlippage(amounts.b),
        owner,
        deadline(),
      ],
    }),
  })
}

async function enterGrowth(
  owner: Address,
  send: Sender,
  progress: Progress,
) {
  const pool = await resolveGrowthPool()
  if (!pool || !BOOST_ROUTER) {
    throw new Error('Growth Boost is not open yet — check back soon')
  }

  // Use ~all free cash: half stays cash, half swaps into the risk leg.
  const { available, shares, wrapper } = await freeCashForBoost(owner)
  let cash = available
  if (shares > 0n && wrapper) {
    progress('Making your standard balance available…')
    const before = cash
    await sendAndWait(send, {
      to: wrapper,
      data: encodeFunctionData({
        abi: vaultAbi,
        functionName: 'redeem',
        args: [shares, owner, owner],
      }),
    })
    cash = await tokenBalance(pool.cash, owner)
    if (cash <= before) throw new Error('Could not free balance for Growth')
  }
  if (cash < 2n) throw new Error('Fund your dollar account first')

  const half = cash / 2n
  progress('Balancing your Growth position…')
  await ensureAllowance(pool.cash, owner, BOOST_ROUTER, half, send, progress)

  const path = [pool.cash, pool.risk] as const
  const quoted = await publicClient.readContract({
    address: BOOST_ROUTER,
    abi: routerAbi,
    functionName: 'getAmountsOut',
    args: [half, [...path]],
  })
  const expectedOut = quoted[quoted.length - 1]!
  if (expectedOut === 0n) throw new Error('Growth market has no liquidity')

  const riskBefore = await tokenBalance(pool.risk, owner)
  await sendAndWait(send, {
    to: BOOST_ROUTER,
    data: encodeFunctionData({
      abi: routerAbi,
      functionName: 'swapExactTokensForTokens',
      args: [
        half,
        minAfterSlippage(expectedOut),
        [...path],
        owner,
        deadline(),
      ],
    }),
  })
  const riskAfter = await tokenBalance(pool.risk, owner)
  const riskGot = balanceIncrease(riskAfter, riskBefore)
  const cashLeft = await tokenBalance(pool.cash, owner)

  // Re-read reserves after the swap (price moved).
  const sides = await readPairSides(pool.pair, pool.cash)
  const amounts = optimalAmounts(
    cashLeft,
    riskGot,
    sides.cashReserve,
    sides.riskReserve,
  )
  if (amounts.a === 0n || amounts.b === 0n) {
    throw new Error('Growth position could not be sized')
  }

  await ensureAllowance(pool.cash, owner, BOOST_ROUTER, amounts.a, send, progress)
  await ensureAllowance(pool.risk, owner, BOOST_ROUTER, amounts.b, send, progress)
  progress('Turning on Growth Boost…')
  await sendAndWait(send, {
    to: BOOST_ROUTER,
    data: encodeFunctionData({
      abi: routerAbi,
      functionName: 'addLiquidity',
      args: [
        pool.cash,
        pool.risk,
        amounts.a,
        amounts.b,
        minAfterSlippage(amounts.a),
        minAfterSlippage(amounts.b),
        owner,
        deadline(),
      ],
    }),
  })
}

export async function exitBoost(
  tier: BoostTier,
  owner: Address,
  send: Sender,
  progress: Progress,
) {
  const pool = await resolvePool(tier)
  if (!pool || !BOOST_ROUTER) throw new Error('Boost is not open')

  const liquidity = await tokenBalance(pool.pair, owner)
  if (liquidity === 0n || pool.totalSupply === 0n) {
    throw new Error('No Boost balance to turn off')
  }

  // Fresh reserves for exit sizing
  const sides = await readPairSides(pool.pair, pool.cash)
  const expectedCash = (sides.cashReserve * liquidity) / sides.totalSupply
  const expectedRisk = (sides.riskReserve * liquidity) / sides.totalSupply

  await ensureAllowance(pool.pair, owner, BOOST_ROUTER, liquidity, send, progress)
  progress(tier === 'steady' ? 'Turning off Steady…' : 'Turning off Growth…')

  const cashBefore = await tokenBalance(pool.cash, owner)
  const riskBefore = await tokenBalance(pool.risk, owner)

  await sendAndWait(send, {
    to: BOOST_ROUTER,
    data: encodeFunctionData({
      abi: routerAbi,
      functionName: 'removeLiquidity',
      args: [
        pool.cash,
        pool.risk,
        liquidity,
        minAfterSlippage(expectedCash),
        minAfterSlippage(expectedRisk),
        owner,
        deadline(),
      ],
    }),
  })

  if (tier === 'steady') {
    // Steady risk leg is wUSDG — leave it. Deposit free cash back to standard.
    const cashAfter = await tokenBalance(pool.cash, owner)
    const cashFrom = balanceIncrease(cashAfter, cashBefore)
    const wrapper = cashWrapper()
    if (cashFrom > 0n && wrapper) {
      await ensureAllowance(pool.cash, owner, wrapper, cashFrom, send, progress)
      progress('Returning the balance to standard…')
      await sendAndWait(send, {
        to: wrapper,
        data: encodeFunctionData({
          abi: vaultAbi,
          functionName: 'deposit',
          args: [cashFrom, owner],
        }),
      })
    }
    return
  }

  // Growth: sell risk leg back to cash, then park cash in standard if possible.
  const riskAfter = await tokenBalance(pool.risk, owner)
  const riskFrom = balanceIncrease(riskAfter, riskBefore)
  if (riskFrom > 0n) {
    progress('Settling Growth back to dollars…')
    await ensureAllowance(pool.risk, owner, BOOST_ROUTER, riskFrom, send, progress)
    const path = [pool.risk, pool.cash] as const
    let minOut = 0n
    try {
      const quoted = await publicClient.readContract({
        address: BOOST_ROUTER,
        abi: routerAbi,
        functionName: 'getAmountsOut',
        args: [riskFrom, [...path]],
      })
      minOut = minAfterSlippage(quoted[quoted.length - 1]!)
    } catch {
      minOut = 0n
    }
    await sendAndWait(send, {
      to: BOOST_ROUTER,
      data: encodeFunctionData({
        abi: routerAbi,
        functionName: 'swapExactTokensForTokens',
        args: [riskFrom, minOut, [...path], owner, deadline()],
      }),
    })
  }

  const cashAfter = await tokenBalance(pool.cash, owner)
  const wrapper = cashWrapper()
  if (cashAfter > 0n && wrapper) {
    await ensureAllowance(pool.cash, owner, wrapper, cashAfter, send, progress)
    progress('Returning the balance to standard…')
    await sendAndWait(send, {
      to: wrapper,
      data: encodeFunctionData({
        abi: vaultAbi,
        functionName: 'deposit',
        args: [cashAfter, owner],
      }),
    })
  }
}

// keep ensureCash exported for tests/tools
export { ensureCash }
