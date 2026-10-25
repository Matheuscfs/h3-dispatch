import { latLngToCell } from 'h3-js'
import { DriverIndex, type SearchResult } from './driverIndex'
import { haversineM, moveToward, offsetM, type LatLng } from './geo'
import { createRandom, type Random } from './random'
import { computeSurge, DEFAULT_SURGE, type SurgeOptions } from './surge'

export interface Hotspot {
  name: string
  center: LatLng
  /** Requests spread around the center with this standard deviation. */
  spreadM: number
  /** Relative share of hotspot requests. */
  weight: number
}

export interface SimulationConfig {
  center: LatLng
  /** Service area: a disc around `center`. */
  radiusM: number
  drivers: number
  resolution: number
  seed: number
  /** Simulated seconds per tick. */
  tickSeconds: number
  /** Average driving speed, straight line (there is no road network). */
  speedMps: number
  /** Mean ride requests per tick. */
  requestsPerTick: number
  hotspots: Hotspot[]
  /** Share of requests that start at a hotspot; the rest start anywhere. */
  hotspotShare: number
  /** A driver farther than this from the pickup is never offered the trip. */
  maxPickupM: number
  /** A request that waits longer than this without a driver is dropped. */
  maxWaitTicks: number
  /** Demand for surge pricing counts requests from this many recent ticks. */
  demandWindowTicks: number
  fare: { base: number; perKm: number; minimum: number }
  surge: SurgeOptions
}

// Cascavel, Paraná. The hotspots are offsets from downtown, not real venues.
const CASCAVEL: LatLng = { lat: -24.9555, lng: -53.4552 }

export const DEFAULT_CONFIG: SimulationConfig = {
  center: CASCAVEL,
  radiusM: 7_000,
  drivers: 300,
  resolution: 8,
  seed: 42,
  tickSeconds: 5,
  speedMps: 8.3, // ~30 km/h
  requestsPerTick: 1.2, // ~860 rides an hour, about what 300 drivers can serve
  hotspots: [
    { name: 'Centro', center: CASCAVEL, spreadM: 700, weight: 3 },
    { name: 'Norte', center: offsetM(CASCAVEL, 600, 3_200), spreadM: 600, weight: 1.5 },
    { name: 'Sudoeste', center: offsetM(CASCAVEL, -3_500, -2_600), spreadM: 800, weight: 1 },
  ],
  hotspotShare: 0.7,
  maxPickupM: 4_000,
  maxWaitTicks: 24,
  demandWindowTicks: 12,
  fare: { base: 4, perKm: 2.1, minimum: 8 },
  surge: DEFAULT_SURGE,
}

export type DriverStatus = 'idle' | 'enRoute' | 'onTrip'

export interface Driver {
  id: string
  position: LatLng
  status: DriverStatus
  tripId?: string
  /** Where an idle driver is cruising to. */
  cruiseTo: LatLng
}

export type TripStatus = 'waiting' | 'enRoute' | 'onTrip' | 'completed' | 'expired'

export interface Trip {
  id: string
  pickup: LatLng
  dropoff: LatLng
  pickupCell: string
  requestedAt: number
  status: TripStatus
  driverId?: string
  matchedAt?: number
  pickupDistanceM?: number
  surge?: number
  fare?: number
}

export interface Metrics {
  requested: number
  matched: number
  completed: number
  expired: number
  /** Sum of straight-line distances from the matched driver to the pickup. */
  pickupMeters: number
  /** Sum of ticks between request and match. */
  waitTicks: number
  revenue: number
  searches: number
  cellsVisited: number
  candidates: number
  /** What a linear scan would have checked: every driver, every search. */
  bruteForceChecks: number
}

export interface DispatchAttempt {
  tripId: string
  driverId?: string
  search: SearchResult
}

