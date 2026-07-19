#!/usr/bin/env node
/**
 * vercel --prod aliases *.vercel.app but custom domain accrue.fund can lag.
 * Point both apex + www at the latest production deployment.
 */
import { execSync } from 'node:child_process'

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim()
}

const ls = sh('npx vercel ls --prod')
const match = ls.match(/https:\/\/accruefund-[a-z0-9]+-v79kvnzz45-2321s-projects\.vercel\.app/)
if (!match) {
  console.error('Could not find latest production deployment URL')
  console.error(ls)
  process.exit(1)
}
const url = match[0]
console.log('Aliasing', url, '→ accrue.fund')
sh(`npx vercel alias set ${url} accrue.fund`)
try {
  sh(`npx vercel alias set ${url} www.accrue.fund`)
} catch {
  /* www optional */
}
console.log('Done')
