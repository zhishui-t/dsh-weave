import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GraphService } from '../../../../src/plugins/weave/graph/graph-service.js'
import { GraphRefresher } from '../../../../src/plugins/weave/core/graph-refresh.js'

function fakeGraphService(options: { hasGraph: boolean; build?: () => Promise<void> } ): GraphService {
  return {
    hasGraph: () => options.hasGraph,
    build: options.build ?? (async () => {}),
  } as unknown as GraphService
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('GraphRefresher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('debounces burst requests into a single build', async () => {
    const build = vi.fn(async () => {})
    const refresher = new GraphRefresher({ graphService: fakeGraphService({ hasGraph: true, build }), debounceMs: 100 })
    refresher.request('task-settled', 's1')
    refresher.request('task-settled', 's1')
    refresher.request('team-start', 's2')
    expect(build).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    expect(build).toHaveBeenCalledTimes(1)
    refresher.dispose()
  })

  it('reports created vs updated based on hasGraph and notifies the requesting session', async () => {
    const notify = vi.fn()
    const refresher = new GraphRefresher({
      graphService: fakeGraphService({ hasGraph: false }),
      notify,
      debounceMs: 50,
    })
    refresher.request('team-start', 'captain-1')
    await vi.advanceTimersByTimeAsync(50)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith('captain-1', expect.stringContaining('新建'))
    refresher.dispose()
  })

  it('queues a trailing build for requests arriving during an in-flight build', async () => {
    const gate = deferred()
    const build = vi.fn(() => gate.promise)
    const refresher = new GraphRefresher({ graphService: fakeGraphService({ hasGraph: true, build }), debounceMs: 10 })
    refresher.request('team-start', 's1')
    await vi.advanceTimersByTimeAsync(10)
    expect(build).toHaveBeenCalledTimes(1)
    // 构建进行中再来的请求：挂起为尾随构建。
    refresher.request('task-settled', 's1')
    gate.resolve()
    await vi.advanceTimersByTimeAsync(10)
    expect(build).toHaveBeenCalledTimes(2)
    refresher.dispose()
  })

  it('is a no-op without graphService and never notifies', async () => {
    const notify = vi.fn()
    const refresher = new GraphRefresher({ notify, debounceMs: 10 })
    refresher.request('team-start', 's1')
    await vi.advanceTimersByTimeAsync(10)
    expect(notify).not.toHaveBeenCalled()
  })

  it('swallows build failures without notifying', async () => {
    const notify = vi.fn()
    const warn = vi.fn()
    const build = vi.fn(async () => {
      throw new Error('boom')
    })
    const refresher = new GraphRefresher({
      graphService: fakeGraphService({ hasGraph: true, build }),
      notify,
      log: { warn },
      debounceMs: 10,
    })
    refresher.request('task-settled', 's1')
    await vi.advanceTimersByTimeAsync(10)
    expect(warn).toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('dispose cancels pending debounced builds', async () => {
    const build = vi.fn(async () => {})
    const refresher = new GraphRefresher({ graphService: fakeGraphService({ hasGraph: true, build }), debounceMs: 10 })
    refresher.request('team-start', 's1')
    refresher.dispose()
    await vi.advanceTimersByTimeAsync(20)
    expect(build).not.toHaveBeenCalled()
  })
})
