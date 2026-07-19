# Accrue · [accrue.fund](https://accrue.fund)

> **Work in progress.** Feats and fixes ship to production in realtime as we
> build. Expect rough edges; the product surface and rails are actively
> changing.

---

## Onboarding the next billion

Most people will never open a block explorer. They should not have to.

**Accrue is for the next billion users who do not realize they are on crypto
rails** — they just want their money to turn into more money at a rate many
magnitudes above inflation, without learning a new vocabulary.

| What they see | What is actually happening |
|---------------|----------------------------|
| Dollar account | USDG on Robinhood Chain in a wallet created at sign-up |
| Value per unit goes up | NAV-up wrapper fees stay in the vault |
| Steady Boost | Calm dollar-linked liquidity |
| Growth Boost | Higher risk / higher reward market-linked liquidity |
| Add money / Withdraw | Fiat partners + Relay settlement — no “bridge” in the UI |

No token tickers in the product. No “DeFi.” No homework. Just: **put money in,
choose how hard it works, take money out.**

---

## Status

| Layer | State |
|-------|--------|
| **Web** | Deployed · https://accrue.fund (Vercel + TLS) |
| **Android debug** | Builds (`fund.accrue` APK) |
| **iOS** | Capacitor project; device needs Xcode platform/DDI |
| **Privy** | Dedicated Accrue app · **do not put app secret in `VITE_*`** |
| **wUSDG** | Created on first gas-sponsored login (or set `VITE_USD_WRAPPER`) |
| **Steady / Growth pools** | “Opening soon” until liquidity exists |

---

## Product map

```
  Add money          Standard              Boost                 Withdraw
  ─────────          ────────              ─────                 ────────
  Card / bank   →    Dollar account   →    Steady (calm)    →    Cash out
  (via Privy)        value/unit            or Growth (hot)
                     designed to rise
```

| Mode | User story | Under the hood (devs) |
|------|------------|------------------------|
| **Standard** | Balance in your dollar account; value/unit designed only to rise | USDG → wUSDG vault |
| **Steady Boost** | Lower risk, lower reward — still dollar-linked | LP USDG ↔ wUSDG |
| **Growth Boost** | Higher risk, higher reward — can fall hard | LP USDG ↔ curated stock (auto-picked) |
| **Add money** | Fiat in | Privy → Base USDC → Relay → USDG |
| **Withdraw** | Cash out | USDG → Relay → Base USDC (± bank API) |

EUR / GBP / gold: **Coming soon** until those assets exist on Robinhood Chain.

| | |
|--|--|
| **Bundle ID** | `fund.accrue` |
| **Deep link** | `accrue://auth` |
| **Stack** | Vite · React · Capacitor 6 · Privy · viem |
| **Deploy** | Clean hosting under Accrue identity only (see below) |
| **Repo** | https://github.com/accruedotfund/accrue.fund |
| **Git author** | `accruedotfund` · `accruedotfund@users.noreply.github.com` |

---

## Quick start

```sh
git clone https://github.com/accruedotfund/accrue.fund.git
cd accrue.fund
cp .env.example .env.local
# fill VITE_PRIVY_APP_ID (and optional client-… for mobile)
bun install
bun test
bun run dev
bun run build
./scripts/build-debug.sh   # web + Android debug APK
```

---

## Environment variables

Copy `.env.example` → **`.env` or `.env.local`** (gitignored — **never commit**).

### Required

| Variable | What | Where |
|----------|------|--------|
| **`VITE_PRIVY_APP_ID`** | Public app id (`cm…` / `cl…`) | Privy → Accrue → Settings |

### Optional (mobile)

| Variable | What | Where |
|----------|------|--------|
| **`VITE_PRIVY_CLIENT_ID`** | Mobile client id — **must start with `client-`** | Privy → Clients → create **Mobile** client |

### ⚠️ Common footgun (this broke login)

| Wrong | Right |
|-------|--------|
| Pasting **App Secret** (`privy_app_…`) into `VITE_PRIVY_CLIENT_ID` | That is a **server secret**. Never `VITE_*`. Causes `Invalid app client ID`. |
| Shipping secret in client bundle / Vercel `VITE_` env | Rotate secret in Privy dashboard immediately |

**Web:** app id alone is enough.  
**Capacitor:** create a mobile client and set `client-…`.

### Recommended

| Variable | Note |
|----------|------|
| `VITE_API_BASE=https://accrue.fund` | Offramp API origin |
| `VITE_RH_RPC` | Prefer paid RPC when you have one |

### Chain defaults (mainnet — usually leave as-is)

`VITE_USD_STABLE`, `VITE_WRAPPER_FACTORY`, `VITE_BOOST_ROUTER`, `VITE_USD_DECIMALS`  
`VITE_USD_WRAPPER` / `VITE_USD_BOOST_PAIR` — empty until created/funded.