export class Simulation {
  readonly config: SimulationConfig
  readonly index: DriverIndex
  readonly drivers = new Map<string, Driver>()
  /** Open trips only; completed and expired ones are counted in `metrics` and dropped. */
  readonly trips = new Map<string, Trip>()
  readonly metrics: Metrics = {
    requested: 0,
    matched: 0,
    completed: 0,
    expired: 0,
    pickupMeters: 0,
    waitTicks: 0,
    revenue: 0,
    searches: 0,
    cellsVisited: 0,
    candidates: 0,
    bruteForceChecks: 0,
  }
  surge = new Map<string, number>()
  tick = 0
  /** The latest search with `trace` on, for drawing on the map. */
  lastTraced?: DispatchAttempt

  private readonly random: Random
  private readonly recentRequests: { tick: number; cell: string }[] = []
  private nextTripId = 1

  constructor(config: Partial<SimulationConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.random = createRandom(this.config.seed)
    this.index = new DriverIndex(this.config.resolution)
    for (let i = 0; i < this.config.drivers; i++) {
      const id = `d${i + 1}`
      const position = this.randomPointInArea()
      this.drivers.set(id, { id, position, status: 'idle', cruiseTo: this.cruiseTarget(position) })
      this.index.upsert(id, position)
    }
  }

  /** Advances the world by one tick: new requests, pricing, dispatch, movement. */
  step(): void {
    this.tick++
    const arrivals = Math.floor(this.config.requestsPerTick) + (this.random.next() < this.config.requestsPerTick % 1 ? 1 : 0)
    for (let i = 0; i < arrivals; i++) this.createTrip(this.randomPickup(), this.randomDropoff())
    this.updateSurge()
    for (const trip of this.trips.values()) if (trip.status === 'waiting') this.dispatch(trip, false)
    this.moveDrivers()
  }

  /** A rider asks for a car at `pickup` (e.g. a click on the map). The search is traced. */
  requestRide(pickup: LatLng, dropoff: LatLng = this.randomDropoff(pickup)): Trip {
    const trip = this.createTrip(pickup, dropoff)
    this.dispatch(trip, true)
    return trip
  }

  /** Requests counted as demand per cell over the recent window. */
  demandByCell(): Map<string, number> {
    const demand = new Map<string, number>()
    for (const { cell } of this.recentRequests) demand.set(cell, (demand.get(cell) ?? 0) + 1)
    return demand
  }

  /** Idle drivers per cell. */
  supplyByCell(): Map<string, number> {
    const supply = new Map<string, number>()
    for (const d of this.drivers.values()) {
      if (d.status !== 'idle') continue
      const cell = this.index.cellOf(d.id)!
      supply.set(cell, (supply.get(cell) ?? 0) + 1)
    }
    return supply
  }

  private createTrip(pickup: LatLng, dropoff: LatLng): Trip {
    const pickupCell = latLngToCell(pickup.lat, pickup.lng, this.config.resolution)
    const trip: Trip = { id: `t${this.nextTripId++}`, pickup, dropoff, pickupCell, requestedAt: this.tick, status: 'waiting' }
    this.trips.set(trip.id, trip)
    this.recentRequests.push({ tick: this.tick, cell: pickupCell })
    this.metrics.requested++
    return trip
  }

  private dispatch(trip: Trip, trace: boolean): void {
    const search = this.index.nearest(trip.pickup, 1, {
      maxDistanceM: this.config.maxPickupM,
      filter: (id) => this.drivers.get(id)!.status === 'idle',
      trace,
    })
    this.metrics.searches++
    this.metrics.cellsVisited += search.stats.cellsVisited
    this.metrics.candidates += search.stats.candidates
    this.metrics.bruteForceChecks += this.index.size

    const match = search.matches[0]
    if (trace) this.lastTraced = match ? { tripId: trip.id, driverId: match.id, search } : { tripId: trip.id, search }
    if (!match) {
      if (this.tick - trip.requestedAt > this.config.maxWaitTicks) {
        trip.status = 'expired'
        this.trips.delete(trip.id)
        this.metrics.expired++
      }
      return
    }

    const driver = this.drivers.get(match.id)!
    driver.status = 'enRoute'
    driver.tripId = trip.id
    const surge = this.surge.get(trip.pickupCell) ?? 1
    const { base, perKm, minimum } = this.config.fare
    const km = haversineM(trip.pickup, trip.dropoff) / 1000
    Object.assign(trip, {
      status: 'enRoute',
      driverId: driver.id,
      matchedAt: this.tick,
      pickupDistanceM: match.distanceM,
      surge,
      fare: Math.round(Math.max(minimum, base + perKm * km) * surge * 100) / 100,
    } satisfies Partial<Trip>)
    this.metrics.matched++
    this.metrics.pickupMeters += match.distanceM
    this.metrics.waitTicks += this.tick - trip.requestedAt
  }

