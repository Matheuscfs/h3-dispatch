import { gridDisk } from 'h3-js'

export interface SurgeOptions {
  /** Weight given to the neighbouring cells' pressure, 0 (none) to 1 (only neighbours). */
  smoothing: number
  /** Highest multiplier ever charged. */
  maxMultiplier: number
  /** Multipliers are rounded down to this step (1.0, 1.1, 1.2…). */
  step: number
  /** Pseudo-count added to demand and supply so one request in an empty cell is not a 10× surge. */
  prior: number
}

export const DEFAULT_SURGE: SurgeOptions = { smoothing: 0.35, maxMultiplier: 3, step: 0.1, prior: 2 }

// Surge is recomputed every tick over the same few hundred cells, so their
// neighbour lists are kept instead of asking H3 again each time.
const neighbourCache = new Map<string, string[]>()
function neighboursOf(cell: string): string[] {
  let list = neighbourCache.get(cell)
  if (!list) {
    if (neighbourCache.size >= 16_384) neighbourCache.clear()
    neighbourCache.set(cell, (list = gridDisk(cell, 1).filter((c) => c !== cell)))
  }
  return list
}

/**
 * Surge multiplier per cell from open requests (demand) and idle drivers (supply).
 *
 * Pressure is (demand + prior) / (supply + prior). Each cell's pressure is then
 * blended with the average of its six neighbours, so prices change gradually
 * across the map instead of jumping at a cell edge, and a rider cannot dodge a
 * surge by walking one block. Only cells with a multiplier above 1 are returned.
 */
export function computeSurge(
  demand: ReadonlyMap<string, number>,
  supply: ReadonlyMap<string, number>,
  options: Partial<SurgeOptions> = {},
): Map<string, number> {
  const { smoothing, maxMultiplier, step, prior } = { ...DEFAULT_SURGE, ...options }
  const pressure = (cell: string) => ((demand.get(cell) ?? 0) + prior) / ((supply.get(cell) ?? 0) + prior)

  // Only cells with demand, or next to demand, can end up above 1.
  const candidates = new Set<string>()
  for (const [cell, count] of demand) {
    if (count <= 0) continue
    candidates.add(cell)
    for (const c of neighboursOf(cell)) candidates.add(c)
  }

  const result = new Map<string, number>()
  for (const cell of candidates) {
    const neighbours = neighboursOf(cell)
    const around = neighbours.reduce((sum, c) => sum + pressure(c), 0) / neighbours.length
    const blended = (1 - smoothing) * pressure(cell) + smoothing * around
    // A small epsilon so 1.2 does not become 1.1 through floating-point error.
    const multiplier = Math.min(maxMultiplier, Math.floor(blended / step + 1e-9) * step)
    if (multiplier > 1 + 1e-9) result.set(cell, Math.round(multiplier * 100) / 100)
  }
  return result
}
