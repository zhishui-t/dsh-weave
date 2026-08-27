import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { AuditLog, DEFAULT_AUDIT_DIR } from './audit/audit-log.js'
import { WeaveCli, WeaveMcp, type CliMcpDeps } from './cli-mcp.js'
import type { GetStatusInput } from './cli-mcp.js'
import type { PlanTasksOutput, ToolExecLike } from './planner.js'
import { CircuitBreaker } from './safety/circuit-breaker.js'
import { DagRepository } from './dag/repository.js'
import { ExecutorRegistry } from './executor-registry.js'
import { FeedbackRouter } from './feedback-router.js'
import { KnowledgeReviewService } from './knowledge-review.js'
import { KnowledgeStore } from './knowledge-model.js'
import { ImportPipeline } from './import-pipeline.js'
import { openPersistence } from './persistence/persistence.js'
import { SessionTracker } from './session-tracker.js'
import { TeamManager } from './team-manager.js'
import { ExecutorProviderRegistry } from './executors/executor-provider.js'
import { DshSubagentExecutorProvider } from './executors/dsh-subagent-executor-provider.js'
import { AcpSessionProvider, DEFAULT_ACP_SESSION_INDEX_FILE, ZcodeAcpExecutorProvider, zcodeAcpProviderConfigFromEnvironment, type AcpSessionProviderConfig } from './acp/acp-session-provider.js'

/**
 * P0-PLUGIN-WIRE —— DSH 宿主接线模块（t37）。
 *
 * DSH 0.1.1-rc.2 宿主事实（本地实证，见 t37 输出）：
 * 1. 模型工具（含 MCP 桥接工具）统一注册在 `ctx.tools: ToolRuntime`
 *    （`@deepseek-ai/dsh-tools`），注册 API 为 `ctx.tools.register(ToolDefinition)`
 *    （返回注销 disposer）；外部 MCP server 由 `dsh-mcp-client` 桥接进同一注册表。
 *    → 插件侧通过 `registerWeaveMcpTools` 把 Weave 的业务命令
 *      以 dsh-tools 形状注册，DSH 会话模型即可直接调用。
 *      其中 weave_plan_tasks（队长规划下发，options.planTasks 注入）是唯一的任务下发途径。
 * 2. 斜杠命令存在**服务端注册 API**：`ctx.commands: CommandRuntime`
 *    （`@deepseek-ai/dsh-commands`），`ctx.commands.register(CommandDefinition)`
 *    返回 disposer（参照 dsh-command-compact/goal 的 ctx.effect 模式）；
 *    → `registerWeaveCommand` 把 `WeaveCli` 以 name='weave' 的真实宿主命令注册，
 *      handler 把 invocation.rawInput 分词为 argv 后调用 `cli.run(argv)`，
 *      CliResult 映射为 CommandResult（{kind:'success',text}|{kind:'error',text}）；
 *      `WeaveCli` 同时保持服务导出（`ctx.weave.cli`）契约。
 *
 * 契约（registerWeaveHost）：
 * - deps（CliMcpDeps）由宿主/部署组装注入（样例见 __tests__/cli-mcp.test.ts 的 newEnv）；
 * - ctx.tools 存在 → 注册 weave_* 工具（逐个 try/catch，冲突不中断其它工具），
 *   返回 unregister() 一次性注销；
 * - ctx.weave 存在 → 挂载 mcp/cli 服务引用；
 * - 无 ctx.tools（如裸 Context 测试）→ 仅服务导出，注册表 hasToolRuntime=false。
 */

/** 宿主 ToolRuntime 最小结构视图（与 dsh-tools 0.1.1-rc.2 ToolRuntime.register 形状一致）。 */
export interface HostToolRuntime {
  register(definition: HostToolDefinition): () => void
}

/** dsh-tools ToolDefinition 的最小结构视图（name/description/parameters/output/execute）。 */
export interface HostToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: unknown, value: unknown) => Array<{ type: 'text'; text: string }>
  }
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>
}

