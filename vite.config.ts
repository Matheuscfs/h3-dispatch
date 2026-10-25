import { defineConfig } from 'vitest/config'

export default defineConfig({
  build: {
    // MapLibre alone is ~800 kB; ship it and H3 as their own cacheable chunks.
    chunkSizeWarningLimit: 1_100,
    rollupOptions: {
      output: { manualChunks: { maplibre: ['maplibre-gl'], h3: ['h3-js'] } },
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    // The brute-force comparisons run thousands of queries; give slow CI runners room.
    testTimeout: 20_000,
  },
})
