import { describe, expect, test } from 'bun:test'
import {
  balanceIncrease,
  minAfterSlippage,
  optimalAmounts,
} from './boost'

describe('Boost balance isolation', () => {
  test('uses only the balance created by the current operation', () => {
    expect(balanceIncrease(150n, 100n)).toBe(50n)
  })

  test('fails if an operation appears to reduce the tracked balance', () => {
    expect(() => balanceIncrease(99n, 100n)).toThrow(
      'Balance changed unexpectedly',
    )
  })
})

describe('Boost pool protection', () => {
  test('caps execution two percent below the quote', () => {
    expect(minAfterSlippage(10_000n)).toBe(9_800n)
  })

  test('matches the smaller side to the current reserve ratio', () => {
    expect(optimalAmounts(100n, 80n, 1_000n, 500n)).toEqual({
      a: 100n,
      b: 50n,
    })
    expect(optimalAmounts(100n, 20n, 1_000n, 500n)).toEqual({
      a: 40n,
      b: 20n,
    })
  })
})
