/**
 * 官方 agent-team lifecycle.ts 模式的通用移植（weave 无 TeamError 依赖的等价实现）：
 * - close()：准入截止——signal 立即 abort（携带 DisposedError），后续准入检查据此短路；
 * - settle()：allSettled + 超时上限，被裁定的取消（直接或沿 Error cause 链）按预期吞掉，
 *   其余失败收集进 failures 供调用方落日志/审计——结算不得静默丢错；
 * - withTimeout()：单个结算操作的超时上限，防止 HMR/进程退出被挂起操作阻塞。
 */

/** 运行时被处置的取消事实（close() 的 abort reason，cause 链识别的锚点）。 */
export class DisposedError extends Error {
  readonly code = 'SETTLEMENT_DISPOSED'
  constructor(message = 'service disposed') {
    super(message)
    this.name = 'DisposedError'
  }
}

/** 结算操作超过超时上限。 */
export class SettlementTimeoutError extends Error {
  readonly code = 'SETTLEMENT_TIMEOUT'
  constructor(timeoutMs: number) {
    super(`settlement exceeded ${timeoutMs}ms`)
    this.name = 'SettlementTimeoutError'
  }
}

export class BoundedSettlement {
  readonly #controller = new AbortController()
  readonly #timeoutMs: number

  constructor(timeoutMs: number) {
    this.#timeoutMs = timeoutMs
  }

  /** 准入截止信号：abort 即不再准入新工作。 */
  get signal(): AbortSignal {
    return this.#controller.signal
  }

  get disposed(): boolean {
    return this.#controller.signal.aborted
  }

  /** 取消事实（cause 链识别的比对锚点）。 */
  get reason(): unknown {
    return this.#controller.signal.reason
  }

  /** close 的取消是否等于该 reason（直接命中或沿 Error.cause 链）。 */
  #isCancellation(candidate: unknown): boolean {
    const seen = new Set<unknown>()
    let current: unknown = candidate
    while (!seen.has(current)) {
      if (this.disposed && current === this.reason) return true
      if (current instanceof DisposedError) return true
      if (!(current instanceof Error)) return false
      seen.add(current)
      current = current.cause
    }
    return false
  }

  /** 关闭准入并携带取消事实。 */
  close(): void {
    this.#controller.abort(new DisposedError())
  }

  /**
   * 有界等待全部准入操作收敛：
   * - 全部 resolve / 预期内取消拒绝 → 安静返回；
   * - 非取消失败 → 收集进 failures（调用方落日志/审计）；
   * - 整体超时 → 超时错误进 failures（不抛出——处置路径必须走到收尾）。
   */
  async settle(operations: readonly Promise<unknown>[], failures: unknown[]): Promise<void> {
    if (operations.length === 0) return
    try {
      const outcomes = await this.withTimeout(Promise.allSettled(operations))
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected' && !this.#isCancellation(outcome.reason)) failures.push(outcome.reason)
      }
    } catch (error: unknown) {
      failures.push(error)
    }
  }

  /** 给单个结算操作加超时上限。 */
  async withTimeout<T>(operation: Promise<T>): Promise<T> {
    let timer!: ReturnType<typeof setTimeout>
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new SettlementTimeoutError(this.#timeoutMs)), this.#timeoutMs)
    })
    try {
      return await Promise.race([operation, timeout])
    } finally {
      clearTimeout(timer)
    }
  }
}
