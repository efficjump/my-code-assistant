import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/live/**/*.live.test.ts'],
    environment: 'node',
    fileParallelism: false,
  },
})
