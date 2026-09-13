import { describe, expect, it, vi } from 'vitest'
import { DshSubagentExecutorProvider } from '../../../../src/plugins/weave/executors/dsh-subagent-executor-provider.js'

function turnEvents(text: string): Array<{ type: string; data: Record<string, unknown> }> {
  return [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1 } },
    {
      type: 'assistant/message',
      data: {
        message: {
          content: [{ type: 'text', text }],
        },
        stream: [{ type: 'text-chunks', texts: [text] }],
      },
    },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

describe('DshSubagentExecutorProvider continuable 会话复用', () => {
  it('同一 sessionKey 第二次走 followup，不再 startContinuable 新建子代理', async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = []
    const child = {
      id: 'child-1',
      whenIdle: vi.fn(async () => {
        // 模拟子代理完成本轮并产出 assistant 消息。
        events.push(...turnEvents(`done-${events.length}`))
      }),
      session: { events },
      ctx: { on: () => () => undefined },
      options: { provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' },
    }
    const startContinuable = vi.fn(async () => ({ childId: 'child-1' }))
    const followup = vi.fn(async () => 'message-2')
    const subagents = {
      list: () => ['spawn'],
      start: vi.fn(async () => ({ id: 'should-not-be-used', result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => undefined })),
      startContinuable,
      followup,
      agents: { get: () => child },
    }
    const provider = new DshSubagentExecutorProvider(subagents as never)

    const request = {
      executor: 'spawn',
      sessionKey: 'team:spawn:proj:v1',
      prompt: [{ type: 'text' as const, text: 'task one' }],
      signal: new AbortController().signal,
      runtime: {
        model: { provider: 'deepseek-official', id: 'deepseek-v4-flash-vision-exp' },
      },
    }
    const run1 = await provider.start(request)
    expect(run1.sessionId).toBe('child-1')
    expect(startContinuable).toHaveBeenCalledTimes(1)
    expect(subagents.start).not.toHaveBeenCalled()
    const out1 = await run1.result
    expect(out1.output?.[0]?.text).toContain('done-0')

    const run2 = await provider.start({ ...request, prompt: [{ type: 'text' as const, text: 'task two' }] })
    expect(followup).toHaveBeenCalledTimes(1)
    expect(startContinuable).toHaveBeenCalledTimes(1)
    const out2 = await run2.result
    expect(out2.output?.[0]?.text).toContain('done-4')
  })

  it('rc1 新宿主：child.session 仅提供 snapshotEvents（无 .events）时，边界与产出回收等价', async () => {
    // 特性探测新路径替身：事件只经 snapshotEvents() 物化，seq 单调（0.1.2 形状）。
    const snapshot: Array<{ type: string; seq: number; data: Record<string, unknown> }> = [
      { type: 'turn/start', seq: 0, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const child = {
      id: 'child-new-host',
      whenIdle: vi.fn(async () => {
        // 模拟本轮新增事件：seq 从上一边界（2）之后继续单调前进。
        const base = snapshot[snapshot.length - 1]!.seq + 1
        snapshot.push(
          { type: 'turn/start', seq: base, data: { turn: 2 } },
          { type: 'step/start', seq: base + 1, data: { turn: 2 } },
          { type: 'assistant/message', seq: base + 2, data: { message: { content: [{ type: 'text', text: 'done-new-host' }] }, stream: [{ type: 'text-chunks', texts: ['done-new-host'] }] } },
          { type: 'turn/end', seq: base + 3, data: { turn: 2, reason: { kind: 'completed' } } },
        )
      }),
      session: { snapshotEvents: () => snapshot },
      ctx: { on: () => () => undefined },
      options: { provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' },
    }
    const startContinuable = vi.fn(async () => ({ childId: 'child-new-host' }))
    const subagents = {
      list: () => ['spawn'],
      start: vi.fn(async () => ({ id: 'should-not-be-used', result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => undefined })),
      startContinuable,
      followup: vi.fn(async () => 'message-2'),
      agents: { get: () => child },
    }
    const provider = new DshSubagentExecutorProvider(subagents as never)

    const run = await provider.start({
      executor: 'spawn',
      sessionKey: 'team:spawn:proj:v2',
      prompt: [{ type: 'text' as const, text: 'task on new host' }],
      signal: new AbortController().signal,
      runtime: {
        model: { provider: 'deepseek-official', id: 'deepseek-v4-flash-vision-exp' },
      },
    })

    // 边界 = 末事件 seq+1 = 2（记录于 whenIdle 之前）；回收只折叠本轮增量。
    const out = await run.result
    expect(out.output?.[0]?.text).toBe('done-new-host')
    expect(out.stopReason).toBe('completed')
    expect(subagents.start).not.toHaveBeenCalled()
  })
})

describe("DshSubagentExecutorProvider 'dsh' 统一执行器与自愈", () => {
  function makeChild(id: string, events: Array<{ type: string; data: Record<string, unknown> }>) {
    return {
      id,
      whenIdle: vi.fn(async () => {
        events.push(...turnEvents(`done-${id}-${events.length}`))
      }),
      session: { events },
      ctx: { on: () => () => undefined },
      options: { provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' },
    }
  }

  it("'dsh' 别名：首派以 fork provider 创建 continuable，后续 followup 复用", async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = []
    const child = makeChild('child-dsh', events)
    const startContinuable = vi.fn(async (spec: { provider: string }) => {
      expect(spec.provider).toBe('fork') // 'dsh' → fork：首派 seed 队长前缀
      return { childId: 'child-dsh' }
    })
    const followup = vi.fn(async () => 'message-2')
    const subagents = {
      list: () => ['spawn'], // 宿主列表里没有 'dsh'——别名由 provider 自身支持
      start: vi.fn(),
      startContinuable,
      followup,
      agents: { get: () => child },
    }
    const provider = new DshSubagentExecutorProvider(subagents as never)
    const request = {
      executor: 'dsh',
      sessionKey: 'team:coder:proj:v1',
      prompt: [{ type: 'text' as const, text: 'task one' }],
      signal: new AbortController().signal,
    }
    const run1 = await provider.start(request)
    expect(run1.sessionId).toBe('child-dsh')
    await run1.result
    await provider.start({ ...request, prompt: [{ type: 'text' as const, text: 'task two' }] })
    expect(startContinuable).toHaveBeenCalledTimes(1)
    expect(followup).toHaveBeenCalledTimes(1)
  })

  it('自愈：child 失联（宿主重启后未物化）→ 丢弃旧映射重建新 child，不再 throw', async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = []
    const rebuilt = makeChild('child-2', events)
    const childrenById = new Map<string, unknown>([['child-1', undefined]]) // 旧 child 失联
    const startContinuable = vi.fn(async () => {
      childrenById.set('child-2', rebuilt) // 重建后的 child 物化进 live 表
      return { childId: 'child-2' }
    })
    const followup = vi.fn(async () => 'message-2')
    const subagents = {
      list: () => ['fork'],
      start: vi.fn(),
      startContinuable,
      followup,
      agents: { get: (id: string) => childrenById.get(id) },
    }
    const provider = new DshSubagentExecutorProvider(subagents as never)
    const request = {
      executor: 'fork',
      sessionKey: 'team:coder:proj:v1',
      prompt: [{ type: 'text' as const, text: 'task after restart' }],
      signal: new AbortController().signal,
    }
    childrenById.set('child-1', undefined)
    // 内存表 seed 了旧 childId（hydrateChildren 场景）：stale → 自愈重建
    ;(provider as unknown as { hydrateChildren: () => Promise<void> }).hydrateChildren = async () => undefined
    const childrenStore = {
      load: async () => [{ sessionKey: 'team:coder:proj:v1', executor: 'fork', childId: 'child-1' }],
      record: async () => undefined,
    }
    const provider2 = new DshSubagentExecutorProvider(subagents as never, { childrenStore: childrenStore as never })
    await provider2.hydrateChildren()
    const run = await provider2.start(request)
    expect(run.sessionId).toBe('child-2')
    expect(startContinuable).toHaveBeenCalledTimes(1)
    await run.result
    expect(rebuilt.whenIdle).toHaveBeenCalled()
  })

  it('fork 复用彻底失败（重建也失败）→ 上抛而非静默 one-shot', async () => {
    const subagents = {
      list: () => ['fork'],
      start: vi.fn(),
      startContinuable: vi.fn(async () => { throw new Error('materialization failed') }),
      followup: vi.fn(),
      agents: { get: () => undefined },
    }
    const provider = new DshSubagentExecutorProvider(subagents as never)
    await expect(provider.start({
      executor: 'fork',
      sessionKey: 'team:coder:proj:v1',
      prompt: [{ type: 'text' as const, text: 'x' }],
      signal: new AbortController().signal,
    })).rejects.toThrow(/materialization failed/)
    expect(subagents.start).not.toHaveBeenCalled()
  })
})
