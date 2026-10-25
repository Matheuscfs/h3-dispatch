import { cellToBoundary, cellToLatLng, gridRing, latLngToCell } from 'h3-js'
import { haversineM, type LatLng } from './geo'

export interface Match {
  id: string
  distanceM: number
}

export interface SearchStats {
  /** How many rings were scanned (ring 0 is the origin cell). */
  rings: number
  /** Cells looked up in the index, empty or not. */
  cellsVisited: number
  /** Drivers whose distance was actually computed. */
  candidates: number
}

export interface SearchResult {
  matches: Match[]
  stats: SearchStats
  /** The cells of each scanned ring, only filled when `trace` is set. */
  rings?: string[][]
}

export interface SearchOptions {
  /** Ignore drivers farther than this. Also lets the search stop early. */
  maxDistanceM?: number
  /** Only drivers for which this returns true can be matched. */
  filter?: (id: string) => boolean
  /** Hard cap on rings, a guard against scanning half the planet. */
  maxRings?: number
  /** Record the cells of each ring (for drawing the search on a map). */
  trace?: boolean
}

// H3 cells are not perfectly regular: neighbouring cells can differ in size by
// a few percent. Shrinking the lower bound keeps it a true lower bound.
const DISTORTION_SAFETY = 0.85
const DEFAULT_MAX_RINGS = 64
// Ring cells never change for a given origin, and a city has only a few
// thousand cells, so computed rings are kept. Capped to bound memory.
const RING_CACHE_ORIGINS = 4_096

/**
 * A spatial index of moving points (drivers) bucketed by H3 cell.
 *
 * Updates are O(1): a driver only changes bucket when it crosses a cell
 * boundary. Nearest-neighbour queries scan rings of cells around the query
 * point and stop as soon as no unscanned ring can contain anything closer
 * than the k-th best driver found so far (see `ringLowerBoundM`).
 */
export class DriverIndex {
  // cell → (driver id → position). Positions live in the bucket so a search
  // reads them without a second lookup.
  private readonly buckets = new Map<string, Map<string, LatLng>>()
  private readonly drivers = new Map<string, { point: LatLng; cell: string }>()
  private readonly radiusCache = new Map<string, number>()
  private readonly ringCache = new Map<string, string[][]>()

  constructor(readonly resolution: number) {
    if (!Number.isInteger(resolution) || resolution < 0 || resolution > 15) {
      throw new RangeError(`H3 resolution must be an integer from 0 to 15, got ${resolution}`)
    }
  }

  get size(): number {
    return this.drivers.size
  }

  /** Number of non-empty cells. */
  get occupiedCells(): number {
    return this.buckets.size
  }

  get(id: string): LatLng | undefined {
    return this.drivers.get(id)?.point
  }

  cellOf(id: string): string | undefined {
    return this.drivers.get(id)?.cell
  }

  /** Inserts a driver or updates its position. */
  upsert(id: string, point: LatLng): void {
    const cell = latLngToCell(point.lat, point.lng, this.resolution)
    const current = this.drivers.get(id)
    if (current && current.cell !== cell) this.leave(current.cell, id)
    let bucket = this.buckets.get(cell)
    if (!bucket) this.buckets.set(cell, (bucket = new Map()))
    const copy = { lat: point.lat, lng: point.lng }
    bucket.set(id, copy)
    this.drivers.set(id, { point: copy, cell })
  }

  remove(id: string): boolean {
    const current = this.drivers.get(id)
    if (!current) return false
    this.leave(current.cell, id)
    this.drivers.delete(id)
    return true
  }

