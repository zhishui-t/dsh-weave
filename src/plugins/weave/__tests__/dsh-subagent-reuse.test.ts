import { describe, expect, it, vi } from 'vitest'
import { DshSubagentExecutorProvider } from '../executors/dsh-subagent-executor-provider.js'

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
})
