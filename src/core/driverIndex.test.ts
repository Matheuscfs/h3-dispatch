import { latLngToCell } from 'h3-js'
import { describe, expect, it } from 'vitest'
import { DriverIndex, nearestBruteForce, ringLowerBoundM } from './driverIndex'
import { offsetM, type LatLng } from './geo'
import { createRandom } from './random'

const CENTER: LatLng = { lat: -24.9555, lng: -53.4552 }

function scatter(count: number, radiusM: number, seed: number): Map<string, LatLng> {
  const random = createRandom(seed)
  const points = new Map<string, LatLng>()
  for (let i = 0; i < count; i++) {
    const r = radiusM * Math.sqrt(random.next())
    const t = 2 * Math.PI * random.next()
    points.set(`d${i}`, offsetM(CENTER, r * Math.cos(t), r * Math.sin(t)))
  }
  return points
}

function build(resolution: number, points: Map<string, LatLng>): DriverIndex {
  const index = new DriverIndex(resolution)
  for (const [id, p] of points) index.upsert(id, p)
  return index
}

describe('DriverIndex bookkeeping', () => {
  it('rejects invalid resolutions', () => {
    expect(() => new DriverIndex(16)).toThrow(RangeError)
    expect(() => new DriverIndex(7.5)).toThrow(RangeError)
  })

  it('moves a driver between buckets when it crosses a cell edge', () => {
    const index = new DriverIndex(9)
    index.upsert('a', CENTER)
    const before = index.cellOf('a')
    const far = offsetM(CENTER, 2_000, 0)
    index.upsert('a', far)
    expect(index.cellOf('a')).not.toBe(before)
    expect(index.cellOf('a')).toBe(latLngToCell(far.lat, far.lng, 9))
    expect(index.size).toBe(1)
    expect(index.occupiedCells).toBe(1)
  })

  it('keeps one bucket for drivers in the same cell and drops empty buckets', () => {
    const index = new DriverIndex(7)
    index.upsert('a', CENTER)
    index.upsert('b', offsetM(CENTER, 5, 5))
    expect(index.occupiedCells).toBe(1)
    expect(index.remove('a')).toBe(true)
    expect(index.remove('a')).toBe(false)
    expect(index.remove('b')).toBe(true)
    expect(index.occupiedCells).toBe(0)
    expect(index.size).toBe(0)
  })

  it('stores a copy of the position, not the caller object', () => {
    const index = new DriverIndex(8)
    const p = { ...CENTER }
    index.upsert('a', p)
    p.lat = 0
    expect(index.get('a')).toEqual(CENTER)
  })
})

describe('DriverIndex.nearest', () => {
  it('returns nothing from an empty index', () => {
    const result = new DriverIndex(8).nearest(CENTER, 3)
    expect(result.matches).toEqual([])
    expect(result.stats.cellsVisited).toBe(0)
  })

  it('returns every driver, sorted, when there are fewer than k', () => {
    const points = scatter(4, 3_000, 1)
    const result = build(8, points).nearest(CENTER, 10)
    expect(result.matches).toHaveLength(4)
    expect(result.matches.map((m) => m.distanceM)).toEqual([...result.matches.map((m) => m.distanceM)].sort((a, b) => a - b))
  })

  // The core correctness property: ring search must agree with a linear scan.
  for (const resolution of [7, 8, 9, 10]) {
    for (const k of [1, 5]) {
      it(`matches brute force at resolution ${resolution}, k=${k}`, () => {
        const points = scatter(2_000, 8_000, resolution * 10 + k)
        const index = build(resolution, points)
        const random = createRandom(resolution + k)
        for (let q = 0; q < 300; q++) {
          const query = offsetM(CENTER, random.between(-10_000, 10_000), random.between(-10_000, 10_000))
          const fast = index.nearest(query, k).matches
          const slow = nearestBruteForce(points, query, k)
          expect(fast.map((m) => m.id)).toEqual(slow.map((m) => m.id))
        }
      })
    }
  }

  it('matches brute force for sparse drivers far from the query', () => {
    const points = scatter(30, 15_000, 7)
    const index = build(9, points)
    const random = createRandom(99)
    for (let q = 0; q < 100; q++) {
      const query = offsetM(CENTER, random.between(-5_000, 5_000), random.between(-5_000, 5_000))
      expect(index.nearest(query, 3, { maxRings: 1_000 }).matches).toEqual(nearestBruteForce(points, query, 3))
    }
  })

  it('applies the filter', () => {
    const points = scatter(500, 5_000, 3)
    const index = build(8, points)
    const even = (id: string) => Number(id.slice(1)) % 2 === 0
    const result = index.nearest(CENTER, 5, { filter: even })
    expect(result.matches.every((m) => even(m.id))).toBe(true)
    expect(result.matches).toEqual(nearestBruteForce(points, CENTER, 5, { filter: even }))
  })

  it('never returns a driver beyond maxDistanceM', () => {
    const points = scatter(500, 8_000, 4)
    const index = build(8, points)
    const result = index.nearest(CENTER, 50, { maxDistanceM: 1_000 })
    expect(result.matches.length).toBeGreaterThan(0)
    expect(result.matches.every((m) => m.distanceM <= 1_000)).toBe(true)
    expect(result.matches).toEqual(nearestBruteForce(points, CENTER, 50, { maxDistanceM: 1_000 }))
  })

  it('checks far fewer drivers than a linear scan in a dense city', () => {
    const points = scatter(10_000, 8_000, 5)
    const result = build(9, points).nearest(CENTER, 1)
    expect(result.stats.candidates).toBeLessThan(points.size / 100)
  })

  it('records the cells of each ring when tracing', () => {
    const points = scatter(200, 5_000, 6)
    const result = build(9, points).nearest(CENTER, 1, { trace: true })
    expect(result.rings).toHaveLength(result.stats.rings)
    expect(result.rings![0]).toHaveLength(1)
    if (result.rings!.length > 1) expect(result.rings![1]).toHaveLength(6)
  })
})

describe('ringLowerBoundM', () => {
  it('is zero for the rings that can touch the query point', () => {
    expect(ringLowerBoundM(0, 100)).toBe(0)
    expect(ringLowerBoundM(1, 100)).toBe(0)
  })

  it('grows with the ring number', () => {
    expect(ringLowerBoundM(3, 100)).toBeGreaterThan(ringLowerBoundM(2, 100))
    expect(ringLowerBoundM(10, 100)).toBeGreaterThan(ringLowerBoundM(3, 100))
  })
})
