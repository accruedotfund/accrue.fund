import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  // reverse-DNS of accrue.fund
  appId: 'fund.accrue',
  appName: 'Accrue',
  webDir: 'dist',
  // Privy's embedded wallet iframe needs a secure origin. capacitor://localhost
  // (iOS) and https://localhost (Android) must BOTH be added to the app's
  // Allowed Origins in the Privy dashboard or login silently fails.
  server: {
    androidScheme: 'https',
  },
  ios: {
    contentInset: 'always',
  },
}

export default config
