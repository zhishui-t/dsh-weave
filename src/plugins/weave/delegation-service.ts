import type { ExecutorRegistry } from './executor-registry.js'
import type { SessionTracker } from './session-tracker.js'
import type { ProcessLimiter } from './safety/process-limiter.js'
import type { TaskRecord } from './state/types.js'
import { WeaveError } from './state/weave-error.js'
import type { ExecutorProviderRegistry, ExecutorRuntimeOptions } from './executors/executor-provider.js'

/**
 * P0-DELEG-007 —— DelegationService：基于 `ctx.subagents.start` 的统一委托执行。
 *
 * 红线（ADR-030/031/033）：唯一执行出口为 `ctx.subagents.start(executor, {...})`；
 * 全文件禁止 spawn/kill/child_process 等自研进程管理；Weave 只消费
 * `SubagentRun { id, result: Promise<SubagentResult>, dispose() }`。
 *
 * 契约（TDD 1.5.3 / SDD 2.3.3，第 2/3 轮修订）：
 * - prompt 以 ContentBlock[]（`[{ type: 'text', text }]`）传入；
 * - parent / signal 必填（真实 DSH 0.1.1-rc.2）；
 * - 子代理失败时 run.result **resolve**（stopReason='error'），不 reject；
 *   仅基础设施故障 reject → 抛 WeaveError('execution_failed')；
 * - 执行前申请 ProcessLimiter 槽位（排队不熔断），finally 释放；
 * - `duration_ms` 由 Weave 自计时（start() → result 完成）。
 *
 * 错误映射（TDD 2.4.3）：`mapStopReason`/`detectPermissionDenied` 输出值域
 * （tasks.error_type）与任务终态/熔断标志，见 `StopReasonMapping`。
 */

export type SubagentStopReason = 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'

export interface ContentBlockLike {
  type: 'text'
  text: string
}

/** TDD 2.4.2 Weave 内部结果类型。 */
export interface SubagentTaskOutput {
  id: string
  output: ContentBlockLike[]
  structured?: unknown
  diagnostic?: string
  stopReason: SubagentStopReason
  /** Weave 自计时（start() → result 完成）。 */
  duration_ms: number
  /**
   * 扩展（TDD 2.4.3 表在 Weave 侧的承载）：调用方据此写 `tasks.error_type`
   * 与终态/熔断标志；`errorType` 值域 = stopReason 或
   * timeout / permission_denied / execution_failed（Weave 应用层判定）。
   */
  weave?: {
    errorType: string | null
    status: 'COMPLETED' | 'CANCELLED' | 'FAILED'
    countBreaker: boolean
  }
}

export interface DelegationResultLike {
  output: ContentBlockLike[]
  structured?: unknown
  diagnostic?: string
  stopReason: SubagentStopReason
}

export interface DelegationRunEventLike {
  type?: string
  text?: string
  name?: string
  data?: unknown
  sessionId?: string
}

export interface DelegationRunLike {
  id: string
  /** DSH 子代理/Provider 运行对应的会话 id（用于前端跳转/展示）。 */
  sessionId?: string
  localAgent?: unknown
  result: Promise<DelegationResultLike>
  dispose(): Promise<void>
  /** 自定义 Provider 的实时事件订阅（优先于 readOutput 轮询）。 */
  onEvent?(listener: (event: DelegationRunEventLike) => void): () => void
  /** 自定义 Provider 的实时事件快照（兜底轮询）。 */
  readOutput?(): DelegationRunEventLike[]
}

/** 执行委托所需的最小 ctx 视面（真实 cordis Context 结构化满足；测试注入 mock）。 */
export interface ExecutorAgentOptions {
  provider?: string
  model?: string
}

export interface DelegationContext {
  /**
   * 宿主会话 id（doc/05 §6.2 P1-B）：调度器从 DagRunContext 传入。
   * 执行器事件的 sessionId 路由优先取它——agent.id 是子代理自身会话，
   * 拿它做通知回灌会把进度发错会话。
   */
  sessionId?: string
  subagents: {
    start(
      name: string,
      request: {
        label?: string
        prompt: ContentBlockLike[]
        parent: unknown
        signal: AbortSignal
        agentOptions?: ExecutorAgentOptions
        /**
         * ACP 会话隔离键。DSH 会把 request 原样透传给 provider；必须作为顶层
         * 字段携带（provider 主键），weave.sessionKey 仅作向后兼容兜底。
         */
        sessionKey?: string
        /** ACP 运行时扩展（会话隔离 / 模型 / 思考深度 / 模式）。 */
        weave?: {
          sessionKey?: string
          resumeSessionId?: string
          modelProvider?: string
          model?: string
          thoughtLevel?: string
          mode?: string
          tools?: ExecutorRuntimeOptions['tools']
        }
      },
    ): Promise<DelegationRunLike>
  }
}

