import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { AuditLog, DEFAULT_AUDIT_DIR } from '../audit/audit-log.js'
import { WeaveCli, WeaveMcp, type CliMcpDeps } from './cli-mcp.js'
import type { GetStatusInput } from './cli-mcp.js'
import { PrismClient } from '../prism/prism-client.js'
import { PrismSupervisor } from '../prism/prism-supervisor.js'
import { PrismGateway } from '../prism/gateway.js'
import { PrismTeamSource } from '../prism/team-source.js'
import type { PlanTasksOutput, ToolExecLike } from '../scheduling/planner.js'
import { CircuitBreaker } from '../safety/circuit-breaker.js'
import { DagRepository } from '../dag/repository.js'
import { ExecutorRegistry } from '../executors/executor-registry.js'
import { FeedbackRouter } from '../scheduling/feedback-router.js'
import { createWeaveNoticeMessage, hasPendingToolCall, notifySession, type NoticeSessionLike, type WeaveNoticeMessage } from '../scheduling/session-delegation.js'
import { TaskStatusNotifier } from '../scheduling/task-status-notifier.js'
import { openPersistence } from '../persistence/persistence.js'
import { SessionTracker } from '../scheduling/session-tracker.js'
import { TeamManager } from '../team/team-manager.js'
import { ExecutorProviderRegistry } from '../executors/executor-provider.js'
import { DshSubagentExecutorProvider } from '../executors/dsh-subagent-executor-provider.js'
import type { ExecutorChildPersistence } from '../executors/executor-child-store.js'
import { AcpSessionProvider, DEFAULT_ACP_SESSION_INDEX_FILE, ZcodeAcpExecutorProvider, zcodeAcpProviderConfigFromEnvironment, type AcpSessionProviderConfig } from '../acp/acp-session-provider.js'
import { DEFAULT_WORKBUDDY_ACP_SESSION_INDEX_FILE, workbuddyAcpProviderConfigFromEnvironment } from '../acp/workbuddy-provider.js'
import { createStoredAcpExecutorProvider } from '../acp/acp-session-provider.js'
import { dynamicCapabilitiesFor } from '../acp/dynamic-provider.js'

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
  /**
   * 会话 id 解析回调：weave_team_switch 未显式传 session_id 时，从工具执行上下文
   * （exec.agent 血统回溯到宿主根会话）解析真实会话 id；未注入或解析失败时才回落
   * 'cli-session'（纯 CLI 场景）。避免绑定落进假 id 导致面板按 sessionId 查空。
   */
  resolveSessionId?: (exec: unknown) => string | undefined
  /**
   * pull 模型任务板（成员侧工具）：claim/update/listMine 由调度器+成员域实现，
   * 身份解析（exec.agent → 成员）在接线层完成。未注入时工具返回 configuration_error。
   */
  taskBoard?: {
    claim(args: { task_id: string; expected_revision?: number }, exec: unknown): Promise<unknown>
    update(args: { task_id: string; action: 'complete' | 'release' | 'fail'; expected_revision?: number; attempt_token?: string; result?: string; reason?: string; message?: string }, exec: unknown): Promise<unknown>
    listMine(exec: unknown): Promise<unknown>
  }
  /** pull 模型队长侧成员原语（官方 spawn_teammate/send_message/list_agents 语义）。 */
  teammates?: {
    spawn(args: { role_id: string }, exec: unknown): Promise<unknown>
    send(args: { role_id: string; text: string }, exec: unknown): Promise<unknown>
    list(): Promise<unknown>
  }
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

/** 队长执行纪律（pull 模型瘦身版：派发/追加由调度器机制承担，只留模型自觉项）。 */
export const CAPTAIN_DISCIPLINE: readonly string[] = [
  '有在途任务时必须值守：用 weave_wait_dag_change 阻塞等待状态变更（替代轮询），用户消息优先处理，不得擅自结束会话回合。',
  '新需求增量追加到当前任务组（append_to 或单任务 task_create），非用户明确要求禁止新建任务组。',
  '任务完成后主动读取交付物并推进下一步（下游任务或汇总答复），不等用户触发；失败走 retry/cancel 治理。',
  '质量分层：常规任务由开发自测与测试覆盖，QA 只做终审收口；重大任务块才让 QA 提前介入。',
]

