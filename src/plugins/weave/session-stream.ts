import type { ExecutorRunEvent, ExecutorRunEventType } from './delegation-service.js'

/**
 * 执行实时输出回灌会话——节流适配器（doc/05 §6.2 P1-B）。
 *
 * 职责：把 DelegationService.onExecutorEvent 的五类事件流裁剪为会话可读的低频文本：
 * - 类型过滤：默认仅 output/status（reasoning/tool_* 噪声大不回灌）；
 * - 滑窗节流：同 (sessionId, taskId) 距上次发送不足 minIntervalMs 时进 pending 缓冲；
 * - 窗口到期合并发送：pending 按行拼接后截断 maxChars（excerptOf 风格加 …）；
 * - 任务终态立即 flush 尾包：status 文本不在非终态白名单（streaming/started/
 *   stream_unavailable）即视为终态（覆盖 completed/error/execution_failed/timeout
 *   等完成与失败值域——失败尾包恰是 Pitfall 沉淀素材，不允许丢）。
 *
 * SessionStreamThrottle 是纯逻辑（可注入时钟、无定时器）：窗口到期靠下一次事件
 * 惰性触发或终态/flushAll 显式触发；整体吞错由工厂承担（观察者不得影响委托主链路）。
 */

export interface StreamOptions {
  /** 总开关；默认 true。 */
  enabled?: boolean
  /** 同 (sessionId, taskId) 两次发送的最小间隔；默认 5000ms。 */
  minIntervalMs?: number
  /** 合并发送后的单条文本上限（超出截断加 …）；默认 200。 */
  maxChars?: number
  /** 参与处理的事件类型；默认 ['output', 'status']。 */
  events?: ExecutorRunEventType[]
}

export interface StreamMessage {
  sessionId: string
  taskId: string
  text: string
}

const DEFAULT_EVENTS: ExecutorRunEventType[] = ['output', 'status']

/** 非终态 status 白名单：此外的 status 文本一律视为任务终态并触发尾包 flush。 */
const NON_TERMINAL_STATUSES: ReadonlySet<string> = new Set(['streaming', 'started', 'stream_unavailable'])

/** status 事件不贡献正文（生命周期标记）；其余类型取 text，工具类事件回落 name。 */
function contentOf(event: ExecutorRunEvent): string {
  if (event.type === 'status') return ''
  if (typeof event.text === 'string' && event.text.trim() !== '') return event.text.trim()
  if ((event.type === 'tool_call' || event.type === 'tool_result') && typeof event.name === 'string') {
    return event.name.trim()
  }
  return ''
}

function excerptOf(text: string, maxChars: number): string {
  const trimmed = text.trim()
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}…` : trimmed
}

interface KeyState {
  lastSentAt: number
  pending: string[]
}

export class SessionStreamThrottle {
  readonly #enabled: boolean
  readonly #minIntervalMs: number
  readonly #maxChars: number
  readonly #events: ReadonlySet<ExecutorRunEventType>
  readonly #now: () => number
  readonly #states = new Map<string, KeyState>()

  constructor(options: StreamOptions = {}, now: () => number = Date.now) {
    this.#enabled = options.enabled ?? true
    this.#minIntervalMs = Math.max(0, options.minIntervalMs ?? 5000)
    this.#maxChars = Math.max(1, options.maxChars ?? 200)
    this.#events = new Set(options.events ?? DEFAULT_EVENTS)
    this.#now = now
  }

  /** 处理一条事件；返回本次应立即发送的消息（可能为空数组）。 */
  handle(event: ExecutorRunEvent): StreamMessage[] {
    if (!this.#enabled) return []
    if (!this.#events.has(event.type)) return []
    const sessionId = event.sessionId ?? ''
    const key = `${sessionId}\u0000${event.taskId}`

    if (event.type === 'status') {
      const status = typeof event.text === 'string' ? event.text : ''
      if (status === '' || NON_TERMINAL_STATUSES.has(status)) return []
      // 任务终态：立即补发尾包并关闭该任务窗口（同 taskId 重试时重新开窗）。
      const flushed = this.#flushKey(key, sessionId, event.taskId)
      this.#states.delete(key)
      return flushed
    }

    const line = contentOf(event)
    if (line === '') return []
    const state = this.#states.get(key) ?? { lastSentAt: Number.NEGATIVE_INFINITY, pending: [] }
    if (!this.#states.has(key)) this.#states.set(key, state)
    state.pending.push(line)

    if (this.#now() - state.lastSentAt >= this.#minIntervalMs) {
      return this.#flushKey(key, sessionId, event.taskId)
    }
    return []
  }

  /** 收尾：清空全部 pending（dispose/优雅关闭用）。 */
  flushAll(): StreamMessage[] {
    const messages: StreamMessage[] = []
    for (const key of [...this.#states.keys()]) {
      const [sessionId, taskId] = key.split('\u0000')
      messages.push(...this.#flushKey(key, sessionId ?? '', taskId ?? ''))
    }
    return messages
  }

  /** 诊断：某任务（缺省全部）的 pending 行数。 */
  pendingCount(taskId?: string): number {
    let total = 0
    for (const [key, state] of this.#states) {
      if (taskId === undefined || key.split('\u0000')[1] === taskId) total += state.pending.length
    }
    return total
  }

  #flushKey(key: string, sessionId: string, taskId: string): StreamMessage[] {
    const state = this.#states.get(key)
    if (!state || state.pending.length === 0) return []
    const merged = excerptOf(state.pending.join('\n'), this.#maxChars)
    state.pending = []
    if (merged === '') return []
    state.lastSentAt = this.#now()
    return [{ sessionId, taskId, text: merged }]
  }
}

/**
 * 生产装配工厂：把 onExecutorEvent 适配为「节流后 notify 会话」。
 * notify 文案格式（taskId 前缀 + 正文）在此统一，整体吞错——
 * 回灌链路任何异常都不得影响委托主链路。
 */
export function createExecutorEventNotifier(
  opts: StreamOptions & {
    notify: (sessionId: string, text: string) => void
    now?: () => number
  },
): (event: ExecutorRunEvent) => void {
  const throttle = new SessionStreamThrottle(opts, opts.now)
  const send = (message: StreamMessage): void => {
    opts.notify(message.sessionId, `[weave] 任务 ${message.taskId} 实时输出：\n${message.text}`)
  }
  return (event: ExecutorRunEvent): void => {
    try {
      for (const message of throttle.handle(event)) send(message)
    } catch {
      // 观察者异常不影响委托主链路（与 #emitExecutorEvent 同 philosophy）。
    }
  }
}
