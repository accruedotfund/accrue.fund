import { useEffect, useRef, useState } from 'react'
import { Browser } from '@capacitor/browser'
import { useFundWallet } from '@privy-io/react-auth'
import { base } from 'viem/chains'
import { formatUnits } from 'viem'
import { useAuth } from '../lib/auth'
import {
  prepareRelayDepositRoute,
  waitForDepositSettlement,
  type RelayDepositRoute,
} from '../lib/relay'
import { windDownViaRelay } from '../lib/withdraw'
import { recordDeposit, recordWithdraw } from '../lib/history'
import { tokenBalance } from '../lib/vault'
import type { Holding } from '../lib/nav'
import {
  API_BASE,
  MIN_DEPOSIT,
  RAILS,
  formatMoney,
  type CurrencyCode,
} from '../lib/rails'
import CrossmintCheckout, {
  crossmintClientReady,
} from '../components/CrossmintCheckout'

// Settlement is always Relay both ways (no chain words in UI):
//   IN  Transak card/bank (or crypto send) → Base USDC → Relay → RH dollars
//   OUT free cash on RH → Relay → Base USDC → optional bank hop
// Privy Stripe/MoonPay are NOT used — they fail for CA / Stripe init.

type Direction = 'in' | 'out'
/**
 * transak = merchant widget (primary fiat)
 * crypto  = copy Base USDC address (always works)
 * coinbase = Privy exchange only (optional)
 * crossmint = optional when project verified
 */
type PayMethod = 'transak' | 'crypto' | 'coinbase' | 'crossmint'
/** Deposit feedback after the payment UI closes. */
type DepositOutcome =
  | null
  | { phase: 'waiting'; message: string }
  | { phase: 'settled'; receivedLabel: string }
  | { phase: 'failed'; message: string }
  | { phase: 'timeout'; message: string }

type CrossmintSession = {
  orderId: string
  clientSecret: string
  receiptEmail: string
}

const PRESETS = [50, 200, 1000]

const PAY_OPTIONS: {
  id: PayMethod
  label: string
  blurb: string
  badge?: string
}[] = [
  {
    id: 'transak',
    label: 'Card or bank',
    blurb: 'Buy Base USDC with card/bank — then it routes into your dollar account.',
    badge: 'recommended',
  },
  {
    id: 'crypto',
    label: 'Send USDC (crypto)',
    blurb: 'Copy the deposit address and send Base USDC from Coinbase or any wallet.',
    badge: 'works now',
  },
  {
    id: 'coinbase',
    label: 'Coinbase exchange',
    blurb: 'If you already hold funds on Coinbase (exchange funding).',
  },
  {
    id: 'crossmint',
    label: 'Crossmint (card)',
    blurb: 'Alternate card partner — needs project verification to work in production.',
  },
]

