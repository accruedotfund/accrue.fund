#!/usr/bin/env bash
# Deploy WITHOUT GitHub (no commit-email gate).
# Critical: never use `vercel pull` alone — it writes [SENSITIVE] placeholders
# that break VITE_* bake-in. Always inject real values from .env first.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f .env && ! -f .env.local ]]; then
  echo "Need .env with VITE_PRIVY_APP_ID and VITE_PRIVY_CLIENT_ID (client-…)"
  exit 1
fi

python3 << 'PY'
from pathlib import Path

def load(path):
    e = {}
    p = Path(path)
    if not p.exists():
        return e
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip().strip('"').strip("'")
        if v and v != "[SENSITIVE]":
            e[k.strip()] = v
    return e

env = {**load(".env.local"), **load(".env")}
app = env.get("VITE_PRIVY_APP_ID", "")
cli = env.get("VITE_PRIVY_CLIENT_ID", "")
if not app.startswith(("cm", "cl")):
    raise SystemExit(f"Bad VITE_PRIVY_APP_ID (got prefix {app[:8]!r})")
if cli and not cli.startswith("client-"):
    raise SystemExit(
        "VITE_PRIVY_CLIENT_ID must start with client- (mobile client id). "
        "Never use privy_app_… secret here."
    )
print("Privy app id OK; client id", "OK" if cli else "(empty = web-only)")

Path(".vercel").mkdir(exist_ok=True)
# Real values for vercel build (override redacted pull)
Path(".vercel/.env.production.local").write_text(
    "\n".join(f'{k}="{v}"' for k, v in sorted(env.items())) + "\n"
)
Path(".env.production").write_text(
    "\n".join(f"{k}={v}" for k, v in sorted(env.items()) if k.startswith("VITE_"))
    + "\n"
)
PY

echo "==> bun build (real env)"
bun run build

# Sanity: IDs must appear in bundle
python3 << 'PY'
from pathlib import Path
app = client = None
for line in Path(".env").read_text().splitlines():
    if line.startswith("VITE_PRIVY_APP_ID="):
        app = line.split("=", 1)[1].strip()
    if line.startswith("VITE_PRIVY_CLIENT_ID="):
        client = line.split("=", 1)[1].strip()
blob = "\n".join(p.read_text(errors="ignore") for p in Path("dist/assets").glob("index-*.js"))
if app and app not in blob:
    raise SystemExit("FATAL: app id not baked into dist — check Vite env")
if client and client.startswith("client-") and client not in blob:
    raise SystemExit("FATAL: client id not baked into dist")
if "[SENSITIVE]" in blob:
    raise SystemExit("FATAL: [SENSITIVE] placeholder leaked into dist")
print("dist bake-in OK")
PY

echo "==> vercel build --prod"
npx vercel build --prod

echo "==> vercel deploy --prebuilt --prod"
npx vercel deploy --prebuilt --prod --yes

npx vercel alias set https://accruefund.vercel.app accrue.fund 2>/dev/null || true

echo ""
echo "Live: https://accruefund.vercel.app  and  https://accrue.fund"
echo "Hard-refresh the browser (cache). If SSO wall: disable Deployment Protection."
