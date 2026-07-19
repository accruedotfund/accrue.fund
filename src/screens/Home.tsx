import { useMemo, useState } from 'react'
import BalanceChart from '../components/BalanceChart'
import { statsFor, type HistoryStats } from '../lib/history'
import type { Holding } from '../lib/nav'
import { RAILS, formatMoney, type CurrencyCode } from '../lib/rails'
import { useAuth } from '../lib/auth'

// Monitor surface: total, chart (balance vs cost basis), ledger.

type WindowKey = '1d' | '7d' | '30d' | 'all'

const WINDOWS: { id: WindowKey; label: string; ms: number }[] = [
  { id: '1d', label: '1D', ms: 24 * 60 * 60 * 1000 },
  { id: '7d', label: '7D', ms: 7 * 24 * 60 * 60 * 1000 },
  { id: '30d', label: '30D', ms: 30 * 24 * 60 * 60 * 1000 },
  { id: 'all', label: 'All', ms: 10 * 365 * 24 * 60 * 60 * 1000 },
]

export default function Home({
  holdings,
  loadError,
  onRetry,
  onFund,
  onAccount,
}: {
  holdings: Holding[] | null
  loadError: boolean
  onRetry: () => void
  onFund: () => void
  onAccount: (code: CurrencyCode) => void
}) {
  const { address } = useAuth()
  const [win, setWin] = useState<WindowKey>('7d')

  const funded = useMemo(
    () => (holdings ?? []).filter((h) => h.balance > 0),
    [holdings],
  )
  const usdHolding = useMemo(
    () => (holdings ?? []).find((h) => h.rail.code === 'USD'),
    [holdings],
  )

  const total = usdHolding?.balance ?? 0
  const windowMs = WINDOWS.find((w) => w.id === win)!.ms

  const stats: HistoryStats = useMemo(
    () => statsFor(address, total, windowMs),
    // recompute when holdings tick (address+total) or window changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [address, total, windowMs, holdings],
  )

  const pnlUp = stats.pnl >= 0
  const winUp = stats.windowChange >= 0

  return (
    <div className="screen">
      <header style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <h2>US Dollar account</h2>
        {holdings === null ? (
          <div className="skeleton" style={{ height: 48, width: '70%' }} />
        ) : (
          <p className="display">
            {formatMoney('USD', total)}
          </p>
        )}
        <p className="small muted">
          {funded.length || 'No'} funded account
          {funded.length === 1 ? '' : 's'} · euro, pound, and gold are tabled
          for now
        </p>
      </header>

      {loadError && (
        <div className="notice" role="alert">
          Couldn’t refresh your balances.{' '}
          <button
            className="btn btn-quiet"
            style={{ width: 'auto', padding: '6px 12px', marginLeft: 8 }}
            onClick={onRetry}
          >
            Retry
          </button>
        </div>
      )}

      {holdings !== null && (
        <section className="chart-card" aria-label="Balance over time">
          <div className="chart-tabs" role="tablist" aria-label="Time range">
            {WINDOWS.map((w) => (
              <button
                key={w.id}
                type="button"
                role="tab"
                aria-selected={win === w.id}
                className={win === w.id ? 'chart-tab on' : 'chart-tab'}
                onClick={() => setWin(w.id)}
              >
                {w.label}
              </button>
            ))}
          </div>

          <BalanceChart
            points={stats.points}
            costBasis={stats.costBasis > 0 ? stats.costBasis : undefined}
          />

          <div className="stat-grid">
            <div className="stat">
              <div className="stat-k">Cost basis</div>
              <div className="stat-v figure">
                {formatMoney('USD', stats.costBasis)}
              </div>
            </div>
            <div className="stat">
              <div className="stat-k">P&amp;L</div>
              <div
                className="stat-v figure"
                style={{ color: pnlUp ? 'var(--up)' : 'var(--down)' }}
              >
                {pnlUp ? '+' : ''}
                {formatMoney('USD', stats.pnl)}
                <span className="small muted" style={{ marginLeft: 6 }}>
                  {pnlUp ? '+' : ''}
                  {stats.pnlPct.toFixed(1)}%
                </span>
              </div>
            </div>
            <div className="stat">
              <div className="stat-k">
                {win === 'all' ? 'Since start' : `Change · ${win.toUpperCase()}`}
              </div>
              <div
                className="stat-v figure"
                style={{ color: winUp ? 'var(--up)' : 'var(--down)' }}
              >
                {winUp ? '+' : ''}
                {formatMoney('USD', stats.windowChange)}
                <span className="small muted" style={{ marginLeft: 6 }}>
                  {winUp ? '+' : ''}
                  {stats.windowChangePct.toFixed(1)}%
                </span>
              </div>
            </div>
            <div className="stat">
              <div className="stat-k">Avg balance</div>
              <div className="stat-v figure">
                {formatMoney('USD', stats.avgBalance)}
              </div>
            </div>
          </div>
          <p className="small muted" style={{ marginTop: 8 }}>
            Cost basis is average capital in (deposits minus cash-outs). Chart
            builds as you use the app — stored on this device.
          </p>
        </section>
      )}

      <section>
        <h2 style={{ marginBottom: 8 }}>Accounts</h2>
        {holdings === null ? (
          <div className="ledger">
            {[0, 1, 2].map((i) => (
              <div key={i} className="row" style={{ cursor: 'default' }}>
                <div className="skeleton" style={{ height: 20, width: '100%' }} />
              </div>
            ))}
          </div>
        ) : (
          <div className="ledger">
            {RAILS.map((rail) => {
              const h = holdings.find((x) => x.rail.code === rail.code)
              const soon = rail.status === 'coming_soon'
              const open = !soon
              return (
                <button
                  key={rail.code}
                  className="row"
                  disabled={soon}
                  onClick={() => {
                    if (open && h) onAccount(rail.code)
                    else if (open) onFund()
                  }}
                >
                  <span
                    className="figure"
                    aria-hidden
                    style={{
                      fontSize: '1.25rem',
                      width: 28,
                      textAlign: 'center',
                    }}
                  >
                    {rail.glyph}
                  </span>
                  <span className="grow">
                    <span style={{ display: 'block', fontWeight: 600 }}>
                      {rail.label}
                    </span>
                    <span className="small muted">
                      {soon
                        ? 'Coming soon'
                        : !h
                          ? 'Open · add money to get started'
                          : h.boosted
                            ? h.boosts.some((b) => b.tier === 'growth')
                              ? 'Growth Boost on · can fall hard'
                              : 'Steady Boost on · can still move'
                            : h.standardBalance > 0
                              ? `standard value per unit ${h.nav.toFixed(6)}`
                              : h.availableBalance > 0
                                ? 'Available · ready to grow'
                                : 'Open · add money to get started'}
                    </span>
                  </span>
                  {soon ? (
                    <span className="badge">Soon</span>
                  ) : (
                    <>
                      {h?.boosted && <span className="badge boost">Boost</span>}
                      <span className="figure" style={{ fontSize: '1.05rem' }}>
                        {h && h.balance > 0
                          ? formatMoney(rail.code, h.balance)
                          : formatMoney(rail.code, 0)}
                      </span>
                    </>
                  )}
                </button>
              )
            })}
          </div>
        )}

        {holdings !== null && (
          <div style={{ marginTop: 16 }}>
            <button className="btn btn-primary" onClick={onFund}>
              Add money
            </button>
          </div>
        )}
      </section>

      <p className="small muted">
        Standard value per unit is designed to move upward. Growth is variable,
        and Boosted balances can fall.
      </p>
    </div>
  )
}
