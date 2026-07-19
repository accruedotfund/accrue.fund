// Local balance history + cost basis (per wallet address).
// Snapshots: balance over time for charts.
// Flows: deposits / withdrawals for average cost basis and P&L.
// All client-side — no backend. Survives reloads via localStorage.

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

/**
 * Record a poll of account value. Throttled unless balance moved meaningfully.
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
  const moved =
    !last || Math.abs(last.total - snap.total) >= SNAP_EPS
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

  // Infer cost basis from balance jumps when we have no explicit flows yet.
  // Large upticks without a flow → treat as capital in (deposit / bridge).
  if (last && snap.total > last.total + 0.5) {
    const delta = snap.total - last.total
    // Only auto-credit if no flow in last 2 minutes (Fund path may record explicitly)
    const recentFlow = ledger.flows.some((f) => now - f.t < 120_000)
    if (!recentFlow) {
      ledger.costBasis = round2(ledger.costBasis + delta)
      ledger.flows.push({ t: now, kind: 'in', amount: round2(delta) })
    }
  } else if (last && snap.total < last.total - 0.5 && ledger.costBasis > 0) {
    const delta = last.total - snap.total
    const recentFlow = ledger.flows.some((f) => now - f.t < 120_000)
    if (!recentFlow) {
      // Reduce cost basis pro-rata with withdrawal of value
      const ratio = last.total > 0 ? Math.min(1, delta / last.total) : 1
      const basisOut = ledger.costBasis * ratio
      ledger.costBasis = round2(Math.max(0, ledger.costBasis - basisOut))
      ledger.flows.push({ t: now, kind: 'out', amount: round2(delta) })
    }
  }

  // Seed cost basis on first non-zero snapshot
  if (ledger.points.length === 1 && snap.total > 0 && ledger.costBasis <= 0) {
    ledger.costBasis = round2(snap.total)
    ledger.flows.push({ t: now, kind: 'in', amount: round2(snap.total) })
  }

  if (ledger.flows.length > MAX_FLOWS) {
    ledger.flows = ledger.flows.slice(-MAX_FLOWS)
  }

  save(ledger)
  return ledger
}

/** Explicit deposit (Fund success). Adds full amount to cost basis. */
export function recordDeposit(address: string | undefined, amount: number) {
  if (!address || !(amount > 0)) return
  const ledger = loadLedger(address) ?? empty(address)
  const now = Date.now()
  ledger.costBasis = round2(ledger.costBasis + amount)
  ledger.flows.push({ t: now, kind: 'in', amount: round2(amount) })
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
  ledger.flows.push({ t: now, kind: 'out', amount: round2(amount) })
  if (ledger.flows.length > MAX_FLOWS) {
    ledger.flows = ledger.flows.slice(-MAX_FLOWS)
  }
  save(ledger)
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
}

export function statsFor(
  address: string | undefined,
  currentTotal: number,
  windowMs: number = 7 * 24 * 60 * 60 * 1000,
): HistoryStats {
  const ledger = loadLedger(address)
  const now = Date.now()
  const points = (ledger?.points ?? []).filter((p) => p.t >= now - windowMs)
  // Always append current as tip for live chart
  const series =
    points.length > 0
      ? [...points, { t: now, total: currentTotal, available: 0, standard: 0, boost: 0 }]
      : currentTotal > 0
        ? [{ t: now, total: currentTotal, available: 0, standard: 0, boost: 0 }]
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
  }
}

function round2(n: number) {
  return Math.round(n * 100) / 100
}
