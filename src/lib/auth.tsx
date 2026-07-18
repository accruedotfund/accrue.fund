// Production auth seam: Privy email/SMS login → embedded EVM wallet.
//
// App ID and mobile client ID are public identifiers for the Accrue (accrue.fund)
// Privy application — never hardcode another product's IDs here. The Privy app
// secret must never be shipped in this bundle. There is deliberately no
// demo-auth fallback: a release that cannot authenticate must fail loudly.

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
import { defineChain, type Hash } from 'viem'
import type { Address } from 'viem'
import { CHAIN_ID, RH_RPC_URLS, RPC_URL } from './rails'

const PRIVY_APP_ID = import.meta.env.VITE_PRIVY_APP_ID as string | undefined
const PRIVY_CLIENT_ID = import.meta.env.VITE_PRIVY_CLIENT_ID as string | undefined

if (!PRIVY_APP_ID || !PRIVY_CLIENT_ID) {
  // Loud failure at module load in production builds; dev still mounts so
  // designers can work on non-auth screens.
  console.error(
    '[accrue.fund] Set VITE_PRIVY_APP_ID and VITE_PRIVY_CLIENT_ID (new Accrue Privy app — not shared with any other product).',
  )
} else if (
  !PRIVY_CLIENT_ID.startsWith('client-') &&
  !PRIVY_CLIENT_ID.startsWith('cl')
) {
  // Mobile client IDs from Privy are usually `client-…`. App secrets / other
  // tokens will fail login with opaque errors — warn early.
  console.warn(
    '[accrue.fund] VITE_PRIVY_CLIENT_ID does not look like a mobile client id (expected client-…). Check Privy → App → Clients.',
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

function PrivyBridge({ children }: { children: ReactNode }) {
  const { ready, authenticated, user, getAccessToken, login, logout } = usePrivy()
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
      await embeddedWallet.switchChain(CHAIN_ID)
      const result = await sendPrivyTransaction(
        {
          to: tx.to,
          data: tx.data,
          value: tx.value,
        },
        {
          address: embeddedWallet.address,
          sponsor: true,
          uiOptions: { showWalletUIs: false },
        },
      )
      return result.hash as Hash
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
  if (!PRIVY_APP_ID || !PRIVY_CLIENT_ID) {
    return (
      <div className="frame">
        <div className="screen" style={{ justifyContent: 'center' }}>
          <div className="empty">
            <p className="display" style={{ fontSize: '1.6rem' }}>
              Accrue is not configured
            </p>
            <p className="small muted" style={{ maxWidth: '32ch' }}>
              Set VITE_PRIVY_APP_ID and VITE_PRIVY_CLIENT_ID for the Accrue
              Privy application (accrue.fund).
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      clientId={PRIVY_CLIENT_ID}
      config={{
        loginMethods: ['email', 'sms'],
        embeddedWallets: {
          ethereum: { createOnLogin: 'users-without-wallets' },
        },
        supportedChains: [robinhoodChain],
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
