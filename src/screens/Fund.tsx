import { useEffect, useRef, useState } from 'react'
import { Browser } from '@capacitor/browser'
import { useFiatOnramp, useFundWallet } from '@privy-io/react-auth'
import { base } from 'viem/chains'
import { formatUnits } from 'viem'
import { useAuth } from '../lib/auth'
import {
  prepareRelayDepositRoute,
  waitForDepositSettlement,
  RELAY_ORIGIN_ASSET,
  type RelayDepositRoute,
} from '../lib/relay'
import { windDownViaRelay } from '../lib/withdraw'
import { tokenBalance } from '../lib/vault'
import type { Holding } from '../lib/nav'
import {
  API_BASE,
  MIN_DEPOSIT,
  RAILS,
  formatMoney,
  type CurrencyCode,
} from '../lib/rails'

// Settlement is always Relay both ways (no chain words in UI):
//   IN  card/bank/etc → Base USDC → Relay deposit addr → RH dollar balance
//   OUT free cash on RH → Relay → Base USDC → optional bank hop

type Direction = 'in' | 'out'
/** How the user funds the Base USDC deposit leg. */
type PayMethod = 'card' | 'coinbase' | 'moonpay' | 'choose'
/** Deposit feedback after the payment UI closes. */
type DepositOutcome =
  | null
  | { phase: 'waiting'; message: string }
  | { phase: 'settled'; receivedLabel: string }
  | { phase: 'failed'; message: string }
  | { phase: 'timeout'; message: string }

const PRESETS = [50, 200, 1000]

const PAY_METHODS: {
  id: PayMethod
  label: string
  blurb: string
}[] = [
  {
    id: 'card',
    label: 'Card or bank',
    blurb: 'Debit, credit, or bank — no Coinbase account needed.',
  },
  {
    id: 'coinbase',
    label: 'Coinbase',
    blurb: 'If you already use Coinbase (account or onramp).',
  },
  {
    id: 'moonpay',
    label: 'MoonPay',
    blurb: 'Another card partner. May not be available in every region.',
  },
  {
    id: 'choose',
    label: 'Show all options',
    blurb: 'Open the full payment menu and pick there.',
  },
]

function humanError(err: unknown, direction: Direction): string {
  const msg = err instanceof Error ? err.message : ''
  if (/minimum|too many decimals|valid amount|above zero|Not enough|available/i.test(msg)) {
    return msg
  }
  if (/not configured|not ready|session has expired|Opening your dollar/i.test(msg)) {
    return msg
  }
  if (/insufficient funds|gas required|intrinsic gas|network fee/i.test(msg)) {
    return direction === 'out'
      ? 'Cash out needs a tiny network fee on Robinhood (ETH on this address). Your dollars are untouched — add a little ETH, then try again.'
      : msg
  }
  if (/Relay|route/i.test(msg)) {
    return direction === 'in'
      ? 'We couldn’t prepare a deposit route right now. Nothing was charged — try again.'
      : 'We couldn’t prepare a cash-out route right now. Your balance is untouched — try again.'
  }
  return direction === 'in'
    ? 'We couldn’t start your deposit. Nothing was charged — try again.'
    : 'We couldn’t start your cash out. Your balance is untouched — try again.'
}

