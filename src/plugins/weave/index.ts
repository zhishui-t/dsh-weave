import { Context, Service } from '@deepseek-ai/cordis'
import type { WeaveCli, WeaveMcp } from './cli-mcp.js'
import { createDefaultCliDeps, createDefaultExecutorProviderRegistry, registerWeaveHost } from './host-wiring.js'
import { registerWeaveRpc } from './rpc.js'
import type { ZcodeAcpExecutorProvider } from './acp/acp-session-provider.js'
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

  // 真实 DSH 宿主接入：存在 ctx.subagents 时自动组装默认依赖并注册 MCP 工具 + /weave 命令。
  // 通过 reflect.get 检测服务，避免在未声明 inject 的裸 Context 中抛错。
  const subagents = ctx.reflect.get('subagents', false)
  if (subagents) {
    try {
      service.executorProviders = createDefaultExecutorProviderRegistry(ctx)
      const deps = createDefaultCliDeps(ctx)
      const zcodeProvider = service.executorProviders?.get('zcode') as ZcodeAcpExecutorProvider | undefined
      registerWeaveRpc(ctx, deps, async () => {
        if (!zcodeProvider) return undefined
        return await zcodeProvider.describeSession(process.cwd())
      })
      const bundle = registerWeaveHost(ctx, deps)
      ctx.effect(() => () => bundle.dispose(), 'dsh-weave host wiring')
    } catch (error) {
      // 自动接线失败不阻断插件加载；宿主仍可手动调用 registerWeaveHost。
      console.warn('[dsh-weave] automatic host wiring failed:', error)
    }
  }
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
