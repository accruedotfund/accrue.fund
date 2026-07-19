// Production auth seam: Privy email/SMS login → embedded EVM wallet.
//
// App ID is public. Mobile client ID (client-…) is public too when using
// Capacitor. NEVER put PRIVY_APP_SECRET in VITE_* — it ships in the browser.
//
// Gas sponsorship (App pays):
// 1) Client sponsor:true when Privy allows it
// 2) Else POST /api/accrue-sponsor-tx with server PRIVY_APP_SECRET
// 3) Else self-pay (user ETH on that chain)
// Robinhood mainnet may still fail sponsorship if not on Privy’s list — then
// we top up RH ETH from Base via Relay (gasBridge).

import {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from 'react'
import {
  PrivyProvider,
  usePrivy,
  useSendTransaction,
  useWallets,
  type ConnectedWallet,
  type User,
} from '@privy-io/react-auth'
import { base } from 'viem/chains'
import { defineChain, type Hash } from 'viem'
import type { Address } from 'viem'
import { API_BASE, BASE_CHAIN_ID, CHAIN_ID, RH_RPC_URLS, RPC_URL } from './rails'

const PRIVY_APP_ID = (import.meta.env.VITE_PRIVY_APP_ID as string | undefined)?.trim()
const rawClientId = (import.meta.env.VITE_PRIVY_CLIENT_ID as string | undefined)?.trim()

const PRIVY_CLIENT_ID =
  rawClientId &&
  rawClientId.startsWith('client-') &&
  !rawClientId.startsWith('privy_app')
    ? rawClientId
    : undefined

if (rawClientId && !PRIVY_CLIENT_ID) {
  console.error(
    '[accrue.fund] VITE_PRIVY_CLIENT_ID looks like an app secret or wrong value. ' +
      'Use the mobile client id (starts with client-), or leave it empty for web.',
  )
}

if (!PRIVY_APP_ID) {
  console.error(
    '[accrue.fund] Set VITE_PRIVY_APP_ID (Privy → Accrue app → Settings).',
  )
}

const robinhoodChain = defineChain({
  id: CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: RH_RPC_URLS },
    public: { http: RH_RPC_URLS },
  },
  blockExplorers: {
    default: {
      name: 'Robinhood Chain Explorer',
      url: 'https://robinhoodchain.blockscout.com',
    },
  },
})

void RPC_URL

export interface TransactionRequest {
  to: Address
  data?: `0x${string}`
  value?: bigint
  /** Defaults to Robinhood (4663). Use BASE_CHAIN_ID for Base-only ops. */
  chainId?: number
  /**
   * Prefer gas sponsorship (default true on Base). Set false to force self-pay.
   * Client → server sponsor API → self-pay.
   */
  sponsor?: boolean
}

export interface Session {
  ready: boolean
  authenticated: boolean
  email?: string
  address?: Address
  walletReady: boolean
  sendTransaction: (tx: TransactionRequest) => Promise<Hash>
  getAccessToken: () => Promise<string | null>
  login: () => void
  logout: () => void
}

const Ctx = createContext<Session | null>(null)

export function useAuth(): Session {
  const s = useContext(Ctx)
  if (!s) throw new Error('useAuth outside AuthProvider')
  return s
}

function walletIdForAddress(
  user: User | null | undefined,
  address: string,
): string | undefined {
  const want = address.toLowerCase()
  for (const a of user?.linkedAccounts ?? []) {
    if (a.type !== 'wallet') continue
    const w = a as { id?: string; address?: string }
    if (w.address?.toLowerCase() === want && w.id) return w.id
  }
  return undefined
}

function humanSendError(err: unknown, chainId: number): Error {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  if (/app secret is required|gas sponsored|PRIVY_APP_SECRET/i.test(msg)) {
    return new Error(
      chainId === CHAIN_ID
        ? 'Could not sponsor network fees on Robinhood. We can top up from Base ETH — try again. Your dollars are safe.'
        : 'Could not sponsor network fees. Set PRIVY_APP_SECRET on the server, or keep a little ETH on Base for gas.',
    )
  }
  if (/insufficient funds|gas required|intrinsic gas/i.test(msg)) {
    return new Error(
      chainId === CHAIN_ID
        ? 'Not enough Robinhood network fee. If you have ETH on Base, retry — we’ll move a tiny fee over. Deposits never need RH ETH.'
        : 'Not enough ETH on Base for this step (value + gas). Top up Base ETH and try again.',
    )
  }
  return err instanceof Error ? err : new Error(msg || 'Transaction failed')
}

