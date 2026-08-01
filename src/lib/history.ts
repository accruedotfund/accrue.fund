// Local balance history + cost basis (per wallet address).
// Snapshots: balance over time for charts.
// Flows: deposits / withdrawals for average cost basis and P&L.
// All client-side — no backend. Survives reloads via localStorage.
//
// Rule: cost basis = capital in − capital out. Market/Boost MTM is P&L only.
// Deposits book when balance jumps without a matching flow (Fund also calls
// recordDeposit explicitly when settlement succeeds).

export type BalancePoint = {
  t: number // ms epoch
  total: number
  available: number
  standard: number
  boost: number
}

export type Flow = {
  t: number
  kind: 'in' | 'out'
  /** USD amount of principal moved */
  amount: number
  /** optional source for UI */
  source?: 'fund' | 'inferred' | 'seed' | 'withdraw'
}

export type Ledger = {
  v: 1
  address: string
  points: BalancePoint[]
  flows: Flow[]
  /** Running principal (deposits − withdrawals attributed at average cost) */
  costBasis: number
}

const MAX_POINTS = 2_000
const MAX_FLOWS = 500
/** Min ms between stored snapshots (avoid spam on 15s poll). */
const MIN_SNAP_GAP_MS = 60_000
/** Always snap if balance moves more than this (USD). */
const SNAP_EPS = 0.02
/** Ignore dust when inferring deposits (Boost mark noise). */
const INFER_MIN = 1
/** Fund min deposit — jumps at/above this are capital until proven otherwise. */
const DEPOSIT_SHAPE = 4.5

function key(address: string) {
  return `accrue.history.v1.${address.toLowerCase()}`
}

function empty(address: string): Ledger {
  return { v: 1, address: address.toLowerCase(), points: [], flows: [], costBasis: 0 }
}

export function loadLedger(address: string | undefined): Ledger | null {
  if (!address || typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(key(address))
    if (!raw) return empty(address)
    const parsed = JSON.parse(raw) as Ledger
    if (parsed?.v !== 1 || !Array.isArray(parsed.points)) return empty(address)
    return {
      ...empty(address),
      ...parsed,
      address: address.toLowerCase(),
      points: parsed.points ?? [],
      flows: parsed.flows ?? [],
      costBasis: Number(parsed.costBasis) || 0,
    }
  } catch {
    return empty(address)
  }
}

function save(ledger: Ledger) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(key(ledger.address), JSON.stringify(ledger))
  } catch {
    /* quota */
  }
}

/** True if a recent flow already accounts for this amount (±15% or $0.50). */
function flowCovers(
  ledger: Ledger,
  kind: 'in' | 'out',
  amount: number,
  withinMs: number,
  now: number,
): boolean {
  return ledger.flows.some((f) => {
    if (f.kind !== kind) return false
    if (now - f.t > withinMs) return false
    const tol = Math.max(0.5, amount * 0.15)
    return Math.abs(f.amount - amount) <= tol
  })
}

/**
 * Record a poll of account value. Throttled unless balance moved meaningfully.
 * Large unexplained upticks → deposit (capital in), not free P&L.
 */
export function recordSnapshot(
  address: string | undefined,
  snap: {
    total: number
    available: number
    standard: number
    boost: number
  },
): Ledger | null {
  if (!address) return null
  const ledger = loadLedger(address) ?? empty(address)
  const now = Date.now()
  const last = ledger.points[ledger.points.length - 1]
  const moved = !last || Math.abs(last.total - snap.total) >= SNAP_EPS
  const aged = !last || now - last.t >= MIN_SNAP_GAP_MS
  if (!moved && !aged) return ledger

  ledger.points.push({
    t: now,
    total: round2(snap.total),
    available: round2(snap.available),
    standard: round2(snap.standard),
    boost: round2(snap.boost),
  })
  if (ledger.points.length > MAX_POINTS) {
    ledger.points = ledger.points.slice(-MAX_POINTS)
  }

  // Seed cost basis on first non-zero snapshot
  if (ledger.points.length === 1 && snap.total > 0 && ledger.costBasis <= 0) {
    ledger.costBasis = round2(snap.total)
    ledger.flows.push({
      t: now,
      kind: 'in',
      amount: round2(snap.total),
      source: 'seed',
    })
  } else if (last && snap.total > last.total + INFER_MIN) {
    const delta = snap.total - last.total
    // Deposit-shaped: ≥ ~min fund, or any jump when boost didn't dominate.
    // Skip only if Fund already booked a matching flow.
    const already = flowCovers(ledger, 'in', delta, 5 * 60_000, now)
    const depositShaped = delta >= DEPOSIT_SHAPE
    // Small bumps while boosted can be MTM — only book if deposit-shaped
    // or available/standard legs drove the jump (proxy: boost delta small).
    const boostDelta = snap.boost - (last.boost ?? 0)
    const capitalLike = depositShaped || boostDelta < delta * 0.5
    if (!already && capitalLike) {
      ledger.costBasis = round2(ledger.costBasis + delta)
      ledger.flows.push({
        t: now,
        kind: 'in',
        amount: round2(delta),
        source: 'inferred',
      })
    }
  } else if (last && snap.total < last.total - INFER_MIN && ledger.costBasis > 0) {
    const delta = last.total - snap.total
    const already = flowCovers(ledger, 'out', delta, 5 * 60_000, now)
    if (!already) {
      const ratio = last.total > 0 ? Math.min(1, delta / last.total) : 1
      const basisOut = ledger.costBasis * ratio
      ledger.costBasis = round2(Math.max(0, ledger.costBasis - basisOut))
      ledger.flows.push({
        t: now,
        kind: 'out',
        amount: round2(delta),
        source: 'inferred',
      })
    }
  }

  if (ledger.flows.length > MAX_FLOWS) {
    ledger.flows = ledger.flows.slice(-MAX_FLOWS)
  }

  save(ledger)
  return ledger
}

