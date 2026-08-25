/**
 * SingleWriterQueue — SQLite 写操作串行化队列（TDD 1.5.9）。
 *
 * 保证：
 * 1. 所有写任务按 run() 提交顺序 FIFO 串行执行，同一时刻只有一个任务运行；
 * 2. 前一个任务失败不会中断队列，后续任务照常执行；
 * 3. 每个调用方拿到自己任务的真实结果或异常。
 */
export class SingleWriterQueue {
  #tail: Promise<unknown> = Promise.resolve()
  #pending = 0

  /** 当前排队中（含执行中）的任务数。 */
  get size(): number {
    return this.#pending
  }

  /** 提交一个写任务；返回的 Promise 为此任务的结果/异常。 */
  run<T>(write: () => Promise<T>): Promise<T> {
    this.#pending++
    const task = this.#tail.then(write)
    // 尾链吞掉错误继续传递（任务自身错误仍由调用方通过 task 感知）
    this.#tail = task.then(
      () => {
        this.#pending--
      },
      () => {
        this.#pending--
      },
    )
    return task
  }

  /** 等待当前已提交的所有任务清空（不含之后新提交的任务）。 */
  async drain(): Promise<void> {
    await this.#tail
  }
}
