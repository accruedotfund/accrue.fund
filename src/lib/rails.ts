// The ONLY file that knows the app runs on chain rails. Everything above this
// layer speaks fiat: currencies, balances, growth. Keep it that way — the
// product surface must contain zero chain vocabulary (see README compliance
// notes; chain disclosure lives in Legal only).
//
// Production MVP = USD only. EUR / GBP / XAU stay visible as "coming soon"
// until Robinhood lists those underlyings and we deploy wrappers.

import type { Address } from 'viem'

export type CurrencyCode = 'USD' | 'EUR' | 'GBP' | 'XAU'

export type RailStatus = 'live' | 'coming_soon'

export interface Rail {
  code: CurrencyCode
  /** user-facing name — fiat language only */
  label: string
  /** Intl currency code for formatting ('XAU' formatted manually as oz) */
  intl: string
  glyph: string
  status: RailStatus
  stable?: Address
  wrapper?: Address
  /** v2 stable/wrapper LP token used by Boost */
  boostPair?: Address
  decimals: number
}

const env = import.meta.env

const addr = (v: string | undefined): Address | undefined =>
  v && v.startsWith('0x') ? (v as Address) : undefined

const decimals = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 255
    ? parsed
    : fallback
}

/** Official Robinhood USDG. */
export const USD_STABLE: Address | undefined =
  addr(env.VITE_USD_STABLE) ??
  ('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address)

export const WRAPPER_FACTORY: Address | undefined =
  addr(env.VITE_WRAPPER_FACTORY) ??
  ('0xa9d906b8e0FFb15fdff5Efb50eEee34F1165bB03' as Address)

/** Mutable runtime rail table — wrapper may be filled after on-chain create. */
export const RAILS: Rail[] = [
  {
    code: 'USD',
    label: 'US Dollar',
    intl: 'USD',
    glyph: '$',
    status: 'live',
    stable: USD_STABLE,
    wrapper: addr(env.VITE_USD_WRAPPER),
    boostPair: addr(env.VITE_USD_BOOST_PAIR),
    decimals: decimals(env.VITE_USD_DECIMALS, 6),
  },
  {
    code: 'EUR',
    label: 'Euro',
    intl: 'EUR',
    glyph: '€',
    status: 'coming_soon',
    stable: addr(env.VITE_EUR_STABLE),
    wrapper: addr(env.VITE_EUR_WRAPPER),
    boostPair: addr(env.VITE_EUR_BOOST_PAIR),
    decimals: decimals(env.VITE_EUR_DECIMALS, 6),
  },
  {
    code: 'GBP',
    label: 'British Pound',
    intl: 'GBP',
    glyph: '£',
    status: 'coming_soon',
    stable: addr(env.VITE_GBP_STABLE),
    wrapper: addr(env.VITE_GBP_WRAPPER),
    boostPair: addr(env.VITE_GBP_BOOST_PAIR),
    decimals: decimals(env.VITE_GBP_DECIMALS, 6),
  },
  {
    code: 'XAU',
    label: 'Gold',
    intl: 'XAU',
    glyph: '◉',
    status: 'coming_soon',
    stable: addr(env.VITE_XAU_STABLE),
    wrapper: addr(env.VITE_XAU_WRAPPER),
    boostPair: addr(env.VITE_XAU_BOOST_PAIR),
    decimals: decimals(env.VITE_XAU_DECIMALS, 18),
  },
]

export const railFor = (code: CurrencyCode): Rail =>
  RAILS.find((r) => r.code === code)!

/** Product is open (USD today) — can fund even before wrapper exists. */
export const isOpen = (r: Rail): boolean =>
  r.status === 'live' && Boolean(r.stable)

/** Fully configured for standard wrap + boost (needs wrapper address). */
export const isLive = (r: Rail): boolean =>
  isOpen(r) && Boolean(r.wrapper)

export const isBoostLive = (r: Rail): boolean =>
  Boolean(r.stable && r.wrapper && r.boostPair && BOOST_ROUTER)

export function setRailWrapper(code: CurrencyCode, wrapper: Address) {
  const rail = railFor(code)
  rail.wrapper = wrapper
  rail.status = 'live'
}

/**
 * Robinhood Chain (4663) HTTP RPCs.
 * Chainlist only lists the official endpoint (often CF-challenged). PublicNode
 * + Blockscout eth-rpc are free public fallbacks that answer eth_chainId=0x1237.
 * Prefers VITE_RH_RPC when set (Alchemy/DRPC key, etc.), then public endpoints.
 */
const PUBLIC_RH_RPCS = [
  'https://robinhood-rpc.publicnode.com',
  'https://robinhoodchain.blockscout.com/api/eth-rpc',
  'https://rpc.mainnet.chain.robinhood.com',
] as const

function parseRpcList(raw: string | undefined): string[] {
  if (!raw?.trim()) return []
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => /^https:\/\//.test(s))
}

export const RH_RPC_URLS: string[] = (() => {
  const preferred = [
    ...parseRpcList(env.VITE_RH_RPC as string | undefined),
    ...parseRpcList(env.VITE_RH_RPCS as string | undefined),
  ]
  const seen = new Set<string>()
  const out: string[] = []
  for (const url of [...preferred, ...PUBLIC_RH_RPCS]) {
    const key = url.replace(/\/$/, '')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(url)
  }
  return out
})()

/** Primary URL (first in the fallback list). Prefer RH_RPC_URLS + fallback transport. */
export const RPC_URL: string = RH_RPC_URLS[0]!
export const CHAIN_ID = 4663

/**
 * Backend that issues bank cashout sessions.
 * Set to the Accrue API origin (https://accrue.fund or your deploy).
 * When empty, withdrawals use the on-device Relay bridge (USDG → Base USDC).
 */
export const API_BASE: string = (env.VITE_API_BASE as string | undefined) ?? ''

export const BOOST_ROUTER = addr(env.VITE_BOOST_ROUTER)

/** Conservative floor shared by the enabled regulated funding providers. */
export const MIN_DEPOSIT = 5

export function formatMoney(code: CurrencyCode, amount: number): string {
  if (code === 'XAU') {
    return `${amount.toFixed(4)} oz`
  }
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: code,
  }).format(amount)
}
