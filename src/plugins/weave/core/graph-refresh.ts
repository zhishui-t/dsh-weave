
/** 图谱刷新触发源：团队启动（先建/更新图谱）与任务完成（主会话侧更新）。 */
export type GraphRefreshReason = 'team-start' | 'task-settled'

/** 图谱构建薄触发（prism 承接）：weave 只发请求，构建逻辑全在 prism。 */
export type GraphBuildFn = () => Promise<{ project: string; status: string }>

export interface GraphRefresherOptions {
  /** 图谱构建触发（PrismGateway.graphBuild）；未注入则所有请求静默忽略（向后兼容）。 */
  build?: GraphBuildFn
  /** 构建结果通知出口（生产绑 notifyWeaveSession，落点为主会话）。 */
  notify?: (sessionId: string, text: string) => void
  /** 去抖窗口：窗口内的多次请求合并为一次构建（默认 3000ms）。 */
  debounceMs?: number
  log?: { warn?: (...args: unknown[]) => void }
}

/**
 * 代码图谱自动刷新器（core 组合层，无业务逻辑）。
 *
 * - 团队启动 / 任务完成时调用 request()：经注入的 build 薄触发 prism 建图。
 * - 去抖合并突发请求（同 DAG 多任务相继 settle 只构建一次）；构建期间的请求挂起为尾随构建。
 * - 构建完成后经 notify 通知触发时的主会话；build 缺失时为 no-op。
 */
export class GraphRefresher {
  readonly #options: GraphRefresherOptions
  readonly #debounceMs: number
  #timer: ReturnType<typeof setTimeout> | undefined
  #building = false
  #pendingAfterBuild = false
  #disposed = false
  #targetSessionId: string | undefined
  #lastReason: GraphRefreshReason | undefined

  constructor(options: GraphRefresherOptions = {}) {
    this.#options = options
    this.#debounceMs = options.debounceMs ?? 3000
  }

  /** 请求一次图谱刷新；sessionId 为触发时的主会话（构建完成后通知它）。 */
  request(reason: GraphRefreshReason, sessionId?: string): void {
    if (this.#disposed) return
    if (sessionId) this.#targetSessionId = sessionId
    this.#lastReason = reason
    if (this.#building) {
      this.#pendingAfterBuild = true
      return
    }
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      void this.#build()
    }, this.#debounceMs)
  }

  /** 停止后续刷新（运行时销毁时调用）；进行中的构建结果将被丢弃。 */
  dispose(): void {
    this.#disposed = true
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
  }

  async #build(): Promise<void> {
    const { build, notify } = this.#options
    if (!build) return
    if (this.#disposed) return
    const sessionId = this.#targetSessionId
    const reason = this.#lastReason
    this.#building = true
    try {
      const result = await build()
      if (this.#disposed) return
      if (sessionId && notify) notify(sessionId, `[dsh-weave] 代码图谱已构建：${result.project}（触发: ${reason}）`)
    } catch (error) {
      this.#options.log?.warn?.('[dsh-weave] graph refresh failed:', error)
    } finally {
      this.#building = false
    }
    if (this.#pendingAfterBuild && !this.#disposed) {
      this.#pendingAfterBuild = false
      this.request(this.#lastReason ?? 'task-settled', this.#targetSessionId)
    }
  }
}