  private updateSurge(): void {
    const oldest = this.tick - this.config.demandWindowTicks
    while (this.recentRequests.length > 0 && this.recentRequests[0]!.tick <= oldest) this.recentRequests.shift()
    this.surge = computeSurge(this.demandByCell(), this.supplyByCell(), this.config.surge)
  }

  private moveDrivers(): void {
    const stride = this.config.speedMps * this.config.tickSeconds
    for (const driver of this.drivers.values()) {
      const trip = driver.tripId ? this.trips.get(driver.tripId) : undefined
      if (driver.status === 'enRoute' && trip) {
        driver.position = moveToward(driver.position, trip.pickup, stride)
        if (haversineM(driver.position, trip.pickup) < 1) {
          driver.status = 'onTrip'
          trip.status = 'onTrip'
        }
      } else if (driver.status === 'onTrip' && trip) {
        driver.position = moveToward(driver.position, trip.dropoff, stride)
        if (haversineM(driver.position, trip.dropoff) < 1) {
          trip.status = 'completed'
          this.trips.delete(trip.id)
          this.metrics.completed++
          this.metrics.revenue += trip.fare ?? 0
          driver.status = 'idle'
          delete driver.tripId
          driver.cruiseTo = this.cruiseTarget(driver.position)
        }
      } else {
        // Idle drivers cruise slowly around their area.
        driver.position = moveToward(driver.position, driver.cruiseTo, stride / 3)
        if (haversineM(driver.position, driver.cruiseTo) < 1) driver.cruiseTo = this.cruiseTarget(driver.position)
      }
      this.index.upsert(driver.id, driver.position)
    }
  }

  private randomPointInArea(): LatLng {
    return this.randomPointInDisc(this.config.center, this.config.radiusM)
  }

  private randomPointInDisc(center: LatLng, radiusM: number): LatLng {
    const r = radiusM * Math.sqrt(this.random.next())
    const theta = 2 * Math.PI * this.random.next()
    return offsetM(center, r * Math.cos(theta), r * Math.sin(theta))
  }

  private inArea(p: LatLng): boolean {
    return haversineM(p, this.config.center) <= this.config.radiusM
  }

  private randomPickup(): LatLng {
    const { hotspots, hotspotShare } = this.config
    if (hotspots.length === 0 || this.random.next() >= hotspotShare) return this.randomPointInArea()
    let pick = this.random.next() * hotspots.reduce((sum, h) => sum + h.weight, 0)
    const hotspot = hotspots.find((h) => (pick -= h.weight) < 0) ?? hotspots[hotspots.length - 1]!
    for (let attempt = 0; attempt < 10; attempt++) {
      const p = offsetM(hotspot.center, this.random.gaussian() * hotspot.spreadM, this.random.gaussian() * hotspot.spreadM)
      if (this.inArea(p)) return p
    }
    return hotspot.center
  }

  private randomDropoff(from?: LatLng): LatLng {
    for (let attempt = 0; attempt < 10; attempt++) {
      const p = this.randomPointInArea()
      if (!from || haversineM(from, p) >= 800) return p
    }
    return this.randomPointInArea()
  }

  private cruiseTarget(from: LatLng): LatLng {
    for (let attempt = 0; attempt < 10; attempt++) {
      const p = this.randomPointInDisc(from, 1_500)
      if (this.inArea(p)) return p
    }
    return this.config.center
  }
}
