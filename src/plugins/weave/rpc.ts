import { homedir } from 'node:os'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import { stringify as stringifyYaml } from 'yaml'

import { DEFAULT_AUDIT_DIR } from './audit/audit-log.js'
import type { CliMcpDeps } from './cli-mcp.js'
import type { ExecutorSessionConfig } from './executors/executor-provider.js'
import { DEFAULT_STATE_DIR } from './persistence/persistence.js'
import type { WeaveQueryService } from './web/query-service.js'
import { WeaveError } from './state/weave-error.js'
import { DEFAULT_PROVIDERS_FILE, type StoredProviderConfig } from './acp/provider-store.js'
import { DEFAULT_WEAVE_SETTINGS_FILE, loadWeaveSettingsOverrides, saveWeaveSettingsOverrides } from './settings-store.js'
import type { TeamConfig } from './team-manager.js'

/** 浏览器 / 宿主共用的独立 RPC channel。 */
export const WEAVE_RPC_CHANNEL = '/dsh-weave'

export const DEFAULT_OBSIDIAN_DIR = join(homedir(), '.dsh', 'obsidian')
export const DEFAULT_KNOWLEDGE_DIR = join(homedir(), '.dsh', 'knowledge')

type RpcSuccess<T> = { ok: true; value: T }
type RpcFailure = {
  ok: false
  error: { code: string; message: string; details: Record<string, unknown> }
}
export type RpcResult<T> = RpcSuccess<T> | RpcFailure

interface ConnectionRpcHandlerOptions {
  authority: 'trusted-host' | 'loopback'
}
type ConnectionRpcHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<RpcResult<unknown>>
interface HostConnectionRpc {
  handle(channel: string, handler: ConnectionRpcHandler, options: ConnectionRpcHandlerOptions): () => Promise<void> | void
}

function success<T>(value: T): RpcResult<T> {
  return { ok: true, value }
}

function failure(error: unknown): RpcResult<never> {
  if (error instanceof WeaveError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.details ?? {},
      },
    }
  }
  return {
    ok: false,
    error: {
      code: 'internal',
      message: error instanceof Error ? error.message : String(error),
      details: {},
    },
  }
}

function objectPayload(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new WeaveError('invalid_argument', 'RPC payload 必须是对象')
  }
  return payload as Record<string, unknown>
}

/** 必填字符串字段校验（RPC 入参；空串/非字符串一律 invalid_argument）。 */
function requireString(input: Record<string, unknown>, field: string): string {
  const value = input[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WeaveError('invalid_argument', `${field} 必须为非空字符串`)
  }
  return value
}

export type ZcodeCatalog = () => Promise<ExecutorSessionConfig | undefined>

/**
 * createWeaveRpcHandler 最小依赖：团队/执行器必选；
 * persistence 可选——存在时 team/bind* 与 overview.bindings、settings.state_dir 才可用。
 */
export interface ExecutorRunsQuery {
    getExecutorRun(runId: string): { events: Array<{ type: string; text?: string; name?: string }>; state: string } | undefined
    listExecutorRuns(): Array<{ runId: string; taskId: string; executor: string; state: string; startedAt: number; events: Array<{ type: string; text?: string; name?: string }> }>
}
export type WeaveRpcDeps = Pick<CliMcpDeps, 'teamManager' | 'executorRegistry'> &
  Partial<Pick<CliMcpDeps, 'persistence'>> & {
    /** settings.json 目录覆盖文件路径；settings/describe 与 settings/update 用。 */
    settingsFile?: string
    /** 执行器运行快照查询（P3 实时输出）；由 DelegationService 提供。 */
    executorRuns?: ExecutorRunsQuery

    /**
     * t4：任务/知识/审计/会话四域查询服务。
     * 可传实例或惰性工厂（部署侧延迟组装）；未注入时相应端点返回 configuration_error。
     */
    queryService?: WeaveQueryService | (() => WeaveQueryService | undefined)
    /**
     * t8：providers.json 动态 ACP provider 存储（provider/list 与 settings.providers_file 用）。
     * 未注入时相应能力返回 configuration_error，UI 呈现明确空态。
     */
    providerStore?: { list(): StoredProviderConfig[] } | (() => { list(): StoredProviderConfig[] } | undefined)
    /** ctx.llm 驱动：返回全局可用模型目录（provider -> models）。 */
    llmCatalog?: () => Promise<Array<{ provider: string; name: string; models: Array<{ id: string; name: string }> }>>
  }

