import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.{ts,tsx}'],
    environment: 'node',
    testTimeout: 15000,
    hookTimeout: 15000,
  },
})