/** TDD 2.3 角色模型（DelegationService 消费的子集）。 */
export interface RoleConfig {
  id: string
  name: string
  bias: string
  executor: string
  stages: string[]
  max_concurrent_tasks: number
  personality: string
  /** 可选 LLM provider 覆盖（如 deepseek-official）；缺省继承父会话路由。 */
  provider?: string
  /** 可选模型 id 覆盖（如 deepseek-v4-flash-vision-exp）；缺省继承父会话模型。 */
  model?: string
  /** ACP 思考深度 / thought level；ZCode 当前支持 off、high、max。 */
  thought_level?: string
  /** ACP/agent 模式；例如 code、architect、yolo。 */
  mode?: string
}

/** TDD 2.3 知识注入限额（团队级唯一来源，ME-2）。 */
export interface KnowledgeInjectionLimits {
  max_entries: number
  max_chars_per_entry: number
  max_total_chars: number
  priority: 'freshness_first'
}

/** TDD 2.3 团队模型（DelegationService 消费的子集）。 */
export interface TeamConfigLike {
  team_id: string
  knowledge_injection: KnowledgeInjectionLimits
}

export interface KnowledgeInjectionEntryLike {
  id: string
  title: string
  content: string
  layer: string
  freshness_score: number
}

/** KnowledgeEngine 最小视面（P0-KINJECT-013 提供完整实现）。 */
export interface KnowledgeEngineLike {
  searchForInjection(params: {
    taskId: string
    projectId: string
    version: string
    roleId: string
    limit: KnowledgeInjectionLimits
    slim?: boolean
  }): Promise<KnowledgeInjectionEntryLike[]>
}

/** 委托上下文（prompt 模板所需；parentAgent 为 DSH Agent，必填于 start）。 */
export interface TaskContext {
  /** 委托父 Agent（DSH 必填；单元测试用占位）。 */
  parentAgent: unknown
  projectName?: string
  repoPath?: string
  gitBranch?: string
  /** 上游任务产物（依赖注入）。 */
  upstreamOutputs?: Array<{ label: string; output: string }>
  outputRequirements?: string
  /** 委托超时 ms（覆盖构造默认值）。 */
  timeoutMs?: number
  /** 本次委托的运行时覆盖；优先于角色默认配置。 */
  runtime?: ExecutorRuntimeOptions
}

export interface StopReasonMapping {
  errorType: string | null
  status: 'COMPLETED' | 'CANCELLED' | 'FAILED'
  countBreaker: boolean
}

export const DEFAULT_DELEGATION_TIMEOUT_MS = 300_000
/** 空闲超时缺省：连续无任何执行器事件的时长上限；0=禁用空闲检测（回退纯墙钟）。 */
export const DEFAULT_DELEGATION_IDLE_TIMEOUT_MS = 600_000
/** 单次委托绝对上限缺省：不受事件重置；0=不限。 */
export const DEFAULT_DELEGATION_MAX_WALL_CLOCK_MS = 0

/** 非交互拒绝启发式（可选 P0，AC-EXEC-004）：命中文本 → permission_denied。 */
const PERMISSION_DENIED_PATTERN =
  /需要批准|需要授权|需要许可|approval required|permission denied|requires permission|not authorized/i

export function detectPermissionDenied(result: { output: ContentBlockLike[]; diagnostic?: string }): boolean {
  if (result.diagnostic && PERMISSION_DENIED_PATTERN.test(result.diagnostic)) return true
  const text = result.output
    .map((block) => block.text)
    .join('\n')
  return PERMISSION_DENIED_PATTERN.test(text)
}

/**
 * TDD 2.4.3 错误映射：DSH stopReason（+ Weave 应用层类别）→
 * tasks.error_type / 任务终态 / 熔断标志。
 */
export function mapStopReason(
  stopReason: SubagentStopReason,
  options?: { weaveErrorType?: 'timeout' | 'idle_timeout'; permissionDenied?: boolean },
): StopReasonMapping {
  if (options?.weaveErrorType === 'timeout' || options?.weaveErrorType === 'idle_timeout') {
    return { errorType: options.weaveErrorType, status: 'FAILED', countBreaker: true }
  }
  switch (stopReason) {
    case 'completed':
      return { errorType: null, status: 'COMPLETED', countBreaker: false }
    case 'aborted':
      return { errorType: 'aborted', status: 'CANCELLED', countBreaker: false }
    case 'error':
    case 'max-tokens':
    case 'refusal':
      if (options?.permissionDenied) {
        return { errorType: 'permission_denied', status: 'FAILED', countBreaker: true }
      }
      return { errorType: 'execution_failed', status: 'FAILED', countBreaker: true }
    default:
      return { errorType: 'execution_failed', status: 'FAILED', countBreaker: true }
  }
}

