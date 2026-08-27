import { Context, Service } from '@deepseek-ai/cordis'
import type { WeaveCli, WeaveMcp } from './cli-mcp.js'
import { createDefaultCliDeps, createDefaultExecutorProviderRegistry, registerWeaveHost } from './host-wiring.js'
import { DEFAULT_PROVIDERS_FILE, ProviderStore } from './acp/provider-store.js'
import { acpRegistryContextFrom, createWeaveProviderCommandDefinitions, registerStoredAcpProviders } from './acp/dynamic-provider.js'
import { registerWeaveRpc } from './rpc.js'
import { KnowledgeEngine } from './knowledge-engine.js'
import { ProcessLimiter } from './safety/process-limiter.js'
import { DelegationService } from './delegation-service.js'
import { SessionTracker } from './session-tracker.js'
import {
  SequentialSessionDelegator,
  createPreStepDelegationHook,
  notifySession,
  type NoticeSessionLike,
} from './session-delegation.js'
import { createWeaveQueryServiceFromCliDeps } from './web/query-service.js'
import type { ZcodeAcpExecutorProvider } from './acp/acp-session-provider.js'
import { DEFAULT_AUDIT_DIR } from './audit/audit-log.js'
import { DEFAULT_STATE_DIR } from './persistence/persistence.js'
import { DEFAULT_WEAVE_SETTINGS_FILE, loadWeaveSettingsOverrides } from './settings-store.js'
import { DEFAULT_KNOWLEDGE_DIR, DEFAULT_OBSIDIAN_DIR } from './rpc.js'
import type { ExecutorProviderRegistry } from './executors/executor-provider.js'

/** 插件版本常量；与 package.json version 保持同步（0.2.0）。 */
export const WEAVE_VERSION = '0.2.0'

/** cordis 插件元数据：插件 identifier 为 dsh-weave；外部包名 @deepseek-ai/dsh-plugin-weave。 */
export const name = 'dsh-weave'

/** 插件声明的服务依赖；P0 阶段无强依赖，后续按需声明（如需要 sqlite/scope 时）。 */
export const inject = {}

/**
 * Weave 上下文服务：插件加载后通过 `ctx.weave` 访问。
 * 继承 cordis `Service`，构造时自动注册到当前 context，并随插件 fiber 析构自动移除。
 */
export class WeaveService extends Service {
  readonly pluginName = name
  readonly loadedAt = Date.now()

  /**
   * 宿主接线（P0-PLUGIN-WIRE / t37）：`registerWeaveHost(ctx, deps)`（host-wiring.ts）
   * 在插件加载后把 MCP/CLI 实例挂到本服务上，供 DSH 会话/Web 宿主或 CLI 客户端模块取用：
   * - `mcp`：weave_* 业务命令（已注册到 ctx.tools 时模型可直接调用）；
   * - `cli`：`/weave` 斜杠命令解析器；通过 host-wiring 的 `registerWeaveCommand`
   *   可注册为 DSH 真实宿主命令（`ctx.commands.register`），服务导出保留为后备契约。
   */
  mcp?: WeaveMcp
  cli?: WeaveCli
  executorProviders?: ExecutorProviderRegistry

  version(): string {
    return WEAVE_VERSION
  }

  describe(): string {
    return `dsh-weave v${WEAVE_VERSION} (loaded at ${new Date(this.loadedAt).toISOString()})`
  }
}

/**
 * cordis 对象插件入口：在 ctx 上注册 weave 服务。
 * 真实 DSH 宿主存在 ctx.subagents 时，自动调用 createDefaultCliDeps + registerWeaveHost，
 * 注册 MCP weave_* 工具与 /weave 宿主命令；裸 Context/测试环境保持零依赖可加载。
 */
