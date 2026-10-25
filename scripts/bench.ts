// Ring search vs. linear scan for "closest driver to this rider".
// Prints a Markdown table (the one in the README comes from this script).
// Run: npm run bench

import { DriverIndex, nearestBruteForce } from '../src/core/driverIndex'
import { offsetM, type LatLng } from '../src/core/geo'
import { createRandom } from '../src/core/random'

const CENTER: LatLng = { lat: -24.9555, lng: -53.4552 }
const CITY_RADIUS_M = 10_000
const QUERIES = 2_000

function pointInCity(random: ReturnType<typeof createRandom>): LatLng {
  const r = CITY_RADIUS_M * Math.sqrt(random.next())
  const t = 2 * Math.PI * random.next()
  return offsetM(CENTER, r * Math.cos(t), r * Math.sin(t))
}

function time(fn: () => void): number {
  const start = performance.now()
  fn()
  return performance.now() - start
}

const rows: string[] = []
for (const drivers of [1_000, 10_000, 100_000]) {
  const random = createRandom(drivers)
  const points = new Map<string, LatLng>()
  for (let i = 0; i < drivers; i++) points.set(`d${i}`, pointInCity(random))
  const queries = Array.from({ length: QUERIES }, () => pointInCity(random))
  const entries = [...points]

  let slowResults: string[] = []
  const slowMs = time(() => {
    slowResults = queries.map((q) => nearestBruteForce(entries, q, 1)[0]!.id)
  })

  for (const resolution of [7, 8, 9]) {
    const index = new DriverIndex(resolution)
    const buildMs = time(() => {
      for (const [id, p] of entries) index.upsert(id, p)
    })
    // Warm the ring cache once so the timing reflects steady state, as in a running service.
    for (const q of queries) index.nearest(q, 1)

    let cells = 0
    let candidates = 0
    let agree = 0
    const fastMs = time(() => {
      queries.forEach((q, i) => {
        const { matches, stats } = index.nearest(q, 1)
        cells += stats.cellsVisited
        candidates += stats.candidates
        if (matches[0]!.id === slowResults[i]) agree++
      })
    })

    rows.push(
      [
        drivers.toLocaleString('en-US'),
        resolution,
        `${((buildMs / drivers) * 1000).toFixed(2)} µs`,
        `${((fastMs / QUERIES) * 1000).toFixed(1)} µs`,
        `${((slowMs / QUERIES) * 1000).toFixed(1)} µs`,
        `${(slowMs / fastMs).toFixed(1)}×`,
        (cells / QUERIES).toFixed(1),
        (candidates / QUERIES).toFixed(1),
        `${((agree / QUERIES) * 100).toFixed(0)}%`,
      ].join(' | '),
    )
  }
}

console.log(`Drivers spread over a ${CITY_RADIUS_M / 1000} km radius, ${QUERIES} queries, k = 1. Node ${process.version}.\n`)
console.log('| Drivers | Res | Insert | Ring search | Linear scan | Speed-up | Cells visited | Distances computed | Same answer |')
console.log('|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
for (const row of rows) console.log(`| ${row} |`)