/** 知识注入段格式化（限额：max_entries / max_chars_per_entry / max_total_chars）。 */
export function formatKnowledgeSection(
  entries: KnowledgeInjectionEntryLike[],
  limits: KnowledgeInjectionLimits,
): string {
  const lines: string[] = []
  let total = 0
  for (const entry of entries.slice(0, Math.max(0, limits.max_entries))) {
    const content =
      entry.content.length > limits.max_chars_per_entry
        ? `${entry.content.slice(0, limits.max_chars_per_entry)}…`
        : entry.content
    const line = `- [${entry.layer}] ${entry.title}（${entry.id}）：${content}`
    if (total + line.length > limits.max_total_chars && lines.length > 0) break
    if (total + line.length > limits.max_total_chars) break
    lines.push(line)
    total += line.length
  }
  return lines.length ? lines.join('\n') : '（无）'
}

export type ExecutorRunEventType = 'status' | 'output' | 'reasoning' | 'tool_call' | 'tool_result'

/** 派发任务时注入的 DSH memory 提示（本地优先/以实际输出为准等）。 */
const DSH_MEMORY_HINTS = `- 先查本地源码、配置、文档，不随意联网搜索。
- 改文件前先重读当前内容，不要凭旧快照改动。
- 命令输出以真实结果为准，环境/工具失败先分类再定位根因。
- 完成后沉淀可复用经验，避免重复踩坑。`

/** 派发任务时注入的执行纪律。 */
const EXECUTION_DISCIPLINE = `- 小步快跑：一次改一处，改完立即验证。
- 失败即停：回到该步定位根因，不盲目换参数重试。
- 同一工具/命令连续失败 2 次后，停止相同重试。
- 连续多种方案仍失败时，向用户如实报告，不假装成功。`

export interface ExecutorRunEvent {
  taskId: string
  executor: string
  runId: string
  sessionId?: string
  type: ExecutorRunEventType
  /** 增量文本 / 状态描述 / 工具名或结果摘要。 */
  text?: string
  name?: string
  data?: unknown
}

export interface DelegationServiceOptions {
  executorRegistry: ExecutorRegistry
  sessionTracker: SessionTracker
  processLimiter: ProcessLimiter
  knowledgeEngine: KnowledgeEngineLike
  /**
   * 兼容入参：历史语义「单次委托总时长上限」。仍被接受并映射为绝对墙钟；
   * 新接线请改用 delegationIdleTimeoutMs + delegationMaxWallClockMs 两参数。
   */
  timeoutMs?: number
  /** 空闲超时：连续无执行器事件（token/工具/状态）才判定挂起；默认 600s，0=禁用。 */
  idleTimeoutMs?: number
  /** 绝对墙钟上限：不受事件重置，任一次委托总时长硬顶；默认 0=不限。 */
  delegationMaxWallClockMs?: number
  /** 可注入时钟（测试用）。 */
  now?: () => number
  /**
   * 执行器运行事件回调：有 localAgent 的执行器可实时输出 token、
   * reasoning、工具调用与状态。远端执行器若不返回 localAgent，则无法流式。
   */
  onExecutorEvent?: (event: ExecutorRunEvent) => void
  /** 每个 run 保留的实时事件数量（轮询/诊断用；默认 200）。 */
  executorEventBufferSize?: number
  /** 统一执行器 Provider 注册表；存在时优先走 Provider 抽象。 */
  executorProviders?: ExecutorProviderRegistry
}

export interface ExecutorRunSnapshot {
  runId: string
  taskId: string
  executor: string
  sessionId?: string
  startedAt: number
  updatedAt: number
  /** running / completed / failed / timeout / cancelled。 */
  state: 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled'
  events: ExecutorRunEvent[]
}

export class DelegationService {
  readonly #ctx: DelegationContext
  readonly #executorRegistry: ExecutorRegistry
  readonly #sessionTracker: SessionTracker
  readonly #processLimiter: ProcessLimiter
  readonly #knowledgeEngine: KnowledgeEngineLike
  readonly #wallClockMs: number
  readonly #idleTimeoutMs: number
  readonly #now: () => number
  readonly #onExecutorEvent?: (event: ExecutorRunEvent) => void
  readonly #executorEventBufferSize: number
  readonly #executorProviders?: ExecutorProviderRegistry
  readonly #executorRuns = new Map<string, ExecutorRunSnapshot>()
  /** 运行中的空闲探针：runId → 收到新事件时的重置回调（await 等待期注册）。 */
  readonly #activitySinks = new Map<string, () => void>()

