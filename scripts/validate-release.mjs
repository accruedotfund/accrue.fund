import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()

function parseEnvFile(file) {
  if (!fs.existsSync(file)) return {}
  const out = {}
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const equals = line.indexOf('=')
    if (equals < 1) continue
    const key = line.slice(0, equals).trim()
    let value = line.slice(equals + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

const config = {}
for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
  Object.assign(config, parseEnvFile(path.join(root, name)))
}
Object.assign(config, process.env)

// USD-only MVP by default. Set ACTIVE_RAILS=USD,EUR,GBP,XAU when those exist.
const rails = String(config.ACTIVE_RAILS ?? 'USD')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean)

const required = [
  'VITE_RH_RPC',
  'VITE_WRAPPER_FACTORY',
  'VITE_USD_STABLE',
  ...rails.flatMap((code) => [
    `VITE_${code}_STABLE`,
    `VITE_${code}_WRAPPER`,
    `VITE_${code}_DECIMALS`,
  ]),
]

const missing = required.filter((key) => !String(config[key] ?? '').trim())
if (missing.length) {
  console.error(`Release blocked: missing ${missing.join(', ')}`)
  process.exit(1)
}

if (!/^https:\/\//.test(config.VITE_RH_RPC)) {
  console.error('Release blocked: VITE_RH_RPC must use https://')
  process.exit(1)
}

const addressPattern = /^0x[0-9a-fA-F]{40}$/
for (const key of ['VITE_WRAPPER_FACTORY', 'VITE_USD_STABLE']) {
  if (!addressPattern.test(config[key])) {
    console.error(`Release blocked: ${key} is not an EVM address`)
    process.exit(1)
  }
}
for (const code of rails) {
  for (const suffix of ['STABLE', 'WRAPPER']) {
    const key = `VITE_${code}_${suffix}`
    if (!addressPattern.test(config[key])) {
      console.error(`Release blocked: ${key} is not an EVM address`)
      process.exit(1)
    }
  }
  const decimals = Number(config[`VITE_${code}_DECIMALS`])
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    console.error(`Release blocked: VITE_${code}_DECIMALS must be an integer from 0 to 255`)
    process.exit(1)
  }
}

async function rpc(method, params) {
  const res = await fetch(config.VITE_RH_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`)
  const body = await res.json()
  if (body.error) throw new Error(body.error.message ?? 'RPC error')
  return body.result
}

try {
  const factoryCode = await rpc('eth_getCode', [config.VITE_WRAPPER_FACTORY, 'latest'])
  if (!factoryCode || factoryCode === '0x') {
    throw new Error('Wrapper factory has no deployed bytecode')
  }

  for (const code of rails) {
    const stable = config[`VITE_${code}_STABLE`].toLowerCase()
    const wrapper = config[`VITE_${code}_WRAPPER`]
    const expectedDecimals = BigInt(config[`VITE_${code}_DECIMALS`])
    const encodedStable = stable.slice(2).padStart(64, '0')

    const [
      stableCode,
      wrapperCode,
      canonicalWrapperResult,
      assetResult,
      decimalsResult,
      wrapperDecimalsResult,
      entryFeeResult,
      exitFeeResult,
      transferFeeResult,
    ] = await Promise.all([
      rpc('eth_getCode', [stable, 'latest']),
      rpc('eth_getCode', [wrapper, 'latest']),
      rpc('eth_call', [
        { to: config.VITE_WRAPPER_FACTORY, data: `0x0c9c836c${encodedStable}` },
        'latest',
      ]),
      rpc('eth_call', [{ to: wrapper, data: '0x38d52e0f' }, 'latest']),
      rpc('eth_call', [{ to: stable, data: '0x313ce567' }, 'latest']),
      rpc('eth_call', [{ to: wrapper, data: '0x313ce567' }, 'latest']),
      rpc('eth_call', [{ to: wrapper, data: '0xedc74a21' }, 'latest']),
      rpc('eth_call', [{ to: wrapper, data: '0xe9b7656e' }, 'latest']),
      rpc('eth_call', [{ to: wrapper, data: '0xf5ea9870' }, 'latest']),
    ])
    if (!stableCode || stableCode === '0x') {
      throw new Error(`${code} underlying has no deployed bytecode`)
    }
    if (!wrapperCode || wrapperCode === '0x') {
      throw new Error(`${code} wrapper has no deployed bytecode`)
    }
    const canonicalWrapper = `0x${String(canonicalWrapperResult).slice(-40)}`.toLowerCase()
    if (canonicalWrapper !== wrapper.toLowerCase()) {
      throw new Error(
        `${code} wrapper is not the factory's canonical wrapper for its asset`,
      )
    }
    const wrapperAsset = `0x${String(assetResult).slice(-40)}`.toLowerCase()
    if (wrapperAsset !== stable) {
      throw new Error(`${code} wrapper asset() does not match its configured stable`)
    }
    const stableDecimals = BigInt(decimalsResult)
    const wrapperDecimals = BigInt(wrapperDecimalsResult)
    if (stableDecimals !== expectedDecimals || wrapperDecimals !== expectedDecimals) {
      throw new Error(`${code} configured decimals do not match its contracts`)
    }
    const fees = [BigInt(entryFeeResult), BigInt(exitFeeResult), BigInt(transferFeeResult)]
    if (fees.some((fee) => fee <= 0n || fee > 10_000n)) {
      throw new Error(`${code} wrapper does not have valid positive NAV-up fees`)
    }

    // Boost pair is optional for USD MVP.
    const pair = config[`VITE_${code}_BOOST_PAIR`]
    if (pair && addressPattern.test(pair) && config.VITE_BOOST_ROUTER) {
      const pairCode = await rpc('eth_getCode', [pair, 'latest'])
      if (!pairCode || pairCode === '0x') {
        throw new Error(`${code} boost pair has no deployed bytecode`)
      }
    }
  }
} catch (error) {
  console.error(
    `Release blocked: ${error instanceof Error ? error.message : error}`,
  )
  process.exit(1)
}

console.log(
  `Release configuration verified for rail(s): ${rails.join(', ')} (Boost optional).`,
)
