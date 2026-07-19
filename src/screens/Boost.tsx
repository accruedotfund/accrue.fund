import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../lib/auth'
import {
  enterBoost,
  exitBoost,
  resolveGrowthPool,
  resolveSteadyPool,
  type BoostPosition,
} from '../lib/boost'
import { hasNetworkFeeReady } from '../lib/gasBridge'
import type { Holding } from '../lib/nav'
import { formatMoney } from '../lib/rails'
import { STRATEGIES, type BoostStrategy, type BoostTier } from '../lib/strategies'

// Operate surface: two risk tiers. User never picks stocks or stables —
// Steady is dollar-linked; Growth is equity-linked (engine picks the pool).

/** Only real fee / gas shortages — never bare “Robinhood” (swap reverts include that). */
function isGasError(msg: string): boolean {
  if (/GAS_TOPUP_NEEDED:/.test(msg)) return true
  if (
    /Base ETH|ETH on Base|Accrue address|top-up|top up|network fees? needed|sponsor network/i.test(
      msg,
    )
  ) {
    return true
  }
  // Intrinsic gas / empty wallet — not generic “execution reverted”
  if (
    /insufficient funds for gas|insufficient funds for transfer|gas required exceeds|intrinsic gas too low/i.test(
      msg,
    )
  ) {
    return true
  }
  return false
}

function humanBoostError(raw: string): string {
  if (/INSUFFICIENT_[AB]_AMOUNT/i.test(raw)) {
    return 'Boost liquidity slipped (pool too thin or price moved). Try again or keep funds in Standard.'
  }
  if (
    /Growth|stock market|re-approve|too thin|Steady for now|Token approval/i.test(
      raw,
    )
  ) {
    // Already product copy
    return raw.replace(/^Error:\s*/i, '')
  }
  if (/execution reverted|unknown reason|Request Arguments:/i.test(raw)) {
    return 'That step failed on the network. Your dollars are still in your account — try again, or use Steady.'
  }
  return raw
}

function AddressFundCard({
  address,
  title,
  detail,
}: {
  address: string
  title?: string
  detail?: string
}) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* ignore */
    }
  }
  return (
    <div style={{ marginTop: title || detail ? 0 : 12 }}>
      {title && (
        <p style={{ margin: '0 0 8px', fontWeight: 600 }}>{title}</p>
      )}
      {detail && (
        <p className="small muted" style={{ margin: '0 0 10px' }}>
          {detail}
        </p>
      )}
      <p className="small muted" style={{ margin: '0 0 6px' }}>
        Your Accrue address — send a little <strong>ETH on Base</strong> here:
      </p>
      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <code
          className="figure"
          style={{
            fontSize: '0.85rem',
            wordBreak: 'break-all',
            flex: 1,
            minWidth: 0,
          }}
          title={address}
        >
          {address}
        </code>
        <button
          type="button"
          className="btn btn-quiet"
          style={{ width: 'auto', padding: '8px 12px', flexShrink: 0 }}
          onClick={() => void copy()}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="small muted" style={{ margin: '8px 0 0' }}>
        Network: <strong>Base</strong> · not Ethereum mainnet · not Robinhood.
        About $0.30–1 is enough. After it lands, turn Steady on again.
      </p>
    </div>
  )
}

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
  const [gasAddress, setGasAddress] = useState<string | null>(null)
  const [feeReady, setFeeReady] = useState<boolean | null>(null)
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

  // Proactive: show fund-address card before they hit Turn on and fail.
  useEffect(() => {
    if (!address || !walletReady) {
      setFeeReady(null)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const ok = await hasNetworkFeeReady(address)
        if (!cancelled) setFeeReady(ok)
      } catch {
        if (!cancelled) setFeeReady(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [address, walletReady, holdings])

  function positionFor(tier: BoostTier): BoostPosition | undefined {
    return positions.find((p) => p.tier === tier)
  }

  async function change(strategy: BoostStrategy, on: boolean) {
    if (!address || !walletReady) {
      setError('Your account is not ready yet.')
      setGasAddress(null)
      return
    }
    setConfirming(null)
    setBusyId(strategy.id)
    setStatus('Preparing…')
    setError(null)
    setGasAddress(null)
    try {
      if (on) {
        await enterBoost(strategy.tier, address, sendTransaction, setStatus)
      } else {
        await exitBoost(strategy.tier, address, sendTransaction, setStatus)
      }
      setStatus('Updating your balance…')
      await onRefresh()
      try {
        setFeeReady(await hasNetworkFeeReady(address))
      } catch {
        /* ignore */
      }
    } catch (cause) {
      const raw =
        cause instanceof Error
          ? cause.message
          : 'Boost did not change. Your existing balance is untouched.'

      const tagged = raw.match(
        /^GAS_TOPUP_NEEDED:(0x[a-fA-F0-9]{40}):([\s\S]+)$/,
      )
      let msg: string
      if (tagged) {
        msg = tagged[2]!.trim()
        setGasAddress(tagged[1]!)
        setFeeReady(false)
      } else if (isGasError(raw)) {
        msg =
          /Base ETH|ETH on Base|Accrue address|top-up|top up/i.test(raw)
            ? raw
            : 'Need a little ETH on Base for network fees (~$0.30+). Send it to the address below, then try again. Your dollars are safe.'
        setGasAddress(address)
        setFeeReady(false)
      } else {
        msg = humanBoostError(raw)
        setGasAddress(null)
      }
      setError(msg)
    } finally {
      setBusyId(null)
      setStatus(null)
    }
  }

  const showFundUpFront =
    Boolean(address) && feeReady === false && !error

  return (
    <div className="screen">
      <header>
        <h1>Boost</h1>
        <p className="muted" style={{ maxWidth: '36ch', marginTop: 6 }}>
          Choose how hard your dollar balance works. You pick a risk level —
          not a market, token, or pool.
        </p>
      </header>

      {showFundUpFront && address && (
        <div className="notice" role="status">
          <AddressFundCard
            address={address}
            title="Network fee needed first"
            detail="Steady runs on Robinhood Chain. We move a scrap of ETH from Base for fees. Fund Base once, then turn Steady on."
          />
        </div>
      )}

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
                  <p className="small muted">
                    {strategy.tier === 'steady'
                      ? 'Steady needs your dollar Standard account and network config. Open Standard / refresh, then try again.'
                      : 'Growth stock markets are still too thin on-chain. Use Steady for now — Growth opens when books deepen.'}
                  </p>
                )}
                {!active && open === true && strategy.tier === 'steady' && (
                  <p className="small muted">
                    Dollar-linked pool. Turn on to seed or join with your
                    standard balance.
                  </p>
                )}
                {!active && open === true && strategy.tier === 'growth' && (
                  <p className="small muted">
                    Buys a market-linked leg on live stock books, then pools it.
                    Needs free dollars. Higher risk.
                  </p>
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
          <p style={{ margin: 0 }}>{error}</p>
          {gasAddress && <AddressFundCard address={gasAddress} />}
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
