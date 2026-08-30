import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

const capabilitiesSrc = fileURLToPath(new URL('./subprojects/dsh-weave-capabilities/src/index.ts', import.meta.url))
const forkAcpSrc = fileURLToPath(new URL('./subprojects/dsh-agent-teams/src/acp/index.ts', import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: '@zhishui/dsh-weave-capabilities', replacement: capabilitiesSrc },
      { find: '@nanmicoder/dsh-agent-teams/acp', replacement: forkAcpSrc },
    ],
  },
  test: {
    include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
    environment: 'node',
    testTimeout: 15000,
    hookTimeout: 15000,
  },
})