/** Explicit deposit (Fund success). Adds full amount to cost basis. */
export function recordDeposit(
  address: string | undefined,
  amount: number,
  source: Flow['source'] = 'fund',
) {
  if (!address || !(amount > 0)) return
  const ledger = loadLedger(address) ?? empty(address)
  const now = Date.now()
  // Dedupe: Fund settle + poll may both fire for same dollars
  if (flowCovers(ledger, 'in', amount, 5 * 60_000, now)) {
    save(ledger)
    return
  }
  ledger.costBasis = round2(ledger.costBasis + amount)
  ledger.flows.push({ t: now, kind: 'in', amount: round2(amount), source })
  if (ledger.flows.length > MAX_FLOWS) {
    ledger.flows = ledger.flows.slice(-MAX_FLOWS)
  }
  save(ledger)
}

/** Explicit cash-out. Reduces cost basis pro-rata to current total if known. */
export function recordWithdraw(
  address: string | undefined,
  amount: number,
  currentTotal?: number,
) {
  if (!address || !(amount > 0)) return
  const ledger = loadLedger(address) ?? empty(address)
  const now = Date.now()
  if (flowCovers(ledger, 'out', amount, 5 * 60_000, now)) {
    save(ledger)
    return
  }
  const total =
    currentTotal ??
    ledger.points[ledger.points.length - 1]?.total ??
    ledger.costBasis
  if (total > 0 && ledger.costBasis > 0) {
    const ratio = Math.min(1, amount / total)
    ledger.costBasis = round2(Math.max(0, ledger.costBasis * (1 - ratio)))
  } else {
    ledger.costBasis = round2(Math.max(0, ledger.costBasis - amount))
  }
  ledger.flows.push({
    t: now,
    kind: 'out',
    amount: round2(amount),
    source: 'withdraw',
  })
  if (ledger.flows.length > MAX_FLOWS) {
    ledger.flows = ledger.flows.slice(-MAX_FLOWS)
  }
  save(ledger)
}

/** Recent capital flows for Home activity strip. */
export function recentFlows(
  address: string | undefined,
  limit = 5,
): Flow[] {
  const ledger = loadLedger(address)
  if (!ledger) return []
  return [...ledger.flows].sort((a, b) => b.t - a.t).slice(0, limit)
}

export type HistoryStats = {
  costBasis: number
  /** Current total − cost basis */
  pnl: number
  pnlPct: number
  /** First → last total change over window */
  windowChange: number
  windowChangePct: number
  /** Simple time-weighted: average balance over points (for display) */
  avgBalance: number
  points: BalancePoint[]
  hasHistory: boolean
  recent: Flow[]
}

export function statsFor(
  address: string | undefined,
  currentTotal: number,
  windowMs: number = 7 * 24 * 60 * 60 * 1000,
): HistoryStats {
  const ledger = loadLedger(address)
  const now = Date.now()
  const points = (ledger?.points ?? []).filter((p) => p.t >= now - windowMs)
  const series =
    points.length > 0
      ? [
          ...points,
          {
            t: now,
            total: currentTotal,
            available: 0,
            standard: 0,
            boost: 0,
          },
        ]
      : currentTotal > 0
        ? [
            {
              t: now,
              total: currentTotal,
              available: 0,
              standard: 0,
              boost: 0,
            },
          ]
        : []

  const costBasis = ledger?.costBasis ?? (currentTotal > 0 ? currentTotal : 0)
  const pnl = currentTotal - costBasis
  const pnlPct = costBasis > 0 ? (pnl / costBasis) * 100 : 0

  const first = series[0]?.total ?? currentTotal
  const windowChange = currentTotal - first
  const windowChangePct = first > 0 ? (windowChange / first) * 100 : 0

  const avgBalance =
    series.length > 0
      ? series.reduce((s, p) => s + p.total, 0) / series.length
      : currentTotal

  return {
    costBasis: round2(costBasis),
    pnl: round2(pnl),
    pnlPct: round2(pnlPct),
    windowChange: round2(windowChange),
    windowChangePct: round2(windowChangePct),
    avgBalance: round2(avgBalance),
    points: series,
    hasHistory: (ledger?.points.length ?? 0) > 1,
    recent: recentFlows(address, 5),
  }
}

function round2(n: number) {
  return Math.round(n * 100) / 100
}