/** 部署侧注入的静态描述信息（settings/describe 用）。 */
export interface WeaveRpcSettings {
  /** 插件版本（部署方传 WEAVE_VERSION）；缺省返回 null。 */
  version?: string
  /** 审计目录；缺省 DEFAULT_AUDIT_DIR（~/.dsh/audit）。 */
  auditDir?: string
  /** providers.json 路径（settings/describe 的配置来源展示）；缺省 DEFAULT_PROVIDERS_FILE。 */
  providersFile?: string
  /** Obsidian Vault 路径；缺省 ~/.dsh/obsidian。 */
  obsidianDir?: string
  /** state 目录；缺省 DEFAULT_STATE_DIR。 */
  stateDir?: string
  /** 知识仓库根目录；缺省 ~/.dsh/knowledge。 */
  knowledgeDir?: string
}

/* ------------------------------ 序列化：完整团队与角色信息 ------------------------------ */

function serializeTeam(team: TeamConfig) {
  return {
    team_id: team.team_id,
    name: team.name,
    default: team.default,
    roles: team.roles.map((role) => ({
      id: role.id,
      name: role.name,
      bias: role.bias,
      executor: role.executor,
      stages: [...role.stages],
      max_concurrent_tasks: role.max_concurrent_tasks,
      personality: role.personality,
      ...(role.provider !== undefined ? { provider: role.provider } : {}),
      ...(role.model !== undefined ? { model: role.model } : {}),
      ...(role.thought_level !== undefined ? { thought_level: role.thought_level } : {}),
      ...(role.mode !== undefined ? { mode: role.mode } : {}),
      ...(role.fallback_provider !== undefined ? { fallback_provider: role.fallback_provider } : {}),
      ...(role.fallback_model !== undefined ? { fallback_model: role.fallback_model } : {}),
    })),
    task_decomposition: team.task_decomposition,
    knowledge_injection: team.knowledge_injection,
    feedback: team.feedback,
    ...(team.executor_limits ? { executor_limits: team.executor_limits } : {}),
  }
}

/**
 * /dsh-weave RPC 处理器。
 *
 * 约定：
 * - 所有 response 均为 JSON 对象（RpcResult 信封，value 永远是 object）；
 * - 客户端调用永远传 payload={} 或具体对象（零参 endpoint 也接受 {}）；
 * - 错误统一走 failure()：WeaveError 映射业务 code，其余归 internal。
 */
/** 解析可选 providerStore（实例或惰性工厂）；未注入返回 undefined。 */
function resolvedProviderStore(deps: WeaveRpcDeps): { list(): StoredProviderConfig[] } | undefined {
  const resolved = deps.providerStore
  if (resolved === undefined) return undefined
  return typeof resolved === 'function' ? resolved() ?? undefined : resolved
}

