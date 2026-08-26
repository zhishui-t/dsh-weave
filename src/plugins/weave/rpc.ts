import type { Context } from '@deepseek-ai/cordis'
import { stringify as stringifyYaml } from 'yaml'

import { DEFAULT_AUDIT_DIR } from './audit/audit-log.js'
import type { CliMcpDeps } from './cli-mcp.js'
import type { ExecutorSessionConfig } from './executors/executor-provider.js'
import { DEFAULT_STATE_DIR } from './persistence/persistence.js'
import type { WeaveQueryService } from './web/query-service.js'
import { WeaveError } from './state/weave-error.js'
import type { TeamConfig } from './team-manager.js'

/** 浏览器 / 宿主共用的独立 RPC channel。 */
export const WEAVE_RPC_CHANNEL = '/dsh-weave'

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
export type WeaveRpcDeps = Pick<CliMcpDeps, 'teamManager' | 'executorRegistry'> &
  Partial<Pick<CliMcpDeps, 'persistence'>> & {
    /**
     * t4：任务/知识/审计/会话四域查询服务。
     * 可传实例或惰性工厂（部署侧延迟组装）；未注入时相应端点返回 configuration_error。
     */
    queryService?: WeaveQueryService | (() => WeaveQueryService | undefined)
  }

/** 部署侧注入的静态描述信息（settings/describe 用）。 */
export interface WeaveRpcSettings {
  /** 插件版本（部署方传 WEAVE_VERSION）；缺省返回 null。 */
  version?: string
  /** 审计目录；缺省 DEFAULT_AUDIT_DIR（~/.dsh/audit）。 */
  auditDir?: string
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
        return success({
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

      if (endpoint === 'settings/describe') {
        objectPayload(payload)
        let registeredZcode = false
        try {
          registeredZcode = resolvedDeps.executorRegistry.get('zcode') !== undefined
        } catch {
          registeredZcode = false
        }
        return success({
          version: settings.version ?? null,
          node_version: process.version,
          state_dir: resolvedDeps.persistence?.stateDir ?? DEFAULT_STATE_DIR,
          teams_dir: resolvedDeps.teamManager.teamsDir,
          audit_dir: settings.auditDir ?? DEFAULT_AUDIT_DIR,
          zcode: {
            // 发现状态：部署侧是否装配了 ZCode 能力目录源。
            configured: typeof zcodeCatalog === 'function',
            // 是否已在执行器注册表中真实发现 ZCode（来自 ctx.subagents 注册项）。
            registered: registeredZcode,
          },
        })
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
    inject?(services: string[], callback: (scoped: Context & { connection?: { rpc?: HostConnectionRpc } }) => unknown): unknown
    connection?: { rpc?: HostConnectionRpc }
  }

  // Cordis 的 inject 会等 connection 就绪后再注册，避免启动顺序竞态。
  runtime.inject?.(['connection'], (scoped) => {
    const handler = createWeaveRpcHandler(deps, zcodeCatalog, settings)
    scoped.connection?.rpc?.handle(WEAVE_RPC_CHANNEL, handler, { authority: 'trusted-host' })
  })
  return Boolean(runtime.inject)
}
