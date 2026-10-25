import 'maplibre-gl/dist/maplibre-gl.css'
import './style.css'
import { cellToBoundary, getHexagonAreaAvg, polygonToCells, UNITS } from 'h3-js'
import type { Feature, FeatureCollection } from 'geojson'
import maplibregl, { type GeoJSONSource, type MapMouseEvent } from 'maplibre-gl'
import { offsetM, Simulation, type LatLng, type SimulationConfig } from '../core'

const collection = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features })

// Real time between ticks at 1×. A tick is 5 simulated seconds, so 1× runs at 20× real time.
const TICK_MS = 250

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const ui = {
  play: $<HTMLButtonElement>('play'),
  speed: [...document.querySelectorAll<HTMLButtonElement>('[data-speed]')],
  resolution: $<HTMLSelectElement>('resolution'),
  drivers: $<HTMLInputElement>('drivers'),
  driversOut: $<HTMLOutputElement>('drivers-out'),
  grid: $<HTMLInputElement>('grid'),
  restart: $<HTMLButtonElement>('restart'),
  clock: $('clock'),
  stats: $('stats'),
  efficiency: $('efficiency'),
  last: $('last'),
  lastStats: $('last-stats'),
}

let sim = createSimulation()
let running = true
let speed = 1
let myTripId: string | undefined
let searchTimer: number | undefined
let ready = false // sources and layers exist

function createSimulation(): Simulation {
  const config: Partial<SimulationConfig> = { resolution: Number(ui.resolution.value), drivers: Number(ui.drivers.value), seed: Date.now() % 1e9 }
  return new Simulation(config)
}

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  center: [sim.config.center.lng, sim.config.center.lat],
  zoom: 12.2,
  attributionControl: { compact: true },
})
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')

// ─── GeoJSON builders ────────────────────────────────────────────────────────

function hexagon(cell: string, properties: Record<string, unknown> = {}): Feature {
  const ring = cellToBoundary(cell, true) // [lng, lat] pairs, GeoJSON order
  ring.push(ring[0]!)
  return { type: 'Feature', properties, geometry: { type: 'Polygon', coordinates: [ring] } }
}

const point = (p: LatLng, properties: Record<string, unknown> = {}): Feature => ({
  type: 'Feature',
  properties,
  geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
})

const line = (a: LatLng, b: LatLng, properties: Record<string, unknown> = {}): Feature => ({
  type: 'Feature',
  properties,
  geometry: { type: 'LineString', coordinates: [[a.lng, a.lat], [b.lng, b.lat]] },
})

function serviceAreaCells(s: Simulation): string[] {
  const { center, radiusM } = s.config
  const outline = Array.from({ length: 72 }, (_, i) => {
    const t = (i / 72) * 2 * Math.PI
    const p = offsetM(center, radiusM * Math.cos(t), radiusM * Math.sin(t))
    return [p.lat, p.lng]
  })
  return polygonToCells(outline, s.config.resolution)
}

// ─── Map layers ──────────────────────────────────────────────────────────────

const SOURCES = ['grid', 'surge', 'search', 'routes', 'riders', 'drivers', 'mine'] as const
const source = (id: (typeof SOURCES)[number]) => map.getSource(id) as GeoJSONSource

