// Production auth seam: Privy email/SMS login → embedded EVM wallet.
//
// App ID is public. Mobile client ID (client-…) is public too when using
// Capacitor. NEVER put PRIVY_APP_SECRET in VITE_* — it ships in the browser.
//
// Gas:
// 1) Base only: try Privy client sponsor:true (dashboard “allow from client”)
// 2) Else self-pay with user’s ETH on that chain
// Server /api/accrue-sponsor-tx is intentionally NOT used for embedded wallets:
// Privy wallet RPC needs a user authorization signature; JWT exchange rejects
// the browser access token in this app setup (“Invalid JWT token provided”).
// Robinhood (4663) is never sponsored — ensureRhGas bridges Base ETH → RH.

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
} from '@privy-io/react-auth'
import { base } from 'viem/chains'
import { defineChain, type Hash } from 'viem'
import type { Address } from 'viem'
import { BASE_CHAIN_ID, CHAIN_ID, RH_RPC_URLS, RPC_URL } from './rails'

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
  /** Explicit gas limit — set when eth_estimateGas is flaky (thin V3 swaps on RH). */
  gas?: bigint
  /** Defaults to Robinhood (4663). Use BASE_CHAIN_ID for Base-only ops. */
  chainId?: number
  /**
   * Prefer gas sponsorship (default true on Base). Set false to force self-pay.
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

function humanSendError(err: unknown, chainId: number): Error {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  if (/app secret is required|gas sponsored|PRIVY_APP_SECRET/i.test(msg)) {
    return new Error(
      'Keep a little ETH on Base for network fees (~$0.30+), then retry. Your dollars are safe.',
    )
  }
  if (/insufficient funds|gas required|intrinsic gas/i.test(msg)) {
    return new Error(
      chainId === CHAIN_ID
        ? 'Not enough Robinhood network fee. If you have ETH on Base, retry — we’ll move a tiny fee over. Your dollars are safe.'
        : 'Not enough ETH on Base for this step (value + gas). Send ~$1 of ETH on Base to your Accrue address, then try again.',
    )
  }
  return err instanceof Error ? err : new Error(msg || 'Transaction failed')
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
      // Only attempt client sponsorship on Base (Privy-supported app-pays chain).
      const wantClientSponsor =
        tx.sponsor !== false && chainId === BASE_CHAIN_ID

      const sendClient = async (useSponsor: boolean) => {
        await embeddedWallet.switchChain(chainId)
        return sendPrivyTransaction(
          {
            to: tx.to,
            data: tx.data,
            value: tx.value,
            chainId,
            ...(tx.gas != null ? { gas: tx.gas } : {}),
          },
          {
            address: embeddedWallet.address,
            sponsor: useSponsor,
            uiOptions: { showWalletUIs: false },
          },
        )
      }

      // 1) Client-sponsored Base when dashboard allows it
      if (wantClientSponsor) {
        try {
          const result = await sendClient(true)
          return result.hash as Hash
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err ?? '')
          // Fall through to self-pay when sponsorship is disabled / needs app secret
          if (
            !/app secret is required|gas sponsored|sponsor|invalid_data/i.test(
              msg,
            )
          ) {
            throw humanSendError(err, chainId)
          }
        }
      }

      // 2) Self-pay — Base gas bridge + all RH Steady txs after ensureRhGas
      try {
        const result = await sendClient(false)
        return result.hash as Hash
      } catch (err) {
        throw humanSendError(err, chainId)
      }
    },
    [embeddedWallet, sendPrivyTransaction],
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
