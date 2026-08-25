import type { ExecutorRegistry } from './executor-registry.js'
import type { SessionTracker } from './session-tracker.js'
import type { ProcessLimiter } from './safety/process-limiter.js'
import type { TaskRecord } from './state/types.js'
import { WeaveError } from './state/weave-error.js'

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

export interface DelegationRunLike {
  id: string
  localAgent?: unknown
  result: Promise<DelegationResultLike>
  dispose(): Promise<void>
}

/** 执行委托所需的最小 ctx 视面（真实 cordis Context 结构化满足；测试注入 mock）。 */
export interface DelegationContext {
  subagents: {
    start(name: string, request: { label?: string; prompt: ContentBlockLike[]; parent: unknown; signal: AbortSignal }): Promise<DelegationRunLike>
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
}

export interface StopReasonMapping {
  errorType: string | null
  status: 'COMPLETED' | 'CANCELLED' | 'FAILED'
  countBreaker: boolean
}

export const DEFAULT_DELEGATION_TIMEOUT_MS = 300_000

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
  options?: { weaveErrorType?: 'timeout'; permissionDenied?: boolean },
): StopReasonMapping {
  if (options?.weaveErrorType === 'timeout') {
    return { errorType: 'timeout', status: 'FAILED', countBreaker: true }
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
    const line = `- [${entry.layer}] ${entry.title}：${content}`
    if (total + line.length > limits.max_total_chars && lines.length > 0) break
    if (total + line.length > limits.max_total_chars) break
    lines.push(line)
    total += line.length
  }
  return lines.length ? lines.join('\n') : '（无）'
}

export interface DelegationServiceOptions {
  executorRegistry: ExecutorRegistry
  sessionTracker: SessionTracker
  processLimiter: ProcessLimiter
  knowledgeEngine: KnowledgeEngineLike
  /** 委托超时（Weave 应用层；默认 300s）。 */
  timeoutMs?: number
  /** 可注入时钟（测试用）。 */
  now?: () => number
}

export class DelegationService {
  readonly #ctx: DelegationContext
  readonly #executorRegistry: ExecutorRegistry
  readonly #sessionTracker: SessionTracker
  readonly #processLimiter: ProcessLimiter
  readonly #knowledgeEngine: KnowledgeEngineLike
  readonly #timeoutMs: number
  readonly #now: () => number

  constructor(ctx: DelegationContext, options: DelegationServiceOptions) {
    this.#ctx = ctx
    this.#executorRegistry = options.executorRegistry
    this.#sessionTracker = options.sessionTracker
    this.#processLimiter = options.processLimiter
    this.#knowledgeEngine = options.knowledgeEngine
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_DELEGATION_TIMEOUT_MS
    this.#now = options.now ?? Date.now
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
        })
      } catch {
        // 注入失败不阻断主链路（降级为无知识，P0 最小可用）
        knowledge = []
      }

      const revisionContext = await this.#sessionTracker.getRevisionContext(task.id)
      const prompt = this.buildPrompt(task, role, context, knowledge, revisionContext, team.knowledge_injection)

      const startedAt = this.#now()
      const run = await this.#ctx.subagents.start(executor, {
        prompt: [{ type: 'text', text: prompt }],
        parent: context.parentAgent,
        signal: cancelSignal,
      })

      // timeout 竞速：Weave 自计时（应用层 timeout，TDD 2.4.3）
      const outcome = await this.#awaitResultWithTimeout(run, context.timeoutMs ?? this.#timeoutMs)
      const durationMs = Math.max(0, this.#now() - startedAt)

      if (outcome.kind === 'timeout') {
        await run.dispose()
        return {
          id: run.id,
          output: [],
          stopReason: 'aborted',
          duration_ms: durationMs,
          diagnostic: 'Weave 委托超时，已终止运行',
          weave: mapStopReason('aborted', { weaveErrorType: 'timeout' }),
        }
      }

      return this.mapResult(run, outcome.result, durationMs)
    } catch (error) {
      // 取消处理：取消发生在 start 前/排队中 → 返回 aborted（CANCELLED，不计熔断）
      if (cancelSignal.aborted) {
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
    return {
      id: run.id,
      output: result.output ?? [],
      ...(result.structured !== undefined ? { structured: result.structured } : {}),
      ...(result.diagnostic !== undefined ? { diagnostic: result.diagnostic } : {}),
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

  async #awaitResultWithTimeout(
    run: DelegationRunLike,
    timeoutMs: number,
  ): Promise<{ kind: 'result'; result: DelegationResultLike } | { kind: 'timeout' }> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs)
    })
    try {
      const raced = await Promise.race<DelegationResultLike | 'timeout'>([run.result, timeout])
      if (raced === 'timeout') return { kind: 'timeout' }
      return { kind: 'result', result: raced }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