map.on('load', () => {
  for (const id of SOURCES) map.addSource(id, { type: 'geojson', data: collection([]) })

  map.addLayer({ id: 'grid', type: 'line', source: 'grid', paint: { 'line-color': '#9aa4b2', 'line-opacity': 0.12, 'line-width': 0.6 } })
  map.addLayer({
    id: 'surge',
    type: 'fill',
    source: 'surge',
    paint: {
      'fill-color': ['interpolate', ['linear'], ['get', 'multiplier'], 1.1, '#f5b041', 2, '#f97316', 3, '#ef4444'],
      'fill-opacity': ['interpolate', ['linear'], ['get', 'multiplier'], 1.1, 0.18, 3, 0.5],
    },
  })
  map.addLayer({
    id: 'surge-label',
    type: 'symbol',
    source: 'surge',
    minzoom: 13,
    layout: { 'text-field': ['concat', ['to-string', ['get', 'multiplier']], '×'], 'text-size': 11, 'text-font': ['Open Sans Semibold'] },
    paint: { 'text-color': '#ffe2b0', 'text-halo-color': '#000', 'text-halo-width': 1 },
  })
  map.addLayer({
    id: 'search',
    type: 'fill',
    source: 'search',
    paint: { 'fill-color': ['interpolate', ['linear'], ['get', 'ring'], 0, '#f472b6', 6, '#7c3aed'], 'fill-opacity': 0.28 },
  })
  map.addLayer({ id: 'search-outline', type: 'line', source: 'search', paint: { 'line-color': '#f9a8d4', 'line-width': 1, 'line-opacity': 0.7 } })
  map.addLayer({
    id: 'routes',
    type: 'line',
    source: 'routes',
    paint: {
      'line-color': ['match', ['get', 'status'], 'enRoute', '#f5b041', '#60a5fa'],
      'line-opacity': 0.35,
      'line-width': 1,
      'line-dasharray': [2, 2],
    },
  })
  map.addLayer({ id: 'riders', type: 'circle', source: 'riders', paint: { 'circle-radius': 4, 'circle-color': '#f472b6', 'circle-stroke-color': '#000', 'circle-stroke-width': 1 } })
  map.addLayer({
    id: 'drivers',
    type: 'circle',
    source: 'drivers',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2, 14, 4.5],
      'circle-color': ['match', ['get', 'status'], 'idle', '#4ade80', 'enRoute', '#f5b041', '#60a5fa'],
      'circle-opacity': 0.9,
    },
  })
  map.addLayer({
    id: 'mine-line',
    type: 'line',
    source: 'mine',
    filter: ['==', ['geometry-type'], 'LineString'],
    paint: { 'line-color': '#ffffff', 'line-width': 2.5, 'line-opacity': 0.9 },
  })
  map.addLayer({
    id: 'mine-points',
    type: 'circle',
    source: 'mine',
    filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-radius': 7, 'circle-color': ['match', ['get', 'kind'], 'pickup', '#f472b6', '#ffffff'], 'circle-stroke-color': '#000', 'circle-stroke-width': 2 },
  })

  ready = true
  drawGrid()
  render()
  requestAnimationFrame(loop)
})

map.on('click', (e: MapMouseEvent) => requestRide({ lat: e.lngLat.lat, lng: e.lngLat.lng }))
map.on('mouseenter', 'drivers', () => (map.getCanvas().style.cursor = 'default'))

// ─── Simulation loop ─────────────────────────────────────────────────────────

let last = performance.now()
let pending = 0
function loop(now: number) {
  if (running) {
    pending += ((now - last) / TICK_MS) * speed
    let steps = Math.min(Math.floor(pending), 64) // never stall the tab catching up
    pending -= Math.floor(pending)
    let stepped = false
    while (steps-- > 0) {
      sim.step()
      stepped = true
    }
    if (stepped) render()
  }
  last = now
  requestAnimationFrame(loop)
}

function render() {
  if (!ready) return
  const drivers: Feature[] = []
  const routes: Feature[] = []
  const riders: Feature[] = []

  for (const d of sim.drivers.values()) {
    drivers.push(point(d.position, { status: d.status }))
    const trip = d.tripId ? sim.trips.get(d.tripId) : undefined
    if (trip && trip.id !== myTripId) routes.push(line(d.position, d.status === 'enRoute' ? trip.pickup : trip.dropoff, { status: d.status }))
  }
  for (const t of sim.trips.values()) if (t.status === 'waiting') riders.push(point(t.pickup))

  source('drivers').setData(collection(drivers))
  source('routes').setData(collection(routes))
  source('riders').setData(collection(riders))
  source('surge').setData(collection([...sim.surge].map(([cell, multiplier]) => hexagon(cell, { multiplier }))))
  renderMine()
  renderStats()
}

function renderMine() {
  const trip = myTripId ? sim.trips.get(myTripId) : undefined
  if (!trip) {
    source('mine').setData(collection([]))
    return
  }
  const features: Feature[] = [point(trip.pickup, { kind: 'pickup' }), point(trip.dropoff, { kind: 'dropoff' })]
  const driver = trip.driverId ? sim.drivers.get(trip.driverId) : undefined
  if (driver) features.push(line(driver.position, trip.status === 'enRoute' ? trip.pickup : trip.dropoff))
  source('mine').setData(collection(features))
}

function drawGrid() {
  if (!ready) return
  source('grid').setData(collection(ui.grid.checked ? serviceAreaCells(sim).map((c) => hexagon(c)) : []))
}

