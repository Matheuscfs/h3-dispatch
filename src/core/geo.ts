export interface LatLng {
  lat: number
  lng: number
}

// Mean Earth radius (IUGG), the same one H3 uses for its distance helpers.
const EARTH_RADIUS_M = 6_371_008.8
const RAD = Math.PI / 180

/** Great-circle distance in meters. */
export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = (b.lat - a.lat) * RAD
  const dLng = (b.lng - a.lng) * RAD
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * Moves a point by a number of meters east (dx) and north (dy). Uses a local
 * flat-earth approximation, which is accurate to well under 1% at city scale.
 */
export function offsetM(p: LatLng, dxM: number, dyM: number): LatLng {
  const lat = p.lat + dyM / (EARTH_RADIUS_M * RAD)
  const lng = p.lng + dxM / (EARTH_RADIUS_M * RAD * Math.cos(p.lat * RAD))
  return { lat, lng }
}

/** Walks from `from` towards `to` by at most `meters`; lands on `to` if it is closer. */
export function moveToward(from: LatLng, to: LatLng, meters: number): LatLng {
  const total = haversineM(from, to)
  if (total <= meters || total === 0) return { lat: to.lat, lng: to.lng }
  const t = meters / total
  return { lat: from.lat + (to.lat - from.lat) * t, lng: from.lng + (to.lng - from.lng) * t }
}