  /** The k drivers closest to `point`, nearest first. */
  nearest(point: LatLng, k = 1, options: SearchOptions = {}): SearchResult {
    const { maxDistanceM = Infinity, filter, maxRings = DEFAULT_MAX_RINGS, trace = false } = options
    const stats: SearchStats = { rings: 0, cellsVisited: 0, candidates: 0 }
    const traced: string[][] = []
    const best: Match[] = []
    if (k < 1 || this.drivers.size === 0) return trace ? { matches: best, stats, rings: traced } : { matches: best, stats }

    const origin = latLngToCell(point.lat, point.lng, this.resolution)
    const radius = this.circumradiusM(origin)
    let seen = 0

    for (let r = 0; r <= maxRings; r++) {
      const bound = ringLowerBoundM(r, radius)
      const kth = best[k - 1]
      if (kth && bound > kth.distanceM) break
      if (bound > maxDistanceM) break
      if (seen === this.drivers.size) break // every driver has been looked at

      const ring = this.ring(origin, r)
      if (trace) traced.push(ring)
      stats.rings++
      for (const cell of ring) {
        stats.cellsVisited++
        const bucket = this.buckets.get(cell)
        if (!bucket) continue
        for (const [id, p] of bucket) {
          seen++
          if (filter && !filter(id)) continue
          stats.candidates++
          const distanceM = haversineM(point, p)
          if (distanceM <= maxDistanceM) insertSorted(best, id, distanceM, k)
        }
      }
    }

    return trace ? { matches: best, stats, rings: traced } : { matches: best, stats }
  }

  private leave(cell: string, id: string): void {
    const bucket = this.buckets.get(cell)
    if (!bucket) return
    bucket.delete(id)
    if (bucket.size === 0) this.buckets.delete(cell)
  }

  /** The cells exactly r steps away from `origin`, memoized. */
  private ring(origin: string, r: number): string[] {
    let rings = this.ringCache.get(origin)
    if (!rings) {
      if (this.ringCache.size >= RING_CACHE_ORIGINS) this.ringCache.delete(this.ringCache.keys().next().value!)
      this.ringCache.set(origin, (rings = [[origin]]))
    }
    while (rings.length <= r) rings.push(gridRing(origin, rings.length))
    return rings[r]!
  }

  /** Largest distance from a cell's center to its corners. */
  private circumradiusM(cell: string): number {
    let radius = this.radiusCache.get(cell)
    if (radius === undefined) {
      const [lat, lng] = cellToLatLng(cell)
      radius = Math.max(...cellToBoundary(cell).map(([vLat, vLng]) => haversineM({ lat, lng }, { lat: vLat, lng: vLng })))
      this.radiusCache.set(cell, radius)
    }
    return radius
  }
}

/**
 * A lower bound on the distance from a query point to anything in ring `r`.
 *
 * In a regular hex grid with circumradius e, cell centers are √3·e apart and
 * the closest center in ring r sits at r·√3·e·(√3/2) = 1.5·r·e from the origin
 * center. Both the query point and the far point can be up to e away from
 * their own centers, hence 1.5·r·e − 2·e. Rings 0 and 1 can touch the query.
 */
export function ringLowerBoundM(r: number, circumradiusM: number): number {
  return Math.max(0, (1.5 * r - 2) * circumradiusM * DISTORTION_SAFETY)
}

/** Linear-scan baseline: checks every driver. Used by the tests and the benchmark. */
export function nearestBruteForce(
  drivers: Iterable<readonly [string, LatLng]>,
  point: LatLng,
  k = 1,
  options: Pick<SearchOptions, 'maxDistanceM' | 'filter'> = {},
): Match[] {
  const { maxDistanceM = Infinity, filter } = options
  const best: Match[] = []
  if (k < 1) return best
  for (const [id, p] of drivers) {
    if (filter && !filter(id)) continue
    const distanceM = haversineM(point, p)
    if (distanceM <= maxDistanceM) insertSorted(best, id, distanceM, k)
  }
  return best
}

// Keeps `list` sorted by distance and at most k long. k is small (1 to ~10)
// in dispatch, so an insertion into an array beats a heap.
function insertSorted(list: Match[], id: string, distanceM: number, k: number): void {
  if (list.length === k && distanceM >= list[k - 1]!.distanceM) return
  let i = list.length
  while (i > 0 && list[i - 1]!.distanceM > distanceM) i--
  list.splice(i, 0, { id, distanceM })
  if (list.length > k) list.pop()
}