export interface WeaveHostOptions {
  /** MCP 工具名前缀，默认 `weave_` */
  toolPrefix?: string
  /** 动态 ACP provider 管理回调；由集成方注入热注册实现。 */
  providerCommand?: (args: string[]) => Promise<{ kind: 'success' | 'error'; text: string }>
  /**
   * 队长规划回调（planner.createPlanTasksHandler 的产物）：
   * weave_plan_tasks 工具的唯一任务下发路径；未注入时工具返回 configuration_error。
   */
  planTasks?: (args: unknown, exec: unknown) => Promise<PlanTasksOutput>
}

export interface WeaveMcpToolsRegistration {
  /** 成功注册的工具名（注册失败的不在列） */
  registered: string[]
  /** 注册失败的工具名与原因 */
  failed: Array<{ name: string; error: string }>
  /** 宿主是否提供 ctx.tools（false = 仅服务导出契约） */
  hasToolRuntime: boolean
  /** 注销全部已注册工具 */
  unregister: () => void
}

const jsonText = (value: unknown): Array<{ type: 'text'; text: string }> => [
  { type: 'text', text: JSON.stringify(value, null, 2) },
]

const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }

/**
 * P0-TOOLS-SCHEMA-FIX —— 属性规格表 → 标准 JSON Schema（递归）。
 *
 * 宿主原生 `tools.register()` 不做 typed-DSL 转换（那是 defineTool() 的职责），
 * 直接把属性规格表当 parameters 上 wire 会缺 { type:'object', properties } 外壳，
 * 严格解析的模型端视为无效 schema，只会发出 {} 空参（wire 铁证见 request/header 事件）。
 *
 * 转换规则与 dsh-tools parameterSchemaSpecToJsonSchema 对齐：每层属性表里的
 * 叶子 `required: true` 上提为该层父级的 required 数组。必须递归处理——
 * weave_plan_tasks.tasks.items.properties 里嵌套的布尔标记同样是非法 JSON Schema
 * （JSON Schema 的 required 只能是字符串数组），不递归会导致模型端再次整包判无效。
 */
function convertSchemaNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(convertSchemaNode)
  if (!node || typeof node !== 'object') return node
  const obj = { ...(node as Record<string, unknown>) }
  if (obj['properties'] && typeof obj['properties'] === 'object' && !Array.isArray(obj['properties'])) {
    const converted = toJsonPropertySpec(obj['properties'] as Record<string, unknown>)
    const nested = converted as { properties?: Record<string, unknown>; required?: string[] }
    // 深层仅保留 properties/required 的转换产物，去掉外面包裹的一层 type:'object'
    obj['properties'] = nested.properties ?? {}
    if (nested.required && nested.required.length > 0) {
      const existing = Array.isArray(obj['required']) ? (obj['required'] as string[]) : []
      obj['required'] = [...new Set([...existing, ...nested.required])]
    }
  }
  if ('items' in obj) obj['items'] = convertSchemaNode(obj['items'])
  return obj
}

export function toJsonPropertySpec(spec: Record<string, unknown>): Record<string, unknown> {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return spec
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [key, value] of Object.entries(spec)) {
    let schema = convertSchemaNode(value)
    if (schema && typeof schema === 'object' && !Array.isArray(schema) && (schema as { required?: boolean }).required === true) {
      const rest = { ...(schema as Record<string, unknown>) }
      delete rest.required
      schema = rest
      required.push(key)
    }
    properties[key] = schema
  }
  return {
    type: 'object',
    ...(Object.keys(properties).length > 0 ? { properties, ...(required.length > 0 ? { required } : {}) } : {}),
  }
}

