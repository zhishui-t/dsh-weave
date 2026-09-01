import { Context, Service } from '@deepseek-ai/cordis'
import type { WeaveCli, WeaveMcp } from './cli-mcp.js'
import { createDefaultCliDeps, createDefaultExecutorProviderRegistry, registerWeaveHost } from './host-wiring.js'
import { createTeamRuntime } from './core/team-runtime.js'
import { createExecutorLayer } from './core/executors.js'
import { createCapabilities } from './core/capabilities.js'
import { DEFAULT_PROVIDERS_FILE, ProviderStore } from './acp/provider-store.js'
import { acpRegistryContextFrom, createWeaveProviderCommandDefinitions, registerStoredAcpProviders } from './acp/dynamic-provider.js'
import { registerWeaveRpc } from './rpc.js'
import { KnowledgeEngine } from './knowledge-engine.js'
import { DelegationService } from './delegation-service.js'
import { SessionTracker } from './session-tracker.js'
import { createPlanTasksHandler, resolveHostSessionId, TeamPlanner } from './planner.js'
import { WeaveScheduler, subjectLabel } from './scheduler.js'
import { ReflectionService } from './reflection-service.js'
import { createExecutorEventNotifier } from './session-stream.js'
import { TaskStatusNotifier } from './task-status-notifier.js'
import {
  createPreStepDelegationHook,
  createWeaveNoticeMessage,
  hasPendingToolCall,
  notifySession,
  type NoticeSessionLike,
  type WeaveNoticeMessage,
} from './session-delegation.js'
import { createWeaveQueryServiceFromCliDeps } from './web/query-service.js'
import { CaptainTurnGuard } from './captain-turn-guard.js'
import type { ZcodeAcpExecutorProvider } from './acp/acp-session-provider.js'
import { AuditLog, DEFAULT_AUDIT_DIR } from './audit/audit-log.js'
import { DEFAULT_STATE_DIR } from './persistence/persistence.js'
import { DEFAULT_WEAVE_SETTINGS_FILE, loadExecutionIdleTimeoutMs, loadExecutionStreamSettings, loadWeaveSettingsOverrides } from './settings-store.js'
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

    const weaveSettingsFile = DEFAULT_WEAVE_SETTINGS_FILE
    const settingsOverrides = loadWeaveSettingsOverrides(weaveSettingsFile)
    const executionStream = loadExecutionStreamSettings(weaveSettingsFile)
    const effectiveProvidersFile = settingsOverrides.providers_file ?? DEFAULT_PROVIDERS_FILE
    const effectiveStateDir = settingsOverrides.state_dir ?? DEFAULT_STATE_DIR
    const effectiveAuditDir = settingsOverrides.audit_dir ?? DEFAULT_AUDIT_DIR
    const effectiveObsidianDir = settingsOverrides.obsidian_dir ?? DEFAULT_OBSIDIAN_DIR
    const effectiveKnowledgeDir = settingsOverrides.knowledge_dir ?? DEFAULT_KNOWLEDGE_DIR
    try {
      const deps = createDefaultCliDeps(runtime, {
        ...(settingsOverrides.state_dir ? { stateDir: settingsOverrides.state_dir } : {}),
        ...(settingsOverrides.teams_dir ? { teamsDir: settingsOverrides.teams_dir } : {}),
        ...(settingsOverrides.audit_dir ? { auditDir: settingsOverrides.audit_dir } : {}),
        ...(settingsOverrides.knowledge_dir ? { knowledgeDir: settingsOverrides.knowledge_dir } : {}),
        ...(settingsOverrides.obsidian_dir ? { obsidianDir: settingsOverrides.obsidian_dir } : {}),
      })
      const executorLayer = createExecutorLayer({
        runtime,
        deps,
        target: service,
        providersFile: effectiveProvidersFile,
      })
      const {
        zcodeProvider,
        providerCommands,
      } = executorLayer
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
      // 队长调度模式：weave_plan_tasks 是唯一的任务下发路径（对话即派发），
      // planner 校验落库 → scheduler 按依赖自动调度成员执行并回灌会话。
      // 委托唯一出口仍是 DelegationService.executeTask（内部 ctx.subagents.start）。
      const capabilities = createCapabilities({
        auditDir: effectiveAuditDir,
        knowledgeStore: deps.knowledgeStore!,
      })
      const teamRuntime = createTeamRuntime({
        runtime,
        deps,
        executorProviders: service.executorProviders,
        weaveSettingsFile,
        executionStream,
        idleTimeoutMs: loadExecutionIdleTimeoutMs(weaveSettingsFile),
        capabilities,
      })
      const {
        delegation,
        scheduler,
        statusNotifier,
        auditLog,
        reflection,
        agentsRegistry,
        notifyWeaveSession,
        resolveNoticeSession,
        planTasks,
      } = teamRuntime
      runtime.effect(() => () => teamRuntime.disposeScheduler(), 'dsh-weave scheduler lifecycle')

      // 会话控制通道最先接线：自然语言团队启停短句（绑定=启用）拦截；其余消息放行。
      // 只依赖已构造好的 teamManager，无宿主服务依赖——后续 RPC/工具接线失败不得连坐。
      try {
        const hook = createPreStepDelegationHook({
          listTeams: () => deps.teamManager.listTeams(),
          setSelection: async (sessionId, teamId) => {
            if (teamId === null) await deps.teamManager.unbindTeam(sessionId)
            else await deps.teamManager.bindTeam(sessionId, teamId)
          },
          notify: notifyWeaveSession,
        })
        const evented = runtime as Context & { on?(name: string, listener: unknown): unknown }
        const offHook = evented.on?.('agent/pre-step', hook)
        runtime.effect(() => () => {
          if (typeof offHook === 'function') offHook()
        }, 'dsh-weave pre-step delegation hook')
      } catch (error) {
        console.warn('[dsh-weave] pre-step delegation hook registration failed:', error)
      }

      // 队长回合硬约束：有在途 Weave 任务时，turn-stopping 注入 next-step，
      // 使 agent-loop 不关闭回合，模型无法“提前结束回合”绕过值守。
      try {
        const guard = new CaptainTurnGuard({
          persistence: deps.persistence,
          notify: (sessionId, text) => notifyWeaveSession(sessionId, text, resolveNoticeSession(sessionId)),
        })
        const evented = runtime as Context & { on?(name: string, listener: unknown): unknown }
        const offTurnGuard = evented.on?.('agent/turn-stopping', async (payload: { agent?: { id?: string } }) => {
          const sessionId = payload?.agent?.id ?? ''
          if (!sessionId) return
          const tasks = await guard.activeTasks(sessionId)
          if (tasks.length === 0) return
          const message = guard.buildInjectedMessage(tasks)
          const agent = (payload as { agent?: { inject?: (message: unknown) => void } & Record<string, unknown> }).agent
          if (message && typeof agent?.inject === 'function') {
            agent.inject(message)
          }
          guard.startWatching(sessionId)
        })
        runtime.effect(() => () => {
          if (typeof offTurnGuard === 'function') offTurnGuard()
          guard.dispose()
        }, 'dsh-weave captain turn guard')
      } catch (error) {
        console.warn('[dsh-weave] captain turn guard registration failed:', error)
      }

      // RPC 通道（WS handler + HTTP fallback）：传输层失败只降级面板/远程调用。
      try {
        registerWeaveRpc(runtime, {
          ...deps,
          queryService: createWeaveQueryServiceFromCliDeps(deps, { scheduler, graphService: deps.graphService, obsidianService: deps.obsidianService }),
          executorRuns: delegation,
          executorProviders: service.executorProviders,
          providerStore: new ProviderStore({ file: effectiveProvidersFile }),
          settingsFile: weaveSettingsFile,
          // 诊断联调：在插件进程内用会话 cwd 合成父代理，走真实规划+调度，
          // 让 UI 的 executor/run-events 能读取到进程内实时事件缓冲。
          debugPlanTasks: async (args) => {
            const sessionId = String(args['session_id'] ?? '')
            const cwd = typeof args['cwd'] === 'string' && args['cwd'] !== '' ? args['cwd'] : process.cwd()
            // 优先用真实会话 Agent 作为父代理（DSH 子代理需要真实 parent.ctx），
            // 取不到时再回落合成 cwd 父代理（仅 ACP/zcode 路径可用）。
            const realAgent = agentsRegistry?.get(sessionId) as
              | { id?: string; session?: { header?: { cwd?: string } } }
              | undefined
            const parentAgent = realAgent?.id
              ? realAgent
              : { id: sessionId, session: { header: { cwd } } }
            return planTasks(args, { agent: parentAgent })
          },
          ...(llmCatalog ? { llmCatalog } : {}),
        }, async () => {
          if (!zcodeProvider) return undefined
          return await zcodeProvider.describeSession(process.cwd())
        }, { version: WEAVE_VERSION, stateDir: effectiveStateDir, auditDir: effectiveAuditDir, providersFile: effectiveProvidersFile, obsidianDir: effectiveObsidianDir, knowledgeDir: effectiveKnowledgeDir })
      } catch (error) {
        console.warn('[dsh-weave] rpc registration failed:', error)
      }

      // 宿主工具与 /weave 命令：队长模型的任务下发路径。
      try {
        // P1-D 通电：治理发电与审计共用 scheduler 侧同一组实例（doc/05 §6.4）。
        const bundle = registerWeaveHost(runtime, { ...deps, statusNotifier, audit: auditLog }, {
          planTasks,
          // weave_team_switch 缺省会话解析：与 planTasks 同一真值链（exec.agent 血统回溯），
          // 模型/用户无需知道会话 id；仅纯 CLI（无 exec.agent）回落 'cli-session'。
          resolveSessionId: (exec) => {
            const resolved = resolveHostSessionId(
              (exec as { agent?: unknown } | undefined)?.agent,
              { getAgentById: (id) => agentsRegistry?.get(id as never) },
            )
            return resolved !== '' ? resolved : undefined
          },
          providerCommand: async (args) => {
            if (args[0] === 'add') {
              return await providerCommands.add.handler(args.slice(1).join(' '))
            }
            return await providerCommands.manage.handler(args.join(' '))
          },
        })
        runtime.effect(() => () => bundle.dispose(), 'dsh-weave host wiring')
      } catch (error) {
        console.warn('[dsh-weave] host tool registration failed:', error)
      }

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
