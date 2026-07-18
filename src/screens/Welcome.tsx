import { useAuth } from '../lib/auth'

// Decide surface: one claim, one action. No feature grid, no hero art.
export default function Welcome() {
  const { login } = useAuth()
  return (
    <div className="frame">
      <div
        className="screen"
        style={{ justifyContent: 'flex-end', gap: 28, paddingBottom: 48 }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <span className="figure" style={{ fontSize: '1.1rem' }}>
            accrue.fund
          </span>
          <p className="display" style={{ fontSize: '2.2rem' }}>
            Growth by
            <br />
            design.
          </p>
          <p className="muted" style={{ maxWidth: '30ch' }}>
            Hold dollars. Standard value per unit is designed to rise. Boost
            when you want more risk for more reward.
          </p>
        </div>
        <button className="btn btn-primary" onClick={login}>
          Continue with email
        </button>
        <p className="small muted" style={{ textAlign: 'center' }}>
          No branches, no paperwork. Growth rates are variable, not guaranteed.
        </p>
      </div>
    </div>
  )
}
