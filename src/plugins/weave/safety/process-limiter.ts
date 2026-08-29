export interface ExecutorLimits {
  /** 并发槽位上限；<=0 表示不限制并发 */
  maxConcurrent: number
  /** 滚动 1 小时内的执行次数（保留为诊断字段；不再参与限流拒绝） */
  maxPerHour: number
}

export interface ProcessLimiterOptions {
  /** 按执行器配置限制；不匹配的执行器用 defaultLimits */
  limits?: Record<string, ExecutorLimits>
  defaultLimits?: ExecutorLimits
  /** 等待轮询间隔 ms，默认 100 */
  pollIntervalMs?: number
  /** 可注入时钟（测试用），默认 Date.now */
  now?: () => number
}

/** 缺省安全网：团队 executor_limits 未覆盖时使用。0 = 不限制并发/小时频率。 */
export const DEFAULT_EXECUTOR_LIMITS: ExecutorLimits = { maxConcurrent: 0, maxPerHour: 0 }

const HOUR_MS = 3600_000

interface ExecutorState {
  executorId: string
  active: number
  /** 每次成功 acquire 的时刻（epoch ms），滑动 1 小时窗口 */
  acquiredAt: number[]
}

/**
 * ProcessLimiter：per-executor 并发 + 小时频率限流（架构 10.5）。
 * 超限时 acquire 返回 false / waitForProcessSlot 排队等待，不触发熔断（AC-EXEC-005）。
 * 等待实现为轮询（pollIntervalMs），release 后自动继续、时窗滑移后可恢复，无死锁。
 */
export class ProcessLimiter {
  readonly #limits: Record<string, ExecutorLimits>
  readonly #defaultLimits: ExecutorLimits
  readonly #pollIntervalMs: number
  readonly #now: () => number
  readonly #executors = new Map<string, ExecutorState>()

  constructor(options: ProcessLimiterOptions = {}) {
    this.#limits = options.limits ?? {}
    this.#defaultLimits = options.defaultLimits ?? DEFAULT_EXECUTOR_LIMITS
    this.#pollIntervalMs = options.pollIntervalMs ?? 100
    this.#now = options.now ?? Date.now
  }

  #state(executorId: string): ExecutorState {
    let st = this.#executors.get(executorId)
    if (!st) {
      st = { executorId, active: 0, acquiredAt: [] }
      this.#executors.set(executorId, st)
    }
    return st
  }

  #limitsOf(executorId: string): ExecutorLimits {
    return this.#limits[executorId] ?? this.#defaultLimits
  }

  /** 尝试获取槽位；成功返回 true。并发/小时频率不足返回 false（排队，不熔断）。 */
  acquire(executorId: string): boolean {
    const st = this.#state(executorId)
    const limits = this.#limitsOf(executorId)
    const now = this.#now()
    // 滑动窗口：清理 1 小时前的记录
    st.acquiredAt = st.acquiredAt.filter((t) => now - t < HOUR_MS)
    // maxConcurrent<=0 表示不限制并发（用户裁定：执行器任务派发不做并发上限）。
    if (limits.maxConcurrent > 0 && st.active >= limits.maxConcurrent) return false
    // 用户裁定：小时频率限制已移除。maxPerHour 仅保留为诊断/兼容字段，不再参与拒绝。
    st.active++
    st.acquiredAt.push(now)
    return true
  }

  /** 释放槽位；等待者会在下一个轮询周期自动获得槽位（AC-EXEC-005）。 */
  release(executorId: string): void {
    const st = this.#executors.get(executorId)
    if (!st || st.active <= 0) return
    st.active--
  }

  /** 排队等待槽位（超限排队不熔断）；signal 中止时抛错。 */
  async waitForProcessSlot(executorId: string, signal?: AbortSignal): Promise<void> {
    while (true) {
      if (this.acquire(executorId)) return
      await this.#sleep(this.#pollIntervalMs, signal)
    }
  }

  #sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError(signal))
        return
      }
      const onAbort = (): void => {
        clearTimeout(timer)
        reject(abortError(signal))
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** 诊断：当前状态快照。 */
  status(executorId: string): {
    active: number
    maxConcurrent: number
    usedInHour: number
    maxPerHour: number
    waiting: number
  } {
    const st = this.#state(executorId)
    const limits = this.#limitsOf(executorId)
    const now = this.#now()
    st.acquiredAt = st.acquiredAt.filter((t) => now - t < HOUR_MS)
    return {
      active: st.active,
      maxConcurrent: limits.maxConcurrent,
      usedInHour: st.acquiredAt.length,
      maxPerHour: limits.maxPerHour,
      waiting: 0,
    }
  }
}

function abortError(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason
  return reason instanceof Error ? reason : new Error('aborted')
}
