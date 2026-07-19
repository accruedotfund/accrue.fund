# ACCRUE · [accrue.fund](https://accrue.fund)

### money that works harder than you do.

not a bank. not a casino UI. not another “defi education” homework app.

**you put dollars in. you pick how spicy. you take dollars out.**  
the chain stays under the floorboards where it belongs.

```
  ╭────────────╮     ╭────────────╮     ╭────────────╮     ╭────────────╮
  │ ADD MONEY  │ ──▶ │  DOLLARS   │ ──▶ │   BOOST    │ ──▶ │  CASH OUT  │
  │ card/bank  │     │  standard  │     │ calm / hot │     │  bank time │
  ╰────────────╯     ╰────────────╯     ╰────────────╯     ╰────────────╯
```

live · shipping in public · rough edges included  
**https://accrue.fund**

---

## the pitch

inflation is a silent tax. savings accounts are a participation trophy.

most people will never open a block explorer and **they should not have to**.

accrue is for the next billion users who do not know (or care) that they are on crypto rails. they want:

- **more money** than sitting in a checking account  
- **no seed phrases, no gas memes, no ticker soup** in the product UI  
- **on / off ramps** that feel like paying a bill, not bridging a L2  

under the hood? robinhood chain, USDG, relay, privy, base settlement.  
in the app? **dollar account. boost. move money.** done.

| they see | you know |
|----------|----------|
| dollar account | USDG + vault on RH |
| value / unit up | NAV-up wrapper (fees stay in the vault) |
| steady boost | calmer dollar-linked LP |
| growth boost | higher beta · can dump hard |
| add money | card/bank/coinbase/moonpay → base USDC → relay → USDG |
| withdraw | USDG → relay → base USDC → bank partner when wired |

**no “defi.” no “gas sponsorship drama” in the UI.** just rates that don’t suck.

---

## modes (pick your poison)

| mode | vibe | risk |
|------|------|------|
| **standard** | park it. value/unit designed only to climb | chill |
| **steady boost** | dollar-linked, still working | medium |
| **growth boost** | market-linked · can fall hard | degen |

EUR / GBP / gold: **coming soon** when the rails exist. USD is live.

---

## status (realtime)

| | |
|--|--|
| **web** | 🟢 [accrue.fund](https://accrue.fund) |
| **android** | debug APK ships (`fund.accrue`) |
| **ios** | capacitor · needs your xcode / device |
| **repo** | [accruedotfund/accrue.fund](https://github.com/accruedotfund/accrue.fund) |
| **stack** | vite · react · capacitor 6 · privy · viem · relay · base |

this repo is **WIP**. feats and fixes go to prod as we cook. expect blood.

---

## for the next billion (product law)

1. **zero chain vocabulary** on the consumer surface  
2. **sign up = email/SMS** · wallet is an implementation detail  
3. **add money** asks *how* you pay (card/bank · coinbase · moonpay · all options) — coinbase is optional  
4. **boost** double-opts people into risk  
5. **cash out** without teaching them CAIP-2  

if you need a seed phrase tutorial, you shipped the wrong product.

---

## ship it (builders)

```sh
git clone https://github.com/accruedotfund/accrue.fund.git
cd accrue.fund
cp .env.example .env
# VITE_PRIVY_APP_ID=cm…
bun install && bun test && bun run dev
```

| command | what |
|---------|------|
| `bun run dev` | local web |
| `bun test` | unit + live relay quotes |
| `bun run build` | prod bundle |
| `./scripts/build-debug.sh` | web + android debug apk |
| `./scripts/deploy-web.sh` | prebuilt vercel prod (real `.env`, no `[SENSITIVE]` bake-in) |

apk: `android/app/build/outputs/apk/debug/app-debug.apk`

### env that matters

**client (ok in `VITE_*`):**

```env
VITE_PRIVY_APP_ID=cmxxxxxxxx
VITE_API_BASE=https://accrue.fund
VITE_RH_RPC=https://robinhood-rpc.publicnode.com
# VITE_PRIVY_CLIENT_ID=client-…   # mobile only — never paste app secret here
```

**server only (vercel, never `VITE_*`):**  
`PRIVY_APP_SECRET` · `CDP_API_KEY_ID` · `CDP_API_KEY_SECRET` · `ACCRUE_OFFRAMP_REDIRECT_URL`

⚠️ pasting **app secret** into `VITE_PRIVY_CLIENT_ID` nukes login. rotate if you ever did that.

### privy (minimum)

- dedicated **Accrue** app · email + SMS · embedded EVM  
- origins: `https://accrue.fund`, `capacitor://localhost`, `https://localhost`  
- redirect: `accrue://auth`  
- onramp → **base** (relay does the rest to RH)  
- **app pays** gas is for *base / supported chains* — RH mainnet is user-pays ETH  

### identity (no other brands)

| layer | owner |
|-------|--------|
| github | `accruedotfund/accrue.fund` |
| git author | `accruedotfund@users.noreply.github.com` |
| bundle | `fund.accrue` |
| hosting | accrue-only vercel · public (no SSO wall) |

---

## architecture (short)

```
src/screens/   welcome · home · account · boost · fund · profile
src/lib/       auth · rails · factory · vault · boost · relay · withdraw
api/           accrue-offramp-session  (cdp sell / bank hop)
```

settlement mental model:

```
  IN   card/bank  →  base USDC  →  relay  →  RH USDG
  OUT  RH USDG    →  relay      →  base USDC  →  bank (when partner live)
```

---

## compliance (don’t get rekt legally)

- not a bank · not FDIC / CDIC / whatever  
- boost can go down · we say so twice  
- store review: disclose digital-asset rails  
- terms / privacy: draft until counsel signs off  

---

## vibe check

> **put money in. choose how hard it works. take money out.**  
> the rest is plumbing.

**accrue.fund** · built in public · for people who just want the bag to grow

<!-- hypertribe:sponsors:start -->
## Sponsors

[![accrue.fund Sponsors](https://api.tribe.run/tokens/DUMA8e5M5AcyhCjKeevWnCVRiKtNpUmMb9nNC4BskdPK/sponsors.svg)](https://tribe.run/token/DUMA8e5M5AcyhCjKeevWnCVRiKtNpUmMb9nNC4BskdPK)

Become a sponsor on [Tribe.run](https://tribe.run/token/DUMA8e5M5AcyhCjKeevWnCVRiKtNpUmMb9nNC4BskdPK).
<!-- hypertribe:sponsors:end -->
