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
import { BOOST_ROUTER, setRailWrapper } from './rails'
import { readUsdWrapper } from './factory'
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

/** Refuse dust / scam-thin pools (TSLA pair had riskReserve = 1 wei). */
const MIN_POOL_CASH = 100n * 10n ** 6n // $100 USDG
/** 18-decimal risk legs: need real depth, not 1 wei. */
const MIN_POOL_RISK_18 = 10n ** 15n // 0.001 token
/** 6-decimal risk (wrapper): same $ idea. */
const MIN_POOL_RISK_6 = 10n * 10n ** 6n // $10 of wUSDG

export const minAfterSlippage = (amount: bigint, bps = 200n) =>
  (amount * (10_000n - bps)) / 10_000n

async function resolveUsdWrapper(): Promise<Address | undefined> {
  const cached = cashWrapper()
  if (cached) return cached
  const onChain = await readUsdWrapper()
  if (onChain) {
    setRailWrapper('USD', onChain)
    return onChain
  }
  return undefined
}

function poolIsLiquid(
  cashReserve: bigint,
  riskReserve: bigint,
  riskDecimals: number,
): boolean {
  if (cashReserve < MIN_POOL_CASH) return false
  if (riskDecimals <= 6) return riskReserve >= MIN_POOL_RISK_6
  return riskReserve >= MIN_POOL_RISK_18
}

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
  {
    type: 'function',
    name: 'createPair',
    stateMutability: 'nonpayable',
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
  {
    type: 'function',
    name: 'convertToAssets',
    stateMutability: 'view',
    inputs: [{ name: 'shares', type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'convertToShares',
    stateMutability: 'view',
    inputs: [{ name: 'assets', type: 'uint256' }],
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
  /** Zero address when Steady has no pair yet — first LP creates it. */
  pair: Address
  cash: Address
  risk: Address
  riskDecimals: number
  cashReserve: bigint
  riskReserve: bigint
  totalSupply: bigint
  /** Growth only — which candidate won. */
  candidate?: GrowthCandidate
  /** Steady first-LP: pair missing or empty. */
  bootstrap?: boolean
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

/**
 * Steady = USDG ↔ wUSDG. Open whenever the standard vault + router exist.
 * Unlike Growth, thin/dust pairs stay open — first LPs seed or top up.
 * Missing pair → bootstrap (createPair + addLiquidity on Turn on).
 */
export async function resolveSteadyPool(): Promise<ResolvedPool | null> {
  const cash = CASH_TOKEN
  const wrapper = await resolveUsdWrapper()
  if (!cash || !wrapper || !BOOST_ROUTER) return null

  const pair = await resolvePair(cash, wrapper, steadyPairOverride())
  if (pair) {
    try {
      const sides = await readPairSides(pair, cash)
      const empty =
        sides.totalSupply === 0n ||
        (sides.cashReserve === 0n && sides.riskReserve === 0n)
      const liquid = poolIsLiquid(
        sides.cashReserve,
        sides.riskReserve,
        CASH_DECIMALS,
      )
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
        // Empty = pure seed. Thin = still joinable (use soft mins on LP).
        bootstrap: empty || !liquid,
      }
    } catch {
      /* fall through — treat as bootstrap */
    }
  }

  // No pair yet — first LP creates it.
  return {
    tier: 'steady',
    strategyId: 'steady',
    pair: zeroAddress,
    cash,
    risk: wrapper,
    riskDecimals: CASH_DECIMALS,
    cashReserve: 0n,
    riskReserve: 0n,
    totalSupply: 0n,
    bootstrap: true,
  }
}

/**
 * Growth pool = USDG ↔ curated stock.
 * Prefer deepest liquid V2 pair. If none, bootstrap via Uniswap V3 (where
 * stock books live): pick first candidate with a V3 route so Turn on can
 * buy stock + seed/join our V2 Boost pair.
 */
export async function resolveGrowthPool(): Promise<ResolvedPool | null> {
  const cash = CASH_TOKEN
  if (!cash || !BOOST_ROUTER) return null

  const { hasV3Liquidity } = await import('./uniswap-v3')

  let best: ResolvedPool | null = null
  let bestScore = 0n
  let bootstrap: ResolvedPool | null = null

  for (const candidate of GROWTH_CANDIDATES) {
    try {
      const pair = await resolvePair(cash, candidate.token, candidate.pair)
      if (pair) {
        try {
          const sides = await readPairSides(pair, cash)
          if (
            poolIsLiquid(
              sides.cashReserve,
              sides.riskReserve,
              candidate.decimals,
            )
          ) {
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
            continue
          }
          // Thin / empty V2 pair — still usable if V3 can source the stock leg.
        } catch {
          /* pair unreadable */
        }
      }

      if (!bootstrap) {
        const v3ok = await hasV3Liquidity(cash, candidate.token)
        if (v3ok) {
          bootstrap = {
            tier: 'growth',
            strategyId: 'growth',
            pair: pair ?? zeroAddress,
            cash,
            risk: candidate.token,
            riskDecimals: candidate.decimals,
            cashReserve: 0n,
            riskReserve: 0n,
            totalSupply: 0n,
            candidate,
            bootstrap: true,
          }
        }
      }
    } catch {
      // skip unreachable candidates
    }
  }
  return best ?? bootstrap
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
  const wrapper = await resolveUsdWrapper()
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
  if (!pool) {
    throw new Error(
      'Steady Boost isn’t ready — open Standard growth first, then try again.',
    )
  }
  const wrapper = await resolveUsdWrapper()
  if (!wrapper || !BOOST_ROUTER) throw new Error('Steady Boost is not configured')

  const { ensureRhGas } = await import('./gasBridge')
  await ensureRhGas({ owner, send, progress })

  // —— Split free value 50/50 cash ↔ shares (asset terms) ——
  progress('Balancing cash and standard for Steady…')
  let cashBal = await tokenBalance(pool.cash, owner)
  let shareBal = await tokenBalance(wrapper, owner)
  if (cashBal === 0n && shareBal === 0n) {
    throw new Error('No standard balance to boost')
  }

  const assetsOf = async (shares: bigint) => {
    if (shares === 0n) return 0n
    return publicClient.readContract({
      address: wrapper,
      abi: vaultAbi,
      functionName: 'convertToAssets',
      args: [shares],
    })
  }
  const sharesOf = async (assets: bigint) => {
    if (assets === 0n) return 0n
    return publicClient.readContract({
      address: wrapper,
      abi: vaultAbi,
      functionName: 'convertToShares',
      args: [assets],
    })
  }

  let shareAssets = await assetsOf(shareBal)
  let total = cashBal + shareAssets
  if (total < 10n ** 4n) throw new Error('Balance too small to boost')
  const half = total / 2n

  // Too many shares → redeem excess into cash (skip dust — high NAV / tiny float)
  const DUST_ASSETS = 10n ** 2n // 0.0001 USDG @ 6 decimals
  if (shareAssets > half + 1n) {
    const excessAssets = shareAssets - half
    let toRedeem = await sharesOf(excessAssets)
    if (toRedeem === 0n) toRedeem = shareBal / 2n
    if (toRedeem > shareBal) toRedeem = shareBal
    const redeemAssets =
      toRedeem > 0n ? await assetsOf(toRedeem) : 0n
    if (toRedeem > 0n && redeemAssets >= DUST_ASSETS) {
      await sendAndWait(send, {
        to: wrapper,
        data: encodeFunctionData({
          abi: vaultAbi,
          functionName: 'redeem',
          args: [toRedeem, owner, owner],
        }),
      })
    }
  } else if (cashBal > half + 1n) {
    // Too much cash → deposit excess into standard shares
    const excessCash = cashBal - half
    if (excessCash >= DUST_ASSETS) {
      await ensureAllowance(pool.cash, owner, wrapper, excessCash, send, progress)
      await sendAndWait(send, {
        to: wrapper,
        data: encodeFunctionData({
          abi: vaultAbi,
          functionName: 'deposit',
          args: [excessCash, owner],
        }),
      })
    }
  }

  cashBal = await tokenBalance(pool.cash, owner)
  shareBal = await tokenBalance(wrapper, owner)
  if (cashBal === 0n || shareBal === 0n) {
    throw new Error('Need both cash and standard shares for Steady — try again')
  }

  // Live deep pool: match ratio. Empty/thin: seed bags (bootstrap path).
  let amounts: { a: bigint; b: bigint }
  const needCreate =
    pool.pair === zeroAddress ||
    !(await resolvePair(pool.cash, wrapper, steadyPairOverride()))
  const emptyPool =
    pool.cashReserve === 0n ||
    pool.riskReserve === 0n ||
    pool.totalSupply === 0n
  // Thin pair: still match existing ratio so we don't blow up the book.
  const thin = Boolean(pool.bootstrap) && !emptyPool && !needCreate

  if (needCreate || emptyPool) {
    amounts = { a: cashBal, b: shareBal }
  } else {
    const sides = await readPairSides(pool.pair, pool.cash)
    amounts = optimalAmounts(
      cashBal,
      shareBal,
      sides.cashReserve,
      sides.riskReserve,
    )
  }
  if (amounts.a === 0n || amounts.b === 0n) {
    throw new Error('Steady position could not be sized')
  }

  // createPair first (own tx) — createPair+addLiquidity in one shot often OOGs.
  if (needCreate) {
    progress('Creating Steady market…')
    try {
      await sendAndWait(send, {
        to: PAIR_FACTORY,
        data: encodeFunctionData({
          abi: factoryAbi,
          functionName: 'createPair',
          args: [pool.cash, wrapper],
        }),
      })
    } catch (e) {
      // Pair may already exist from a race; continue if getPair works.
      const again = await resolvePair(pool.cash, wrapper)
      if (!again) {
        const m = e instanceof Error ? e.message : 'createPair failed'
        throw new Error(
          /unknown reason|reverted|insufficient funds|gas|sponsor|network fee/i.test(
            m,
          )
            ? 'Could not create Steady market. Need a little ETH on Base (~$0.30+) for network fees — send it to your Accrue address, then try again. Your dollars are safe.'
            : m,
        )
      }
    }
  }

  await ensureAllowance(pool.cash, owner, BOOST_ROUTER, amounts.a, send, progress)
  await ensureAllowance(wrapper, owner, BOOST_ROUTER, amounts.b, send, progress)
  progress(
    needCreate || emptyPool
      ? 'Seeding Steady with your balance…'
      : thin
        ? 'Adding to Steady…'
        : 'Turning on Steady Boost…',
  )

  // Soft mins on thin/bootstrap — transfer tax + shallow book need slack.
  const minA =
    needCreate || emptyPool || thin ? 0n : minAfterSlippage(amounts.a, 500n)
  const minB =
    needCreate || emptyPool || thin ? 0n : minAfterSlippage(amounts.b, 500n)
  try {
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
          minA,
          minB,
          owner,
          deadline(),
        ],
      }),
    })
  } catch (e) {
    const m = e instanceof Error ? e.message : ''
    if (/INSUFFICIENT_[AB]_AMOUNT|unknown reason|reverted/i.test(m)) {
      throw new Error(
        'Steady liquidity mint failed. Try again — if it keeps failing, keep funds in Standard for now.',
      )
    }
    throw e
  }
}

