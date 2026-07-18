# Accrue · [accrue.fund](https://accrue.fund)

Mobile money app: **dollar accounts** that are designed to grow, with an optional
**Boost** risk dial. Built with Capacitor (iOS / Android), Privy login, and
Robinhood Chain under the hood.

| | |
|--|--|
| **Bundle ID** | `fund.accrue` |
| **Deep link** | `accrue://auth` |
| **Stack** | Vite · React · Capacitor 6 · Privy · viem |

Consumer screens never say “chain,” “token,” or “LP.” That language lives only
in legal copy and this README.

---

## What the product does

```
  Add money          Standard              Boost                 Withdraw
  ─────────          ────────              ─────                 ────────
  Card / bank   →    Dollar account   →    Steady (calm)    →    Bank / cash out
  (via Privy)        value/unit            or Growth (hot)
                     designed to rise
```

| Mode | User story | Under the hood (devs only) |
|------|------------|----------------------------|
| **Standard** | Balance sits in your dollar account; value per unit is designed only to go up | Deposit USDG into a fee-accruing ERC-4626 wrapper (wUSDG) |
| **Steady Boost** | Lower risk, lower reward — still dollar-linked | LP **USDG ↔ wUSDG** |
| **Growth Boost** | Higher risk, higher reward — can fall hard | Engine picks deepest **USDG ↔ stock** pool, swaps half, LPs |
| **Add money** | Fiat in | Privy onramp → Base USDC → Relay → USDG on Robinhood |
| **Withdraw** | Cash out | USDG → Relay → Base USDC (± bank partner API later) |

EUR / GBP / gold show as **Coming soon** until Robinhood lists those assets.

---

## Quick start

```sh
git clone https://github.com/accruedotfund/accrue.fund.git
cd accrue.fund
cp .env.example .env.local
# edit .env.local — at minimum Privy IDs (see below)
bun install
bun test
bun run dev          # web
bun run build
npx cap sync android # after first build
```

