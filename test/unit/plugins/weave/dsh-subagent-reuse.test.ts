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
          { type: 'assistant/message', seq: base + 2, data: { message: { content: [{ type: 'text', text: 'done-new-host' }] } } },
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