export function createWeaveRpcHandler(
  deps: WeaveRpcDeps | (() => WeaveRpcDeps),
  zcodeCatalog?: ZcodeCatalog,
  settings: WeaveRpcSettings = {},
) {
  return async (endpoint: string, rawPayload: unknown, _signal?: AbortSignal): Promise<RpcResult<unknown>> => {
    const payload = rawPayload ?? {}
    const resolvedDeps = typeof deps === 'function' ? deps() : deps
    try {
      if (endpoint === 'snapshot') {
        let zcodeSessionConfig: ExecutorSessionConfig | undefined
        try {
          zcodeSessionConfig = await zcodeCatalog?.()
        } catch {
          // 能力目录失败不能阻断团队列表；创建表单仍可手填模型。
          zcodeSessionConfig = undefined
        }
        const modelOption = zcodeSessionConfig?.configOptions?.find((option) => option.id === 'model')
        const modeOption = zcodeSessionConfig?.configOptions?.find((option) => option.id === 'mode')
        const thoughtOption = zcodeSessionConfig?.configOptions?.find((option) => option.id === 'thought')
        const currentMode = modeOption?.currentValue ?? zcodeSessionConfig?.modes?.currentModeId
        const modeOptions = modeOption?.options ?? zcodeSessionConfig?.modes?.availableModes?.map((mode) => ({ value: mode.id, name: mode.name }))
        const teams = resolvedDeps.teamManager.listTeams().map(serializeTeam)
        const executors = resolvedDeps.executorRegistry.list().map((executor) => ({
          id: executor.id,
          kind: executor.kind,
          capabilities: executor.capabilities,
        }))
        let bindingsCount: number | undefined
        if (resolvedDeps.persistence) {
          try {
            bindingsCount = (await resolvedDeps.teamManager.listBindings()).length
          } catch {
            // 绑定清单不可用时不阻断 snapshot；overview.bindings 缺省。
            bindingsCount = undefined
          }
        }
        const llmCatalog = resolvedDeps.llmCatalog ? await resolvedDeps.llmCatalog() : []
        return success({
          modelCatalog: llmCatalog,
          zcodeCapabilities: {
            models: modelOption?.options ?? [],
            currentModel: modelOption?.currentValue,
            modes: modeOptions ?? [],
            currentMode,
            thoughtLevels: thoughtOption?.options ?? [],
            currentThoughtLevel: thoughtOption?.currentValue,
          },
          teams,
          executors,
          overview: {
            teams: teams.length,
            roles: teams.reduce((sum, team) => sum + team.roles.length, 0),
            executors: executors.length,
            ...(bindingsCount !== undefined ? { bindings: bindingsCount } : {}),
          },
        })
      }

      if (endpoint === 'team/import') {
        const input = objectPayload(payload)
        let yaml = typeof input.yaml === 'string' ? input.yaml : ''
        if (!yaml && typeof input.config === 'object' && input.config !== null) {
          yaml = stringifyYaml(input.config)
        }
        if (yaml.trim() === '') {
          throw new WeaveError('invalid_argument', 'team/import 需要 yaml 文本或 config 对象')
        }
        const team = resolvedDeps.teamManager.importTeam(yaml, { overwrite: input.overwrite === true })
        return success({ team_id: team.team_id, name: team.name, roles: team.roles.length })
      }

      if (endpoint === 'team/list') {
        objectPayload(payload)
        return success({ teams: resolvedDeps.teamManager.listTeams().map(serializeTeam) })
      }

      if (endpoint === 'team/set-default') {
        const input = objectPayload(payload)
        const teamId = requireString(input, 'teamId')
        return success(resolvedDeps.teamManager.setDefaultTeam(teamId))
      }

      if (endpoint === 'executor/run-events') {
        const input = objectPayload(payload)
        const runs = resolvedDeps.executorRuns
        if (!runs) return success({ runs: [], detail: undefined })
        const runId = typeof input.runId === 'string' ? input.runId : undefined
        const taskId = typeof input.taskId === 'string' ? input.taskId : undefined
        const tail = typeof input.tail === 'number' ? Math.min(input.tail, 200) : 50
        if (runId) {
          const snap = runs.getExecutorRun(runId)
          if (!snap) return success({ detail: undefined, runs: [] })
          return success({ detail: { ...snap, events: snap.events.slice(-tail) }, runs: [] })
        }
        const all = runs.listExecutorRuns()
        const filtered = taskId ? all.filter((r) => r.taskId === taskId) : all
        const withTails = filtered.map((r) => ({ ...r, events: r.events.slice(-tail) }))
        if (taskId && withTails.length > 0) return success({ detail: withTails[0], runs: withTails })
        return success({ detail: undefined, runs: withTails })
      }

      if (endpoint === 'team/get') {
        const input = objectPayload(payload)
        const teamId = requireString(input, 'teamId')
        return success(serializeTeam(resolvedDeps.teamManager.loadTeam(teamId)))
      }

      if (endpoint === 'team/delete') {
        const input = objectPayload(payload)
        const teamId = requireString(input, 'teamId')
        const removed = await resolvedDeps.teamManager.deleteTeam(teamId)
        return success({ deleted: true, ...removed })
      }

      if (endpoint === 'team/bind') {
        const input = objectPayload(payload)
        const sessionId = requireString(input, 'sessionId')
        const teamId = requireString(input, 'teamId')
        resolvedDeps.teamManager.loadTeam(teamId) // 绑定前校验团队存在且可用（invalid_team / executor_unavailable 冒泡）
        await resolvedDeps.teamManager.bindTeam(sessionId, teamId)
        return success({ session_id: sessionId, team_id: teamId })
      }

      if (endpoint === 'team/unbind') {
        const input = objectPayload(payload)
        const sessionId = requireString(input, 'sessionId')
        const unbound = await resolvedDeps.teamManager.unbindTeam(sessionId)
        return success({ session_id: sessionId, unbound })
      }

      if (endpoint === 'team/bindings') {
        objectPayload(payload)
        return success({ bindings: await resolvedDeps.teamManager.listBindings() })
      }
      if (endpoint === 'session/team-selection/get') {
        const input = objectPayload(payload)
        // 不做任何默认（包括 cli-session）：前端必须显式携带当前会话 ID。
        const sessionId = requireString(input, 'sessionId')
        const selection = await resolvedDeps.teamManager.getSelection(sessionId)
        return success({
          session_id: sessionId,
          enabled: selection !== null,
          ...(selection ? { team_id: selection.team_id, updated_at: selection.updated_at } : { team_id: null }),
        })
      }

      if (endpoint === 'session/team-selection/set') {
        const input = objectPayload(payload)
        if (typeof input.sessionId !== 'string' || input.sessionId.trim() === '') {
          throw new WeaveError('invalid_argument', '必须显式传入当前会话 ID（sessionId）；服务端不会默认 cli-session')
        }
        const sessionId = input.sessionId
        if (!('teamId' in input)) {
          throw new WeaveError('invalid_argument', 'session/team-selection/set 需要 teamId 字段（非空字符串，或 null 表示清除选择）')
        }
        if (input.teamId === null) {
          const existed = await resolvedDeps.teamManager.unbindTeam(sessionId)
          return success({ session_id: sessionId, enabled: false, team_id: null, cleared: existed })
        }
        if (typeof input.teamId !== 'string' || input.teamId.trim() === '') {
          throw new WeaveError('invalid_argument', 'teamId 必须为非空字符串或 null（清除选择）')
        }
        resolvedDeps.teamManager.loadTeam(input.teamId) // 启用前校验团队存在且可用（invalid_team/executor_unavailable 冒泡）
        await resolvedDeps.teamManager.bindTeam(sessionId, input.teamId)
        return success({ session_id: sessionId, enabled: true, team_id: input.teamId })
      }

      if (endpoint === 'settings/describe') {
        objectPayload(payload)
        const settingsFile = resolvedDeps.settingsFile ?? DEFAULT_WEAVE_SETTINGS_FILE
        const overrides = loadWeaveSettingsOverrides(settingsFile)
        let registeredZcode = false
        try {
          registeredZcode = resolvedDeps.executorRegistry.get('zcode') !== undefined
        } catch {
          registeredZcode = false
        }
        return success({
          version: settings.version ?? null,
          node_version: process.version,
          state_dir: settings.stateDir ?? resolvedDeps.persistence?.stateDir ?? DEFAULT_STATE_DIR,
          teams_dir: resolvedDeps.teamManager.teamsDir,
          audit_dir: settings.auditDir ?? DEFAULT_AUDIT_DIR,
          obsidian_dir: settings.obsidianDir ?? DEFAULT_OBSIDIAN_DIR,
          knowledge_dir: settings.knowledgeDir ?? DEFAULT_KNOWLEDGE_DIR,
          settings_file: settingsFile,
          overrides,
          zcode: {
            // 发现状态：部署侧是否装配了 ZCode 能力目录源。
            configured: typeof zcodeCatalog === 'function',
            // 是否已在执行器注册表中真实发现 ZCode（来自 ctx.subagents 注册项）。
            registered: registeredZcode,
          },
          ...(resolvedProviderStore(resolvedDeps)
            ? { providers_file: settings.providersFile ?? DEFAULT_PROVIDERS_FILE }
            : {}),
        })
      }

      if (endpoint === 'settings/update') {
        const body = objectPayload(payload)
        const settingsFile = resolvedDeps.settingsFile ?? DEFAULT_WEAVE_SETTINGS_FILE
        const saved = saveWeaveSettingsOverrides(settingsFile, body)
        return success({ saved, settings_file: settingsFile, requires_reload: true })
      }

      // t8：动态 ACP provider 清单（真实 providers.json + 注册表生效状态）。
      if (endpoint === 'provider/list') {
        objectPayload(payload)
        const store = resolvedProviderStore(resolvedDeps)
        if (!store) {
          throw new WeaveError('configuration_error', 'providerStore 未注入（provider/list 不可用）')
        }
        const providers = store.list().map((config: StoredProviderConfig) => {
          let enabled = false
          try {
            enabled = resolvedDeps.executorRegistry?.get(config.name) !== undefined
          } catch {
            enabled = false
          }
          return {
            name: config.name,
            transport: config.transport,
            command: config.command,
            ...(config.args !== undefined ? { args: config.args } : {}),
            ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
            protocol: config.protocol,
            declaredExtensions: config.declaredExtensions ?? [],
            // 生效状态 = 该名字已真实注册进 ExecutorRegistry（host-wiring 注册即生效）。
            enabled,
            envKeys: Object.keys(config.env ?? {}),
          }
        })
        return success({ providers })
      }

      // 四域端点统一路由到 WeaveQueryService.dispatch（t4）；错误由外层 catch 映射为 RpcResult 信封。
      if (['task/', 'knowledge/', 'audit/', 'session/'].some((prefix) => endpoint.startsWith(prefix))) {
        const resolved = resolvedDeps.queryService
        const queryService = typeof resolved === 'function' ? resolved() : resolved
        if (!queryService) {
          throw new WeaveError('configuration_error', 'queryService 未注入（四域查询端点不可用）')
        }
        return success(await queryService.dispatch(endpoint, payload))
      }

      throw new WeaveError('invalid_argument', `未知 RPC endpoint: ${endpoint}`)
    } catch (error) {
      return failure(error)
    }
  }
}

