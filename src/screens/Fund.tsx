import { useState } from 'react'
import { Browser } from '@capacitor/browser'
import { useFiatOnramp } from '@privy-io/react-auth'
import { useAuth } from '../lib/auth'
import {
  RELAY_ORIGIN_ASSET,
  prepareRelayDepositRoute,
  type RelayDepositRoute,
} from '../lib/relay'
import { withdrawAvailableViaRelay } from '../lib/withdraw'
import type { Holding } from '../lib/nav'
import {
  API_BASE,
  MIN_DEPOSIT,
  RAILS,
  formatMoney,
  type CurrencyCode,
} from '../lib/rails'

// Configure surface: pick direction, currency, amount → review → pay/send.
// In: Privy pays Base deposit address → Relay → USDG on Robinhood.
// Out: available USDG → Relay → Base USDC; optional bank URL via API_BASE.

type Direction = 'in' | 'out'
const PRESETS = [50, 200, 1000]

function humanError(err: unknown, direction: Direction): string {
  const msg = err instanceof Error ? err.message : ''
  if (/minimum|too many decimals|valid amount|above zero|Not enough|available/i.test(msg)) {
    return msg
  }
  if (/not configured|not ready|session has expired|Opening your dollar/i.test(msg)) {
    return msg
  }
  if (/Relay|route/i.test(msg)) {
    return direction === 'in'
      ? 'We couldn’t prepare a deposit route right now. Nothing was charged — try again.'
      : 'We couldn’t prepare a withdrawal route right now. Your balance is untouched — try again.'
  }
  return direction === 'in'
    ? 'We couldn’t start your deposit. Nothing was charged — try again.'
    : 'We couldn’t start your withdrawal. Your balance is untouched — try again.'
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
  const { fund } = useFiatOnramp()
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

  const value = parseFloat(amount)
  const rail = RAILS.find((item) => item.code === currency)!
  const sourceCurrency = currency === 'XAU' ? 'USD' : currency
  const held =
    holdings?.find((h) => h.rail.code === currency)?.availableBalance ?? 0
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
            : direction === 'out' && value > held
              ? `You have ${formatMoney(currency, held)} available.`
              : null

  function resetRoute() {
    setDepositRoute(null)
    setError(null)
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
        await fund({
          source: {
            assets: ['usd', 'eur', 'gbp'],
            defaultAsset: sourceCurrency.toLowerCase() as
              | 'usd'
              | 'eur'
              | 'gbp',
          },
          destination: {
            address: depositRoute.depositAddress,
            chain: 'eip155:8453',
            asset: RELAY_ORIGIN_ASSET,
          },
          environment: import.meta.env.PROD ? 'production' : 'sandbox',
          defaultAmount: String(value),
        })
        setDone(true)
        return
      }

      // —— withdraw ——
      // Prefer bank partner session when backend is configured; otherwise
      // settle via Relay to Base USDC at the same wallet address.
      if (API_BASE) {
        setStatus('Starting bank withdrawal…')
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
          // mode === 'relay' falls through to on-device path
        }
      }

      await withdrawAvailableViaRelay({
        rail,
        owner: address,
        amount,
        send: sendTransaction,
        progress: setStatus,
      })
      if (onRefresh) await onRefresh()
      setDone(true)
    } catch (err) {
      setError(humanError(err, direction))
    } finally {
      setBusy(false)
      setStatus(null)
    }
  }

  if (done) {
    return (
      <div className="screen" style={{ justifyContent: 'center' }}>
        <div className="empty">
          <p className="display" style={{ fontSize: '1.8rem' }}>
            {direction === 'in' ? 'Deposit started' : 'Withdrawal sent'}
          </p>
          <p className="small" style={{ maxWidth: '34ch' }}>
            {direction === 'in'
              ? 'Finish the secure payment step. Your payment is then routed to your dollar account — usually within a few minutes.'
              : 'Your available balance is on its way out. Bank arrival is typically 1–2 business days once the cashout partner settles.'}
          </p>
          <button
            className="btn btn-quiet"
            style={{ width: 'auto', padding: '10px 22px' }}
            onClick={() => {
              setDone(false)
              setAmount('')
              setDepositRoute(null)
            }}
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
            {d === 'in' ? 'Add money' : 'Withdraw'}
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
        {direction === 'out' && held > 0 && !invalid && (
          <p className="small muted">
            Available: {formatMoney(currency, held)}
          </p>
        )}
        {direction === 'out' && held === 0 && (
          <p className="small muted">
            Make money available from the account detail first, then return
            here to withdraw it.
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
              ? 'Continue to secure payment'
              : 'Review deposit'
            : 'Withdraw'}
      </button>

      <p className="small muted">
        Deposits and withdrawals are processed by regulated payment partners.
        Card and bank details never touch our servers.
      </p>
    </div>
  )
}
