import { describe, expect, it } from 'vitest'
import { haversineM, moveToward, offsetM } from './geo'

describe('haversineM', () => {
  it('is zero for the same point', () => {
    expect(haversineM({ lat: -24.95, lng: -53.45 }, { lat: -24.95, lng: -53.45 })).toBe(0)
  })

  it('measures one degree of latitude as ~111.2 km', () => {
    expect(haversineM({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(111_195, -1)
  })

  it('is symmetric', () => {
    const a = { lat: -24.95, lng: -53.45 }
    const b = { lat: -25.43, lng: -49.27 }
    expect(haversineM(a, b)).toBeCloseTo(haversineM(b, a), 6)
  })
})

describe('offsetM', () => {
  it('moves the requested distance east and north', () => {
    const start = { lat: -24.95, lng: -53.45 }
    expect(haversineM(start, offsetM(start, 1_000, 0))).toBeCloseTo(1_000, 0)
    expect(haversineM(start, offsetM(start, 0, -2_500))).toBeCloseTo(2_500, 0)
  })
})

describe('moveToward', () => {
  const from = { lat: -24.95, lng: -53.45 }
  const to = offsetM(from, 3_000, 0)

  it('advances by the stride', () => {
    expect(haversineM(from, moveToward(from, to, 1_000))).toBeCloseTo(1_000, 0)
  })

  it('stops exactly at the target instead of overshooting', () => {
    expect(moveToward(from, to, 10_000)).toEqual(to)
  })
})
