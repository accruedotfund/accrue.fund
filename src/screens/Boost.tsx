import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../lib/auth'
import {
  enterBoost,
  exitBoost,
  resolveGrowthPool,
  resolveSteadyPool,
  type BoostPosition,
} from '../lib/boost'
import type { Holding } from '../lib/nav'
import { formatMoney } from '../lib/rails'
import { STRATEGIES, type BoostStrategy, type BoostTier } from '../lib/strategies'

// Operate surface: two risk tiers. User never picks stocks or stables —
// Steady is dollar-linked; Growth is equity-linked (engine picks the pool).

export default function Boost({
  holdings,
  onRefresh,
}: {
  holdings: Holding[] | null
  onRefresh: () => Promise<void>
}) {
  const { address, walletReady, sendTransaction } = useAuth()
  const [confirming, setConfirming] = useState<BoostStrategy | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [steadyOpen, setSteadyOpen] = useState<boolean | null>(null)
  const [growthOpen, setGrowthOpen] = useState<boolean | null>(null)

  const usd = holdings?.find((h) => h.rail.code === 'USD')
  const canEnter =
    (usd?.standardBalance ?? 0) > 0 || (usd?.availableBalance ?? 0) > 0
  const positions = usd?.boosts ?? []

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [s, g] = await Promise.all([
          resolveSteadyPool(),
          resolveGrowthPool(),
        ])
        if (cancelled) return
        setSteadyOpen(Boolean(s))
        setGrowthOpen(Boolean(g))
      } catch {
        if (!cancelled) {
          setSteadyOpen(false)
          setGrowthOpen(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [holdings])

  function positionFor(tier: BoostTier): BoostPosition | undefined {
    return positions.find((p) => p.tier === tier)
  }

  async function change(strategy: BoostStrategy, on: boolean) {
    if (!address || !walletReady) {
      setError('Your account is not ready yet.')
      return
    }
    setConfirming(null)
    setBusyId(strategy.id)
    setStatus('Preparing…')
    setError(null)
    try {
      if (on) {
        await enterBoost(strategy.tier, address, sendTransaction, setStatus)
      } else {
        await exitBoost(strategy.tier, address, sendTransaction, setStatus)
      }
      setStatus('Updating your balance…')
      await onRefresh()
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Boost did not change. Your existing balance is untouched.',
      )
    } finally {
      setBusyId(null)
      setStatus(null)
    }
  }

  return (
    <div className="screen">
      <header>
        <h1>Boost</h1>
        <p className="muted" style={{ maxWidth: '36ch', marginTop: 6 }}>
          Choose how hard your dollar balance works. You pick a risk level —
          not a market, token, or pool.
        </p>
      </header>

      {holdings === null ? (
        <div className="skeleton" style={{ height: 140 }} />
      ) : !usd ? (
        <div className="empty">
          <p className="figure" style={{ fontSize: '1.3rem' }}>
            Dollar account not open
          </p>
          <p className="small">Add money first, then Boost becomes available.</p>
        </div>
      ) : (
        <div className="strategy-list">
          {STRATEGIES.map((strategy) => {
            const pos = positionFor(strategy.tier)
            const open =
              strategy.tier === 'steady' ? steadyOpen : growthOpen
            const busy = busyId === strategy.id
            const active = Boolean(pos && pos.lpUnits > 0n)
            return (
              <article
                key={strategy.id}
                className={`strategy-card${active ? ' strategy-card-on' : ''}`}
              >
                <div className="strategy-top">
                  <div>
                    <h2 className="strategy-title">{strategy.title}</h2>
                    <p className="small muted" style={{ marginTop: 4 }}>
                      {strategy.subtitle}
                    </p>
                  </div>
                  <RiskPips level={strategy.riskLevel} />
                </div>

                {active && pos && (
                  <p className="figure" style={{ fontSize: '1.35rem' }}>
                    {formatMoney('USD', pos.markValue)}
                    <span className="small muted" style={{ marginLeft: 8 }}>
                      boosted
                    </span>
                  </p>
                )}

                {!active && open === false && (
                  <p className="small muted">Opening soon</p>
                )}

                {!active && open === null && (
                  <div className="skeleton" style={{ height: 16, width: '40%' }} />
                )}

                <button
                  className={active ? 'btn btn-quiet' : 'btn btn-primary'}
                  disabled={
                    busy ||
                    open === false ||
                    open === null ||
                    (!active && !canEnter)
                  }
                  onClick={() =>
                    active
                      ? void change(strategy, false)
                      : setConfirming(strategy)
                  }
                >
                  {busy
                    ? status || 'One moment…'
                    : active
                      ? 'Turn off'
                      : open === false
                        ? 'Not open yet'
                        : 'Turn on'}
                </button>
              </article>
            )
          })}
        </div>
      )}

      {usd && !canEnter && positions.length === 0 && (
        <p className="small muted">
          Move money into your standard dollar account, then turn Boost on.
        </p>
      )}

      {error && (
        <div className="notice" role="alert">
          {error}
        </div>
      )}

      <div className="notice">
        <strong>Standard</strong> is designed so value per unit only rises.
        <br />
        <strong>Steady</strong> stays dollar-linked but can still move a little.
        <br />
        <strong>Growth</strong> can fall hard when markets move — higher upside,
        higher risk.
      </div>

      {confirming && (
        <ConfirmSheet
          strategy={confirming}
          amount={usd?.standardBalance ?? 0}
          onClose={() => setConfirming(null)}
          onConfirm={() => change(confirming, true)}
        />
      )}
    </div>
  )
}

