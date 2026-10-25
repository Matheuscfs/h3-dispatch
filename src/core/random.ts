/** A small seeded PRNG (mulberry32), so a simulation replays exactly from its seed. */
export function createRandom(seed: number) {
  let state = seed >>> 0
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    /** Uniform in [min, max). */
    between: (min: number, max: number) => min + (max - min) * next(),
    /** Standard normal sample (Box–Muller). */
    gaussian: () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next()),
  }
}

export type Random = ReturnType<typeof createRandom>
