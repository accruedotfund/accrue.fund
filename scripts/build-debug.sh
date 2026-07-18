#!/usr/bin/env bash
# Full debug build: web → Android APK (+ optional iOS sync).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"

if [[ ! -f .env && ! -f .env.local ]]; then
  echo "Missing .env / .env.local — copy .env.example and set Privy IDs"
  exit 1
fi

echo "==> test"
bun test

echo "==> web build"
bun run build

echo "==> cap sync android"
npx cap sync android

mkdir -p android
echo "sdk.dir=$ANDROID_HOME" > android/local.properties

echo "==> assembleDebug"
(cd android && ./gradlew assembleDebug --quiet)

APK="$ROOT/android/app/build/outputs/apk/debug/app-debug.apk"
echo "==> APK: $APK ($(du -h "$APK" | awk '{print $1}'))"

if [[ "${SYNC_IOS:-1}" == "1" ]]; then
  echo "==> cap sync ios"
  npx cap sync ios || echo "(ios sync failed — install Xcode platforms if needed)"
fi

echo "OK"
