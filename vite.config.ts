import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Capacitor loads the built bundle from disk — relative asset paths required.
  base: './',
  server: { port: 5199 },
})
