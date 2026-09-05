/** 一次性 DAG 变更等待者（One-shot waiters），独立于持久化状态投影。 */

import { WeaveError } from '../state/weave-error.js'

interface Waiter {
  readonly resolve: () => void
}

/** 等待结果：timedOut=true 表示等满 timeoutMs 未见变更。 */
export interface DagWaitResult {
  timedOut: boolean
}

/**
 * 持有当前 DAG 变更等待者并保证每个等待者至多释放一次。
 * 移植自 dsh agent-team activity.ts（TeamActivity）：
 * - Map<DagId, Set<Waiter>>：同一 DAG 的全部等待者在一次 notify 中集体唤醒；
 * - timeout/abort/notify 三方竞态单赢家：settled 标志保证 finish 只走一次，
 *   首个赢家负责清定时器、摘监听、把其余竞争者从集合中移除；
 * - AbortSignal 注册窗口补检：signal.aborted 在预检与监听器注册之间的同步空档
 *   不会重放 abort，注册后立即再查一次；
 * - close：运行时销毁时关闭准入并唤醒全部现存等待者。
 */
export class DagActivity {
  private readonly waiters = new Map<string, Set<Waiter>>()
  private closed = false

  /**
   * 等待该 DAG 的下一次状态变更（单次边沿，不缓存历史）。
   * @param dagId - 关注的 DAG，其下一条边沿唤醒调用方。
   * @param timeoutMs - 有界等待时长，10 秒到 1 小时的整数。
   * @param signal - 仅针对本次等待的取消信号。
   * @returns 是否以超时结束。
   */
  async wait(dagId: string, timeoutMs: number, signal: AbortSignal): Promise<DagWaitResult> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 3_600_000) {
      throw new WeaveError('invalid_argument', 'timeoutMs 必须是 10000 到 3600000 之间的整数', { timeoutMs })
    }
    signal.throwIfAborted()
    if (this.closed) return { timedOut: false }
    const changed = await new Promise<boolean>((resolve, reject) => {
      let waiters = this.waiters.get(dagId)
      if (waiters === undefined) {
        waiters = new Set()
        this.waiters.set(dagId, waiters)
      }
      let settled = false
      const finish = (settle: () => void): void => {
        /* timeout、abort、notify 可能在一个赢家移除其余竞争者后仍触发。 */
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        waiters.delete(waiter)
        if (waiters.size === 0) this.waiters.delete(dagId)
        settle()
      }
      const onAbort = (): void => {
        finish(() => {
          const reason: unknown = signal.reason
          reject(reason instanceof Error
            ? reason
            : new WeaveError('wait_aborted', `waitForChange 已中止: ${String(reason)}`))
        })
      }
      const waiter: Waiter = {
        resolve: () => {
          finish(() => { resolve(true) })
        },
      }
      waiters.add(waiter)
      const timer = setTimeout(() => { finish(() => { resolve(false) }) }, timeoutMs)
      signal.addEventListener('abort', onAbort, { once: true })
      // AbortSignal 不会重放在预检与监听器注册之间获胜的 abort。
      if (signal.aborted) onAbort()
    })
    return { timedOut: !changed }
  }

  /**
   * 唤醒并移除某个 DAG 的全部现存等待者（每条状态变更边沿调用一次）。
   * @param dagId - 观察到变更的 DAG。
   */
  notify(dagId: string): void {
    const waiters = this.waiters.get(dagId)
    if (waiters === undefined) return
    this.waiters.delete(dagId)
    for (const waiter of waiters) waiter.resolve()
  }

  /** 关闭准入并唤醒全部现存等待者（运行时销毁时调用）。 */
  close(): void {
    this.closed = true
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) waiter.resolve()
    }
    this.waiters.clear()
  }
}