async function enterGrowth(
  owner: Address,
  send: Sender,
  progress: Progress,
) {
  const pool = await resolveGrowthPool()
  if (!pool || !BOOST_ROUTER) {
    throw new Error(
      'Growth Boost isn’t ready — no market route for stocks yet. Try again later.',
    )
  }

  const { ensureRhGas } = await import('./gasBridge')
  const { quoteBestExactIn, swapExactInV3 } = await import('./uniswap-v3')
  await ensureRhGas({ owner, send, progress })

  // Use free cash: half stays cash, half swaps into the risk leg.
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
  // Need a real dollar amount (not dust).
  if (cash < 10n ** 5n) throw new Error('Fund your dollar account first')

  const deepV2 =
    !pool.bootstrap &&
    pool.pair !== zeroAddress &&
    poolIsLiquid(pool.cashReserve, pool.riskReserve, pool.riskDecimals)

  // Cap swap at 3% of V2 cash depth when joining a deep book.
  const maxSwap = deepV2 ? pool.cashReserve / 33n : 0n
  let half = cash / 2n
  if (maxSwap > 0n && half > maxSwap) half = maxSwap
  if (half < 10n ** 4n) {
    throw new Error(
      'Not enough balance to open Growth. Add dollars first.',
    )
  }

  progress('Balancing your Growth position…')
  const riskBefore = await tokenBalance(pool.risk, owner)

  // Prefer V2 swap when that book is deep; else buy stock on Uniswap V3.
  let usedV3 = false
  if (deepV2) {
    await ensureAllowance(pool.cash, owner, BOOST_ROUTER, half, send, progress)
    const path = [pool.cash, pool.risk] as const
    let expectedOut: bigint
    try {
      const quoted = await publicClient.readContract({
        address: BOOST_ROUTER,
        abi: routerAbi,
        functionName: 'getAmountsOut',
        args: [half, [...path]],
      })
      expectedOut = quoted[quoted.length - 1]!
    } catch {
      expectedOut = 0n
    }
    if (expectedOut > 0n) {
      try {
        await sendAndWait(send, {
          to: BOOST_ROUTER,
          data: encodeFunctionData({
            abi: routerAbi,
            functionName: 'swapExactTokensForTokens',
            args: [
              half,
              minAfterSlippage(expectedOut, 500n),
              [...path],
              owner,
              deadline(),
            ],
          }),
        })
      } catch (e) {
        const m = e instanceof Error ? e.message : ''
        if (/INSUFFICIENT|slippage|K\b/i.test(m)) {
          throw new Error(
            'Growth market moved while swapping. Try again in a moment.',
          )
        }
        throw e
      }
    } else {
      usedV3 = true
    }
  } else {
    usedV3 = true
  }

  if (usedV3) {
    // Preflight: need a quote or we never open Growth against a dead book.
    const probe = await quoteBestExactIn(pool.cash, pool.risk, half)
    if (!probe) {
      throw new Error(
        'No live stock market to open Growth against. Try again later.',
      )
    }
    try {
      await swapExactInV3({
        tokenIn: pool.cash,
        tokenOut: pool.risk,
        amountIn: half,
        recipient: owner,
        send,
        progress,
        slippageBps: 500n,
      })
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      // Pass through already-human messages from swapExactInV3
      if (
        /Growth swap|stock market|re-approve|Standard|Token approval/i.test(m)
      ) {
        throw e instanceof Error ? e : new Error(m)
      }
      throw new Error(
        'Growth swap failed. Your dollars are still in your account — try again in a moment.',
      )
    }
  }

  const riskAfter = await tokenBalance(pool.risk, owner)
  const riskGot = balanceIncrease(riskAfter, riskBefore)
  const cashLeft = await tokenBalance(pool.cash, owner)
  if (riskGot === 0n) {
    throw new Error('Growth swap returned nothing — market is unusable right now')
  }

  // Ensure V2 pair exists so Boost can hold an LP receipt.
  let pair = await resolvePair(pool.cash, pool.risk, pool.candidate?.pair)
  if (!pair) {
    progress('Creating Growth market…')
    try {
      await sendAndWait(send, {
        to: PAIR_FACTORY,
        data: encodeFunctionData({
          abi: factoryAbi,
          functionName: 'createPair',
          args: [pool.cash, pool.risk],
        }),
      })
    } catch (e) {
      pair = await resolvePair(pool.cash, pool.risk)
      if (!pair) {
        const m = e instanceof Error ? e.message : 'createPair failed'
        throw new Error(
          /gas|insufficient funds|network fee/i.test(m)
            ? 'Could not create Growth market — need a little more network fee. Try again.'
            : m,
        )
      }
    }
    pair = (await resolvePair(pool.cash, pool.risk)) ?? pair
  }
  if (!pair) throw new Error('Growth market did not open')

  // Seed or join V2 at current reserves (empty → full bags).
  let amounts: { a: bigint; b: bigint }
  try {
    const sides = await readPairSides(pair, pool.cash)
    if (sides.cashReserve === 0n || sides.riskReserve === 0n) {
      amounts = { a: cashLeft, b: riskGot }
    } else {
      amounts = optimalAmounts(
        cashLeft,
        riskGot,
        sides.cashReserve,
        sides.riskReserve,
      )
    }
  } catch {
    amounts = { a: cashLeft, b: riskGot }
  }
  if (amounts.a === 0n || amounts.b === 0n) {
    throw new Error(
      'Growth position could not be sized — try again or use Standard for now.',
    )
  }

  await ensureAllowance(pool.cash, owner, BOOST_ROUTER, amounts.a, send, progress)
  await ensureAllowance(pool.risk, owner, BOOST_ROUTER, amounts.b, send, progress)
  progress(
    pool.bootstrap || usedV3
      ? 'Seeding Growth with your balance…'
      : 'Turning on Growth Boost…',
  )
  const softMins = pool.bootstrap || usedV3 || !deepV2
  try {
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
          softMins ? 0n : minAfterSlippage(amounts.a, 800n),
          softMins ? 0n : minAfterSlippage(amounts.b, 800n),
          owner,
          deadline(),
        ],
      }),
    })
  } catch (e) {
    const m = e instanceof Error ? e.message : ''
    if (/INSUFFICIENT_[AB]_AMOUNT/i.test(m)) {
      throw new Error(
        'Growth liquidity mint slipped — market moved. Try again, or keep funds in Standard.',
      )
    }
    throw e
  }
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

  // Growth: sell risk leg back to cash (V2 if deep, else Uniswap V3).
  const riskAfter = await tokenBalance(pool.risk, owner)
  const riskFrom = balanceIncrease(riskAfter, riskBefore)
  if (riskFrom > 0n) {
    progress('Settling Growth back to dollars…')
    let sold = false
    // Try V2 first
    try {
      await ensureAllowance(pool.risk, owner, BOOST_ROUTER, riskFrom, send, progress)
      const path = [pool.risk, pool.cash] as const
      const quoted = await publicClient.readContract({
        address: BOOST_ROUTER,
        abi: routerAbi,
        functionName: 'getAmountsOut',
        args: [riskFrom, [...path]],
      })
      const minOut = minAfterSlippage(quoted[quoted.length - 1]!)
      if (minOut > 0n) {
        await sendAndWait(send, {
          to: BOOST_ROUTER,
          data: encodeFunctionData({
            abi: routerAbi,
            functionName: 'swapExactTokensForTokens',
            args: [riskFrom, minOut, [...path], owner, deadline()],
          }),
        })
        sold = true
      }
    } catch {
      sold = false
    }
    if (!sold) {
      const { quoteBestExactIn, swapExactInV3 } = await import('./uniswap-v3')
      const route = await quoteBestExactIn(pool.risk, pool.cash, riskFrom)
      if (!route) {
        throw new Error(
          'Could not sell Growth risk leg back to dollars — keep the tokens or try later.',
        )
      }
      await swapExactInV3({
        tokenIn: pool.risk,
        tokenOut: pool.cash,
        amountIn: riskFrom,
        recipient: owner,
        send,
        progress,
        slippageBps: 800n,
      })
    }
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
