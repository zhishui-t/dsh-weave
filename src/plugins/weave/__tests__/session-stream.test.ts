import { describe, expect, it } from 'vitest'
import { createExecutorEventNotifier, SessionStreamThrottle } from '../scheduling/session-stream.js'
import type { ExecutorRunEvent } from '../scheduling/delegation-service.js'

const evt = (overrides: Partial<ExecutorRunEvent>): ExecutorRunEvent => ({
  taskId: 't1',
  executor: 'codex',
  runId: 'r1',
  sessionId: 'sess-1',
  type: 'output',
  text: 'hello',
  ...overrides,
})

/** 可注入时钟：手动推进。 */
function makeClock(start = 1000) {
  let now = start
  return {
    now: () => now,
    advance: (ms: number) => { now += ms },
  }
}

describe('SessionStreamThrottle（doc/05 §6.2 P1-B 噪声控制）', () => {
  it('正常路径：首条内容事件立即发送，消息含 sessionId/taskId/正文', () => {
    const throttle = new SessionStreamThrottle()
    const messages = throttle.handle(evt({ text: '第一步完成' }))
    expect(messages).toEqual([{ sessionId: 'sess-1', taskId: 't1', text: '第一步完成' }])
  })

  it('滑窗节流：窗口内事件只进 pending；窗口到期后的下一条触发合并发送', () => {
    const clock = makeClock()
    const throttle = new SessionStreamThrottle({ minIntervalMs: 5000 }, clock.now)
    expect(throttle.handle(evt({ text: 'a' }))).toHaveLength(1) // 首条立即发
    expect(throttle.handle(evt({ text: 'b' }))).toEqual([]) // 窗口内 → pending
    expect(throttle.handle(evt({ text: 'c' }))).toEqual([]) // 仍在窗口 → pending
    expect(throttle.pendingCount('t1')).toBe(2)
    clock.advance(5001)
    const messages = throttle.handle(evt({ text: 'd' })) // 窗口到期 → 合并发送
    expect(messages).toHaveLength(1)
    expect(messages[0]!.text).toBe('b\nc\nd')
    expect(throttle.pendingCount('t1')).toBe(0)
  })

  it('合并发送截断：pending 拼接超 maxChars 截断加 …；恰等于上限不截断', () => {
    const clock = makeClock()
    const throttle = new SessionStreamThrottle({ maxChars: 10 }, clock.now)
    const first = throttle.handle(evt({ text: '1234567890' })) // 首条立即发，恰好 10 字不截断
    expect(first[0]!.text).toBe('1234567890')
    throttle.handle(evt({ text: 'aaaaaaaaaa' })) // 窗口内 → pending
    throttle.handle(evt({ text: 'bbbbbbbbbb' })) // 窗口内 → pending（合计已超 10 字）
    clock.advance(5001)
    const messages = throttle.handle(evt({ text: 'c' })) // 窗口到期 → 合并后截断
    expect(messages).toHaveLength(1)
    expect(messages[0]!.text).toBe('aaaaaaaaaa…')
  })

  it('类型过滤：默认 reasoning/tool_call 放行（zcode 长任务事件主体），tool_result 不处理；自定义 events 生效', () => {
    const throttle = new SessionStreamThrottle()
    expect(throttle.handle(evt({ type: 'reasoning', text: 'think' }))).toHaveLength(1)
    expect(throttle.handle(evt({ type: 'tool_call', name: 'bash' }))).toEqual([]) // 窗口内 → pending
    expect(throttle.pendingCount()).toBe(1)
    expect(throttle.handle(evt({ type: 'tool_result', name: 'bash' }))).toEqual([])
    const narrow = new SessionStreamThrottle({ events: ['output'] })
    expect(narrow.handle(evt({ type: 'tool_call', name: 'bash' }))).toEqual([])
  })

  it('终态 flush：窗口内 pending 被 status=completed 立即补发；非终态 status 不触发', () => {
    const throttle = new SessionStreamThrottle()
    throttle.handle(evt({ text: '进展一' })) // 首条立即发
    throttle.handle(evt({ text: '进展二' })) // 窗口内 → pending
    expect(throttle.handle(evt({ type: 'status', text: 'streaming' }))).toEqual([])
    expect(throttle.pendingCount('t1')).toBe(1) // 非终态不触发、不清 pending
    const flushed = throttle.handle(evt({ type: 'status', text: 'completed' }))
    expect(flushed).toEqual([{ sessionId: 'sess-1', taskId: 't1', text: '进展二' }])
    expect(throttle.pendingCount('t1')).toBe(0)
  })

  it('终态值域：completed/error/execution_failed/timeout 视为终态；started/stream_unavailable 不是', () => {
    for (const terminal of ['completed', 'error', 'execution_failed', 'timeout']) {
      const throttle = new SessionStreamThrottle()
      throttle.handle(evt({ text: 'head' })) // 首条立即发
      throttle.handle(evt({ text: 'tail' })) // pending
      expect(throttle.handle(evt({ type: 'status', text: terminal }))).toHaveLength(1)
    }
    for (const nonTerminal of ['started', 'stream_unavailable']) {
      const throttle = new SessionStreamThrottle()
      throttle.handle(evt({ text: 'head' }))
      throttle.handle(evt({ text: 'tail' }))
      expect(throttle.handle(evt({ type: 'status', text: nonTerminal }))).toEqual([])
      expect(throttle.pendingCount('t1')).toBe(1)
    }
  })

  it('终态后同 taskId 重新开窗（任务重试场景）', () => {
    const clock = makeClock()
    const throttle = new SessionStreamThrottle()
    throttle.handle(evt({ text: '第一次' }))
    throttle.handle(evt({ type: 'status', text: 'completed' }))
    clock.advance(1)
    const again = throttle.handle(evt({ text: '重试输出' })) // 终态清窗后新窗口：立即发送
    expect(again).toEqual([{ sessionId: 'sess-1', taskId: 't1', text: '重试输出' }])
  })

  it('多任务/多会话隔离：各自窗口互不影响', () => {
    const throttle = new SessionStreamThrottle()
    expect(throttle.handle(evt({ taskId: 't1', text: 't1-a' }))).toHaveLength(1)
    expect(throttle.handle(evt({ taskId: 't2', text: 't2-a' }))).toHaveLength(1) // 不同任务独立开窗
    expect(throttle.handle(evt({ sessionId: 'sess-2', taskId: 't1', text: 's2-a' }))).toHaveLength(1)
    expect(throttle.handle(evt({ taskId: 't1', text: 't1-b' }))).toEqual([]) // t1@sess-1 仍在窗口
  })

  it('enabled=false 全静默；空文本/空白文本不发送不开窗', () => {
    const off = new SessionStreamThrottle({ enabled: false })
    expect(off.handle(evt({ text: 'x' }))).toEqual([])
    expect(off.handle(evt({ type: 'status', text: 'completed' }))).toEqual([])
    const clock = makeClock()
    const throttle = new SessionStreamThrottle({}, clock.now)
    expect(throttle.handle(evt({ text: '   ' }))).toEqual([])
    expect(throttle.handle(evt({ text: undefined }))).toEqual([])
    expect(throttle.pendingCount()).toBe(0)
  })

  it('flushAll 收尾：清空全部任务 pending（dispose 场景）', () => {
    const throttle = new SessionStreamThrottle()
    throttle.handle(evt({ taskId: 't1', text: 'a1' })) // 首条立即发
    throttle.handle(evt({ taskId: 't2', text: 'a2' })) // 首条立即发
    throttle.handle(evt({ taskId: 't1', text: 'b1' })) // pending
    throttle.handle(evt({ taskId: 't2', text: 'b2' })) // pending
    const flushed = throttle.flushAll()
    expect(flushed).toHaveLength(2)
    expect(flushed.map((m) => m.taskId).sort()).toEqual(['t1', 't2'])
    expect(flushed.map((m) => m.text).sort()).toEqual(['b1', 'b2'])
    expect(throttle.pendingCount()).toBe(0)
  })

  it('缺 sessionId：以空串归键不丢弃（T10 接线后保证有值）', () => {
    const throttle = new SessionStreamThrottle()
    const messages = throttle.handle(evt({ sessionId: undefined, text: 'no-session' }))
    expect(messages).toEqual([{ sessionId: '', taskId: 't1', text: 'no-session' }])
  })
})

describe('createExecutorEventNotifier（装配工厂）', () => {
  it('把节流消息格式化为 notify 调用（[weave] 前缀 + taskId）', () => {
    const clock = makeClock()
    const notified: Array<{ sessionId: string; text: string }> = []
    const notifier = createExecutorEventNotifier({
      minIntervalMs: 5000,
      notify: (sessionId, text) => notified.push({ sessionId, text }),
      now: clock.now,
    })
    notifier(evt({ text: 'hello stream' }))
    expect(notified).toEqual([
      { sessionId: 'sess-1', text: '[weave] 任务 t1 实时输出：\nhello stream' },
    ])
  })

  it('整体吞错：notify 抛错不影响 notifier，后续事件继续工作', () => {
    const clock = makeClock()
    let broken = true
    const notifier = createExecutorEventNotifier({
      notify: () => {
        if (broken) throw new Error('session gone')
      },
      now: clock.now,
    })
    expect(() => notifier(evt({ text: 'boom' }))).not.toThrow()
    broken = false
    clock.advance(6000)
    expect(() => notifier(evt({ text: 'recovered' }))).not.toThrow()
  })
})