### Server-only (Vercel project env, never `VITE_`)

| Variable | Role |
|----------|------|
| `PRIVY_APP_SECRET` | Verify bearer tokens on `/api/accrue-offramp-session` |
| `CDP_API_KEY_ID` | Coinbase Developer **Secret** API key id |
| `CDP_API_KEY_SECRET` | Coinbase Developer **Secret** private key |
| `ACCRUE_OFFRAMP_REDIRECT_URL` | Post-sell redirect (default `https://accrue.fund`) |
| `ACCRUE_OFFRAMP_URL` | Legacy generic bank URL (optional fallback) |

### Minimal web `.env`

```env
VITE_PRIVY_APP_ID=cmxxxxxxxx
VITE_API_BASE=https://accrue.fund
VITE_RH_RPC=https://robinhood-rpc.publicnode.com
# VITE_PRIVY_CLIENT_ID=client-…   # only for native apps
```

---

## Privy checklist

1. New app named **Accrue** (not shared with other products).  
2. Login: email + SMS · embedded EVM wallet on login.  
3. Allowed origins: `https://accrue.fund`, `capacitor://localhost`, `https://localhost`.  
4. Redirect: `accrue://auth`.  
5. Gas sponsorship → **App pays** → Robinhood Chain **4663**.  
6. Onramp can settle to **Base** (Relay bridges to Robinhood).  
7. **Never** put App Secret in mobile/web env.

---

## Deploy & ownership (no stacc / jarett)

**Product identity**

| Layer | Owner |
|-------|--------|
| GitHub | **`accruedotfund/accrue.fund`** only |
| Git commits | **`accruedotfund@users.noreply.github.com`** (not a personal email) |
| Privy | Dedicated Accrue app only |
| Bundle | `fund.accrue` |

**Do not** use stacc / jarett GitHub, Vercel, or Fly accounts for this product.

### Why deploys were blocked

Vercel was temporarily on a **different** (personal) team than the GitHub
repo. That team enforces “commit email must match a GitHub account **on that
Vercel ↔ GitHub link**.” Commits from `accruedotfund` will **always** fail
there — and putting jarett’s email on Accrue commits is the wrong fix.

### Clean cut (do this once)

1. **Create a Vercel account** with an email you only use for Accrue (or sign
   up with GitHub as **`accruedotfund`**).
2. In that account: **Add New Project** → import `accruedotfund/accrue.fund`.
3. **Transfer the domain** `accrue.fund` from the old Vercel team → new team  
   (Domains → accrue.fund → Transfer), **or** transfer the registrar out and
   point NS to the new team.
4. Project env (Production):
   - `VITE_PRIVY_APP_ID`
   - `VITE_PRIVY_CLIENT_ID` (`client-…` only)
   - `VITE_API_BASE=https://accrue.fund`
   - chain defaults from `.env.example`
5. Deploy → certs for `accrue.fund` issue on the **new** team automatically.
6. Turn **off** Deployment Protection / SSO if the site must be public.
7. Delete the old personal-team project so nothing Accrue remains there.

### Local git (this machine)

```sh
cd ~/claude/accrue.fund
git config user.name  "accruedotfund"
git config user.email "accruedotfund@users.noreply.github.com"
# optional: also set as your GH primary noreply under
# GitHub → Settings → Emails → “Keep my email addresses private”
```

**Do not** `git config --global` to a stacc/jarett address for this repo.

### CLI deploy (only after logged into the *Accrue* Vercel account)

```sh
npx vercel login          # use Accrue identity, not personal stacc
npx vercel link           # link to Accrue-team project
npx vercel deploy --prod --yes
```

---

## Build scripts

| Command | Purpose |
|---------|---------|
| `bun run dev` | Local web |
| `bun test` | Unit + live Relay quotes |
| `bun run build` | Production web bundle |
| `./scripts/build-debug.sh` | Test → web → Cap sync → Android debug APK |
| `bun run release:check` | Fail-closed rails check |

Android APK path after debug build:

`android/app/build/outputs/apk/debug/app-debug.apk`

iOS device: open Xcode, select the connected phone, run. Needs iOS platform /
Developer Disk Image installed (Xcode → Settings → Components).

---

## Architecture

```
src/screens/   Welcome · Home · Account · Boost · Fund · Profile
src/lib/       auth · rails · factory · vault · boost · strategies · relay · withdraw
api/           accrue-offramp-session (Vercel serverless)
```

---

## Compliance

- Not a bank; not deposit-insured.  
- Boost can lose value; double opt-in stays.  
- Store review must disclose digital-asset rails.  
- In-app Terms / Privacy are drafts until counsel review.

---

## Repo hygiene

- Canonical product: **accrue.fund**  
- `.env*` never committed  
- Identity separate from any other brand  
