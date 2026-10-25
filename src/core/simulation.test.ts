import { describe, expect, it } from 'vitest'
import { haversineM } from './geo'
import { Simulation } from './simulation'

function run(ticks: number, seed = 42, drivers = 300): Simulation {
  const sim = new Simulation({ seed, drivers })
  for (let i = 0; i < ticks; i++) sim.step()
  return sim
}

describe('Simulation', () => {
  it('replays exactly from the same seed', () => {
    expect(run(300, 7).metrics).toEqual(run(300, 7).metrics)
  })

  it('differs with another seed', () => {
    expect(run(300, 7).metrics).not.toEqual(run(300, 8).metrics)
  })

  it('matches and completes rides', () => {
    const { metrics } = run(400)
    expect(metrics.requested).toBeGreaterThan(400)
    expect(metrics.matched).toBeGreaterThan(metrics.requested * 0.8)
    expect(metrics.completed).toBeGreaterThan(0)
    expect(metrics.revenue).toBeGreaterThan(0)
  })

  it('accounts for every request', () => {
    const sim = run(400)
    const { requested, matched, expired } = sim.metrics
    const waiting = [...sim.trips.values()].filter((t) => t.status === 'waiting').length
    expect(matched + expired + waiting).toBe(requested)
  })

  it('keeps drivers and trips consistent', () => {
    const sim = run(250)
    for (const driver of sim.drivers.values()) {
      if (driver.status === 'idle') {
        expect(driver.tripId).toBeUndefined()
      } else {
        const trip = sim.trips.get(driver.tripId!)
        expect(trip?.driverId).toBe(driver.id)
        expect(trip?.status).toBe(driver.status)
      }
      expect(sim.index.get(driver.id)).toEqual(driver.position)
    }
  })

  it('keeps drivers inside the service area', () => {
    const sim = run(300)
    for (const d of sim.drivers.values()) expect(haversineM(d.position, sim.config.center)).toBeLessThanOrEqual(sim.config.radiusM + 1)
  })

  it('never sends a driver from farther than maxPickupM', () => {
    const sim = new Simulation({ drivers: 150, maxPickupM: 1_500 })
    for (let i = 0; i < 200; i++) {
      sim.step()
      for (const t of sim.trips.values()) if (t.pickupDistanceM !== undefined) expect(t.pickupDistanceM).toBeLessThanOrEqual(1_500)
    }
  })

  it('surges when there are too few drivers', () => {
    const scarce = run(120, 42, 15)
    expect(scarce.surge.size).toBeGreaterThan(0)
    expect(Math.max(...scarce.surge.values())).toBeGreaterThan(1)
  })

  it('traces the search of a manual request', () => {
    const sim = new Simulation({ drivers: 100 })
    const trip = sim.requestRide(sim.config.center)
    expect(sim.lastTraced?.tripId).toBe(trip.id)
    expect(sim.lastTraced?.search.rings?.length).toBeGreaterThan(0)
    expect(trip.status).toBe('enRoute')
  })

  it('checks far fewer drivers than a linear scan would', () => {
    const { metrics } = run(200, 42, 1_000)
    expect(metrics.candidates).toBeLessThan(metrics.bruteForceChecks / 10)
  })
})