/** 将 WeaveMcp 的业务命令映射为 dsh-tools ToolDefinition 列表（队长模式下发走 weave_plan_tasks）。 */
export function buildWeaveToolDefinitions(mcp: WeaveMcp, options: WeaveHostOptions = {}): HostToolDefinition[] {
  const prefix = options.toolPrefix ?? 'weave_'
  const defs: HostToolDefinition[] = [
    {
      name: `${prefix}plan_tasks`,
      description:
        '队长规划并派发团队任务（唯一的任务下发方式）：用户描述目标后直接调用本工具，把目标拆解为' +
        '一组带依赖的任务并指派给团队成员角色；插件随后按依赖自动调度成员执行并把进度/汇总回灌到会话。' +
        'assignee 必须是团队角色的 id；depends_on 引用本计划内其他任务的 id。' +
        '团队无需显式启用：已配置默认团队或仅有一个团队时自动生效；仅当存在多个未指定团队时报错，届时先 team_list 询问用户选择。',
      parameters: {
        goal: { type: 'string', description: '本次规划的整体目标（可选，用于摘要展示）' },
        project_id: { type: 'string', description: '项目标识（缺省 session）' },
        version: { type: 'string', description: '版本标识（缺省 adhoc）' },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              id: { type: 'string', description: '计划内引用别名（缺省 t1..tN）' },
              subject: { type: 'string', description: '任务短标题（缺省取描述首行）' },
              description: { type: 'string', required: true, description: '交给成员的完整任务说明' },
              assignee: { type: 'string', required: true, description: '成员角色 id' },
              depends_on: {
                type: 'array',
                items: { type: 'string' },
                description: '上游任务别名列表（须在本计划内且不成环）',
              },
            },
          },
        },
      },
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => jsonText(value) },
      execute: (args, exec) =>
        options.planTasks
          ? options.planTasks(args as Record<string, unknown>, exec as ToolExecLike)
          : Promise.reject(new Error('configuration_error: 队长调度器未就绪（weave_plan_tasks 不可用）')),
    },
    {
      name: `${prefix}get_status`,
      description: '查询任务/DAG 状态（dag_id 或 task_id 至少其一）',
      parameters: { task_id: { type: 'string' }, dag_id: { type: 'string' } },
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => jsonText(value) },
      execute: (args) => mcp.getStatus(args as unknown as GetStatusInput),
    },
    {
      name: `${prefix}revise_task`,
      description: '保温期内发送修订反馈（AWAITING_FEEDBACK → REVISION_RUNNING）',
      parameters: { task_id: { type: 'string', required: true }, feedback: { type: 'string', required: true } },
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => jsonText(value) },
      execute: (args) => mcp.reviseTask(args as unknown as { task_id: string; feedback: string }),
    },
    {
      name: `${prefix}accept_task`,
      description: '确认任务完成并关闭（AWAITING_FEEDBACK → CLOSED）',
      parameters: { task_id: { type: 'string', required: true } },
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => jsonText(value) },
      execute: (args) => mcp.acceptTask(args as unknown as { task_id: string }),
    },
    {
      name: `${prefix}team_list`,
      description: '列出可用团队（team_id/name/default/roles）',
      parameters: {},
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => jsonText(value) },
      execute: () => mcp.teamList(),
    },
    {
      name: `${prefix}team_switch`,
      description: '切换当前会话团队并持久化会话绑定',
      parameters: { team_id: { type: 'string', required: true }, session_id: { type: 'string' } },
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => jsonText(value) },
      execute: (args) => mcp.teamSwitch(args as unknown as { team_id: string; session_id?: string }),
    },
    {
      name: `${prefix}executor_list`,
      description: '列出已发现执行器（provider 名/分类/能力）',
      parameters: {},
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => jsonText(value) },
      execute: () => mcp.executorList(),
    },
    // ---------- t36 补充命令（t39 补齐） ----------
    {
      name: `${prefix}knowledge_review`,
      description: '知识审核队列：默认 candidate；可过滤状态/层级并限制条数（TDD 1.2.8）',
      parameters: { status: { type: 'string' }, layer: { type: 'string' }, limit: { type: 'number' } },
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => jsonText(value) },
      execute: (args) => mcp.knowledgeReview(args as unknown as { status?: string; layer?: string; limit?: number }),
    },
    {
      name: `${prefix}knowledge_approve`,
      description: '知识审核通过：candidate → active（显式人工确认，AC-KNOW-003）',
      parameters: { knowledge_id: { type: 'string', required: true } },
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => jsonText(value) },
      execute: (args) => mcp.knowledgeApprove((args as unknown as { knowledge_id: string }).knowledge_id),
    },
    {
      name: `${prefix}knowledge_reject`,
      description: '知识审核拒绝：candidate → deprecated',
      parameters: { knowledge_id: { type: 'string', required: true }, reason: { type: 'string' } },
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => jsonText(value) },
      execute: (args) => mcp.knowledgeReject((args as unknown as { knowledge_id: string }).knowledge_id),
    },
    {
      name: `${prefix}task_retry`,
      description: '重试任务：FAILED/LOOP_TERMINATED/INTERRUPTED/CANCELLED → WAITING',
      parameters: { task_id: { type: 'string', required: true } },
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => jsonText(value) },
      execute: (args) => mcp.taskRetry((args as unknown as { task_id: string }).task_id),
    },
    {
      name: `${prefix}task_skip`,
      description: '跳过任务：失败/熔断/中断/取消态 → SKIPPED（skip_override=1）',
      parameters: { task_id: { type: 'string', required: true } },
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => jsonText(value) },
      execute: (args) => mcp.taskSkip((args as unknown as { task_id: string }).task_id),
    },
    {
      name: `${prefix}task_cancel`,
      description: '取消任务（含下游 SKIPPED 传播，复用 DagRepository.cancelTask）',
      parameters: { task_id: { type: 'string', required: true } },
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => jsonText(value) },
      execute: (args) => mcp.taskCancel((args as unknown as { task_id: string }).task_id),
    },
    {
      name: `${prefix}task_reopen`,
      description: '重新打开已关闭任务：CLOSED → AWAITING_FEEDBACK（24h 窗口）',
      parameters: { task_id: { type: 'string', required: true } },
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => jsonText(value) },
      execute: (args) => mcp.taskReopen((args as unknown as { task_id: string }).task_id),
    },
    {
      name: `${prefix}ban_list`,
      description: '熔断/冷却中实体清单（CircuitBreaker.snapshot 非 ACTIVE 项）',
      parameters: {},
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => jsonText(value) },
      execute: () => mcp.banList(),
    },
  ]
  return defs
}

