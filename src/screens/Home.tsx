import { useMemo } from 'react'
import type { Holding } from '../lib/nav'
import { RAILS, formatMoney, type CurrencyCode } from '../lib/rails'

// Monitor surface: total first (biggest thing, top-left), then a dense
// ledger of accounts. Rows, not cards; nothing centered.

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
  const funded = useMemo(
    () => (holdings ?? []).filter((h) => h.balance > 0),
    [holdings],
  )
  const usdOnly = funded.find((holding) => holding.rail.code === 'USD')?.balance

  return (
    <div className="screen">
      <header style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <h2>US Dollar account</h2>
        {holdings === null ? (
          <div className="skeleton" style={{ height: 48, width: '70%' }} />
        ) : (
          <p className="display">
            {usdOnly === undefined ? '—' : formatMoney('USD', usdOnly)}
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
              const soon = rail.status === 'coming_soon' || !h
              return (
                <button
                  key={rail.code}
                  className="row"
                  disabled={soon}
                  onClick={() => {
                    if (!soon) onAccount(rail.code)
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
                        : h!.boosted
                          ? h!.boosts.some((b) => b.tier === 'growth')
                            ? 'Growth Boost on · can fall hard'
                            : 'Steady Boost on · can still move'
                          : `standard value per unit ${h!.nav.toFixed(6)}`}
                    </span>
                  </span>
                  {soon ? (
                    <span className="badge">Soon</span>
                  ) : (
                    <>
                      {h!.boosted && <span className="badge boost">Boost</span>}
                      <span className="figure" style={{ fontSize: '1.05rem' }}>
                        {h!.balance > 0
                          ? formatMoney(rail.code, h!.balance)
                          : '—'}
                      </span>
                    </>
                  )}
                </button>
              )
            })}
          </div>
        )}

        {holdings !== null && funded.length === 0 && (
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