// ─── Requests from the map ───────────────────────────────────────────────────

function requestRide(pickup: LatLng) {
  if (!ready) return
  const trip = sim.requestRide(pickup)
  myTripId = trip.id
  const traced = sim.lastTraced
  if (!traced || traced.tripId !== trip.id) return

  // Reveal the search one ring at a time, then leave it up for a moment.
  window.clearInterval(searchTimer)
  const rings = traced.search.rings ?? []
  let shown = 0
  const reveal = () => {
    shown++
    source('search').setData(collection(rings.slice(0, shown).flatMap((ring, r) => ring.map((cell) => hexagon(cell, { ring: r })))))
    if (shown >= rings.length) {
      window.clearInterval(searchTimer)
      searchTimer = window.setTimeout(() => source('search').setData(collection([])), 4_000)
    }
  }
  reveal()
  searchTimer = window.setInterval(reveal, 140)

  const { stats, matches } = traced.search
  const match = matches[0]
  ui.last.hidden = false
  ui.lastStats.innerHTML = statList([
    ['Driver', match ? `${Math.round(match.distanceM).toLocaleString('en-US')} m away` : 'none in range'],
    ['Fare', trip.fare ? `R$ ${trip.fare.toFixed(2)}${trip.surge && trip.surge > 1 ? ` · ${trip.surge}×` : ''}` : '—'],
    ['Rings scanned', String(stats.rings)],
    ['Cells visited', String(stats.cellsVisited)],
    ['Distances computed', String(stats.candidates)],
    ['Linear scan would do', sim.index.size.toLocaleString('en-US')],
  ])
  render()
}

// ─── Panel ───────────────────────────────────────────────────────────────────

const statList = (rows: [string, string][]) => rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')

function renderStats() {
  const m = sim.metrics
  const seconds = sim.tick * sim.config.tickSeconds
  ui.clock.textContent = `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')} simulated`
  const idle = [...sim.drivers.values()].filter((d) => d.status === 'idle').length
  ui.stats.innerHTML = statList([
    ['Requests', m.requested.toLocaleString('en-US')],
    ['Matched', m.requested ? `${Math.round((m.matched / m.requested) * 100)}%` : '—'],
    ['Avg pickup', m.matched ? `${Math.round(m.pickupMeters / m.matched).toLocaleString('en-US')} m` : '—'],
    ['Avg pickup ETA', m.matched ? `${(m.pickupMeters / m.matched / sim.config.speedMps / 60).toFixed(1)} min` : '—'],
    ['Idle drivers', `${idle} / ${sim.drivers.size}`],
    ['Surging cells', String(sim.surge.size)],
    ['Completed', m.completed.toLocaleString('en-US')],
    ['Revenue', `R$ ${Math.round(m.revenue).toLocaleString('en-US')}`],
  ])
  if (m.searches > 0) {
    const perSearch = m.candidates / m.searches
    const linear = m.bruteForceChecks / m.searches
    ui.efficiency.innerHTML = `Each search computed <strong>${perSearch.toFixed(1)}</strong> distances on average, against ${Math.round(linear).toLocaleString('en-US')} for a linear scan: <strong>${(linear / Math.max(perSearch, 0.1)).toFixed(0)}× less work</strong>, over ${(m.cellsVisited / m.searches).toFixed(1)} cells per search at resolution ${sim.config.resolution} (~${getHexagonAreaAvg(sim.config.resolution, UNITS.km2).toFixed(2)} km² per cell).`
  }
}

// ─── Controls ────────────────────────────────────────────────────────────────

function restart() {
  sim = createSimulation()
  myTripId = undefined
  ui.last.hidden = true
  if (ready) source('search').setData(collection([]))
  drawGrid()
  render()
}

ui.play.addEventListener('click', () => {
  running = !running
  ui.play.textContent = running ? 'Pause' : 'Play'
  ui.play.setAttribute('aria-pressed', String(running))
})

for (const button of ui.speed) {
  button.addEventListener('click', () => {
    speed = Number(button.dataset.speed)
    for (const b of ui.speed) b.setAttribute('aria-pressed', String(b === button))
  })
}

ui.drivers.addEventListener('input', () => (ui.driversOut.value = ui.drivers.value))
ui.drivers.addEventListener('change', restart)
ui.resolution.addEventListener('change', restart)
ui.grid.addEventListener('change', drawGrid)
ui.restart.addEventListener('click', restart)
