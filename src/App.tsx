import { useCallback, useEffect, useState } from 'react'
import { useAuth } from './lib/auth'
import { readUsdWrapper } from './lib/factory'
import { recordSnapshot } from './lib/history'
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
  const { ready, authenticated, address, walletReady } = useAuth()
  const [tab, setTab] = useState<Tab>('home')
  const [holdings, setHoldings] = useState<Holding[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [selectedCode, setSelectedCode] = useState<string | null>(null)
  // Deposit path = Base (Coinbase) → Relay → RH. Privy does not sponsor RH
  // mainnet gas — never create wUSDG on boot with sponsor:true.
  const ensureRail = useCallback(async () => {
    if (!walletReady || !address) return
    try {
      const wrapper = await readUsdWrapper()
      if (wrapper) {
        setRailWrapper('USD', wrapper)
      }
      // If no wrapper yet: still open for Add money (available USDG via Relay).
    } catch {
      /* RPC noise — balances may still load */
    }
  }, [walletReady, address])

  const refresh = useCallback(async () => {
    try {
      try {
        const w = await readUsdWrapper()
        if (w) setRailWrapper('USD', w)
      } catch {
        /* ignore */
      }
      const next = await fetchHoldings(address)
      setHoldings(next)
      setLoadError(false)
      // Snapshot for balance chart + cost basis (local, per wallet).
      const usd = next.find((h) => h.rail.code === 'USD')
      if (usd && address) {
        recordSnapshot(address, {
          total: usd.balance,
          available: usd.availableBalance,
          standard: usd.standardBalance,
          boost: usd.boostBalance,
        })
      }
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
