import { useState } from 'react'
import { useAuth } from '../lib/auth'

// Learn surface + the ONE place chain custody is disclosed (legal must say
// it even though the product surface never does — see README).

export default function Profile() {
  const { email, logout } = useAuth()
  const [doc, setDoc] = useState<'none' | 'terms' | 'privacy'>('none')

  if (doc !== 'none') {
    return (
      <div className="screen">
        <button
          className="btn btn-quiet"
          style={{ width: 'auto', padding: '8px 16px' }}
          onClick={() => setDoc('none')}
        >
          ← Back
        </button>
        {doc === 'terms' ? <Terms /> : <Privacy />}
      </div>
    )
  }

  return (
    <div className="screen">
      <header>
        <h1>You</h1>
        <p className="muted" style={{ marginTop: 6 }}>
          {email ?? 'Signed in'}
        </p>
      </header>

      <div className="ledger">
        <button className="row" onClick={() => setDoc('terms')}>
          <span className="grow" style={{ fontWeight: 600 }}>
            Terms of Service
          </span>
          <span className="muted" aria-hidden>
            →
          </span>
        </button>
        <button className="row" onClick={() => setDoc('privacy')}>
          <span className="grow" style={{ fontWeight: 600 }}>
            Privacy Policy
          </span>
          <span className="muted" aria-hidden>
            →
          </span>
        </button>
        <button className="row" onClick={logout}>
          <span className="grow" style={{ fontWeight: 600, color: 'var(--down)' }}>
            Sign out
          </span>
        </button>
      </div>

      <p className="small muted">
        Accrue (accrue.fund) is not a bank and balances are not covered by
        government deposit insurance. Growth rates are variable and not
        guaranteed.
      </p>
    </div>
  )
}

function Terms() {
  return (
    <article style={{ maxWidth: '65ch', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h1>Terms of Service</h1>
      <p className="small muted">Working draft — counsel review required before launch.</p>
      <p className="small">
        <strong>What Accrue is.</strong> Accrue (operated at{' '}
        <span className="figure">accrue.fund</span>) provides dollar accounts.
        Additional currencies may open later. Balances are represented by
        digital tokens on a public blockchain: a regulated dollar stablecoin
        held in a non-custodial wallet created for you at sign-up, deposited
        into an on-chain vault whose redemption value is designed to be
        non-decreasing.
      </p>
      <p className="small">
        <strong>What Accrue is not.</strong> Accrue is not a bank, credit
        institution, or licensed deposit-taker. Balances are not deposits,
        are not insured by the FDIC, FSCS, or any deposit-guarantee scheme,
        and are not claims against Accrue. You control your wallet; we cannot
        move funds without your authorization.
      </p>
      <p className="small">
        <strong>Growth and Boost.</strong> Standard account growth reflects
        on-chain vault revenue and is variable, not interest, and not
        guaranteed. Boosted balances additionally supply paired liquidity to
        automated markets: their value can decrease, including below your
        contribution. Boost is enabled only after your explicit double
        confirmation.
      </p>
      <p className="small">
        <strong>Moving money.</strong> Deposits and withdrawals are executed
        by regulated third-party payment providers presented through Privy or
        an Accrue server-created withdrawal session. Those providers perform
        identity verification and hold your payment credentials. Accrue never
        receives card or bank details.
      </p>
    </article>
  )
}

function Privacy() {
  return (
    <article style={{ maxWidth: '65ch', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h1>Privacy Policy</h1>
      <p className="small muted">Working draft — counsel review required before launch.</p>
      <p className="small">
        We collect your email or phone number (for sign-in via Privy, Inc.),
        and your public wallet address. Identity verification for deposits
        and withdrawals is performed by our payment providers under their own
        policies. Your on-chain transactions are publicly visible on the
        blockchain by its nature. We do not sell personal data.
      </p>
    </article>
  )
}
