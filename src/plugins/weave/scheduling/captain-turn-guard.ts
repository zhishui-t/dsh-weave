import { randomUUID } from 'node:crypto'

import type { WeavePersistence } from '../persistence/persistence.js'

/** 非终态任务集合：只要还有这些状态，队长回合就不应结束。 */
const TERMINAL_STATUSES = [
  'COMPLETED',
  'CLOSED',
  'FAILED',
  'BANNED',
  'LOOP_TERMINATED',
  'INTERRUPTED',
  'CANCELLED',
  'SKIPPED',
] as const

export interface CaptainTurnGuardOptions {
  persistence: WeavePersistence
  pluginName?: string
  /** 主动播报回调（收到 { sessionId, text }）；缺省仅注入模型消息，不主动通知。 */
  notify?: (sessionId: string, text: string) => void
  /** 静默值守播报间隔，默认 15s。 */
  watchIntervalMs?: number
}

/** 注入到 next-step 的最小 UserMessage 结构（避免运行时直接依赖 dsh-llm 类型）。 */
export interface InjectedUserMessage {
  id: string
  role: 'user'
  content: Array<{ type: 'text'; text: string }>
  source: {
    kind: 'plugin'
    plugin: string
    form: 'notice'
    summary: string
  }
}

export interface ActiveTaskView {
  id: string
  status: string
  assigned_agent: string | null
  dag_id: string
}

/**
 * 队长回合硬约束（宿主级，不依赖模型自觉）：
 * - 监听 `agent/turn-stopping`；
 * - 发现当前会话还有在途 Weave 任务时，向 `agent.inject()` 注入一条
 *   next-step 消息，使 agent-loop 在 turn-stopping 后因为 inbox.nextStep
 *   非空而不关闭回合，强制模型继续值守。
 */
export class CaptainTurnGuard {
  readonly #persistence: WeavePersistence
  readonly #pluginName: string
  readonly #notify?: (sessionId: string, text: string) => void
  readonly #watchIntervalMs: number
  readonly #timers = new Map<string, ReturnType<typeof setInterval>>()

  constructor(options: CaptainTurnGuardOptions) {
    this.#persistence = options.persistence
    this.#pluginName = options.pluginName ?? 'dsh-weave'
    this.#notify = options.notify
    this.#watchIntervalMs = options.watchIntervalMs ?? 15_000
  }

  /** 开始对某会话做定时主动播报；无在途任务时自动停止。 */
  startWatching(sessionId: string): void {
    if (!sessionId || this.#timers.has(sessionId)) return
    const tick = async (): Promise<void> => {
      try {
        const tasks = await this.activeTasks(sessionId)
        if (tasks.length === 0) {
          this.stopWatching(sessionId)
          return
        }
        this.#notify?.(sessionId, this.buildSummaryText(tasks))
      } catch {
        // 播报失败不阻断值守；下次 tick 重试。
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), this.#watchIntervalMs)
    this.#timers.set(sessionId, timer)
  }

  /** 停止某个会话的定时播报。 */
  stopWatching(sessionId: string): void {
    const timer = this.#timers.get(sessionId)
    if (timer) {
      clearInterval(timer)
      this.#timers.delete(sessionId)
    }
  }

  /** 插件卸载时清理全部定时器。 */
  dispose(): void {
    for (const [sessionId] of this.#timers) this.stopWatching(sessionId)
  }

  /** 生成长文本播报（不注入模型，仅给用户/会话 notice）。 */
  buildSummaryText(tasks: ActiveTaskView[]): string {
    const first = tasks.slice(0, 5).map((task) => `${task.id} [${task.status}]`).join('、')
    return `[weave] 继续值守：仍有 ${tasks.length} 个在途任务（${first}${tasks.length > 5 ? ' 等' : ''}），我会持续轮询并在完成时汇报。`
  }

  /** 当前会话的非终态任务。 */
  async activeTasks(sessionId: string): Promise<ActiveTaskView[]> {
    if (!sessionId) return []
    const placeholders = TERMINAL_STATUSES.map(() => '?').join(',')
    const rows = await this.#persistence.tasks.run((db) =>
      db
        .prepare(
          `SELECT id, status, assigned_agent, dag_id FROM tasks
           WHERE session_id = ? AND status NOT IN (${placeholders})
           ORDER BY created_at LIMIT 20`,
        )
        .all(sessionId, ...TERMINAL_STATUSES),
    ) as unknown as ActiveTaskView[]
    return rows
  }

  /** 当前会话是否存在非终态任务。 */
  async hasActiveTasks(sessionId: string): Promise<boolean> {
    return (await this.activeTasks(sessionId)).length > 0
  }

  /** 生成注入消息；tasks 为空时返回 null。 */
  buildInjectedMessage(tasks: ActiveTaskView[]): InjectedUserMessage | null {
    if (tasks.length === 0) return null
    const first = tasks.slice(0, 5).map((task) => `${task.id} [${task.status}]`).join('、')
    const summary = `存在 ${tasks.length} 个在途 Weave 任务，禁止结束回合`
    const text =
      `[weave] 当前仍有 ${tasks.length} 个在途团队任务，禁止结束回合。` +
      `请继续按队长纪律值守：15 秒级轮询任务状态，状态一变即向用户通报；全部任务收敛后再汇总。` +
      `\n在途任务：${first}${tasks.length > 5 ? ' 等' : ''}`
    return {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: {
        kind: 'plugin',
        plugin: this.#pluginName,
        form: 'notice',
        summary,
      },
    }
  }
}
