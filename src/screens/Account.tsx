import { useState } from 'react'
import { useAuth } from '../lib/auth'
import { ensureUsdWrapper, readUsdWrapper } from '../lib/factory'
import type { Holding } from '../lib/nav'
import { formatMoney, setRailWrapper } from '../lib/rails'
import { depositAvailable, redeemStandard } from '../lib/vault'

function humanMoveError(cause: unknown): string {
  const msg = cause instanceof Error ? cause.message : String(cause ?? '')
  if (/insufficient funds|gas required|intrinsic gas|out of gas/i.test(msg)) {
    return 'Needs a tiny network fee on Robinhood Chain (ETH). Your dollars are safe as available — add a little ETH to that same address, then try again.'
  }
  if (/app secret|gas sponsored|sponsor/i.test(msg)) {
    return 'Network fee couldn’t be sponsored here. Fund a little ETH on Robinhood for this address, then try again. Your available balance is untouched.'
  }
  if (/not configured/i.test(msg)) {
    return 'Standard growth isn’t open on the network yet. We’ll open it once when you move balance (needs a tiny RH network fee).'
  }
  return msg || 'The balance did not move. Nothing was lost.'
}

export default function Account({
  holding,
  onBack,
  onRefresh,
}: {
  holding: Holding
  onBack: () => void
  onRefresh: () => Promise<void>
}) {
  const { address, walletReady, sendTransaction } = useAuth()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const needsVaultOpen = holding.rail.code === 'USD' && !holding.rail.wrapper

  async function ensureStandardVault() {
    // Discover existing wUSDG, or permissionless-create once (user pays RH gas).
    let wrapper = await readUsdWrapper()
    if (!wrapper) {
      setBusy('Opening standard growth on the network…')
      wrapper = await ensureUsdWrapper(sendTransaction, setBusy)
    }
    setRailWrapper('USD', wrapper)
    holding.rail.wrapper = wrapper
    return wrapper
  }

  async function move(direction: 'grow' | 'available') {
    if (!address || !walletReady) {
      setError('Your account is not ready yet.')
      return
    }
    setError(null)
    setBusy('Preparing…')
    try {
      if (direction === 'grow') {
        if (holding.rail.code === 'USD') {
          await ensureStandardVault()
        }
        await depositAvailable(holding.rail, address, sendTransaction, setBusy)
      } else {
        await redeemStandard(holding.rail, address, sendTransaction, setBusy)
      }
      setBusy('Updating your balance…')
      await onRefresh()
    } catch (cause) {
      setError(humanMoveError(cause))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="screen">
      <header>
        <button className="back" onClick={onBack} aria-label="Back">
          ←
        </button>
        <h1>{holding.rail.label}</h1>
        <p className="display" style={{ marginTop: 10 }}>
          {formatMoney(holding.rail.code, holding.balance)}
        </p>
      </header>

      <div className="ledger">
        <div className="row" style={{ cursor: 'default' }}>
          <span className="grow">
            <strong>Standard</strong>
            <span className="small muted" style={{ display: 'block' }}>
              Value per unit {holding.nav.toFixed(6)} · designed to only rise
            </span>
          </span>
          <span className="figure">
            {formatMoney(holding.rail.code, holding.standardBalance)}
          </span>
        </div>
        <div className="row" style={{ cursor: 'default' }}>
          <span className="grow">
            <strong>Available</strong>
            <span className="small muted" style={{ display: 'block' }}>
              Ready to move or withdraw
            </span>
          </span>
          <span className="figure">
            {formatMoney(holding.rail.code, holding.availableBalance)}
          </span>
        </div>
        {holding.boosts?.map((b) => (
          <div key={b.strategyId} className="row" style={{ cursor: 'default' }}>
            <span className="grow">
              <strong>
                Boost · {b.tier === 'steady' ? 'Steady' : 'Growth'}
              </strong>
              <span className="small muted" style={{ display: 'block' }}>
                {b.tier === 'steady'
                  ? 'Dollar-linked · can still move a little'
                  : 'Market-linked · can fall hard'}
              </span>
            </span>
            <span className="figure">
              {formatMoney(holding.rail.code, b.markValue)}
            </span>
          </div>
        ))}
      </div>

      {error && (
        <div className="notice" role="alert">
          {error}
        </div>
      )}

      {holding.availableBalance > 0 && (
        <button
          className="btn btn-primary"
          disabled={Boolean(busy)}
          onClick={() => move('grow')}
        >
          {busy ??
            (needsVaultOpen
              ? 'Open standard growth & move balance'
              : 'Move available balance to standard')}
        </button>
      )}
      {holding.standardBalance > 0 && (
        <button
          className="btn btn-quiet"
          disabled={Boolean(busy)}
          onClick={() => move('available')}
        >
          {busy ?? 'Make standard balance available'}
        </button>
      )}

      <p className="small muted">
        {needsVaultOpen
          ? 'Standard growth opens once on the network (tiny Robinhood network fee in ETH). After that, moving available → standard only needs the same fee for the deposit.'
          : 'A small entry or exit charge stays in the standard account and increases value per unit for everyone who remains.'}
      </p>
    </div>
  )
}