**Required tooling:** [Bun](https://bun.sh), Node-compatible JDK **21** for Android,
Xcode for iOS.

---

## Environment variables

Copy `.env.example` → **`.env.local`** (gitignored). Vite only exposes keys that
start with `VITE_`.

### Required to open the app

| Variable | What it is | Where to get it |
|----------|------------|-----------------|
| **`VITE_PRIVY_APP_ID`** | Public Privy application id | [dashboard.privy.io](https://dashboard.privy.io) → Accrue app → Settings |
| **`VITE_PRIVY_CLIENT_ID`** | Public **mobile** client id | Same app → Clients → mobile / Capacitor client |

Without these two, the app shows **“Accrue is not configured”** and will not log in.

**Privy setup checklist**

1. Create a **new** app named Accrue (do not reuse another product’s app).
2. Login methods: **email + SMS**.
3. Embedded wallets: create Ethereum wallet on login.
4. Allowed origins:
   - `https://accrue.fund`
   - `capacitor://localhost` (iOS)
   - `https://localhost` (Android)
5. Deep link / redirect: `accrue://auth`
6. **Wallet → Gas sponsorship → App pays** → enable **Robinhood Chain (4663)** and add billing if prompted.
7. Onramp: enable fiat providers that can pay **Base** (USDC). Robinhood is not a native Privy funding destination; Relay bridges Base → RH.

> Never put `PRIVY_APP_SECRET` in the mobile env. Secrets belong on a server only.

### Strongly recommended (production money movement)

| Variable | Default / note |
|----------|----------------|
| **`VITE_API_BASE`** | Origin of your API, e.g. `https://accrue.fund`. Used for bank cashout sessions (`POST /api/accrue-offramp-session`). If empty, withdraw still works via on-device Relay → Base USDC. |
| **`VITE_RH_RPC`** | Preferred Robinhood RPC. Default public: `https://robinhood-rpc.publicnode.com`. Put Alchemy/dRPC first when you have a key. |
| **`VITE_RH_RPCS`** | Optional comma-separated list (tried in order, then built-in fallbacks). |

Built-in RPC fallbacks (always):

1. PublicNode · `https://robinhood-rpc.publicnode.com`  
2. Blockscout · `https://robinhoodchain.blockscout.com/api/eth-rpc`  
3. Official · `https://rpc.mainnet.chain.robinhood.com`  

### Chain addresses (ship with known defaults)

These already have correct mainnet defaults in code / `.env.example`. Override only if you redeploy.

| Variable | Role | Default |
|----------|------|---------|
| `VITE_USD_STABLE` | Cash asset (USDG) | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |
| `VITE_WRAPPER_FACTORY` | Creates wUSDG | `0xa9d906b8e0FFb15fdff5Efb50eEee34F1165bB03` |
| `VITE_BOOST_ROUTER` | Uniswap V2-style router | `0x89e5db8b5aa49aa85ac63f691524311aeb649eba` |
| `VITE_USD_DECIMALS` | USDG decimals | `6` |
| `VITE_USD_WRAPPER` | wUSDG address | *empty until created* (app can create on first sponsored login) |
| `VITE_USD_BOOST_PAIR` | Steady LP pair | *optional*; auto-resolved via factory if empty |

### Optional

| Variable | When you need it |
|----------|------------------|
| `VITE_RELAY_QUOTE_URL` / `VITE_RELAY_STATUS_URL` | Only to point at non-prod Relay |
| `VITE_PAIR_FACTORY` | Override Uniswap V2 factory (`0x8bce…7937f`) |
| `VITE_GROWTH_PAIR_*` | Pin Growth pools (NVDA, TSLA, …) instead of deepest auto-pick |
| `VITE_EUR_*` / `VITE_GBP_*` / `VITE_XAU_*` | Leave empty — rails are tabled |
| `ACTIVE_RAILS` | Release checker list; default `USD` |

### Server-only (never in the app bundle)

If you deploy the offramp API (monorepo or accrue.fund backend):

| Variable | Role |
|----------|------|
| `PRIVY_APP_SECRET` | Verify `Bearer` access tokens |
| `ACCRUE_OFFRAMP_URL` | Optional HTTPS bank cashout URL template |

### Android release (shell, not Vite)

| Variable | Role |
|----------|------|
| `ACCRUE_KEYSTORE_PASSWORD` | Signs Play AAB (`android/app/build.gradle`) |

---

## Minimal `.env.local` (dev)

```env
VITE_PRIVY_APP_ID=clxxxxxxxx
VITE_PRIVY_CLIENT_ID=client-xxxxxxxx
VITE_RH_RPC=https://robinhood-rpc.publicnode.com
```

That’s enough to log in, open the UI, and hit public RPCs. Funding and Boost
need Privy gas + onramp configured, and wUSDG (auto-create or set
`VITE_USD_WRAPPER`).

---

## Scripts

| Command | Purpose |
|---------|---------|
| `bun run dev` | Vite dev server |
| `bun test` | Unit + live Relay quote tests |
| `bun run build` | Typecheck + production web bundle |
| `bun run release:check` | Fail-closed rail/config verification |
| `bun run android` | Build web → Cap sync → open Android Studio |
| `bun run ios` | Build web → Cap sync → open Xcode |
| `bun run android:release` | release:check → bundleRelease (needs keystore password) |

Android debug:

```sh
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
bun run build && npx cap sync android
cd android && ./gradlew assembleDebug
# APK: android/app/build/outputs/apk/debug/app-debug.apk
```

---

## Architecture (short)

```
src/
  screens/     Welcome · Home · Account · Boost · Fund · Profile
  lib/
    auth.tsx     Privy session + sponsored txs
    rails.ts     Fiat rails + multi-RPC list
    factory.ts   Ensure wUSDG exists
    vault.ts     Deposit / redeem standard
    boost.ts     Steady + Growth enter/exit
    strategies.ts  Risk tiers + stock candidate list
    relay.ts     Base ↔ Robinhood deposit quotes
    withdraw.ts  Outbound Relay settlement
```

**Funding path:** fiat → Privy pays **Base USDC deposit address** from Relay →
Relay fills **USDG** on Robinhood to the user’s embedded wallet.

**Boost path:** user picks **Steady** or **Growth** only — never a token list.

---

## First-time chain setup

1. Privy gas sponsorship live on Robinhood.  
2. User logs in → app calls `factory.create(USDG, 100, 100, 100)` once if
   `wrapperOf(USDG)` is zero (or you set `VITE_USD_WRAPPER` after a forge deploy).  
3. Steady needs a liquid **USDG/wUSDG** pair; Growth needs liquid **USDG/stock**
   pairs (auto-discovered). Empty liquidity → UI shows **Opening soon**.

---

## Compliance

- Accrue is **not a bank**; balances are not deposit-insured.  
- Boost can lose value; double opt-in (checkbox + hold) is mandatory.  
- App Store / Play metadata must disclose digital-asset functionality.  
- In-app Terms / Privacy are **drafts** — counsel before launch.

---

## Repo hygiene

- No product IDs shared with other brands.  
- `.env*` secrets stay local (see `.gitignore`).  
- Canonical package / homepage: **accrue.fund**.