const CAPTAIN_DISCIPLINE_TEXT = `## 队长执行纪律
${CAPTAIN_DISCIPLINE.map((line, i) => `${i + 1}. ${line}`).join('\n')}`

/** 将 WeaveMcp 的业务命令映射为 dsh-tools ToolDefinition 列表（队长模式下发走 weave_plan_tasks）。 */
export function buildWeaveToolDefinitions(mcp: WeaveMcp, options: WeaveHostOptions = {}): HostToolDefinition[] {
  const prefix = options.toolPrefix ?? 'weave_'
  const defs: HostToolDefinition[] = [
    {
      name: `${prefix}plan_tasks`,
      description:
        '创建团队任务（单个=直派给一个角色；多个=带依赖批量下发）：assignee 填角色 id 或名称；' +
        'dsh 执行器的持久成员会认领任务并回报，其他执行器自动派发。任务编号以此处创建的 T1/T2… 为准' +
        '（文档/方案里的章节号不是任务号）；append_to 不传时自动沿用当前任务组。' +
        '团队无需显式启用：默认团队或唯一团队自动生效。',
      parameters: {
        goal: { type: 'string', description: '本次规划的整体目标（可选，用于摘要展示）' },
        project_id: { type: 'string', description: '项目标识（缺省 session）' },
        version: { type: 'string', description: '版本标识（缺省 adhoc）' },
        append_to: { type: 'string', description: '追加模式：目标 DAG 的 dag_id——把本批任务增量追加进该任务组（编号在其域内自动递增，依赖可引用其既有任务）；缺省新建 DAG' },
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
      output: {
        schema: OUTPUT_SCHEMA,
        // 返回汇总附带队长执行纪律：派发即提示，约束本轮后续行为（值守/推进/治理/追加）。
        render: (args, value) => [
          { type: 'text' as const, text: `${jsonText(value)[0]?.text ?? ''}\n\n${CAPTAIN_DISCIPLINE_TEXT}` },
        ],
      },
      execute: (args, exec) =>
        options.planTasks
          ? options.planTasks(args as Record<string, unknown>, exec as ToolExecLike)
          : Promise.reject(new Error('configuration_error: 队长调度器未就绪（weave_plan_tasks 不可用）')),
    },
    {
      name: `${prefix}task_create`,
      description:
        '创建单个团队任务（直派）：assignee 填角色 id/名称，插件自动建/并入任务组并唤醒成员。' +
        '多任务带依赖批量下发用 weave_plan_tasks。',
      parameters: {
        description: { type: 'string', required: true, description: '完整任务说明' },
        assignee: { type: 'string', required: true, description: '角色 id 或名称' },
        subject: { type: 'string', description: '短标题（缺省取描述首行）' },
        blocked_by: { type: 'array', items: { type: 'string' }, description: '上游任务 id（须已存在）' },
        append_to: { type: 'string', description: '目标 DAG id（缺省自动沿用当前任务组）' },
      },
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => jsonText(value) },
      execute: (args, exec) => {
        const input = args as { description?: string; assignee?: string; subject?: string; blocked_by?: string[]; append_to?: string }
        if (!input.description || !input.assignee) {
          return Promise.reject(new Error('invalid_argument: description 与 assignee 必填'))
        }
        return options.planTasks
          ? options.planTasks(
              {
                tasks: [{
                  ...(input.subject !== undefined ? { subject: input.subject } : {}),
                  description: input.description,
                  assignee: input.assignee,
                  ...(input.blocked_by !== undefined ? { depends_on: input.blocked_by } : {}),
                }],
                ...(input.append_to !== undefined ? { append_to: input.append_to } : {}),
              },
              exec as ToolExecLike,
            )
          : Promise.reject(new Error('configuration_error: 队长调度器未就绪（weave_task_create 不可用）'))
      },
    },
    {
      name: `${prefix}spawn_teammate`,
      description: '创建/取回持久团队成员（pull 模型）：成员是驻留会话，认领名下任务并回报；幂等。',
      parameters: { role_id: { type: 'string', required: true, description: '角色 id' } },
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => jsonText(value) },
      execute: (args, exec) =>
        options.teammates
          ? options.teammates.spawn(args as { role_id: string }, exec)
          : Promise.reject(new Error('configuration_error: 成员域未就绪（weave_spawn_teammate 不可用）')),
    },
    {
      name: `${prefix}send_message`,
      description:
        '向持久成员发消息（官方 agent-team 语义）：执行中就近插入（steer）、空闲开新回合、' +
        '离线冷恢复。用于补充上下文/追问/调整方向。',
      parameters: {
        role_id: { type: 'string', required: true },
        text: { type: 'string', required: true },
      },
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => jsonText(value) },
      execute: (args, exec) =>
        options.teammates
          ? options.teammates.send(args as { role_id: string; text: string }, exec)
          : Promise.reject(new Error('configuration_error: 成员域未就绪（weave_send_message 不可用）')),
    },
    {
      name: `${prefix}list_agents`,
      description: '列出持久成员与状态（running/idle/inactive/failed）。',
      parameters: {},
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => jsonText(value) },
      execute: () =>
        options.teammates
          ? options.teammates.list()
          : Promise.reject(new Error('configuration_error: 成员域未就绪（weave_list_agents 不可用）')),
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
      description: '切换当前会话团队并持久化会话绑定（不传 session_id 时自动取当前宿主会话）',
      parameters: { team_id: { type: 'string', required: true }, session_id: { type: 'string' } },
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => jsonText(value) },
      execute: (args, exec) => {
        const input = args as unknown as { team_id: string; session_id?: string }
        // 显式 session_id > exec 血统回溯 > 'cli-session'（cli-mcp 内兜底，纯 CLI 场景）。
        const hasExplicit = typeof input.session_id === 'string' && input.session_id !== ''
        const resolved = hasExplicit ? input.session_id : options.resolveSessionId?.(exec)
        return mcp.teamSwitch(resolved === undefined ? input : { ...input, session_id: resolved })
      },
    },
    {
      name: `${prefix}executor_list`,
      description: '列出已发现执行器（provider 名/分类/能力）',
      parameters: {},
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => jsonText(value) },
      execute: () => mcp.executorList(),
    },
    // ---------- 知识面（prism 承接）：weave knowledge_* MCP 工具全删 ----------
    // agent 检索走 prism 原生 prism_kb_* 工具（经 ACP mcp_servers 注册）；
    // 主会话审核走 /weave CLI（knowledge review|approve|reject，操作 weave 暂存区）。
    // ---------- pull 模型任务板（成员侧，官方 agent-team team_task_* 语义） ----------
    {
      name: `${prefix}task_claim`,
      description:
        '认领名下就绪任务（pull 模型）：任务须 assignee 为你且状态 WAITING、上游全部完成。' +
        '认领成功任务进入 RUNNING 并返回 attempt 句柄（回报时回传 expected_revision）。',
      parameters: {
        task_id: { type: 'string', required: true },
        expected_revision: { type: 'number', description: '任务板列表返回的 revision（CAS 防并发认领）' },
      },
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => jsonText(value) },
      execute: (args, exec) =>
        options.taskBoard
          ? options.taskBoard.claim(args as { task_id: string; expected_revision?: number }, exec)
          : Promise.reject(new Error('configuration_error: 任务板未就绪（weave_task_claim 不可用）')),
    },
    {
      name: `${prefix}task_update`,
      description:
        '回报名下任务（pull 模型）：action=complete（交付摘要填 result，供下游/队长引用）|' +
        'release（暂时无法推进，附 reason，任务回 INTERRUPTED 等队长重开）|fail（执行失败，附 message）。',
      parameters: {
        task_id: { type: 'string', required: true },
        action: { type: 'string', required: true, description: 'complete | release | fail' },
        expected_revision: { type: 'number' },
        attempt_token: { type: 'string', description: 'claim 返回的 attempt 句柄' },
        result: { type: 'string', description: 'complete：交付摘要（结论+关键产物路径）' },
        reason: { type: 'string', description: 'release：原因' },
        message: { type: 'string', description: 'fail：失败信息' },
      },
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => jsonText(value) },
      execute: (args, exec) =>
        options.taskBoard
          ? options.taskBoard.update(args as never, exec)
          : Promise.reject(new Error('configuration_error: 任务板未就绪（weave_task_update 不可用）')),
    },
    {
      name: `${prefix}task_list`,
      description: '查看名下任务板（pull 模型）：assignee 为你的任务与状态/revision/依赖就绪度。',
      parameters: {},
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => jsonText(value) },
      execute: (args, exec) =>
        options.taskBoard
          ? options.taskBoard.listMine(exec)
          : Promise.reject(new Error('configuration_error: 任务板未就绪（weave_task_list 不可用）')),
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
      name: `${prefix}wait_dag_change`,
      description:
        '队长值守等待：阻塞到任务组（dag_id）的下一条状态变更（任务开始/完成/失败/取消/跳过）后返回，' +
        '替代在途任务期间的 15 秒级高频轮询——调用本工具期间无需重复 get_status。' +
        '无在途任务时立即返回 no_progress=true（此时应直接查状态或推进下一步，不要空等）。' +
        '返回含 timed_out 与当前各任务状态快照；timeout_ms 缺省 60000，允许 10000~3600000。',
      parameters: {
        dag_id: { type: 'string', required: true, description: '任务组 id' },
        timeout_ms: { type: 'number', description: '最长等待毫秒数（10000~3600000，缺省 60000）' },
      },
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => jsonText(value) },
      execute: (args) => mcp.waitDagChange(args as unknown as { dag_id: string; timeout_ms?: number }),
    },
    {
      name: `${prefix}ban_list`,
      description: '熔断/冷却中实体清单（CircuitBreaker.snapshot 非 ACTIVE 项）',
      parameters: {},
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => jsonText(value) },
      execute: () => mcp.banList(),
    },
    // ---------- doc/09 §2.4：weave_graph_*（prism 代码图谱代理） ----------
    {
      name: `${prefix}graph_build`,
      description: '构建/更新项目代码图谱（Prism 承接，异步构建至终态）',
      parameters: {},
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => jsonText(value) },
      execute: () => mcp.graphBuild(),
    },
    {
      name: `${prefix}graph_query`,
      description: '代码图谱语义查询：输入自然语言/符号问题（Prism 图谱）',
      parameters: {
        question: { type: 'string', required: true, description: '查询问题（自然语言或符号描述）' },
      },
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => jsonText(value) },
      execute: (args) => mcp.graphQuery(args as unknown as { question: string }),
    },
    {
      name: `${prefix}graph_path`,
      description: '查询两个代码节点之间的最短路径（Prism 图谱）',
      parameters: {
        source: { type: 'string', required: true, description: '起始节点 id/名称' },
        target: { type: 'string', required: true, description: '目标节点 id/名称' },
      },
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => jsonText(value) },
      execute: (args) => mcp.graphPath(args as unknown as { source: string; target: string }),
    },
    {
      name: `${prefix}graph_explain`,
      description: '解释单个代码图谱节点（Prism 图谱）',
      parameters: { node: { type: 'string', required: true, description: '节点 id/名称' } },
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => jsonText(value) },
      execute: (args) => mcp.graphExplain(args as unknown as { node: string }),
    },
    {
      name: `${prefix}graph_affected`,
      description: '根据改动文件列表计算影响面（Prism 图谱 affected）',
      parameters: {
        files: {
          type: 'array',
          items: { type: 'string' },
          required: true,
          description: '改动文件路径列表（相对项目根）',
        },
      },
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => jsonText(value) },
      execute: (args) => mcp.graphAffected(args as unknown as { files: string[] }),
    },
    // ---------- 文档转换（prism kb convert 代理） ----------
    {
      name: `${prefix}document_convert`,
      description:
        '独立文档转换（Prism 承接）：把 doc/docx/odt/rtf/epub/pdf/ppt/pptx/xls/xlsx/csv 转为 GFM Markdown，' +
        '返回标题/状态与 Markdown 内容。服务端路径模式传 file，base64 上传模式传 filename+data。',
      parameters: {
        file: { type: 'string', description: '服务端本地文件路径（CLI/服务端模式）' },
        filename: { type: 'string', description: '原始文件名（base64 上传模式必填）' },
        data: { type: 'string', description: 'base64 文件内容（控制台浏览器上传模式）' },
        format: { type: 'string', description: '可选格式提示' },
      },
      output: { schema: OUTPUT_SCHEMA, render: (args, value) => jsonText(value) },
      execute: (args) => mcp.documentConvert(args as unknown as { file?: string; filename?: string; data?: string; format?: string }),
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
      'Weave 协作框架命令：团队/任务/知识/执行器/熔断/图谱/文档转换管理。子命令：team list|switch、' +
      'task status|revise|accept|retry|skip|cancel|reopen、dag <dag_id>、' +
      'executor list、knowledge search|review|approve|reject、ban list、' +
      'graph build|query|path|explain|affected、document convert（知识/图谱/转换由 Prism 控制面承接）',
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
 * DagRepository、PrismGateway（知识/图谱/转换，prism serve 本机托管）、
 * AuditLog(~/.dsh/audit)、CircuitBreaker。
 * 注意：会创建/打开磁盘文件（非 :memory:）；测试请用显式 deps（见 __tests__/cli-mcp.test.ts newEnv）。
 */
export interface DefaultCliDepsOptions {
  stateDir?: string
  teamsDir?: string
  auditDir?: string
  /** PrismGateway 注入覆盖（测试/自定义部署）；缺省按本机默认组装。 */
  prism?: PrismGateway
  /** prism serve 基址（缺省 http://127.0.0.1:7777）。 */
  prismBaseUrl?: string
  /** prism 数据目录（PRISM_HOME，缺省 ~/.dsh/prism）。 */
  prismHome?: string
  /** 是否允许托管拉起 prism serve（缺省 true）。 */
  prismAutoStart?: boolean
  /** prism 团队角色映射的缺省执行器（缺省 codex）。 */
  prismDefaultExecutor?: string
}

export function createDefaultCliDeps(ctx: Context, options: DefaultCliDepsOptions = {}): CliMcpDeps {
  const persistence = openPersistence({ ...(options.stateDir ? { stateDir: options.stateDir } : {}) })
  const registry = new ExecutorRegistry()
  registry.load(ctx as never) // 真实宿主 ctx.subagents 存在；缺失时 registry 为空（团队校验由 TeamManager 拦截）
  const tracker = new SessionTracker(persistence.feedback)
  // 任务状态变更通知单出口 + 共享审计（doc/05 §6.4 P1-D）：六组接线点统一发电。
  // 会话面经 ctx.agents 按 sessionId 解析后 notifySession 回灌；echoSelfActions
  // 缺省 false——captain/user 自发动作不回声（部署缺省）。
  const auditDir = options.auditDir ?? DEFAULT_AUDIT_DIR
  const audit = new AuditLog({ dir: auditDir })
  const statusNotifier = new TaskStatusNotifier({
    notify: (sessionId, text) => {
      const agent = (ctx as unknown as { agents?: { get?: (id: string) => { session?: unknown; inject?: (message: WeaveNoticeMessage) => void } | undefined } }).agents?.get?.(sessionId)
      const session = (agent as { session?: NoticeSessionLike } | undefined)?.session
      const inject = (agent as { inject?: (message: WeaveNoticeMessage) => void } | undefined)?.inject
      if (session && inject && hasPendingToolCall(session)) {
        inject(createWeaveNoticeMessage(text))
      } else if (session) {
        notifySession(session, text)
      }
    },
  })
  const router = new FeedbackRouter({
    tasks: persistence.tasks,
    feedback: persistence.feedback,
    sessionTracker: tracker,
    statusNotifier,
    audit,
  })
  const teamsDir = options.teamsDir ?? join(homedir(), '.dsh', 'teams')
  // Prism 控制面：知识库/图谱/文档转换的唯一后端（子项目承接）。
  const prismClient = new PrismClient(options.prismBaseUrl !== undefined ? { baseUrl: options.prismBaseUrl } : {})
  const prismSupervisor = new PrismSupervisor({
    client: prismClient,
    ...(options.prismHome !== undefined ? { prismHome: options.prismHome } : {}),
    autoStart: options.prismAutoStart ?? true,
  })
  const prism = options.prism ?? new PrismGateway({
    client: prismClient,
    supervisor: prismSupervisor,
    audit,
    // 默认根链与旧 GraphService 一致：显式 env > 插件仓根（src/dist 布局均四级向上）。
    ...(process.env.WEAVE_GRAPH_PROJECT_ROOT
      ? { defaultProjectRoot: process.env.WEAVE_GRAPH_PROJECT_ROOT }
      : { defaultProjectRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..') }),
  })
  return {
    persistence,
    teamManager: new TeamManager(registry, {
      teamsDir,
      persistence,
      // pre-step（每条用户消息）与 Team Tab 1s 心跳都会解析团队；1s 缓存把
      // 目录扫描+逐 YAML 读取合并为一次，import/delete/setDefault 写后立即失效。
      cacheTtlMs: 1000,
      // P2：prism 团队源——本地 YAML 之外的编制来源（prism 故障静默降级为空）。
      externalTeams: new PrismTeamSource({
        gateway: prism,
        ...(options.prismDefaultExecutor !== undefined ? { defaultExecutor: options.prismDefaultExecutor } : {}),
      }),
    }),
    executorRegistry: registry,
    feedbackRouter: router,
    dagRepository: new DagRepository(persistence, { statusNotifier, audit }),
    prism,
    prismSupervisor,
    circuitBreaker: new CircuitBreaker(),
    statusNotifier,
    audit,
  }
}

export interface CreateDefaultExecutorProviderRegistryOptions {
  /** 显式覆盖 ZCode ACP 配置；缺省读取 WEAVE_ZCODE_* 环境变量。 */
  zcode?: AcpSessionProviderConfig
  /** 是否包含 DSH 原生子代理 fallback；默认 true。 */
  includeDsh?: boolean
  /** 可选持久映射（executor_children，core.db v3）：continuable 子代理跨重启恢复对账用。 */
  childrenStore?: ExecutorChildPersistence
  /** 追加进每个 ACP 会话的 MCP server（如 prism：prism_kb_* 工具面）。 */
  extraMcpServers?: unknown[]
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
        // prism MCP 注入：agent 会话内直接使用 prism_kb_* / prism_graph_* 工具面。
        ...(options.extraMcpServers?.length
          ? { mcpServers: [...(zcodeConfig.mcpServers ?? []), ...options.extraMcpServers] }
          : {}),
        // iso-1：sessionKey→acpSid 持久索引，跨重启保持「同键续接、异键隔离」。
        sessionIndexFile: DEFAULT_ACP_SESSION_INDEX_FILE,
      },
      (spec) => subprocess.spawn(spec) as never,
    )
    // 同时注册到 ctx.subagents，保证 ExecutorRegistry / 执行器列表可以发现 zcode。
    subagents?.registerProvider?.(acp)
    registry.register(new ZcodeAcpExecutorProvider(acp))
  }

  // WorkBuddy（CodeBuddy 引擎）：原生 ACP agent，CLI 存在即自动注册。
  // 独立会话索引（sessionKey 无执行器维度，与 zcode 共用索引会互相串线索）；
  // 能力面 = 动态基线（实时输出/会话复用），无 zcode 扩展可协商。
  const workbuddyConfig = workbuddyAcpProviderConfigFromEnvironment(process.env)
  if (workbuddyConfig && subprocess) {
    const acp = new AcpSessionProvider(
      {
        ...workbuddyConfig,
        // prism MCP 同样注入：workbuddy 成员会话内直接使用 prism_kb_* 知识工具面。
        ...(options.extraMcpServers?.length
          ? { mcpServers: [...(workbuddyConfig.mcpServers ?? []), ...options.extraMcpServers] }
          : {}),
        sessionIndexFile: DEFAULT_WORKBUDDY_ACP_SESSION_INDEX_FILE,
      },
      (spec) => subprocess.spawn(spec) as never,
    )
    subagents?.registerProvider?.(acp)
    registry.register(createStoredAcpExecutorProvider(acp, dynamicCapabilitiesFor([])))
  }

  if (options.includeDsh !== false && subagents) {
    const agents = (ctx as Context & { reflect?: { get(name: string, fallback?: boolean): unknown } }).reflect?.get?.('agents', false) as
      | { get(id: string): unknown }
      | undefined
    const dshProvider = new DshSubagentExecutorProvider(subagents as unknown as ConstructorParameters<typeof DshSubagentExecutorProvider>[0], {
      agents,
      childrenStore: options.childrenStore,
    })
    registry.register(dshProvider)
    // 启动 seed：持久映射里的 continuable 子代理直达内存表；失败静默（采纳路径兜底）。
    void dshProvider.hydrateChildren().catch(() => undefined)
  }

  return registry
}

/** 便捷入口：默认 deps → { mcp, cli }（与 registerWeaveHost 同用途，跳过工具/命令注册）。 */
export function buildDefaultWeaveCli(ctx: Context): { mcp: WeaveMcp; cli: WeaveCli; deps: CliMcpDeps } {
  const deps = createDefaultCliDeps(ctx)
  const mcp = new WeaveMcp(deps)
  return { mcp, cli: new WeaveCli(mcp), deps }
}
