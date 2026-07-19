// Production auth seam: Privy email/SMS login → embedded EVM wallet.
//
// App ID is public. Mobile client ID (client-…) is public too when using
// Capacitor. NEVER put PRIVY_APP_SECRET in VITE_* — it would ship in the
// browser bundle. Web works with appId alone; mobile needs clientId.
//
// Gas: Privy App-pays sponsorship works on Base (and listed chains). Robinhood
// mainnet (4663) is NOT in Privy’s sponsored set — only “Robinhood Testnet”.
// Deposit path = Coinbase/Base → Relay → RH. Never pass sponsor:true on 4663.

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

/** Only accept real mobile client ids — reject app secrets pasted by mistake. */
const PRIVY_CLIENT_ID =
  rawClientId &&
  rawClientId.startsWith('client-') &&
  !rawClientId.startsWith('privy_app')
    ? rawClientId
    : undefined

if (rawClientId && !PRIVY_CLIENT_ID) {
  console.error(
    '[accrue.fund] VITE_PRIVY_CLIENT_ID looks like an app secret or wrong value. ' +
      'Use the mobile client id (starts with client-), or leave it empty for web. ' +
      'Rotate your Privy app secret if you ever put it in a VITE_ variable.',
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
  if (/app secret is required|gas sponsored/i.test(msg)) {
    return new Error(
      chainId === CHAIN_ID
        ? 'Network fees on Robinhood are not covered by Privy sponsorship. Add money uses Base → Relay (no RH gas). Standard growth / withdraw need a tiny RH network fee — we’re not creating vaults with broken sponsorship.'
        : 'Gas sponsorship failed on this network. Try again, or check Privy App pays + client allow for Base.',
    )
  }
  if (/insufficient funds|gas required|intrinsic gas/i.test(msg)) {
    return new Error(
      'Not enough network fee on this chain. Deposits still work via Base → Relay.',
    )
  }
  return err instanceof Error ? err : new Error(msg || 'Transaction failed')
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
      const chainId = tx.chainId ?? CHAIN_ID
      // Privy native sponsorship: Base yes · Robinhood mainnet no (docs list
      // only Robinhood Testnet). sponsor:true on 4663 → "App secret required".
      const sponsor = chainId === BASE_CHAIN_ID
      try {
        await embeddedWallet.switchChain(chainId)
        const result = await sendPrivyTransaction(
          {
            to: tx.to,
            data: tx.data,
            value: tx.value,
            chainId,
          },
          {
            address: embeddedWallet.address,
            sponsor,
            uiOptions: { showWalletUIs: false },
          },
        )
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
        // Base for Coinbase/onramp + Relay origin; RH for USDG settlement.
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