/** 把 weave_* 工具注册到宿主 ctx.tools（无 ctx.tools 时使用"仅服务导出"契约）。 */
export function registerWeaveMcpTools(ctx: Context, mcp: WeaveMcp, options: WeaveHostOptions = {}): WeaveMcpToolsRegistration {
  const tools = (ctx as Context & { tools?: HostToolRuntime }).tools
  if (!tools || typeof tools.register !== 'function') {
    return { registered: [], failed: [], hasToolRuntime: false, unregister: () => undefined }
  }
  const disposers: Array<() => void> = []
  const registered: string[] = []
  const failed: Array<{ name: string; error: string }> = []
  for (const def of buildWeaveToolDefinitions(mcp, options)) {
    try {
      disposers.push(tools.register({ ...def, parameters: toJsonPropertySpec(def.parameters) }))
      registered.push(def.name)
    } catch (e) {
      failed.push({ name: def.name, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return {
    registered,
    failed,
    hasToolRuntime: true,
    unregister: () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // 注销失败不阻断其它工具注销
        }
      }
    },
  }
}

export interface WeaveHostBundle {
  mcp: WeaveMcp
  cli: WeaveCli
  registration: WeaveMcpToolsRegistration
  /** /weave 宿主命令注册（ctx.commands 缺席时 registered=false）。 */
  command: WeaveCommandRegistration
  /** 卸载：注销工具与命令并移除服务挂载（幂等）。 */
  dispose: () => void
}

/**
 * 宿主接线入口：组装 WeaveMcp/WeaveCli → 注册 ctx.tools 工具 → 挂载到 ctx.weave。
 * 需在 ctx.plugin(weavePlugin) 之后调用；deps 见 CliMcpDeps（team/executor/dag/feedback…）。
 */
export function registerWeaveHost(
  ctx: Context,
  deps: CliMcpDeps,
  options: WeaveHostOptionsCommand = {},
): WeaveHostBundle {
  const mcp = new WeaveMcp(deps)
  const cli = new WeaveCli(mcp, options.providerCommand)
  const service = (ctx as Context & { weave?: { mcp?: WeaveMcp; cli?: WeaveCli } }).weave
  if (service) {
    service.mcp = mcp
    service.cli = cli
  }
  const registration = registerWeaveMcpTools(ctx, mcp, options)
  const command = options.registerCommand === false
    ? { registered: false, name: SLASH_COMMAND_NAME, unregister: () => undefined }
    : registerWeaveCommand(ctx, deps, options)
  let disposed = false
  return {
    mcp,
    cli,
    registration,
    command,
    dispose: () => {
      if (disposed) return
      disposed = true
      registration.unregister()
      command.unregister()
      if (service) {
        service.mcp = undefined
        service.cli = undefined
      }
    },
  }
}

/* ============================ 宿主斜杠命令（t41） ============================ */

/** 宿主命令名（无前导斜杠）。 */
export const SLASH_COMMAND_NAME = 'weave'

/** 宿主 CommandRuntime 的最小结构视图（与 @deepseek-ai/dsh-commands 0.1.1-rc.2 一致）。 */
export interface HostCommandRuntime {
  register(definition: HostCommandDefinition): () => void
}

/** dsh-commands CommandDefinition / CommandInvocation / CommandResult 的最小结构视图。 */
export interface HostCommandDefinition {
  name: string
  description: string
  input?: { hint: string; images?: boolean }
  recordInput?: boolean
  handler: (invocation: HostCommandInvocation) => HostCommandResult | Promise<HostCommandResult>
}

export interface HostCommandInvocation {
  commandId: unknown
  agent: unknown
  rawInput: string
  attachments: unknown[]
  signal: AbortSignal
}

export type HostCommandResult =
  | { kind: 'success'; text?: string }
  | { kind: 'error'; text: string }

export interface WeaveCommandRegistration {
  /** 是否真的注册进 ctx.commands（false = 仅服务导出契约） */
  registered: boolean
  name: string
  unregister: () => void
}

export interface WeaveHostOptionsCommand extends WeaveHostOptions {
  /** registerWeaveHost 是否同时注册 /weave 宿主命令（默认 true；ctx.commands 缺席时自动降级） */
  registerCommand?: boolean
}

/** 扫描从 start 开始的 JSON 对象/数组，返回包含空格与引号的完整 JSON 文本。 */
function scanJsonToken(input: string, start: number): string {
  const open = input[start]!
  const close = open === '{' ? '}' : ']'
  let depth = 1
  let inString = false
  let escaped = false
  let i = start + 1
  while (i < input.length) {
    const ch = input[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
    } else {
      if (ch === '"') inString = true
      else if (ch === open) depth += 1
      else if (ch === close) {
        depth -= 1
        if (depth === 0) {
          i += 1
          break
        }
      }
    }
    i += 1
  }
  return input.slice(start, i)
}

/**
 * shell-like 分词：空格分隔 + 双引号包裹（引号内空格保留原文）。
 * 额外支持把完整的 JSON 对象/数组（含内部空格和引号）作为单个参数保留，
 * 因此 `/weave provider add {"name":"my agent",...}` 可直接粘贴。
 * 例：`task status --dag "dag-proj x"` → ['task','status','--dag','dag-proj x']。
 */
export function tokenizeCommandLine(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let inQuotes = false
  let hasToken = false
  let i = 0
  while (i < input.length) {
    const ch = input[i]!
    if (ch === '"') {
      inQuotes = !inQuotes
      hasToken = true
      i += 1
      continue
    }
    if (!inQuotes && (ch === '{' || ch === '[') && !hasToken) {
      const jsonToken = scanJsonToken(input, i)
      if (jsonToken.length > 0) {
        tokens.push(jsonToken)
        i += jsonToken.length
        continue
      }
    }
    if (ch === ' ' && !inQuotes) {
      if (hasToken) {
        tokens.push(current)
        current = ''
        hasToken = false
      }
      i += 1
      continue
    }
    current += ch
    hasToken = true
    i += 1
  }
  if (hasToken) tokens.push(current)
  return tokens
}

/**
 * 注册真实宿主斜杠命令 `/weave`（ctx.commands.register，参照 dsh-command-compact）。
 * handler 解析 rawInput → WeaveCli.run(argv) → CommandResult（exitCode=0 → success，
 * 否则/异常 → error）；注册随 disposer 生命周期清理（dispose 幂等）。
 * ctx.commands 缺席时返回 {registered:false}（仅服务导出契约）。
 */
export function registerWeaveCommand(
  ctx: Context,
  deps: CliMcpDeps,
  options: WeaveHostOptions = {},
): WeaveCommandRegistration {
  const commands = (ctx as Context & { commands?: HostCommandRuntime }).commands
  if (!commands || typeof commands.register !== 'function') {
    return { registered: false, name: SLASH_COMMAND_NAME, unregister: () => undefined }
  }
  const mcp = new WeaveMcp(deps)
  const cli = new WeaveCli(mcp, options.providerCommand)
  const service = (ctx as Context & { weave?: { mcp?: WeaveMcp; cli?: WeaveCli } }).weave
  if (service) {
    service.mcp = mcp
    service.cli = cli
  }
  const disposer = commands.register({
    name: SLASH_COMMAND_NAME,
    description:
      'Weave 协作框架命令：团队/任务/知识/执行器/熔断管理。子命令：team list|switch、' +
      'task status|revise|accept|retry|skip|cancel|reopen、dag <dag_id>、' +
      'executor list、knowledge review|approve|reject、ban list',
    input: {
      hint: 'weave <子命令> [参数...]　例：weave team list / weave task status --dag <dag_id>',
    },
    handler: async (invocation: HostCommandInvocation): Promise<HostCommandResult> => {
      try {
        const tokenized = tokenizeCommandLine(invocation.rawInput)
        const addMatch = invocation.rawInput.match(/^\s*provider\s+add(?:\s+)?([\s\S]*)$/i)
        const argv = tokenized[0] === 'provider' && tokenized[1] === 'add' && addMatch
          ? ['provider', 'add', addMatch[1]!.trim()]
          : tokenized
        const result = await cli.run(argv)
        return result.exitCode === 0
          ? { kind: 'success', text: result.text }
          : { kind: 'error', text: result.text || result.json }
      } catch (e) {
        return { kind: 'error', text: e instanceof Error ? e.message : String(e) }
      }
    },
  })
  return { registered: true, name: SLASH_COMMAND_NAME, unregister: disposer }
}

/**
 * 默认 CliMcpDeps 组装（真实部署直接接入）：openPersistence(~/.dsh/state)、
 * ExecutorRegistry.load(ctx.subagents)、TeamManager(~/.dsh/teams)、FeedbackRouter、
 * DagRepository、KnowledgeStore(~/.dsh/knowledge)+Review、AuditLog(~/.dsh/audit)、CircuitBreaker。
 * 注意：会创建/打开磁盘文件（非 :memory:）；测试请用显式 deps（见 __tests__/cli-mcp.test.ts newEnv）。
 */
export interface DefaultCliDepsOptions {
  stateDir?: string
  teamsDir?: string
  auditDir?: string
  knowledgeDir?: string
}

export function createDefaultCliDeps(ctx: Context, options: DefaultCliDepsOptions = {}): CliMcpDeps {
  const persistence = openPersistence({ ...(options.stateDir ? { stateDir: options.stateDir } : {}) })
  const registry = new ExecutorRegistry()
  registry.load(ctx as never) // 真实宿主 ctx.subagents 存在；缺失时 registry 为空（团队校验由 TeamManager 拦截）
  const tracker = new SessionTracker(persistence.feedback)
  const router = new FeedbackRouter({ tasks: persistence.tasks, feedback: persistence.feedback, sessionTracker: tracker })
  const teamsDir = options.teamsDir ?? join(homedir(), '.dsh', 'teams')
  const knowledgeRoot = options.knowledgeDir ?? join(homedir(), '.dsh', 'knowledge')
  const auditDir = options.auditDir ?? DEFAULT_AUDIT_DIR
  const kstore = new KnowledgeStore({ rootDir: knowledgeRoot, metaDb: persistence.knowledgeMeta })
  const kreview = new KnowledgeReviewService({ knowledge: kstore, audit: new AuditLog({ dir: auditDir }) })
  const importPipeline = new ImportPipeline({
    importsDb: persistence.imports,
    importsDir: join(homedir(), '.dsh', 'imports'),
    knowledgeStore: kstore,
  })
  return {
    persistence,
    teamManager: new TeamManager(registry, { teamsDir, persistence }),
    executorRegistry: registry,
    feedbackRouter: router,
    dagRepository: new DagRepository(persistence),
    knowledgeReview: kreview,
    knowledgeStore: kstore,
    importPipeline,
    circuitBreaker: new CircuitBreaker(),
  }
}

export interface CreateDefaultExecutorProviderRegistryOptions {
  /** 显式覆盖 ZCode ACP 配置；缺省读取 WEAVE_ZCODE_* 环境变量。 */
  zcode?: AcpSessionProviderConfig
  /** 是否包含 DSH 原生子代理 fallback；默认 true。 */
  includeDsh?: boolean
}

/**
 * 创建统一执行器 Provider 注册表：
 * - 若配置了 ZCode ACP，则注册支持实时输出 / 模型 / 思考深度 / 模式的 Provider；
 * - 注册 DSH 原生子代理作为 fallback。
 * 解析顺序按注册顺序：ZCode 优先于通用 DSH fallback。
 */
export function createDefaultExecutorProviderRegistry(
  ctx: Context,
  options: CreateDefaultExecutorProviderRegistryOptions = {},
): ExecutorProviderRegistry {
  const registry = new ExecutorProviderRegistry()
  const runtimeCtx = ctx as Context & {
    subprocess?: {
      spawn(spec: {
        argv: string[]
        cwd?: string
        env?: Record<string, string>
        stdio: { stdin: 'pipe'; stdout: 'pipe'; stderr: 'inherit' | 'ignore' | 'pipe' }
        graceMs?: number
      }): unknown
    }
  }
  const zcodeConfig = options.zcode ?? zcodeAcpProviderConfigFromEnvironment(process.env)
  const subagents = ctx.reflect.get('subagents', false) as
    | { registerProvider?(provider: unknown): () => void }
    | undefined
  const subprocess = runtimeCtx.subprocess

  if (zcodeConfig && subprocess) {
    const acp = new AcpSessionProvider(
      {
        ...zcodeConfig,
        // iso-1：sessionKey→acpSid 持久索引，跨重启保持「同键续接、异键隔离」。
        sessionIndexFile: DEFAULT_ACP_SESSION_INDEX_FILE,
      },
      (spec) => subprocess.spawn(spec) as never,
    )
    // 同时注册到 ctx.subagents，保证 ExecutorRegistry / 执行器列表可以发现 zcode。
    subagents?.registerProvider?.(acp)
    registry.register(new ZcodeAcpExecutorProvider(acp))
  }

  if (options.includeDsh !== false && subagents) {
    registry.register(new DshSubagentExecutorProvider(subagents as unknown as ConstructorParameters<typeof DshSubagentExecutorProvider>[0]))
  }

  return registry
}

/** 便捷入口：默认 deps → { mcp, cli }（与 registerWeaveHost 同用途，跳过工具/命令注册）。 */
export function buildDefaultWeaveCli(ctx: Context): { mcp: WeaveMcp; cli: WeaveCli; deps: CliMcpDeps } {
  const deps = createDefaultCliDeps(ctx)
  const mcp = new WeaveMcp(deps)
  return { mcp, cli: new WeaveCli(mcp), deps }
}