  constructor(ctx: DelegationContext, options: DelegationServiceOptions) {
    this.#ctx = ctx
    this.#executorRegistry = options.executorRegistry
    this.#sessionTracker = options.sessionTracker
    this.#processLimiter = options.processLimiter
    this.#knowledgeEngine = options.knowledgeEngine
    // 墙钟解析：delegationMaxWallClockMs 显式 > 历史 timeoutMs（等义映射）> 缺省不限。
    // 历史 timeoutMs 的原语义是「总时长上限」，与绝对墙钟一致。
    this.#wallClockMs =
      options.delegationMaxWallClockMs ?? (options.timeoutMs !== undefined ? options.timeoutMs : DEFAULT_DELEGATION_MAX_WALL_CLOCK_MS)
    this.#idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_DELEGATION_IDLE_TIMEOUT_MS
    this.#now = options.now ?? Date.now
    this.#onExecutorEvent = options.onExecutorEvent
    this.#executorEventBufferSize = Math.max(1, options.executorEventBufferSize ?? 200)
    this.#executorProviders = options.executorProviders
  }

  /** 按 runId 查询实时事件快照（最新事件在末尾）。 */
  getExecutorRun(runId: string): ExecutorRunSnapshot | undefined {
    const run = this.#executorRuns.get(runId)
    if (!run) return undefined
    return { ...run, events: [...run.events] }
  }

