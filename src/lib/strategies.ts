// Boost is a risk dial, not a token picker.
//
//   Steady  → USDG ↔ wUSDG   (dollar-linked, low IL)
//   Growth  → USDG ↔ stock   (equity-linked, real IL)
//
// Users only see "Steady" / "Growth". The engine picks the live Growth pool
// with the deepest cash side among curated stock candidates.

import type { Address } from 'viem'
import { USD_STABLE, WRAPPER_FACTORY, BOOST_ROUTER, railFor } from './rails'

export type BoostTier = 'steady' | 'growth'

export interface GrowthCandidate {
  /** Internal id — never shown as a "token ticker" in consumer copy. */
  id: string
  /** Soft label for support/debug; UI says "Growth" only. */
  label: string
  token: Address
  decimals: number
  /** Optional hard-coded pair; else resolved via factory.getPair(USDG, token). */
  pair?: Address
}

export interface BoostStrategy {
  id: string
  tier: BoostTier
  /** Consumer title */
  title: string
  /** One-line risk story */
  subtitle: string
  /** Confirm-sheet body */
  riskCopy: string
  /** 1 = calm … 3 = spicy, for UI bars */
  riskLevel: 1 | 2 | 3
}

/** Canonical cash leg — only USDG on Robinhood today. */
export const CASH_TOKEN: Address | undefined = USD_STABLE
export const CASH_DECIMALS = 6

/**
 * Curated equity legs for Growth. Order is preference when liquidity ties.
 * Addresses are official Robinhood Stock Tokens (see docs.robinhood.com/chain).
 */
export const GROWTH_CANDIDATES: GrowthCandidate[] = [
  {
    id: 'nvda',
    label: 'broad tech A',
    token: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC' as Address,
    decimals: 18,
    pair: envPair('VITE_GROWTH_PAIR_NVDA'),
  },
  {
    id: 'tsla',
    label: 'broad tech B',
    token: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d' as Address,
    decimals: 18,
    pair: envPair('VITE_GROWTH_PAIR_TSLA'),
  },
  {
    id: 'aapl',
    label: 'broad tech C',
    token: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9' as Address,
    decimals: 18,
    pair: envPair('VITE_GROWTH_PAIR_AAPL'),
  },
  {
    id: 'meta',
    label: 'broad tech D',
    token: '0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35' as Address,
    decimals: 18,
    pair: envPair('VITE_GROWTH_PAIR_META'),
  },
  {
    id: 'googl',
    label: 'broad tech E',
    token: '0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3' as Address,
    decimals: 18,
    pair: envPair('VITE_GROWTH_PAIR_GOOGL'),
  },
  {
    id: 'amzn',
    label: 'broad tech F',
    token: '0x12f190a9F9d7D37a250758b26824B97CE941bF54' as Address,
    decimals: 18,
    pair: envPair('VITE_GROWTH_PAIR_AMZN'),
  },
  {
    id: 'msft',
    label: 'broad tech G',
    token: '0xe93237C50D904957Cf27E7B1133b510C669c2e74' as Address,
    decimals: 18,
    pair: envPair('VITE_GROWTH_PAIR_MSFT'),
  },
  {
    id: 'coin',
    label: 'broad tech H',
    token: '0x6330D8C3178a418788dF01a47479c0ce7CCF450b' as Address,
    decimals: 18,
    pair: envPair('VITE_GROWTH_PAIR_COIN'),
  },
]

export const STRATEGIES: BoostStrategy[] = [
  {
    id: 'steady',
    tier: 'steady',
    title: 'Steady',
    subtitle: 'Lower risk · lower reward · dollar-linked',
    riskCopy:
      'Your balance stays tied to dollars. Value can still move a little as the market for the dollar account trades, and you may get back slightly less than you put in.',
    riskLevel: 1,
  },
  {
    id: 'growth',
    tier: 'growth',
    title: 'Growth',
    subtitle: 'Higher risk · higher reward · can move with markets',
    riskCopy:
      'Part of your balance is linked to market prices, not just dollars. It can fall well below what you put in — including large, fast drops. This is not your standard account.',
    riskLevel: 3,
  },
]

function envPair(key: string): Address | undefined {
  const v = import.meta.env[key] as string | undefined
  return v && v.startsWith('0x') ? (v as Address) : undefined
}

/** Uniswap V2 factory behind the Boost router. */
export const PAIR_FACTORY: Address =
  ((import.meta.env.VITE_PAIR_FACTORY as string | undefined) &&
    (import.meta.env.VITE_PAIR_FACTORY as Address)) ||
  ('0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f' as Address)

export function steadyPairOverride(): Address | undefined {
  return railFor('USD').boostPair
}

export function cashWrapper(): Address | undefined {
  return railFor('USD').wrapper
}

export function hasBoostRouter(): boolean {
  return Boolean(BOOST_ROUTER)
}

export function hasCashRail(): boolean {
  return Boolean(CASH_TOKEN && WRAPPER_FACTORY)
}
