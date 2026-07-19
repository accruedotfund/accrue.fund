import { useState } from 'react'
import { useAuth } from '../lib/auth'
import { ensureUsdWrapper, readUsdWrapper } from '../lib/factory'
import { ensureRhGas } from '../lib/gasBridge'
import type { Holding } from '../lib/nav'
import { formatMoney, setRailWrapper } from '../lib/rails'
import { depositAvailable, redeemStandard } from '../lib/vault'

type GasHint = {
  address: string
  detail: string
}

function parseGasHint(
  cause: unknown,
  fallbackAddress?: string,
): GasHint | null {
  const msg = cause instanceof Error ? cause.message : String(cause ?? '')
  const tagged = msg.match(/^GAS_TOPUP_NEEDED:(0x[a-fA-F0-9]{40}):([\s\S]+)$/)
  if (tagged) {
    return { address: tagged[1]!, detail: tagged[2]!.trim() }
  }
  if (
    /Base ETH|network fee|top-up|top up|Robinhood|insufficient funds|gas required|intrinsic gas/i.test(
      msg,
    )
  ) {
    if (fallbackAddress) {
      return {
        address: fallbackAddress,
        detail:
          msg.replace(/^GAS_TOPUP_NEEDED:[^:]+:/, '').trim() ||
          'Send a little ETH on Base to this address, then try again.',
      }
    }
  }
  return null
}

function humanMoveError(cause: unknown): string {
  const msg = cause instanceof Error ? cause.message : String(cause ?? '')
  if (msg.startsWith('GAS_TOPUP_NEEDED:')) {
    return msg.replace(/^GAS_TOPUP_NEEDED:0x[a-fA-F0-9]{40}:/, '').trim()
  }
  if (
    /Base ETH|network fee|top-up|top up|Robinhood/i.test(msg) &&
    /safe|try again|settling/i.test(msg)
  ) {
    return msg
  }
  if (
    /insufficient funds|gas required|intrinsic gas|out of gas|network fee on this chain/i.test(
      msg,
    )
  ) {
    return 'Robinhood needs a tiny network fee. Send a little ETH on Base to your address below — we’ll move it over automatically.'
  }
  if (/app secret|gas sponsored|sponsor/i.test(msg)) {
    return 'Network fee couldn’t be sponsored on Robinhood. Send a little ETH on Base to your address, then retry.'
  }
  if (/not configured|not open/i.test(msg)) {
    return 'Standard growth isn’t open yet — we’ll open it when you move balance (uses a tiny network fee).'
  }
  return msg || 'The balance did not move. Nothing was lost.'
}

function shorten(addr: string): string {
  if (addr.length < 12) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
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
  const [gasHint, setGasHint] = useState<GasHint | null>(null)
  const [copied, setCopied] = useState(false)

  const needsVaultOpen = holding.rail.code === 'USD' && !holding.rail.wrapper

  async function ensureStandardVault() {
    let wrapper = await readUsdWrapper()
    if (!wrapper) {
      setBusy('Opening standard growth on the network…')
      wrapper = await ensureUsdWrapper(sendTransaction, setBusy)
    }
    setRailWrapper('USD', wrapper)
    holding.rail.wrapper = wrapper
    return wrapper
  }

  async function copyAddress(addr: string) {
    try {
      await navigator.clipboard.writeText(addr)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* ignore */
    }
  }

  async function move(direction: 'grow' | 'available') {
    if (!address || !walletReady) {
      setError('Your account is not ready yet.')
      setGasHint(null)
      return
    }
    setError(null)
    setGasHint(null)
    setBusy('Preparing…')
    try {
      await ensureRhGas({
        owner: address,
        send: sendTransaction,
        progress: setBusy,
      })
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
      setGasHint(parseGasHint(cause, address))
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
          <p style={{ margin: 0 }}>{error}</p>
          {gasHint && (
            <div style={{ marginTop: 12 }}>
              <p className="small muted" style={{ margin: '0 0 6px' }}>
                Your Accrue address — send a little <strong>ETH on Base</strong>{' '}
                here:
              </p>
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                  flexWrap: 'wrap',
                }}
              >
                <code
                  className="figure"
                  style={{
                    fontSize: '0.85rem',
                    wordBreak: 'break-all',
                    flex: 1,
                    minWidth: 0,
                  }}
                  title={gasHint.address}
                >
                  {gasHint.address}
                </code>
                <button
                  type="button"
                  className="btn btn-quiet"
                  style={{ width: 'auto', padding: '8px 12px', flexShrink: 0 }}
                  onClick={() => void copyAddress(gasHint.address)}
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <p className="small muted" style={{ margin: '8px 0 0' }}>
                Network: <strong>Base</strong> · not Ethereum mainnet · not
                Robinhood. After it lands, tap the button again (
                {shorten(gasHint.address)}).
              </p>
            </div>
          )}
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
          ? 'Standard growth opens once. Network fee uses a scrap of ETH — we’ll pull it from Base to Robinhood when you have some.'
          : 'A small entry or exit charge stays in the standard account and increases value per unit for everyone who remains.'}
      </p>
    </div>
  )
}
