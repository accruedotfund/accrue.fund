import { describe, expect, test } from 'bun:test'
import { toUnits } from './relay'

describe('Relay amount encoding', () => {
  test('encodes whole dollars to USDC base units', () => {
    expect(toUnits('50', 6)).toBe('50000000')
    expect(toUnits('5', 6)).toBe('5000000')
  })

  test('encodes fractional amounts up to the decimal limit', () => {
    expect(toUnits('12.34', 6)).toBe('12340000')
    expect(toUnits('0.01', 6)).toBe('10000')
  })

  test('rejects zero, negative-looking, and over-precise amounts', () => {
    expect(() => toUnits('0', 6)).toThrow('above zero')
    expect(() => toUnits('0.0000001', 6)).toThrow('too many decimals')
    expect(() => toUnits('abc', 6)).toThrow('valid amount')
    expect(() => toUnits('', 6)).toThrow('valid amount')
  })
})

const RECIPIENT = '0x1111111111111111111111111111111111111111' as const
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as const

describe('Relay live quote (Base USDC → Robinhood USDG)', () => {
  test('returns a deposit address for a known USDG route', async () => {
    const { prepareRelayDepositRoute } = await import('./relay')

    const route = await prepareRelayDepositRoute({
      recipient: RECIPIENT,
      destinationAsset: USDG,
      amount: '50',
    })

    expect(route.depositAddress).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(route.requestId).toMatch(/^0x[0-9a-f]{64}$/i)
    expect(Number(route.quotedReceived)).toBeGreaterThan(45)
    expect(Number(route.minimumReceived)).toBeGreaterThan(40)
    expect(Number(route.minimumReceived)).toBeLessThanOrEqual(
      Number(route.quotedReceived),
    )
  }, 20_000)
})

describe('Relay live withdraw quote (Robinhood USDG → Base USDC)', () => {
  test('returns a deposit address for the reverse cashout leg', async () => {
    const { prepareRelayWithdrawRoute } = await import('./relay')

    const route = await prepareRelayWithdrawRoute({
      recipient: RECIPIENT,
      originAsset: USDG,
      amount: '50',
    })

    expect(route.depositAddress).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(route.requestId).toMatch(/^0x[0-9a-f]{64}$/i)
    expect(route.amountUnits).toBe('50000000')
    expect(Number(route.quotedReceived)).toBeGreaterThan(45)
  }, 20_000)
})
