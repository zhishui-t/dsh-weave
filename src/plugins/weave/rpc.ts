import type { Context } from '@deepseek-ai/cordis'
import { stringify as stringifyYaml } from 'yaml'

import type { CliMcpDeps } from './cli-mcp.js'
import type { ExecutorSessionConfig } from './executors/executor-provider.js'
import { WeaveError } from './state/weave-error.js'

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

export type ZcodeCatalog = () => Promise<ExecutorSessionConfig | undefined>

export function createWeaveRpcHandler(
  deps: Pick<CliMcpDeps, 'teamManager' | 'executorRegistry'> | (() => Pick<CliMcpDeps, 'teamManager' | 'executorRegistry'>),
  zcodeCatalog?: ZcodeCatalog,
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
        return success({
          zcodeCapabilities: {
            models: modelOption?.options ?? [],
            currentModel: modelOption?.currentValue,
            modes: modeOptions ?? [],
            currentMode,
            thoughtLevels: thoughtOption?.options ?? [],
            currentThoughtLevel: thoughtOption?.currentValue,
          },
          teams: resolvedDeps.teamManager.listTeams().map((team) => ({
            team_id: team.team_id,
            name: team.name,
            default: team.default,
            roles: team.roles.map((role) => ({
              id: role.id,
              name: role.name,
              executor: role.executor,
              provider: role.provider,
              model: role.model,
              thought_level: role.thought_level,
              mode: role.mode,
            })),
          })),
          executors: resolvedDeps.executorRegistry.list().map((executor) => ({
            id: executor.id,
            kind: executor.kind,
            capabilities: executor.capabilities,
          })),
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

      throw new WeaveError('invalid_argument', `未知 RPC endpoint: ${endpoint}`)
    } catch (error) {
      return failure(error)
    }
  }
}

/** Connection 是 Web 可选服务；headless 插件加载时自动降级为仅 MCP/CLI。 */
export function registerWeaveRpc(
  context: Context,
  deps: Pick<CliMcpDeps, 'teamManager' | 'executorRegistry'> | (() => Pick<CliMcpDeps, 'teamManager' | 'executorRegistry'>),
  zcodeCatalog?: ZcodeCatalog): boolean {
  const runtime = context as Context & {
    inject?(services: string[], callback: (scoped: Context & { connection?: { rpc?: HostConnectionRpc } }) => unknown): unknown
    connection?: { rpc?: HostConnectionRpc }
  }

  // Cordis 的 inject 会等 connection 就绪后再注册，避免启动顺序竞态。
  runtime.inject?.(['connection'], (scoped) => {
    const handler = createWeaveRpcHandler(deps, zcodeCatalog)
    scoped.connection?.rpc?.handle(WEAVE_RPC_CHANNEL, handler, { authority: 'trusted-host' })
  })
  return Boolean(runtime.inject)
}
