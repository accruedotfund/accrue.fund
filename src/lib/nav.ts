// NAV + balance reads. NAV comes from the wrapper's convertToAssets() and is
// clamped monotonic on display: the wrapper's economics only ratchet up, so a
// lower read is always RPC noise (stale node) — never render a down-tick.

import { formatUnits, type Address } from 'viem'
import { RAILS, isOpen, isLive, type Rail } from './rails'
import {
  fetchBoostPositions,
  type BoostPosition,
} from './boost'
import { publicClient } from './vault'

const erc20Abi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'a', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const

const wrapperAbi = [
  {
    type: 'function',
    name: 'convertToAssets',
    stateMutability: 'view',
    inputs: [{ name: 'shares', type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'a', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const

const lastNav = new Map<string, number>()

export interface Holding {
  rail: Rail
  /** total account value: available + standard + all Boost marks */
  balance: number
  /** unwrapped underlying sitting in the user's wallet */
  availableBalance: number
  /** assets represented by wrapper shares */
  standardBalance: number
  /** sum of Boost mark values (Steady + Growth) */
  boostBalance: number
  /** open Boost positions for this cash rail */
  boosts: BoostPosition[]
  /** current NAV per share, ≥ 1 by construction */
  nav: number
  boosted: boolean
  assetUnits: bigint
  shareUnits: bigint
  boostUnits: bigint
}

function monotonic(key: string, nav: number): number {
  const prev = lastNav.get(key) ?? 1
  const clamped = Math.max(prev, nav)
  lastNav.set(key, clamped)
  return clamped
}

export async function fetchHoldings(
  owner: Address | undefined,
): Promise<Holding[]> {
  if (!owner) throw new Error('Embedded wallet is not ready')

  // Open rails (USD) always appear — even before wUSDG is created.
  const open = RAILS.filter(isOpen)
  if (open.length === 0) return []

  let boosts: BoostPosition[] = []
  try {
    boosts = await fetchBoostPositions(owner)
  } catch {
    boosts = []
  }
  const boostMark = boosts.reduce((s, p) => s + p.markValue, 0)
  const boostUnits = boosts.reduce((s, p) => s + p.lpUnits, 0n)

  const out: Holding[] = []
  for (const rail of open) {
    const railBoosts = rail.code === 'USD' ? boosts : []
    const railBoostMark = rail.code === 'USD' ? boostMark : 0
    const railBoostUnits = rail.code === 'USD' ? boostUnits : 0n

    // Available USDG (or other stable) always readable.
    const available = await publicClient.readContract({
      address: rail.stable!,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [owner],
    })
    const availableBalance = Number(formatUnits(available, rail.decimals))

    if (!isLive(rail)) {
      // Dollar account open; standard vault not online yet.
      out.push({
        rail,
        balance: availableBalance + railBoostMark,
        availableBalance,
        standardBalance: 0,
        boostBalance: railBoostMark,
        boosts: railBoosts,
        nav: 1,
        boosted: railBoostUnits > 0n,
        assetUnits: available,
        shareUnits: 0n,
        boostUnits: railBoostUnits,
      })
      continue
    }

    const one = 10n ** BigInt(rail.decimals)
    const [assets, shares] = await Promise.all([
      publicClient.readContract({
        address: rail.wrapper!,
        abi: wrapperAbi,
        functionName: 'convertToAssets',
        args: [one],
      }),
      publicClient.readContract({
        address: rail.wrapper!,
        abi: wrapperAbi,
        functionName: 'balanceOf',
        args: [owner],
      }),
    ])
    const nav = monotonic(rail.code, Number(formatUnits(assets, rail.decimals)))
    const standardBalance = Number(formatUnits(shares, rail.decimals)) * nav

    out.push({
      rail,
      balance: availableBalance + standardBalance + railBoostMark,
      availableBalance,
      standardBalance,
      boostBalance: railBoostMark,
      boosts: railBoosts,
      nav,
      boosted: railBoostUnits > 0n,
      assetUnits: available,
      shareUnits: shares,
      boostUnits: railBoostUnits,
    })
  }
  return out
}
