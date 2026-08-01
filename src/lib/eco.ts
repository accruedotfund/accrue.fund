// Ecosystem-wide stats (on-chain, RH). Home shows these next to personal ledger.
// Fiat language only — no chain jargon in UI labels (see rails.ts).

import { formatUnits, type Address } from 'viem'
import { publicClient } from './vault'
import { RAILS, USD_STABLE, isLive } from './rails'

const erc20Abi = [
  {
    type: 'function',
    name: 'totalSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const

const wrapperAbi = [
  {
    type: 'function',
    name: 'totalAssets',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
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
    name: 'convertToAssets',
    stateMutability: 'view',
    inputs: [{ name: 'shares', type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
] as const

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
] as const

export type EcoStats = {
  /** Circulating USDG (stable total supply) */
  dollarSupply: number
  /** Assets locked in standard growth (wrapper) */
  standardTvl: number
  /** Cash-side reserve in the primary boost pool (if configured) */
  boostCashTvl: number
  /** dollarSupply + standard is double-count risk — prefer reported "in product" */
  inProduct: number
  updatedAt: number
}

/**
 * Read protocol-wide dollar stats from RH.
 * Failures return zeros so Home never hard-crashes.
 */
export async function fetchEcoStats(): Promise<EcoStats> {
  const usd = RAILS.find((r) => r.code === 'USD')
  const decimals = usd?.decimals ?? 6
  const empty: EcoStats = {
    dollarSupply: 0,
    standardTvl: 0,
    boostCashTvl: 0,
    inProduct: 0,
    updatedAt: Date.now(),
  }
  if (!USD_STABLE) return empty

  try {
    const supplyRaw = await publicClient.readContract({
      address: USD_STABLE,
      abi: erc20Abi,
      functionName: 'totalSupply',
    })
    const dollarSupply = Number(formatUnits(supplyRaw, decimals))

    let standardTvl = 0
    if (usd && isLive(usd) && usd.wrapper) {
      try {
        const assets = await publicClient.readContract({
          address: usd.wrapper,
          abi: wrapperAbi,
          functionName: 'totalAssets',
        })
        standardTvl = Number(formatUnits(assets, decimals))
      } catch {
        // Fallback: shares * convertToAssets(1 share unit)
        try {
          const one = 10n ** BigInt(decimals)
          const [shares, per] = await Promise.all([
            publicClient.readContract({
              address: usd.wrapper!,
              abi: wrapperAbi,
              functionName: 'totalSupply',
            }),
            publicClient.readContract({
              address: usd.wrapper!,
              abi: wrapperAbi,
              functionName: 'convertToAssets',
              args: [one],
            }),
          ])
          const nav = Number(formatUnits(per, decimals))
          const shareCount = Number(formatUnits(shares, decimals))
          standardTvl = shareCount * nav
        } catch {
          standardTvl = 0
        }
      }
    }

    let boostCashTvl = 0
    if (usd?.boostPair) {
      try {
        const pair = usd.boostPair as Address
        const [token0, reserves] = await Promise.all([
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
        ])
        const cashIs0 =
          token0.toLowerCase() === USD_STABLE.toLowerCase() ||
          (usd.wrapper && token0.toLowerCase() === usd.wrapper.toLowerCase())
        const cashReserve = cashIs0 ? reserves[0] : reserves[1]
        boostCashTvl = Number(formatUnits(cashReserve, decimals))
      } catch {
        boostCashTvl = 0
      }
    }

    // Avoid double-counting wrapper assets that are already USDG-denominated:
    // in-product ≈ free circulating USDG is wrong; report supply + pools as:
    //   "dollars in Accrue rails" ≈ standard vault assets + boost cash leg
    //   plus note circulating stable separately.
    const inProduct = standardTvl + boostCashTvl

    return {
      dollarSupply: round2(dollarSupply),
      standardTvl: round2(standardTvl),
      boostCashTvl: round2(boostCashTvl),
      inProduct: round2(inProduct > 0 ? inProduct : dollarSupply),
      updatedAt: Date.now(),
    }
  } catch {
    return empty
  }
}

function round2(n: number) {
  return Math.round(n * 100) / 100
}