export default function Fund({
  holdings,
  onRefresh,
}: {
  holdings: Holding[] | null
  onRefresh?: () => Promise<void>
}) {
  const { email, address, getAccessToken, sendTransaction, walletReady } =
    useAuth()
  const { fundWallet } = useFundWallet()
  const { fund: fundFiat } = useFiatOnramp()
  const [direction, setDirection] = useState<Direction>('in')
  const [currency, setCurrency] = useState<CurrencyCode>('USD')
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [depositRoute, setDepositRoute] = useState<RelayDepositRoute | null>(
    null,
  )
  const [payMethod, setPayMethod] = useState<PayMethod>('card')
  const [depositOutcome, setDepositOutcome] = useState<DepositOutcome>(null)
  /** Withdraw settled to Base (Relay reverse). */
  const [withdrawSettled, setWithdrawSettled] = useState(false)
  const settleAbort = useRef<AbortController | null>(null)

  useEffect(() => {
    return () => {
      settleAbort.current?.abort()
    }
  }, [])

  const value = parseFloat(amount)
  const rail = RAILS.find((item) => item.code === currency)!
  const sourceCurrency = currency === 'XAU' ? 'USD' : currency
  const holding = holdings?.find((h) => h.rail.code === currency)
  const available = holding?.availableBalance ?? 0
  const standard = holding?.standardBalance ?? 0
  /** Cash that can leave: available + standard (we free standard on wind-down). */
  const freeCash = available + standard
  const railReady = Boolean(rail.stable) && rail.status === 'live'
  const invalid =
    !amount || isNaN(value)
      ? null
      : rail.status === 'coming_soon'
        ? 'This account isn’t open yet.'
        : direction === 'in' && !railReady
          ? 'This account isn’t open for deposits yet.'
          : direction === 'in' && value < MIN_DEPOSIT
            ? `Minimum is ${formatMoney(sourceCurrency, MIN_DEPOSIT)}.`
            : direction === 'out' && value > freeCash
              ? `You have ${formatMoney(currency, freeCash)} free to cash out.`
              : null

  function resetRoute() {
    setDepositRoute(null)
    setError(null)
  }

  function clearDepositFlow() {
    settleAbort.current?.abort()
    settleAbort.current = null
    setDone(false)
    setDepositOutcome(null)
    setWithdrawSettled(false)
    setAmount('')
    setDepositRoute(null)
    setStatus(null)
    setError(null)
  }

  /** Pay Base USDC into the Relay deposit address (Base → Relay → RH dollars). */
  async function openDepositPayment(route: RelayDepositRoute) {
    if (payMethod === 'card') {
      // Fiat onramp destinations the Relay sink — not a personal QR receive.
      await fundFiat({
        source: {
          assets: ['usd', 'eur', 'gbp'],
          defaultAsset: sourceCurrency.toLowerCase() as 'usd' | 'eur' | 'gbp',
        },
        destination: {
          address: route.depositAddress,
          chain: 'eip155:8453',
          asset: RELAY_ORIGIN_ASSET,
        },
        environment: import.meta.env.PROD ? 'production' : 'sandbox',
        defaultAmount: String(value),
      })
      return
    }
    const baseOpts = {
      chain: base,
      amount: String(value),
      asset: 'USDC' as const,
    }
    const options =
      payMethod === 'coinbase'
        ? {
            ...baseOpts,
            defaultFundingMethod: 'exchange' as const,
            card: { preferredProvider: 'coinbase' as const },
          }
        : payMethod === 'moonpay'
          ? {
              ...baseOpts,
              defaultFundingMethod: 'card' as const,
              card: { preferredProvider: 'moonpay' as const },
            }
          : baseOpts
    await fundWallet({
      address: route.depositAddress,
      options,
    })
  }

  async function watchDepositSettlement(route: RelayDepositRoute) {
    if (!address || !rail.stable) return
    settleAbort.current?.abort()
    const ac = new AbortController()
    settleAbort.current = ac

    const baseline = await tokenBalance(rail.stable, address).catch(() => 0n)
    // ~half of quoted receive or $0.50 floor — ignore dust noise
    const minBump = (() => {
      const q = Number(route.quotedReceived)
      if (Number.isFinite(q) && q > 0) {
        return BigInt(Math.max(1, Math.floor(q * 0.4 * 10 ** rail.decimals)))
      }
      return 10n ** BigInt(Math.max(0, rail.decimals - 1)) // 0.1 unit
    })()

    setDepositOutcome({
      phase: 'waiting',
      message: 'Waiting for your payment to land in your dollar account…',
    })

    const result = await waitForDepositSettlement({
      requestId: route.requestId,
      signal: ac.signal,
      progress: (msg) =>
        setDepositOutcome({ phase: 'waiting', message: msg }),
      balanceIncreased: async () => {
        const now = await tokenBalance(rail.stable!, address)
        return now >= baseline + minBump
      },
    })

    if (ac.signal.aborted) return

    if (onRefresh) await onRefresh().catch(() => {})

    if (result.kind === 'settled') {
      let receivedLabel = formatMoney(
        currency,
        Number(route.quotedReceived) || value,
      )
      try {
        const now = await tokenBalance(rail.stable, address)
        const delta = now > baseline ? now - baseline : 0n
        if (delta > 0n) {
          receivedLabel = formatMoney(
            currency,
            Number(formatUnits(delta, rail.decimals)),
          )
        }
      } catch {
        /* use quote */
      }
      setDepositOutcome({ phase: 'settled', receivedLabel })
      return
    }

    if (result.kind === 'failed') {
      setDepositOutcome({ phase: 'failed', message: result.reason })
      return
    }

    // Timeout: money may still arrive — refresh and soft-success if balance moved
    try {
      const now = await tokenBalance(rail.stable, address)
      if (now >= baseline + minBump) {
        setDepositOutcome({
          phase: 'settled',
          receivedLabel: formatMoney(
            currency,
            Number(formatUnits(now - baseline, rail.decimals)),
          ),
        })
        return
      }
    } catch {
      /* ignore */
    }
    setDepositOutcome({
      phase: 'timeout',
      message:
        'Still confirming. Check Home in a minute — your balance updates when the deposit finishes.',
    })
  }

  async function go() {
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      if (!address || !walletReady) throw new Error('Your account is not ready')
      if (direction === 'in') {
        if (!rail.stable) throw new Error('This account is not configured')
        if (!depositRoute) {
          setStatus('Getting a deposit quote…')
          const route = await prepareRelayDepositRoute({
            recipient: address,
            destinationAsset: rail.stable,
            amount,
          })
          setDepositRoute(route)
          setStatus(null)
          return
        }
        setStatus('Opening secure payment…')
        // Pay → Base USDC at Relay deposit address → Relay → RH USDG.
        await openDepositPayment(depositRoute)
        setDone(true)
        setBusy(false)
        setStatus(null)
        void watchDepositSettlement(depositRoute)
        return
      }

      // —— wind down: free standard if needed → RH USDG → Relay → Base USDC ——
      await windDownViaRelay({
        rail,
        owner: address,
        amount,
        send: sendTransaction,
        progress: setStatus,
      })
      if (onRefresh) await onRefresh()
      setWithdrawSettled(true)

      if (API_BASE) {
        setStatus('Opening bank cash out…')
        const accessToken = await getAccessToken()
        if (!accessToken) throw new Error('Your session has expired')
        const res = await fetch(`${API_BASE}/api/accrue-offramp-session`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ currency, amount: value, email, address }),
        })
        if (res.ok) {
          const body = (await res.json()) as {
            url?: string
            mode?: string
          }
          if (body.url && /^https:\/\//.test(body.url)) {
            await Browser.open({ url: body.url })
            setDone(true)
            return
          }
        }
      }
      setDone(true)
    } catch (err) {
      setError(humanError(err, direction))
    } finally {
      setBusy(false)
      setStatus(null)
    }
  }

  if (done && direction === 'in') {
    const outcome = depositOutcome
    const waiting = !outcome || outcome.phase === 'waiting'
    const settled = outcome?.phase === 'settled'
    const failed = outcome?.phase === 'failed'
    const timedOut = outcome?.phase === 'timeout'

    return (
      <div className="screen" style={{ justifyContent: 'center' }}>
        <div className="empty">
          <p className="display" style={{ fontSize: '1.8rem' }}>
            {settled
              ? 'Money arrived'
              : failed
                ? 'Deposit didn’t complete'
                : timedOut
                  ? 'Still confirming'
                  : 'Deposit on the way'}
          </p>

          {settled && (
            <>
              <p
                className="figure"
                style={{ fontSize: '2.2rem', margin: '8px 0 0' }}
              >
                +{outcome.receivedLabel}
              </p>
              <p className="small muted" style={{ maxWidth: '34ch' }}>
                It’s in your dollar account as available balance — ready to grow
                or withdraw when you are.
              </p>
            </>
          )}

          {waiting && (
            <p className="small" style={{ maxWidth: '34ch' }} aria-live="polite">
              {outcome?.phase === 'waiting'
                ? outcome.message
                : 'Waiting for your payment to land in your dollar account…'}
            </p>
          )}

          {(failed || timedOut) && outcome && 'message' in outcome && (
            <p className="small" style={{ maxWidth: '34ch' }} role="alert">
              {outcome.message}
            </p>
          )}

          <div
            style={{
              display: 'flex',
              gap: 10,
              marginTop: 8,
              flexWrap: 'wrap',
              justifyContent: 'center',
            }}
          >
            {waiting && (
              <button
                className="btn btn-quiet"
                style={{ width: 'auto', padding: '10px 22px' }}
                onClick={() => {
                  if (onRefresh) void onRefresh()
                }}
              >
                Refresh balance
              </button>
            )}
            <button
              className="btn btn-primary"
              style={{ width: 'auto', padding: '10px 22px' }}
              onClick={() => {
                clearDepositFlow()
                if (onRefresh) void onRefresh()
              }}
            >
              {settled ? 'Back to account' : 'Done'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (done) {
    return (
      <div className="screen" style={{ justifyContent: 'center' }}>
        <div className="empty">
          <p className="display" style={{ fontSize: '1.8rem' }}>
            {withdrawSettled ? 'Cash out on the way' : 'Withdrawal sent'}
          </p>
          <p className="small" style={{ maxWidth: '34ch' }}>
            {withdrawSettled
              ? 'Your dollars left the account and are settling to cash. If a bank partner opened, finish that step — bank arrival is typically 1–2 business days.'
              : 'Your dollars are settling to cash. Bank arrival is typically 1–2 business days after the partner step.'}
          </p>
          <button
            className="btn btn-quiet"
            style={{ width: 'auto', padding: '10px 22px' }}
            onClick={clearDepositFlow}
          >
            Done
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="screen">
      <header>
        <h1>Move money</h1>
      </header>

      <div className="presets" role="tablist" aria-label="Direction">
        {(['in', 'out'] as const).map((d) => (
          <button
            key={d}
            role="tab"
            aria-pressed={direction === d}
            onClick={() => {
              setDirection(d)
              resetRoute()
            }}
          >
            {d === 'in' ? 'Add money' : 'Cash out'}
          </button>
        ))}
      </div>

      <div className="field">
        <label htmlFor="ccy">Account</label>
        <div className="presets" id="ccy">
          {RAILS.map((r) => (
            <button
              key={r.code}
              aria-pressed={currency === r.code}
              disabled={r.status === 'coming_soon'}
              title={
                r.status === 'coming_soon' ? 'Coming soon' : undefined
              }
              onClick={() => {
                if (r.status === 'coming_soon') return
                setCurrency(r.code)
                resetRoute()
              }}
            >
              {r.code === 'XAU' ? 'Gold' : r.code}
            </button>
          ))}
        </div>
        {rail.status === 'coming_soon' && (
          <p className="small muted">
            Euro, pound, and gold open when those assets are live. Dollar works
            now.
          </p>
        )}
      </div>

      <div className="field">
        <label htmlFor="amt">
          {direction === 'in' && currency === 'XAU'
            ? 'Amount to add (USD)'
            : 'Amount'}
        </label>
        <input
          id="amt"
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          aria-invalid={Boolean(invalid)}
          onChange={(e) => {
            setAmount(e.target.value.replace(/[^\d.]/g, ''))
            resetRoute()
          }}
        />
        {invalid && <p className="error">{invalid}</p>}
        {direction === 'out' && freeCash > 0 && !invalid && (
          <p className="small muted">
            Free to cash out: {formatMoney(currency, freeCash)}
            {standard > 0
              ? ` (${formatMoney(currency, available)} available · ${formatMoney(currency, standard)} standard — we’ll free standard first)`
              : ''}
          </p>
        )}
        {direction === 'out' && freeCash === 0 && (
          <p className="small muted">
            Nothing free to cash out yet. Add money first.
          </p>
        )}
      </div>

      {direction === 'in' && (
        <div className="presets" aria-label="Quick amounts">
          {PRESETS.map((p) => (
            <button
              key={p}
              aria-pressed={value === p}
              onClick={() => {
                setAmount(String(p))
                resetRoute()
              }}
            >
              {formatMoney(currency === 'XAU' ? 'USD' : currency, p)}
            </button>
          ))}
        </div>
      )}

      {direction === 'in' && depositRoute && (
        <>
          <div className="notice" aria-live="polite">
            <p style={{ margin: 0 }}>
              Current estimate:{' '}
              <span className="figure">
                {formatMoney(currency, Number(depositRoute.quotedReceived))}
              </span>
            </p>
            <p className="small muted" style={{ margin: '6px 0 0' }}>
              Floor if markets move:{' '}
              {formatMoney(currency, Number(depositRoute.minimumReceived))}. The
              final amount follows your payment and the live exchange route.
            </p>
          </div>

          <div className="field">
            <label id="pay-how">How do you want to pay?</label>
            <div
              className="presets pay-options"
              role="radiogroup"
              aria-labelledby="pay-how"
            >
              {PAY_METHODS.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={payMethod === m.id}
                  aria-pressed={payMethod === m.id}
                  onClick={() => setPayMethod(m.id)}
                >
                  <span className="figure" style={{ fontSize: '1rem' }}>
                    {m.label}
                    {m.id === 'card' ? ' · recommended' : ''}
                  </span>
                  <span className="small muted">{m.blurb}</span>
                </button>
              ))}
            </div>
            <p className="small muted" style={{ marginTop: 8 }}>
              Coinbase is optional. Card or bank does not require a Coinbase
              account.
            </p>
          </div>
        </>
      )}

      {status && (
        <p className="small muted" aria-live="polite">
          {status}
        </p>
      )}

      {error && (
        <div className="notice" role="alert">
          {error}
        </div>
      )}

      <button
        className="btn btn-primary"
        disabled={busy || !value || Boolean(invalid)}
        onClick={go}
      >
        {busy
          ? status || 'One moment…'
          : direction === 'in'
            ? depositRoute
              ? payMethod === 'coinbase'
                ? 'Continue with Coinbase'
                : payMethod === 'moonpay'
                  ? 'Continue with MoonPay'
                  : payMethod === 'choose'
                    ? 'Open payment options'
                    : 'Continue with card or bank'
              : 'Review deposit'
            : 'Cash out'}
      </button>

      <p className="small muted">
        {direction === 'in'
          ? 'Card/bank pays on Base; we route it into your dollar account automatically.'
          : 'Cash out frees your balance, settles it to cash, then opens bank payout when configured. Needs a tiny Robinhood network fee (ETH).'}
      </p>
    </div>
  )
}
