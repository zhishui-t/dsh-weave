import type { Context } from '@deepseek-ai/cordis'
import type { CliMcpDeps } from '../cli-mcp.js'
import type { ExecutorProviderRegistry } from '../executors/executor-provider.js'
import { createDefaultExecutorProviderRegistry } from '../host-wiring.js'
import {
  acpRegistryContextFrom,
  createWeaveProviderCommandDefinitions,
  registerStoredAcpProviders,
} from '../acp/dynamic-provider.js'

export interface ExecutorLayerOptions {
  runtime: Context
  deps: CliMcpDeps
  target: { executorProviders?: ExecutorProviderRegistry }
  providersFile: string
}

export interface ExecutorLayer {
  executorProviders: ExecutorProviderRegistry | undefined
  zcodeProvider: unknown
  providerCommands: ReturnType<typeof createWeaveProviderCommandDefinitions>
  refreshExecutorSnapshot: () => void
  dispose: () => void
}

export function createExecutorLayer(options: ExecutorLayerOptions): ExecutorLayer {
  const { runtime, deps, target, providersFile } = options
  const dynamicProviderDisposers = new Map<string, Array<() => void>>()

  let executorProviders: ExecutorProviderRegistry | undefined
  try {
    executorProviders = createDefaultExecutorProviderRegistry(runtime)
    target.executorProviders = executorProviders
    const storedProviders = registerStoredAcpProviders({
      providersFile,
      ...acpRegistryContextFrom(runtime),
      registry: executorProviders,
    })
    for (const name of storedProviders.registered) {
      dynamicProviderDisposers.set(name, storedProviders.disposersByName[name] ?? [])
    }
    runtime.effect(() => () => {
      for (const disposers of dynamicProviderDisposers.values()) {
        for (const dispose of disposers) dispose()
      }
    }, 'dsh-weave dynamic provider lifecycle')
  } catch (error) {
    console.warn('[dsh-weave] executor provider registration failed:', error)
  }

  const zcodeProvider = executorProviders?.get('zcode')

  const refreshExecutorSnapshot = (): void => {
    deps.executorRegistry.load(runtime)
  }

  const providerCommands = createWeaveProviderCommandDefinitions({
    providersFile,
    hotRegister: (config) => {
      const result = registerStoredAcpProviders({
        providersFile,
        ...acpRegistryContextFrom(runtime),
        registry: executorProviders,
        names: [config.name],
      })
      const failed = result.failed.find((item) => item.name === config.name)
      if (failed) return failed.error
      dynamicProviderDisposers.set(config.name, result.disposersByName[config.name] ?? [])
      refreshExecutorSnapshot()
      return null
    },
    onRemove: (name) => {
      const disposers = dynamicProviderDisposers.get(name)
      if (!disposers) return
      dynamicProviderDisposers.delete(name)
      for (const dispose of [...disposers].reverse()) dispose()
      refreshExecutorSnapshot()
    },
  })

  return {
    executorProviders,
    zcodeProvider,
    providerCommands,
    refreshExecutorSnapshot,
    dispose: () => {
      for (const disposers of dynamicProviderDisposers.values()) {
        for (const dispose of disposers) dispose()
      }
      dynamicProviderDisposers.clear()
    },
  }
}