function humanError(err: unknown, direction: Direction): string {
  const msg = err instanceof Error ? err.message : ''
  if (/minimum|too many decimals|valid amount|above zero|Not enough|available/i.test(msg)) {
    return msg
  }
  if (/not configured|not ready|session has expired|Opening your dollar|Transak|transak/i.test(msg)) {
    return msg
  }
  if (/region|coming soon|not supported|geo/i.test(msg)) {
    return 'That payment method is not available in your region. Use Send USDC (crypto) instead.'
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
    ? 'We couldn’t start your deposit. Nothing was charged — try again. Prefer Send USDC (crypto).'
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
  const [payMethod, setPayMethod] = useState<PayMethod>('transak')
  const [depositOutcome, setDepositOutcome] = useState<DepositOutcome>(null)
  const [crossmint, setCrossmint] = useState<CrossmintSession | null>(null)
  const [copied, setCopied] = useState(false)
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
    setCrossmint(null)
    setStatus(null)
    setError(null)
    setCopied(false)
    setPayMethod('transak')
  }

  function apiOrigin(): string {
    return (
      API_BASE ||
      (typeof window !== 'undefined' ? window.location.origin : '')
    )
  }

  /** Transak merchant widget → Base USDC at Relay deposit address. */
  async function openTransakOnramp(route: RelayDepositRoute) {
    // Prefer browser-reported public IP for x-user-ip (session pin)
    let clientIp: string | undefined
    try {
      const ipRes = await fetch('https://api.ipify.org?format=json')
      const ipJson = (await ipRes.json()) as { ip?: string }
      if (ipJson.ip) clientIp = ipJson.ip
    } catch {
      /* server falls back to x-forwarded-for */
    }
    const res = await fetch(`${apiOrigin()}/api/transak-widget`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        walletAddress: route.depositAddress,
        amount: value,
        email: email || undefined,
        productsAvailed: 'BUY',
        fiatCurrency: 'USD',
        clientIp,
      }),
    })
    const body = (await res.json().catch(() => ({}))) as {
      widgetUrl?: string
      message?: string
      error?: string
      hint?: string
      mode?: string
    }
    if (!res.ok || !body.widgetUrl) {
      throw new Error(
        body.message ||
          body.error ||
          'Card/bank (Transak) is not available yet. Use Send USDC (crypto).',
      )
    }
    if (body.hint && body.mode === 'legacy') {
      setStatus(
        'Opening Transak… (if it fails, use Send USDC — partner IP whitelist may still be pending)',
      )
    }
    await Browser.open({ url: body.widgetUrl })
  }

  /** Crossmint embedded checkout (optional / when verified). */
  async function openCrossmintOnramp(route: RelayDepositRoute) {
    const receiptEmail = (email || '').trim()
    if (!receiptEmail || !receiptEmail.includes('@')) {
      throw new Error(
        'Add an email to your account first — card/bank needs a receipt address.',
      )
    }
    if (!crossmintClientReady()) {
      throw new Error(
        'Crossmint is not configured. Use Transak or Send USDC (crypto).',
      )
    }
    const accessToken = await getAccessToken()
    const res = await fetch(`${apiOrigin()}/api/crossmint-order`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify({
        walletAddress: route.depositAddress,
        amount: value,
        receiptEmail,
        kind: 'onramp',
      }),
    })
    const body = (await res.json().catch(() => ({}))) as {
      orderId?: string
      clientSecret?: string
      message?: string
      error?: string
    }
    if (!res.ok || !body.orderId || !body.clientSecret) {
      throw new Error(
        body.message ||
          body.error ||
          'Crossmint is not live yet (project verification). Use Transak or crypto send.',
      )
    }
    setCrossmint({
      orderId: body.orderId,
      clientSecret: body.clientSecret,
      receiptEmail,
    })
  }

  async function copyDepositAddress(addr: string) {
    try {
      await navigator.clipboard.writeText(addr)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('Could not copy — select the address and copy manually.')
    }
  }

  /**
   * Pay Base USDC into the Relay deposit address.
   * No Privy fundFiat / MoonPay card — those crash or geo-block.
   */
  async function openDepositPayment(route: RelayDepositRoute) {
    if (payMethod === 'transak') {
      await openTransakOnramp(route)
      return
    }
    if (payMethod === 'crypto') {
      // Stay on-page with copyable address (no Privy modal).
      return
    }
    if (payMethod === 'crossmint') {
      await openCrossmintOnramp(route)
      return
    }
    if (payMethod === 'coinbase') {
      await fundWallet({
        address: route.depositAddress,
        options: {
          chain: base,
          amount: String(value),
          asset: 'USDC' as const,
          defaultFundingMethod: 'exchange' as const,
        },
      })
      return
    }
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
      let receivedUsd = Number(route.quotedReceived) || value
      let receivedLabel = formatMoney(currency, receivedUsd)
      try {
        const now = await tokenBalance(rail.stable, address)
        const delta = now > baseline ? now - baseline : 0n
        if (delta > 0n) {
          receivedUsd = Number(formatUnits(delta, rail.decimals))
          receivedLabel = formatMoney(currency, receivedUsd)
        }
      } catch {
        /* use quote */
      }
      recordDeposit(address, receivedUsd)
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
        const receivedUsd = Number(formatUnits(now - baseline, rail.decimals))
        recordDeposit(address, receivedUsd)
        setDepositOutcome({
          phase: 'settled',
          receivedLabel: formatMoney(currency, receivedUsd),
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
          // Crypto: stay on page with address; start watching immediately.
          if (payMethod === 'crypto') {
            void watchDepositSettlement(route)
          }
          return
        }
        setStatus(
          payMethod === 'crypto'
            ? 'Showing deposit address…'
            : 'Opening secure payment…',
        )
        await openDepositPayment(depositRoute)
        // Crypto stays on this screen (address panel). Others open external/embed.
        if (payMethod === 'crypto') {
          setBusy(false)
          setStatus(null)
          void watchDepositSettlement(depositRoute)
          return
        }
        if (payMethod === 'crossmint') {
          void watchDepositSettlement(depositRoute)
          setBusy(false)
          setStatus(null)
          return
        }
        // Transak / Coinbase: external UI; poll settlement in background
        setDone(true)
        void watchDepositSettlement(depositRoute)
        setBusy(false)
        setStatus(null)
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
      // Cost basis: cash-out reduces principal pro-rata to total NAV.
      const totalNav =
        (holding?.balance ?? 0) || available + standard
      recordWithdraw(address, value, totalNav > 0 ? totalNav : undefined)
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

  // Embedded Crossmint checkout (primary path)
  if (crossmint && depositRoute && direction === 'in') {
    return (
      <div className="screen">
        <header>
          <h1>Add money</h1>
          <p className="small muted">
            Card or bank · estimate{' '}
            {formatMoney(currency, Number(depositRoute.quotedReceived))}
          </p>
        </header>
        <CrossmintCheckout
          orderId={crossmint.orderId}
          clientSecret={crossmint.clientSecret}
          receiptEmail={crossmint.receiptEmail}
          onClose={() => {
            setCrossmint(null)
            setBusy(false)
          }}
        />
        {depositOutcome?.phase === 'waiting' && (
          <p className="small muted" style={{ marginTop: 12 }} aria-live="polite">
            {depositOutcome.message}
          </p>
        )}
        {depositOutcome?.phase === 'settled' && (
          <div className="notice" style={{ marginTop: 12 }}>
            <p style={{ margin: 0, fontWeight: 600 }}>
              Money arrived · +{depositOutcome.receivedLabel}
            </p>
            <button
              className="btn btn-primary"
              style={{ marginTop: 10 }}
              onClick={() => {
                clearDepositFlow()
                if (onRefresh) void onRefresh()
              }}
            >
              Back to account
            </button>
          </div>
        )}
      </div>
    )
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
            <label id="pay-how">How to pay</label>
            <div
              className="presets pay-options"
              role="radiogroup"
              aria-labelledby="pay-how"
            >
              {PAY_OPTIONS.map((m) => (
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
                    {m.badge ? ` · ${m.badge}` : ''}
                  </span>
                  <span className="small muted">{m.blurb}</span>
                </button>
              ))}
            </div>
          </div>

          {payMethod === 'crypto' && (
            <div className="notice deposit-address" aria-live="polite">
              <p style={{ margin: 0, fontWeight: 600 }}>
                Send Base USDC to this address
              </p>
              <p className="small muted" style={{ margin: '6px 0 8px' }}>
                Network must be <strong>Base</strong>. Wrong network = lost funds.
                Amount ~{formatMoney('USD', value)}.
              </p>
              <code
                className="figure"
                style={{
                  display: 'block',
                  wordBreak: 'break-all',
                  fontSize: '0.8rem',
                  marginBottom: 10,
                }}
              >
                {depositRoute.depositAddress}
              </code>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ width: 'auto', padding: '10px 18px' }}
                  onClick={() =>
                    void copyDepositAddress(depositRoute.depositAddress)
                  }
                >
                  {copied ? 'Copied ✓' : 'Copy address'}
                </button>
                <button
                  type="button"
                  className="btn btn-quiet"
                  style={{ width: 'auto', padding: '10px 18px' }}
                  onClick={() => {
                    void watchDepositSettlement(depositRoute)
                    setStatus('Waiting for your transfer…')
                  }}
                >
                  I’ve sent it
                </button>
              </div>
              {depositOutcome?.phase === 'waiting' && (
                <p className="small muted" style={{ marginTop: 10 }}>
                  {depositOutcome.message}
                </p>
              )}
              {depositOutcome?.phase === 'settled' && (
                <p style={{ marginTop: 10, fontWeight: 600, color: 'var(--up)' }}>
                  Money arrived · +{depositOutcome.receivedLabel}
                </p>
              )}
            </div>
          )}
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

      {!(direction === 'in' && depositRoute && payMethod === 'crypto') && (
        <button
          className="btn btn-primary"
          disabled={busy || !value || Boolean(invalid)}
          onClick={go}
        >
          {busy
            ? status || 'One moment…'
            : direction === 'in'
              ? depositRoute
                ? payMethod === 'transak'
                  ? 'Continue with card or bank'
                  : payMethod === 'coinbase'
                    ? 'Continue with Coinbase'
                    : payMethod === 'crossmint'
                      ? 'Continue with Crossmint'
                      : 'Continue'
                : 'Review deposit'
              : 'Cash out'}
        </button>
      )}

      {direction === 'in' && depositRoute && payMethod === 'crypto' && (
        <button
          className="btn btn-quiet"
          style={{ marginTop: 8 }}
          disabled={busy}
          onClick={() => {
            clearDepositFlow()
            if (onRefresh) void onRefresh()
          }}
        >
          Done
        </button>
      )}

      <p className="small muted">
        {direction === 'in'
          ? 'Card/bank uses Transak (when configured). Crypto send always works: Base USDC only. MoonPay/Privy card are disabled — they fail in your region.'
          : 'Cash out frees your balance, settles it to cash, then opens bank payout when configured. Needs a tiny Robinhood network fee (ETH).'}
      </p>
    </div>
  )
}
