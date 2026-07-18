# Accrue · [accrue.fund](https://accrue.fund)

Dollar accounts on Robinhood Chain with **Standard**, **Steady Boost**, and
**Growth Boost**. Consumer UI stays fiat-language; chain detail lives in legal.

Bundle ID: `fund.accrue` · deep link: `accrue://auth`

## Product

| Surface | What it is |
|---------|------------|
| **Standard** | wUSDG vault — NAV designed to only rise (entry/exit fees stay in) |
| **Steady Boost** | Lower risk · USDG ↔ wUSDG LP |
| **Growth Boost** | Higher risk · engine LPs USDG ↔ curated stock (deepest live pool) |
| **Move money** | In: Privy → Base USDC → Relay → USDG. Out: Relay reverse (optional bank API) |

EUR / GBP / gold are tabled until those underlyings exist on Robinhood Chain.

## Identity (clean cut)

This repo is **Accrue only** — no shared product IDs.

1. Create a **new Privy app** named Accrue at [dashboard.privy.io](https://dashboard.privy.io)
2. Add allowed origins: `capacitor://localhost`, `https://localhost`, `https://accrue.fund`
3. Gas sponsorship → **App pays** → enable Robinhood Chain (4663)
4. Copy app ID + mobile client ID into `.env.local` (see `.env.example`)

## RPCs (Robinhood 4663)

Fallback order (verified free public endpoints):

1. `https://robinhood-rpc.publicnode.com`
2. `https://robinhoodchain.blockscout.com/api/eth-rpc`
3. `https://rpc.mainnet.chain.robinhood.com`

Override with `VITE_RH_RPC` / `VITE_RH_RPCS`.

## Setup

```sh
cp .env.example .env.local   # fill Privy IDs
bun install
bun test
bun run build
npx cap sync android
npx cap sync ios
```

Android (JDK 21):

```sh
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
cd android && ./gradlew assembleDebug
```

Signed Play AAB needs `ACCRUE_KEYSTORE_PASSWORD`.

## Wrapper (wUSDG)

Factory `0xa9d906b8…bb03` — permissionless `create(USDG, 100, 100, 100)`.
First sponsored login can create it, or:

```sh
cd contracts/robinhood-wrappers   # if present alongside
PRIVATE_KEY=0x… forge script script/CreateUsdgWrapper.s.sol \
  --rpc-url https://robinhood-rpc.publicnode.com --broadcast
```

## Off-ramp API

Optional: deploy `POST /api/accrue-offramp-session` and set
`VITE_API_BASE=https://accrue.fund`. Without it, the app settles withdraws via
Relay to Base USDC on-device.

## Compliance

- Not a bank; no deposit insurance claims  
- Boost risk copy + hold-to-confirm stay  
- Store review must disclose digital-asset rails  