/** Connection 是 Web 可选服务；headless 插件加载时自动降级为仅 MCP/CLI。 */
export function registerWeaveRpc(
  context: Context,
  deps: WeaveRpcDeps | (() => WeaveRpcDeps),
  zcodeCatalog?: ZcodeCatalog,
  settings: WeaveRpcSettings = {},
): boolean {
  const runtime = context as Context & {
    inject?(services: string[], callback: (scoped: Context & {
      connection?: { rpc?: HostConnectionRpc }
    }) => unknown): unknown
    connection?: { rpc?: HostConnectionRpc }
  }

  // WebSocket RPC handler（与之前一致，只等 connection）。
  runtime.inject?.(['connection'], (scoped) => {
    const handler = createWeaveRpcHandler(deps, zcodeCatalog, settings)
    scoped.connection?.rpc?.handle(WEAVE_RPC_CHANNEL, handler, { authority: 'trusted-host' })
  })

  // HTTP fallback：注册 POST /dsh-weave/* 路由到 webServer，客户端 WS 不可用时走 HTTP。
  const handler = createWeaveRpcHandler(deps, zcodeCatalog, settings)
  const ws = (context as any)?.webServer
  if (ws?.register) {
    ws.register({
      kind: 'prefix',
      path: WEAVE_RPC_CHANNEL,
      handler: async (req: any, res: any) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const endpoint = url.pathname.replace(`${WEAVE_RPC_CHANNEL}/`, '')
        let raw = ''
        await new Promise<void>((resolve) => {
          let done = false
          const finish = (): void => { if (!done) { done = true; resolve() } }
          req.on('data', (chunk: unknown) => { raw += String(chunk) })
          req.on('end', finish)
          setTimeout(finish, 5000)
        })
        let payload: unknown = {}
        try { payload = JSON.parse(raw) } catch { /* 零参 endpoint 接受空 body */ }
        try {
          const result = await handler(endpoint, payload)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: { code: 'internal', message: String(err) } }))
        }
      },
    })
  }
  return Boolean(runtime.inject)
}
