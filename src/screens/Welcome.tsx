import { useAuth } from '../lib/auth'
import { GITHUB_REPO_URL } from './Profile'

/**
 * Unauthed lander: pitch + stats + uptake + ethos.
 * Honesty first — no fake TVL/users. PoC is the live product; scale needs partners.
 */

const STATS: { k: string; v: string; d: string }[] = [
  { k: 'Rails live', v: 'USD', d: 'EUR · GBP · gold when rails exist' },
  { k: 'Modes', v: '3', d: 'Standard · Steady · Growth' },
  { k: 'Surfaces', v: '2', d: 'Web + Android (debug APK)' },
  { k: 'Chain vocab', v: '0', d: 'On the consumer surface' },
]

const FLOW = ['Add money', 'Dollars', 'Boost (opt-in)', 'Cash out'] as const

const ETHOS = [
  'Zero chain vocabulary on the consumer surface.',
  'Sign up = email / SMS. Wallet is plumbing.',
  'Default is non-speculative. Risk is opt-in only.',
  'Cash out without teaching anyone CAIP-2.',
  'Not a bank. Not FDIC. Not a casino UI.',
] as const

export default function Welcome() {
  const { login } = useAuth()

  return (
    <div className="frame">
      <div className="screen lander">
        {/* —— pitch —— */}
        <header className="lander-hero">
          <div className="lander-brand">
            <span className="figure lander-mark">accrue.fund</span>
            <span className="badge gold">public alpha</span>
          </div>
          <h1 className="display lander-title">
            Dollar account.
            <br />
            Earn on USD.
          </h1>
          <p className="lander-pitch">
            Quoted in USD. Default is a non-speculative park — standard value
            per unit is designed to rise. Optional Boost for more reward, with
            real risk — only if you opt in.
          </p>
          <p className="small muted lander-sub">
            Inflation is a silent tax. Checking accounts are a participation
            trophy. Accrue is for people who want the bag to work without
            learning a block explorer.
          </p>
        </header>

        <button className="btn btn-primary" onClick={login} type="button">
          Continue with email
        </button>

        {/* —— flow —— */}
        <section className="lander-section" aria-labelledby="lander-flow">
          <h2 id="lander-flow">How it works</h2>
          <ol className="lander-flow">
            {FLOW.map((step, i) => (
              <li key={step}>
                <span className="lander-flow-n figure">{i + 1}</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </section>

        {/* —— stats —— */}
        <section className="lander-section" aria-labelledby="lander-stats">
          <h2 id="lander-stats">At a glance</h2>
          <div className="lander-stats">
            {STATS.map((s) => (
              <div key={s.k} className="lander-stat">
                <span className="small muted">{s.k}</span>
                <span className="figure lander-stat-v">{s.v}</span>
                <span className="small muted">{s.d}</span>
              </div>
            ))}
          </div>
        </section>

        {/* —— uptake / status (honest) —— */}
        <section className="lander-section" aria-labelledby="lander-uptake">
          <h2 id="lander-uptake">Status · uptake</h2>
          <div className="ledger lander-ledger">
            <div className="row" style={{ cursor: 'default' }}>
              <span className="grow">
                <span style={{ fontWeight: 600 }}>Proof of concept</span>
                <span className="small muted" style={{ display: 'block' }}>
                  Live product path: deposit rails → dollar account → optional
                  Boost → withdraw. Open the app and the contracts — dig in.
                </span>
              </span>
              <span className="badge boost">live</span>
            </div>
            <div className="row" style={{ cursor: 'default' }}>
              <span className="grow">
                <span style={{ fontWeight: 600 }}>Why scale isn&apos;t here yet</span>
                <span className="small muted" style={{ display: 'block' }}>
                  Full bank-grade on/off-ramp partners, institutional packaging,
                  and growth capital are still open. The software ships; the
                  distribution and funding stack is the gap.
                </span>
              </span>
              <span className="badge">open</span>
            </div>
            <div className="row" style={{ cursor: 'default' }}>
              <span className="grow">
                <span style={{ fontWeight: 600 }}>Shipping in public</span>
                <span className="small muted" style={{ display: 'block' }}>
                  Web live · Android debug APK · open source. Rough edges
                  included. No fake TVL, no invented user counts.
                </span>
              </span>
              <span className="badge">WIP</span>
            </div>
          </div>
        </section>

        {/* —— ethos —— */}
        <section className="lander-section" aria-labelledby="lander-ethos">
          <h2 id="lander-ethos">Product law</h2>
          <ul className="lander-ethos">
            {ETHOS.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>

        {/* —— dig in —— */}
        <section className="lander-section" aria-labelledby="lander-dig">
          <h2 id="lander-dig">Dig in</h2>
          <div className="ledger lander-ledger">
            <a
              className="row"
              href={GITHUB_REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              <span className="grow">
                <span style={{ fontWeight: 600 }}>Source &amp; contracts</span>
                <span className="small muted" style={{ display: 'block' }}>
                  github.com/accruedotfund/accrue.fund
                </span>
              </span>
              <span className="muted" aria-hidden>
                →
              </span>
            </a>
            <a
              className="row"
              href="https://stacc.bio"
              target="_blank"
              rel="noopener noreferrer"
            >
              <span className="grow">
                <span style={{ fontWeight: 600 }}>Builder dossier</span>
                <span className="small muted" style={{ display: 'block' }}>
                  stacc.bio · track record &amp; receipts
                </span>
              </span>
              <span className="muted" aria-hidden>
                →
              </span>
            </a>
          </div>
        </section>

        <button className="btn btn-primary" onClick={login} type="button">
          Open a dollar account
        </button>
        <p className="small muted" style={{ textAlign: 'center', paddingBottom: 12 }}>
          No branches. No seed phrases. Boost is optional and can go down.
          Growth is experimental.
        </p>
      </div>
    </div>
  )
}