function RiskPips({ level }: { level: 1 | 2 | 3 }) {
  return (
    <div className="risk-pips" aria-label={`Risk level ${level} of 3`}>
      {[1, 2, 3].map((i) => (
        <span
          key={i}
          className={i <= level ? 'risk-pip on' : 'risk-pip'}
          aria-hidden
        />
      ))}
    </div>
  )
}

function ConfirmSheet({
  strategy,
  amount,
  onClose,
  onConfirm,
}: {
  strategy: BoostStrategy
  amount: number
  onClose: () => void
  onConfirm: () => Promise<void>
}) {
  const [checked, setChecked] = useState(false)
  const [holdingButton, setHoldingButton] = useState(false)
  const timer = useRef<number>()

  const start = () => {
    if (!checked || holdingButton) return
    setHoldingButton(true)
    timer.current = window.setTimeout(() => {
      setHoldingButton(false)
      void onConfirm()
    }, 900)
  }
  const cancel = () => {
    setHoldingButton(false)
    window.clearTimeout(timer.current)
  }

  useEffect(() => () => window.clearTimeout(timer.current), [])

  return (
    <div className="sheet-veil" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={`Confirm ${strategy.title}`}
        onClick={(event) => event.stopPropagation()}
      >
        <h1>Turn on {strategy.title}?</h1>
        <p className="muted">
          {amount > 0
            ? `${formatMoney('USD', amount)} from your standard account will work harder.`
            : 'Your available dollar balance will work harder.'}{' '}
          {strategy.riskCopy}
        </p>
        <label className="check">
          <input
            type="checkbox"
            checked={checked}
            onChange={(event) => setChecked(event.target.checked)}
          />
          <span className="small">
            I understand this is not my standard account, and I can get back
            less than I put in
            {strategy.tier === 'growth' ? ' — including large losses' : ''}.
          </span>
        </label>
        <button
          className={`btn btn-primary hold-btn${holdingButton ? ' holding' : ''}`}
          disabled={!checked}
          onPointerDown={start}
          onPointerUp={cancel}
          onPointerLeave={cancel}
          onKeyDown={(event) => {
            if ((event.key === 'Enter' || event.key === ' ') && !event.repeat) {
              event.preventDefault()
              start()
            }
          }}
          onKeyUp={(event) => {
            if (event.key === 'Enter' || event.key === ' ') cancel()
          }}
        >
          <div className="fill" aria-hidden />
          <span>{holdingButton ? 'Keep holding…' : 'Hold to confirm'}</span>
        </button>
        <button className="btn btn-quiet" onClick={onClose}>
          Not now
        </button>
      </div>
    </div>
  )
}
