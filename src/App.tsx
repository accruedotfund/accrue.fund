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

  const ensureRail = useCallback(async () => {
    if (!walletReady || !address) return
    setBootError(null)
    try {
      let wrapper = await readUsdWrapper()
      if (!wrapper) {
        setBootStatus('Opening your dollar account…')
        wrapper = await ensureUsdWrapper(sendTransaction, setBootStatus)
      }
      setRailWrapper('USD', wrapper)
      setBootStatus(null)
    } catch (err) {
      setBootStatus(null)
      setBootError(
        err instanceof Error
          ? err.message
          : 'Could not open the dollar account. Check gas sponsorship, then retry.',
      )
    }
  }, [walletReady, address, sendTransaction])

  const refresh = useCallback(async () => {
    try {
      setHoldings(await fetchHoldings(address))
      setLoadError(false)
    } catch {
      setLoadError(true)
    }
  }, [address])

  useEffect(() => {
    if (!authenticated) return
    void ensureRail()
  }, [authenticated, ensureRail])

  useEffect(() => {
    if (!authenticated) return
    refresh()
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
            <button
              className="btn btn-quiet"
              style={{ width: 'auto', padding: '6px 12px', marginTop: 8 }}
              onClick={() => void ensureRail()}
            >
              Retry setup
            </button>
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