async function sendSponsoredOnServer(opts: {
  walletId: string
  chainId: number
  tx: TransactionRequest
  getAccessToken: () => Promise<string | null>
}): Promise<Hash> {
  const accessToken = await opts.getAccessToken()
  if (!accessToken) throw new Error('Your session has expired')

  const origin =
    API_BASE ||
    (typeof window !== 'undefined' ? window.location.origin : '')
  if (!origin) throw new Error('API origin not configured for sponsorship')

  const res = await fetch(`${origin}/api/accrue-sponsor-tx`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      walletId: opts.walletId,
      caip2: `eip155:${opts.chainId}`,
      transaction: {
        to: opts.tx.to,
        data: opts.tx.data,
        value:
          opts.tx.value != null ? opts.tx.value.toString() : undefined,
      },
    }),
  })
  const body = (await res.json().catch(() => ({}))) as {
    hash?: string
    error?: string
  }
  if (!res.ok || !body.hash || !/^0x[a-fA-F0-9]{64}$/.test(body.hash)) {
    throw new Error(body.error || `Sponsored send failed (${res.status})`)
  }
  return body.hash as Hash
}

function PrivyBridge({ children }: { children: ReactNode }) {
  const { ready, authenticated, user, getAccessToken, login, logout } =
    usePrivy()
  const { ready: walletsReady, wallets } = useWallets()
  const { sendTransaction: sendPrivyTransaction } = useSendTransaction()

  const embeddedWallet = useMemo<ConnectedWallet | undefined>(
    () =>
      wallets.find(
        (wallet) =>
          wallet.walletClientType === 'privy' && wallet.type === 'ethereum',
      ) ?? wallets.find((wallet) => wallet.type === 'ethereum'),
    [wallets],
  )

  const sendTransaction = useMemo(
    () => async (tx: TransactionRequest): Promise<Hash> => {
      if (!embeddedWallet) throw new Error('Your account is not ready.')
      const chainId = tx.chainId ?? CHAIN_ID
      // Want sponsorship by default on Base (low friction). RH: still try server
      // sponsor; client sponsor rarely works there.
      const wantSponsor = tx.sponsor !== false

      const sendClient = async (useSponsor: boolean) => {
        await embeddedWallet.switchChain(chainId)
        return sendPrivyTransaction(
          {
            to: tx.to,
            data: tx.data,
            value: tx.value,
            chainId,
          },
          {
            address: embeddedWallet.address,
            sponsor: useSponsor,
            uiOptions: { showWalletUIs: false },
          },
        )
      }

      const walletId = walletIdForAddress(user, embeddedWallet.address)

      // 1) Client-sponsored (works when Privy “Allow from client” is on)
      if (wantSponsor && chainId === BASE_CHAIN_ID) {
        try {
          const result = await sendClient(true)
          return result.hash as Hash
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err ?? '')
          if (!/app secret is required|gas sponsored|invalid_data/i.test(msg)) {
            // Non-sponsor error (user reject, etc.) — don't mask
            if (!/sponsor|app secret/i.test(msg)) throw humanSendError(err, chainId)
          }
          // fall through to server sponsor
        }
      }

      // 2) Server-sponsored with PRIVY_APP_SECRET
      if (wantSponsor && walletId) {
        try {
          return await sendSponsoredOnServer({
            walletId,
            chainId,
            tx,
            getAccessToken,
          })
        } catch {
          // fall through to self-pay
        }
      }

      // 3) Self-pay
      try {
        const result = await sendClient(false)
        return result.hash as Hash
      } catch (err) {
        throw humanSendError(err, chainId)
      }
    },
    [embeddedWallet, sendPrivyTransaction, user, getAccessToken],
  )

  const value = useMemo<Session>(
    () => ({
      ready: ready && walletsReady,
      authenticated,
      email: user?.email?.address,
      address: embeddedWallet?.address as Address | undefined,
      walletReady: Boolean(embeddedWallet),
      sendTransaction,
      getAccessToken,
      login,
      logout,
    }),
    [
      ready,
      walletsReady,
      authenticated,
      user,
      embeddedWallet,
      sendTransaction,
      getAccessToken,
      login,
      logout,
    ],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function AuthProvider({ children }: { children: ReactNode }) {
  if (!PRIVY_APP_ID) {
    return (
      <div className="frame">
        <div className="screen" style={{ justifyContent: 'center' }}>
          <div className="empty">
            <p className="display" style={{ fontSize: '1.6rem' }}>
              Accrue is not configured
            </p>
            <p className="small muted" style={{ maxWidth: '34ch' }}>
              Set VITE_PRIVY_APP_ID for the Accrue Privy app. Optional
              VITE_PRIVY_CLIENT_ID is only for mobile (must start with client-).
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      {...(PRIVY_CLIENT_ID ? { clientId: PRIVY_CLIENT_ID } : {})}
      config={{
        loginMethods: ['email', 'sms'],
        embeddedWallets: {
          ethereum: { createOnLogin: 'users-without-wallets' },
        },
        supportedChains: [base, robinhoodChain],
        defaultChain: robinhoodChain,
        customOAuthRedirectUrl: 'accrue://auth',
        appearance: {
          theme: 'light',
          accentColor: '#2e5344',
          showWalletLoginFirst: false,
        },
      }}
    >
      <PrivyBridge>{children}</PrivyBridge>
    </PrivyProvider>
  )
}