export function apply(ctx: Context): void {
  // 插件标识固定为 dsh-weave；业务服务仍以 ctx.weave 暴露。
  const service = new WeaveService(ctx, 'weave')

  // 真实 DSH 宿主接入：等待宿主服务就绪后一次性注册真实依赖。
  // 执行器列表来自 ctx.subagents 当前实际注册项；ZCode ACP 只是可选附加源。
  ctx.inject(['subagents', 'subprocess', 'commands', 'tools', 'llm', 'connection'], (scoped) => {
    const runtime = scoped as Context

    const dynamicProviderDisposers = new Map<string, Array<() => void>>()
    const weaveSettingsFile = DEFAULT_WEAVE_SETTINGS_FILE
    const settingsOverrides = loadWeaveSettingsOverrides(weaveSettingsFile)
    const effectiveProvidersFile = settingsOverrides.providers_file ?? DEFAULT_PROVIDERS_FILE
    const effectiveStateDir = settingsOverrides.state_dir ?? DEFAULT_STATE_DIR
    const effectiveAuditDir = settingsOverrides.audit_dir ?? DEFAULT_AUDIT_DIR
    const effectiveObsidianDir = settingsOverrides.obsidian_dir ?? DEFAULT_OBSIDIAN_DIR
    const effectiveKnowledgeDir = settingsOverrides.knowledge_dir ?? DEFAULT_KNOWLEDGE_DIR
    try {
      service.executorProviders = createDefaultExecutorProviderRegistry(runtime)
      // 启动即加载用户通过 /weave provider add 持久化的外部 harness。
      const storedProviders = registerStoredAcpProviders({
        providersFile: effectiveProvidersFile,
        ...acpRegistryContextFrom(runtime),
        registry: service.executorProviders,
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

    try {
      const deps = createDefaultCliDeps(runtime, {
        ...(settingsOverrides.state_dir ? { stateDir: settingsOverrides.state_dir } : {}),
        ...(settingsOverrides.teams_dir ? { teamsDir: settingsOverrides.teams_dir } : {}),
        ...(settingsOverrides.audit_dir ? { auditDir: settingsOverrides.audit_dir } : {}),
        ...(settingsOverrides.knowledge_dir ? { knowledgeDir: settingsOverrides.knowledge_dir } : {}),
      })
      const zcodeProvider = service.executorProviders?.get('zcode') as ZcodeAcpExecutorProvider | undefined
      const refreshExecutorSnapshot = () => deps.executorRegistry.load(runtime)
      const providerCommands = createWeaveProviderCommandDefinitions({
        providersFile: effectiveProvidersFile,
        hotRegister: (config) => {
          const result = registerStoredAcpProviders({
            providersFile: effectiveProvidersFile,
            ...acpRegistryContextFrom(runtime),
            registry: service.executorProviders,
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
      const llmRuntime = (runtime as Context & { llm?: { listProviders(): Array<{ id: string; name: string }>; listModels(providerId: string): Promise<Array<{ id: string; name: string }>> } }).llm
      const llmCatalog = llmRuntime?.listProviders
        ? async (): Promise<Array<{ provider: string; name: string; models: Array<{ id: string; name: string }> }>> => {
            const providers = llmRuntime.listProviders()
            return Promise.all(providers.map(async (provider) => {
              try {
                const models = await llmRuntime.listModels(provider.id)
                return { provider: provider.id, name: provider.name, models }
              } catch {
                return { provider: provider.id, name: provider.name, models: [] }
              }
            }))
          }
        : undefined
      registerWeaveRpc(runtime, { ...deps, queryService: createWeaveQueryServiceFromCliDeps(deps), providerStore: new ProviderStore({ file: effectiveProvidersFile }), settingsFile: weaveSettingsFile, ...(llmCatalog ? { llmCatalog } : {}) }, async () => {
        if (!zcodeProvider) return undefined
        return await zcodeProvider.describeSession(process.cwd())
      }, { version: WEAVE_VERSION, stateDir: effectiveStateDir, auditDir: effectiveAuditDir, providersFile: effectiveProvidersFile, obsidianDir: effectiveObsidianDir, knowledgeDir: effectiveKnowledgeDir })
      const bundle = registerWeaveHost(runtime, deps, {
        providerCommand: async (args) => {
          if (args[0] === 'add') {
            return await providerCommands.add.handler(args.slice(1).join(' '))
          }
          return await providerCommands.manage.handler(args.join(' '))
        },
      })
      runtime.effect(() => () => bundle.dispose(), 'dsh-weave host wiring')

      // t6：会话内任务委托编排——agent/pre-step 拦截用户消息，按会话启用的团队顺序委托。
      // 委托唯一出口仍是 DelegationService.executeTask（内部 ctx.subagents.start）。
      const delegation = new DelegationService(
        { subagents: (runtime as unknown as { subagents: unknown }).subagents } as never,
        {
          executorRegistry: deps.executorRegistry,
          sessionTracker: new SessionTracker(deps.persistence.feedback),
          processLimiter: new ProcessLimiter(),
          knowledgeEngine: new KnowledgeEngine(deps.knowledgeStore!),
        },
      )
      const hook = createPreStepDelegationHook({
        getSelection: (sessionId) => deps.teamManager.getSelection(sessionId),
        loadTeam: (teamId) => deps.teamManager.loadTeam(teamId),
        listTeams: () => deps.teamManager.listTeams(),
        setSelection: async (sessionId, teamId) => {
          if (teamId === null) await deps.teamManager.unbindTeam(sessionId)
          else await deps.teamManager.bindTeam(sessionId, teamId)
        },
        delegator: new SequentialSessionDelegator(delegation),
        notify: (sessionId, text, session?: NoticeSessionLike) => {
          if (!session) {
            console.warn('[dsh-weave] cannot notify session', sessionId, '- session surface unavailable')
            return
          }
          try {
            notifySession(session, text)
          } catch (error) {
            console.warn('[dsh-weave] notify session failed:', error)
          }
        },
      })
      const evented = runtime as Context & { on?(name: string, listener: unknown): unknown }
      const offHook = evented.on?.('agent/pre-step', hook)
      runtime.effect(() => () => {
        if (typeof offHook === 'function') offHook()
      }, 'dsh-weave pre-step delegation hook')

    } catch (error) {
      console.warn('[dsh-weave] automatic host wiring failed:', error)
    }
  })
}

/* ---------- 宿主接线（P0-PLUGIN-WIRE / t37） ---------- */
export {
  buildWeaveToolDefinitions,
  registerWeaveMcpTools,
  registerWeaveHost,
  registerWeaveCommand,
  tokenizeCommandLine,
  createDefaultCliDeps,
  buildDefaultWeaveCli,
  SLASH_COMMAND_NAME,
} from './host-wiring.js'
export {
  ExecutorProviderRegistry,
  type ExecutorCapabilities,
  type ExecutorEvent,
  type ExecutorProvider,
  type ExecutorResult,
  type ExecutorRun,
  type ExecutorRuntimeOptions,
  type ExecutorStartRequest,
} from './executors/executor-provider.js'
export {
  AcpSessionProvider,
  ZcodeAcpExecutorProvider,
  registerAcpSessionProvider,
  zcodeAcpProviderConfigFromEnvironment,
  type AcpExecutorEvent,
  type AcpSessionProviderConfig,
} from './acp/acp-session-provider.js'
export type {
  HostToolDefinition,
  HostToolRuntime,
  WeaveHostBundle,
  WeaveHostOptions,
  WeaveHostOptionsCommand,
  WeaveMcpToolsRegistration,
  WeaveCommandRegistration,
  HostCommandRuntime,
  HostCommandDefinition,
  HostCommandInvocation,
  HostCommandResult,
} from './host-wiring.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    weave: WeaveService
  }
}
