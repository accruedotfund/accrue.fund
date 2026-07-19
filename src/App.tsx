import { useCallback, useEffect, useState } from 'react'
import { useAuth } from './lib/auth'
import { ensureUsdWrapper, readUsdWrapper } from './lib/factory'
import { fetchHoldings, type Holding } from './lib/nav'
import { setRailWrapper, type CurrencyCode } from './lib/rails'
import Home from './screens/Home'
import Boost from './screens/Boost'
import Account from './screens/Account'
import Fund from './screens/Fund'
import Profile from './screens/Profile'
import Welcome from './screens/Welcome'

type Tab = 'home' | 'boost' | 'fund' | 'profile'

const TABS: { id: Tab; label: string; glyph: string }[] = [
  { id: 'home', label: 'Home', glyph: '◆' },
  { id: 'boost', label: 'Boost', glyph: '↑' },
  { id: 'fund', label: 'Move money', glyph: '⇄' },
  { id: 'profile', label: 'You', glyph: '●' },
]

export default function App() {
  const { ready, authenticated, address, walletReady, sendTransaction } =
    useAuth()
  const [tab, setTab] = useState<Tab>('home')
  const [holdings, setHoldings] = useState<Holding[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [selectedCode, setSelectedCode] = useState<string | null>(null)
  const [bootStatus, setBootStatus] = useState<string | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)

  const humanBootError = (err: unknown): string => {
    const msg = err instanceof Error ? err.message : String(err ?? '')
    if (/app secret is required/i.test(msg) || /gas sponsored/i.test(msg)) {
      return 'Network fees for setup need Privy gas sponsorship: App pays + Robinhood Chain + “Allow transactions from the client”. You can still add money; Standard growth unlocks after that.'
    }
    if (/sponsor|gas sponsorship/i.test(msg)) {
      return 'Gas sponsorship is not ready yet. You can still add money — Standard account setup will finish once sponsorship is on.'
    }
    return msg || 'Could not finish account setup. You can still add money.'
  }

  const ensureRail = useCallback(async () => {
    if (!walletReady || !address) return
    setBootError(null)
    try {
      // Always discover existing wrapper (no gas needed).
      let wrapper = await readUsdWrapper()
      if (wrapper) {
        setRailWrapper('USD', wrapper)
        setBootStatus(null)
        return
      }
      // Create requires sponsored gas — may fail until Privy is configured.
      setBootStatus('Opening standard dollar growth…')
      wrapper = await ensureUsdWrapper(sendTransaction, setBootStatus)
      setRailWrapper('USD', wrapper)
      setBootStatus(null)
    } catch (err) {
      setBootStatus(null)
      setBootError(humanBootError(err))
    }
  }, [walletReady, address, sendTransaction])

  const refresh = useCallback(async () => {
    try {
      // Prefer on-chain wrapper discovery even if create failed.
      try {
        const w = await readUsdWrapper()
        if (w) setRailWrapper('USD', w)
      } catch {
        /* ignore */
      }
      setHoldings(await fetchHoldings(address))
      setLoadError(false)
    } catch {
      setLoadError(true)
    }
  }, [address])

  useEffect(() => {
    if (!authenticated) return
    void (async () => {
      await ensureRail()
      await refresh()
    })()
  }, [authenticated, ensureRail, refresh])

  useEffect(() => {
    if (!authenticated) return
    const t = setInterval(refresh, 15_000)
    return () => clearInterval(t)
  }, [authenticated, refresh])

  if (!ready) {
    return (
      <div className="frame">
        <div className="screen" aria-busy="true">
          <div className="skeleton" style={{ height: 44, width: '60%' }} />
          <div className="skeleton" style={{ height: 120 }} />
        </div>
      </div>
    )
  }

  if (!authenticated) return <Welcome />

  const selected = holdings?.find((h) => h.rail.code === selectedCode)

  return (
    <div className="frame">
      {(bootStatus || bootError) && (
        <div
          className="notice"
          role={bootError ? 'alert' : 'status'}
          style={{ margin: '12px 16px 0' }}
        >
          {bootError ?? bootStatus}
          {bootError && (
            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <button
                className="btn btn-quiet"
                style={{ width: 'auto', padding: '6px 12px' }}
                onClick={() => void ensureRail()}
              >
                Retry setup
              </button>
              <button
                className="btn btn-primary"
                style={{ width: 'auto', padding: '6px 12px' }}
                onClick={() => setTab('fund')}
              >
                Add money
              </button>
            </div>
          )}
        </div>
      )}
      {selected ? (
        <Account
          holding={selected}
          onBack={() => setSelectedCode(null)}
          onRefresh={refresh}
        />
      ) : tab === 'home' ? (
        <Home
          holdings={holdings}
          loadError={loadError}
          onRetry={refresh}
          onFund={() => setTab('fund')}
          onAccount={(code: CurrencyCode) => setSelectedCode(code)}
        />
      ) : tab === 'boost' ? (
        <Boost holdings={holdings} onRefresh={refresh} />
      ) : tab === 'fund' ? (
        <Fund holdings={holdings} onRefresh={refresh} />
      ) : (
        <Profile />
      )}
      {!selected && (
        <nav className="tabbar" aria-label="Main">
          {TABS.map((t) => (
            <button
              key={t.id}
              aria-current={tab === t.id}
              onClick={() => setTab(t.id)}
            >
              <span className="glyph" aria-hidden>
                {t.glyph}
              </span>
              {t.label}
            </button>
          ))}
        </nav>
      )}
    </div>
  )
}
