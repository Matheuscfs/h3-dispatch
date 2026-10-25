import { gridDisk, latLngToCell } from 'h3-js'
import { describe, expect, it } from 'vitest'
import { computeSurge } from './surge'

const CELL = latLngToCell(-24.9555, -53.4552, 8)

describe('computeSurge', () => {
  it('charges no surge without demand', () => {
    expect(computeSurge(new Map(), new Map([[CELL, 10]])).size).toBe(0)
  })

  it('charges no surge when idle drivers outnumber requests', () => {
    expect(computeSurge(new Map([[CELL, 2]]), new Map([[CELL, 10]])).size).toBe(0)
  })

  it('raises the price where demand outruns supply', () => {
    const surge = computeSurge(new Map([[CELL, 12]]), new Map([[CELL, 1]]))
    expect(surge.get(CELL)).toBeGreaterThan(1)
  })

  it('caps the multiplier', () => {
    const surge = computeSurge(new Map([[CELL, 500]]), new Map(), { maxMultiplier: 2.5 })
    expect(surge.get(CELL)).toBe(2.5)
  })

  it('rounds down to the step', () => {
    // pressure = (8 + 2) / (2 + 2) = 2.5; with no smoothing that is exactly 2.5
    const surge = computeSurge(new Map([[CELL, 8]]), new Map([[CELL, 2]]), { smoothing: 0, step: 0.2 })
    expect(surge.get(CELL)).toBe(2.4)
  })

  it('spills over into neighbouring cells so prices change gradually', () => {
    const surge = computeSurge(new Map([[CELL, 40]]), new Map(), { smoothing: 0.5 })
    const neighbours = gridDisk(CELL, 1).filter((c) => c !== CELL)
    for (const n of neighbours) {
      expect(surge.get(n)).toBeGreaterThan(1)
      expect(surge.get(n)).toBeLessThan(surge.get(CELL)!)
    }
  })

  it('ignores neighbours entirely with smoothing 0', () => {
    const surge = computeSurge(new Map([[CELL, 40]]), new Map(), { smoothing: 0 })
    expect([...surge.keys()]).toEqual([CELL])
  })
})
