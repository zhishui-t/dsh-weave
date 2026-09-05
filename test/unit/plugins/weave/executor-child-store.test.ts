import { describe, expect, it, vi } from 'vitest'
import { WeaveDatabase } from '../../../../src/plugins/weave/persistence/weave-database.js'
import { DEFAULT_SCHEMAS } from '../../../../src/plugins/weave/persistence/schemas.js'
import { ExecutorChildStore } from '../../../../src/plugins/weave/executors/executor-child-store.js'
import { DshSubagentExecutorProvider } from '../../../../src/plugins/weave/executors/dsh-subagent-executor-provider.js'

function openCoreDb(): WeaveDatabase {
  return new WeaveDatabase({ path: ':memory:', schema: DEFAULT_SCHEMAS.core })
}

function turnEvents(text: string): Array<{ type: string; data: Record<string, unknown> }> {
  return [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1 } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

describe('ExecutorChildStore（executor_children，core.db v3）持久化往返', () => {
  it('record → load 往返一致；同 sessionKey upsert 后者胜；remove 删除', async () => {
    const store = new ExecutorChildStore(openCoreDb())
    await store.record({ sessionKey: 'team:r1:proj:v1', executor: 'spawn', childId: 'child-a' })
    await store.record({ sessionKey: 'team:r2:proj:v1', executor: 'fork', childId: 'child-b' })
    expect(await store.load()).toEqual([
      { sessionKey: 'team:r1:proj:v1', executor: 'spawn', childId: 'child-a' },
      { sessionKey: 'team:r2:proj:v1', executor: 'fork', childId: 'child-b' },
    ])

    // 会话复用语义：同 sessionKey 复用同一子代理——upsert 覆盖 childId，不新增行
    await store.record({ sessionKey: 'team:r1:proj:v1', executor: 'spawn', childId: 'child-a2' })
    expect(await store.load()).toEqual([
      { sessionKey: 'team:r1:proj:v1', executor: 'spawn', childId: 'child-a2' },
      { sessionKey: 'team:r2:proj:v1', executor: 'fork', childId: 'child-b' },
    ])

    await store.remove('team:r1:proj:v1')
    expect(await store.load()).toEqual([{ sessionKey: 'team:r2:proj:v1', executor: 'fork', childId: 'child-b' }])
  })

  it('独立实例重开同库（:memory: 隔离新库）：空表 load 返回空数组', async () => {
    const store = new ExecutorChildStore(openCoreDb())
    expect(await store.load()).toEqual([])
  })
})

describe('DshSubagentExecutorProvider × executor_children 持久镜像', () => {
  it('hydrateChildren：持久映射 seed 内存表，重启后同 sessionKey 直达原子代理（不新建）', async () => {
    const startContinuable = vi.fn(async () => ({ childId: 'child-new' }))
    const followup = vi.fn(async () => 'message-2')
    const seededEvents: Array<{ type: string; data: Record<string, unknown> }> = []
    const child = {
      id: 'child-seeded',
      whenIdle: vi.fn(async () => {
        seededEvents.push(...turnEvents('seeded-output'))
      }),
      session: { events: seededEvents },
      ctx: { on: () => () => undefined },
      options: { provider: 'p', model: 'm' },
    }
    const subagents = {
      list: () => ['spawn'],
      start: vi.fn(),
      startContinuable,
      followup,
      agents: { get: (id: string) => (id === 'child-seeded' ? child : undefined) },
    }
    const rows: Array<{ sessionKey: string; executor: string; childId: string }> = [
      { sessionKey: 'team:spawn:proj:v9', executor: 'spawn', childId: 'child-seeded' },
    ]
    const store = {
      load: vi.fn(async () => rows),
      record: vi.fn(async () => undefined),
    }
    const provider = new DshSubagentExecutorProvider(subagents as never, { childrenStore: store })
    await provider.hydrateChildren()

    const run = await provider.start({
      executor: 'spawn',
      sessionKey: 'team:spawn:proj:v9',
      prompt: [{ type: 'text' as const, text: 'task after restart' }],
      signal: new AbortController().signal,
      runtime: { model: { provider: 'p', id: 'm' } },
    })
    await run.result
    // seed 生效：直达原子代理走 followup，不再 startContinuable 新建
    expect(startContinuable).not.toHaveBeenCalled()
    expect(followup).toHaveBeenCalledTimes(1)
    expect(run.sessionId).toBe('child-seeded')
  })

  it('派发新建子代理时同步落库（record 被调用，携带 executor）', async () => {
    const freshEvents: Array<{ type: string; data: Record<string, unknown> }> = []
    const child = {
      id: 'child-fresh',
      whenIdle: vi.fn(async () => {
        freshEvents.push(...turnEvents('fresh-output'))
      }),
      session: { events: freshEvents },
      ctx: { on: () => () => undefined },
      options: { provider: 'p', model: 'm' },
    }
    const subagents = {
      list: () => ['spawn'],
      start: vi.fn(),
      startContinuable: vi.fn(async () => ({ childId: 'child-fresh' })),
      followup: vi.fn(async () => 'message-2'),
      agents: { get: () => child },
    }
    const store = { load: vi.fn(async () => []), record: vi.fn(async () => undefined) }
    const provider = new DshSubagentExecutorProvider(subagents as never, { childrenStore: store })

    const run = await provider.start({
      executor: 'spawn',
      sessionKey: 'team:spawn:proj:v10',
      prompt: [{ type: 'text' as const, text: 'first dispatch' }],
      signal: new AbortController().signal,
      runtime: { model: { provider: 'p', id: 'm' } },
    })
    await run.result
    expect(store.record).toHaveBeenCalledWith({ sessionKey: 'team:spawn:proj:v10', executor: 'spawn', childId: 'child-fresh' })
  })

  it('持久化失败不阻断派发（record 拒绝被吞，运行照常完成）', async () => {
    const xEvents: Array<{ type: string; data: Record<string, unknown> }> = []
    const child = {
      id: 'child-x',
      whenIdle: vi.fn(async () => {
        xEvents.push(...turnEvents('output-x'))
      }),
      session: { events: xEvents },
      ctx: { on: () => () => undefined },
      options: { provider: 'p', model: 'm' },
    }
    const subagents = {
      list: () => ['spawn'],
      start: vi.fn(),
      startContinuable: vi.fn(async () => ({ childId: 'child-x' })),
      followup: vi.fn(async () => 'message-2'),
      agents: { get: () => child },
    }
    const store = {
      load: vi.fn(async () => []),
      record: vi.fn(async () => {
        throw new Error('disk full')
      }),
    }
    const provider = new DshSubagentExecutorProvider(subagents as never, { childrenStore: store })
    const run = await provider.start({
      executor: 'spawn',
      sessionKey: 'team:spawn:proj:v11',
      prompt: [{ type: 'text' as const, text: 'dispatch with broken store' }],
      signal: new AbortController().signal,
      runtime: { model: { provider: 'p', id: 'm' } },
    })
    const result = await run.result
    expect(result.stopReason).toBe('completed')
  })
})