  /** 查询全部执行器运行快照（新启动的在前）。 */
  listExecutorRuns(): ExecutorRunSnapshot[] {
    return [...this.#executorRuns.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((run) => ({ ...run, events: [...run.events] }))
  }

  #recordExecutorEvent(event: ExecutorRunEvent): void {
    const existing = this.#executorRuns.get(event.runId)
    const now = this.#now()
    if (!existing) {
      this.#executorRuns.set(event.runId, {
        runId: event.runId,
        taskId: event.taskId,
        executor: event.executor,
        ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
        startedAt: now,
        updatedAt: now,
        state: 'running',
        events: [event],
      })
      return
    }
    existing.updatedAt = now
    if (event.sessionId !== undefined) existing.sessionId = event.sessionId
    existing.events.push(event)
    if (existing.events.length > this.#executorEventBufferSize) {
      existing.events.splice(0, existing.events.length - this.#executorEventBufferSize)
    }
  }

  #emitExecutorEvent(event: ExecutorRunEvent): void {
    try {
      this.#recordExecutorEvent(event)
      this.#onExecutorEvent?.(event)
      // 活动感知空闲检测：任何执行器事件（含 status）都视为运行活跃，
      // 重置该 run 的 idle 计时器；等待器未注册（订阅窗口外）时为 noop。
      this.#activitySinks.get(event.runId)?.()
    } catch {
      // 输出观察者不得影响委托主链路。
    }
  }

  /**
   * 事件 sessionId 归属（doc/05 §6.2 P1-B）：宿主会话（context.sessionId，调度器
   * 从 DagRunContext 传入）优先——agent.id/run.sessionId 是子代理自身会话，
   * 拿它做通知回灌会把进度发错会话；两者皆缺时保持 undefined（历史行为）。
   */
  #eventSessionId(fallback: string | undefined): string | undefined {
    return this.#ctx.sessionId ?? fallback
  }

  #finishExecutorRun(
    runId: string,
    state: ExecutorRunSnapshot['state'],
    text?: string,
    data?: unknown,
  ): void {
    const run = this.#executorRuns.get(runId)
    if (!run) return
    run.state = state
    run.updatedAt = this.#now()
    const event: ExecutorRunEvent = {
      taskId: run.taskId,
      executor: run.executor,
      runId,
      ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
      type: 'status',
      ...(text !== undefined ? { text } : {}),
      ...(data !== undefined ? { data } : {}),
    }
    run.events.push(event)
    if (run.events.length > this.#executorEventBufferSize) {
      run.events.splice(0, run.events.length - this.#executorEventBufferSize)
    }
    try {
      this.#onExecutorEvent?.(event)
    } catch {
      // 观察者异常不影响委托结果。
    }
  }

  #resolveRuntime(role: RoleConfig, context: TaskContext): Required<Pick<ExecutorRuntimeOptions,'tools'>> & ExecutorRuntimeOptions {
    const requested = context.runtime ?? {}
    const modelProvider = requested.model?.provider ?? role.provider
    const modelId = requested.model?.id ?? role.model

    return {
      ...requested,
      model:
        modelProvider !== undefined || modelId !== undefined
          ? {
              ...(modelProvider !== undefined ? { provider: modelProvider } : {}),
              ...(modelId !== undefined ? { id: modelId } : {}),
            }
          : undefined,
      thoughtLevel: requested.thoughtLevel ?? role.thought_level,
      mode: requested.mode ?? role.mode,
      tools: {
        management: 'external',
        permission: 'reject',
        ...requested.tools,
      },
    }
  }

  #buildAgentOptions(runtime: ExecutorRuntimeOptions): ExecutorAgentOptions | undefined {
    const options: ExecutorAgentOptions = {}
    if (runtime.model?.provider !== undefined) options.provider = runtime.model.provider
    if (runtime.model?.id !== undefined) options.model = runtime.model.id
    return Object.keys(options).length > 0 ? options : undefined
  }

  /**
   * 订阅执行器事件流。返回 `hasEventSource` 标记是否存在真实事件源：
   * - 有源（onEvent 直通 / readOutput 轮询 / localAgent 桥接）：参与活动感知空闲超时；
   * - 无源（三者皆缺或桥接失败，仅发出 stream_unavailable）：自动回退纯墙钟语义，
   *   避免把「不可观测但健康」的长任务误判为空闲挂起。
   */
  #subscribeRunEvents(taskId: string, executor: string, run: DelegationRunLike): { unsubscribe: () => void; hasEventSource: boolean } {
    // 自定义 ACP Provider 直接暴露实时事件流。
    if (typeof run.onEvent === 'function') {
      const unsubscribe = run.onEvent((event) => {
        const type = (event.type ?? 'status') as ExecutorRunEventType
        this.#emitExecutorEvent({
          taskId,
          executor,
          runId: run.id,
          type,
          sessionId: this.#eventSessionId(event.sessionId),
          ...(event.text !== undefined ? { text: event.text } : {}),
          ...(event.name !== undefined ? { name: event.name } : {}),
          ...(event.data !== undefined ? { data: event.data } : {}),
        })
      })
      this.#emitExecutorEvent({ taskId, executor, runId: run.id, sessionId: this.#eventSessionId(undefined), type: 'status', text: 'streaming' })
      return { unsubscribe: unsubscribe ?? (() => undefined), hasEventSource: true }
    }

    // 兜底：仅提供事件快照的 Provider 用短间隔轮询。
    if (typeof run.readOutput === 'function') {
      let cursor = 0
      const timer = setInterval(() => {
        try {
          const events = run.readOutput?.() ?? []
          while (cursor < events.length) {
            const event = events[cursor]!
            cursor += 1
            const type = (event.type ?? 'status') as ExecutorRunEventType
            this.#emitExecutorEvent({
              taskId,
              executor,
              runId: run.id,
              type,
              sessionId: this.#eventSessionId(event.sessionId),
              ...(event.text !== undefined ? { text: event.text } : {}),
              ...(event.name !== undefined ? { name: event.name } : {}),
              ...(event.data !== undefined ? { data: event.data } : {}),
            })
          }
        } catch {
          // 快照失败不阻断委托。
        }
      }, 250)
      this.#emitExecutorEvent({ taskId, executor, runId: run.id, sessionId: this.#eventSessionId(undefined), type: 'status', text: 'streaming' })
      return { unsubscribe: () => clearInterval(timer), hasEventSource: true }
    }

    const agent = run.localAgent as
      | {
          id?: string
          ctx?: { on?: (event: string, listener: (session: unknown, event: unknown) => void) => (() => void) | undefined }
        }
      | undefined

    if (!agent?.ctx?.on || typeof agent.ctx.on !== 'function') {
      this.#emitExecutorEvent({
        taskId,
        executor,
        runId: run.id,
        sessionId: this.#eventSessionId(undefined),
        type: 'status',
        text: 'stream_unavailable',
      })
      return { unsubscribe: () => undefined, hasEventSource: false }
    }

      try {
        const unsubscribe = agent.ctx.on('session/event', (session, rawEvent) => {
          const event = rawEvent as { type?: string; data?: any }
          const base = {
            taskId,
            executor,
            runId: run.id,
            sessionId: this.#eventSessionId(agent.id ?? (session as { id?: string } | undefined)?.id),
          }
        if (event.type === 'assistant/chunk') {
          const chunk = event.data?.chunk
          if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
            this.#emitExecutorEvent({ ...base, type: 'output', text: chunk.text })
          } else if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') {
            this.#emitExecutorEvent({ ...base, type: 'reasoning', text: chunk.text })
          }
          return
        }
        if (event.type === 'assistant/message') {
          const text = (event.data?.message?.content ?? [])
            .map((block: any) => (typeof block?.text === 'string' ? block.text : ''))
            .join('')
          if (text) this.#emitExecutorEvent({ ...base, type: 'output', text })
          return
        }
        if (event.type === 'tool/call') {
          this.#emitExecutorEvent({
            ...base,
            type: 'tool_call',
            name: event.data?.name,
            text: event.data?.arguments,
            data: event.data,
          })
          return
        }
        if (event.type === 'tool/result') {
          this.#emitExecutorEvent({
            ...base,
            type: 'tool_result',
            name: event.data?.callId,
            data: event.data,
          })
        }
      })
      this.#emitExecutorEvent({ taskId, executor, runId: run.id, sessionId: this.#eventSessionId(undefined), type: 'status', text: 'streaming' })
      return { unsubscribe: unsubscribe ?? (() => undefined), hasEventSource: true }
    } catch (error) {
      this.#emitExecutorEvent({
        taskId,
        executor,
        runId: run.id,
        sessionId: this.#eventSessionId(undefined),
        type: 'status',
        text: 'stream_unavailable',
        data: String(error),
      })
      return { unsubscribe: () => undefined, hasEventSource: false }
    }
  }

  /**
   * 执行一次委托：唯一出口 `subagents.start(role.executor, { prompt, parent, signal })`。
   * @returns SubagentTaskOutput（DSH 正常路径；含 weave 映射，见 2.4.3）
   * @throws WeaveError('executor_unavailable') 注册表校验失败（委托前拦截，不计熔断）
   * @throws WeaveError('execution_failed') DSH 基础设施故障（start()/run.result reject）
   */
  async executeTask(
    task: TaskRecord,
    role: RoleConfig,
    team: TeamConfigLike,
    context: TaskContext,
    cancelSignal: AbortSignal,
  ): Promise<SubagentTaskOutput> {
    const executor = role.executor
    const executorInfo = this.#executorRegistry.get(executor)
    if (!executorInfo) {
      throw new WeaveError('executor_unavailable', `执行器未注册: ${executor}`, {
        executor,
        taskId: task.id,
      })
    }

    // 执行器级硬限制：超限排队（不熔断）；signal 中止时 waitForProcessSlot 抛错
    if (!this.#processLimiter.acquire(executor)) {
      await this.#processLimiter.waitForProcessSlot(executor, cancelSignal)
    }

    try {
      let knowledge: KnowledgeInjectionEntryLike[] = []
      try {
        knowledge = await this.#knowledgeEngine.searchForInjection({
          taskId: task.id,
          projectId: task.project_id,
          version: task.version,
          roleId: role.id,
          limit: team.knowledge_injection,
          slim: true,
        })
      } catch {
        // 注入失败不阻断主链路（降级为无知识，P0 最小可用）
        knowledge = []
      }

      const revisionContext = await this.#sessionTracker.getRevisionContext(task.id)
      const prompt = this.buildPrompt(task, role, context, knowledge, revisionContext, team.knowledge_injection)

      const startedAt = this.#now()
      const runtime = this.#resolveRuntime(role, context)
      const provider = this.#executorProviders?.resolve(executor)
      // iso-1 会话隔离键：团队+角色+项目+版本。角色维度不同 ⇒ 键不同；
      // 同一角色重复执行同项目同版本任务 ⇒ 复用同一 ACP/zcode 会话。
      const sessionKey = `${team.team_id}:${role.id}:${task.project_id}:${task.version}`

      let run: DelegationRunLike
      if (provider) {
        run = await provider.start({
          executor,
          sessionKey,
          prompt: [{ type: 'text', text: prompt }],
          parent: context.parentAgent,
          signal: cancelSignal,
          runtime,
        }) as DelegationRunLike
      } else {
        const agentOptions = this.#buildAgentOptions(runtime)
        const weave = executorInfo.kind === 'acp'
          ? {
              sessionKey,
              ...(runtime.model?.provider !== undefined ? { modelProvider: runtime.model.provider } : {}),
              ...(runtime.model?.id !== undefined ? { model: runtime.model.id } : {}),
              ...(runtime.thoughtLevel !== undefined ? { thoughtLevel: runtime.thoughtLevel } : {}),
              ...(runtime.mode !== undefined ? { mode: runtime.mode } : {}),
              ...(runtime.tools !== undefined ? { tools: runtime.tools } : {}),
            }
          : undefined
        run = await this.#ctx.subagents.start(executor, {
          prompt: [{ type: 'text', text: prompt }],
          parent: context.parentAgent,
          signal: cancelSignal,
          ...(agentOptions ? { agentOptions } : {}),
          // DSH 会把 request 原样透传给 provider：sessionKey 必须顶层携带；
          // weave.sessionKey 保留为 provider 侧的兼容兜底。
          ...(weave ? { sessionKey, weave } : {}),
        })
      }

      const runSessionId = this.#eventSessionId(
        (run as DelegationRunLike).sessionId ?? ((run as { localAgent?: { id?: string } | undefined }).localAgent?.id),
      )
      this.#emitExecutorEvent({
        taskId: task.id,
        executor,
        runId: run.id,
        ...(runSessionId !== undefined ? { sessionId: runSessionId } : {}),
        type: 'status',
        text: 'started',
      })
      const { unsubscribe, hasEventSource } = this.#subscribeRunEvents(task.id, executor, run)

      // 超时竞速：活动感知空闲 + 绝对墙钟双闸（TDD 2.4.3 扩展）。
      // context.timeoutMs 兼容保留为「单次绝对墙钟」覆盖；有事件源才启用空闲检测。
      let outcome:
        | { kind: 'result'; result: DelegationResultLike }
        | { kind: 'timeout'; reason: 'idle' | 'wallclock' }
      try {
        outcome = await this.#awaitResultWithTimeout(run, {
          hasEventSource,
          idleTimeoutMs: this.#idleTimeoutMs,
          wallClockMs: context.timeoutMs ?? this.#wallClockMs,
        })
      } finally {
        unsubscribe()
      }
      const durationMs = Math.max(0, this.#now() - startedAt)

      if (outcome.kind === 'timeout') {
        // 死亡递送：提取事件尾部摘要让队长知道子代理死前在做什么。
        const snapshot = this.getExecutorRun(run.id)
        const tail = (snapshot?.events ?? [])
          .filter((e) => e.text && e.type !== 'status')
          .slice(-3)
          .map((e) => `[${e.type}] ${(e.text ?? '').slice(0, 150)}`)
          .join(' | ')
        await run.dispose()
        const idleCause = outcome.reason === 'idle'
        const message = idleCause
          ? `Weave 空闲超时（连续 ${this.#idleTimeoutMs}ms 无执行器事件），已终止运行`
          : 'Weave 委托超时，已终止运行'
        const diagnostic = tail ? `${message}
临终活动：${tail}` : message
        this.#finishExecutorRun(run.id, 'timeout', diagnostic)
        return {
          id: run.id,
          output: [],
          stopReason: 'aborted',
          duration_ms: durationMs,
          diagnostic,
          weave: mapStopReason('aborted', { weaveErrorType: idleCause ? 'idle_timeout' : 'timeout' }),
        }
      }

      const mapped = this.mapResult(run, outcome.result, durationMs)
      this.#finishExecutorRun(
        run.id,
        mapped.stopReason === 'completed'
          ? 'completed'
          : mapped.stopReason === 'aborted'
            ? 'cancelled'
            : 'failed',
        mapped.weave?.errorType ?? mapped.stopReason,
        mapped,
      )
      return mapped
    } catch (error) {
      // 取消处理：取消发生在 start 前/排队中 → 返回 aborted（CANCELLED，不计熔断）
      if (cancelSignal.aborted) {
        if (this.#executorRuns.has(task.id)) this.#finishExecutorRun(task.id, 'cancelled', 'cancelled before start')
        return {
          id: task.id,
          output: [],
          stopReason: 'aborted',
          duration_ms: 0,
          diagnostic: 'cancelled before start',
          weave: mapStopReason('aborted'),
        }
      }
      if (error instanceof WeaveError) throw error
      throw new WeaveError('execution_failed', `委托基础设施故障: ${error instanceof Error ? error.message : String(error)}`, {
        taskId: task.id,
        executor,
      })
    } finally {
      this.#processLimiter.release(executor)
    }
  }

  /**
   * TDD 2.4.2：SubagentRun + SubagentResult → SubagentTaskOutput。
   * duration_ms 由 Weave 自计时；run.result 失败时 resolve（不 reject），
   * 此处不做状态判定（交给 weave 映射/调用方）。
   */
  mapResult(run: DelegationRunLike, result: DelegationResultLike, durationMs: number): SubagentTaskOutput {
    const mapping = mapStopReason(result.stopReason, {
      permissionDenied: detectPermissionDenied(result),
    })
    const output = result.output ?? []
    // 成果递送兜底：output 为空时从事件缓冲提取最近文本/工具摘要，防止 result 空洞。
    let diagnostic = result.diagnostic
    if (output.length === 0 && !diagnostic) {
      const snapshot = this.getExecutorRun(run.id)
      const tail = (snapshot?.events ?? [])
        .filter((e) => e.text && e.type !== 'status')
        .slice(-3)
        .map((e) => `[${e.type}] ${(e.text ?? '').slice(0, 150)}`)
        .join(' | ')
      if (tail) diagnostic = `（产出见文件；执行器活动摘要）${tail}`
    }
    return {
      id: run.id,
      output,
      ...(result.structured !== undefined ? { structured: result.structured } : {}),
      ...(diagnostic !== undefined ? { diagnostic } : {}),
      stopReason: result.stopReason,
      duration_ms: durationMs,
      weave: mapping,
    }
  }

  /**
   * 委托 prompt 构建（SDD 2.3.4 模板）。
   * `prompt` 以 ContentBlock[] 包装后传入 `ctx.subagents.start`；
   * 修订（REVISION_RUNNING）由 `revisionContext`（SessionTracker.getRevisionContext）
   * 注入完整上下文（ephemeral 线程无跨任务记忆，ADR-031）。
   */
  buildPrompt(
    task: TaskRecord,
    role: RoleConfig,
    context: TaskContext,
    knowledge: KnowledgeInjectionEntryLike[],
    revisionContext: string | null,
    limits: KnowledgeInjectionLimits,
  ): string {
    const lines: string[] = []
    lines.push(`你是 ${role.name}，负责完成以下任务。`)
    lines.push('')
    lines.push('## 角色人格')
    lines.push(role.personality || '（无）')
    lines.push('')
    lines.push('## DSH Memory 提示')
    lines.push(DSH_MEMORY_HINTS)
    lines.push('')
    lines.push('## 执行纪律')
    lines.push(EXECUTION_DISCIPLINE)
    lines.push('')
    lines.push('## 任务描述')
    lines.push(task.description)
    lines.push('')
    lines.push('## 项目上下文')
    lines.push(`- 项目: ${task.project_id} - 版本: ${task.version}${context.projectName ? ` - ${context.projectName}` : ''}`)
    lines.push(`- 工作目录: ${context.repoPath ?? '（由 DSH 从父会话自动解析）'}`)
    lines.push(`- Git 分支: ${context.gitBranch ?? '（无）'}`)
    lines.push('')
    lines.push('## 上游任务产物')
    if (context.upstreamOutputs?.length) {
      for (const item of context.upstreamOutputs) {
        lines.push(`### ${item.label}`)
        lines.push(item.output)
      }
    } else {
      lines.push('（无）')
    }
    lines.push('')
    lines.push('## 相关知识（来自知识库）')
    lines.push(formatKnowledgeSection(knowledge, limits))
    lines.push('')
    if (revisionContext) {
      // SessionTracker.getRevisionContext 已含完整小节（修订注入，ADR-031）
      lines.push(revisionContext)
      lines.push('')
    }
    lines.push('## 可用命令（执行中可调用）')
    lines.push('- （P0 阶段无知识检索 CLI；`/weave knowledge search` 属 P1，不在执行器可用命令中）')
    lines.push('')
    lines.push('## 知识沉淀要求')
    lines.push('### WEAVE_KNOWLEDGE_START')
    lines.push('{"type": "pitfall", "title": "...", "content": "...", "tags": ["..."]}')
    lines.push('### WEAVE_KNOWLEDGE_END')
    lines.push('')
    lines.push('## 输出要求')
    lines.push(context.outputRequirements ?? '输出最终结果；同时按上述知识沉淀格式记录可复用经验（可留空）。')
    return lines.join('\n')
  }

  /**
   * 结果等待（活动感知超时，TDD 2.4.3 扩展）：
   * - idle 闸：注册 `#activitySinks` 探针，任何执行器事件经 #emitExecutorEvent 重置
   *   单个 setTimeout（同一句柄 clearTimeout+setTimeout 原地续命，无并发定时器泄漏）；
   *   连续 idleTimeoutMs 无事件 → `{kind:'timeout', reason:'idle'}`；
   * - wallclock 闸：绝对上限，独立第二个句柄，到点必触发（事件风暴无法延后）；
   * - 回退：hasEventSource=false（无 onEvent/readOutput/localAgent 源）时不装 idle 闸，
   *   行为与旧纯墙钟实现完全一致；
   * - 任一闸关闭或 idleTimeoutMs<=0 / wallClockMs<=0 时跳过对应闸门。
   */
  #awaitResultWithTimeout(
    run: DelegationRunLike,
    params: { hasEventSource: boolean; idleTimeoutMs: number; wallClockMs: number },
  ): Promise<{ kind: 'result'; result: DelegationResultLike } | { kind: 'timeout'; reason: 'idle' | 'wallclock' }> {
    const { hasEventSource, idleTimeoutMs, wallClockMs } = params
    return new Promise((resolve, reject) => {
      let settled = false
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      let wallTimer: ReturnType<typeof setTimeout> | undefined

      const cleanup = () => {
        if (idleTimer !== undefined) {
          clearTimeout(idleTimer)
          idleTimer = undefined
        }
        if (wallTimer !== undefined) {
          clearTimeout(wallTimer)
          wallTimer = undefined
        }
        this.#activitySinks.delete(run.id)
      }
      const settle = (value:
        | { kind: 'result'; result: DelegationResultLike }
        | { kind: 'timeout'; reason: 'idle' | 'wallclock' }) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      }

      // 事件探针：仅重排 idle 句柄；结算后的迟到事件是 noop。
      this.#activitySinks.set(run.id, () => {
        if (settled) return
        if (idleTimer !== undefined) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => settle({ kind: 'timeout', reason: 'idle' }), idleTimeoutMs)
      })

      const armIdle = () => {
        if (!hasEventSource || idleTimeoutMs <= 0) return
        if (idleTimer !== undefined) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => settle({ kind: 'timeout', reason: 'idle' }), idleTimeoutMs)
      }
      armIdle()

      if (wallClockMs > 0) {
        wallTimer = setTimeout(() => settle({ kind: 'timeout', reason: 'wallclock' }), wallClockMs)
      }

      void run.result.then(
        (result) => settle({ kind: 'result', result }),
        (error) => {
          if (settled) return
          settled = true
          cleanup()
          reject(error instanceof Error ? error : new Error(String(error)))
        },
      )
    })
  }
}
