import { describe, expect, it, vi } from 'vitest'

import {
  ExecutorProviderRegistry,
  type ExecutorProvider,
  type ExecutorStartRequest,
} from '../../../../src/plugins/weave/executors/executor-provider'
import { ZcodeAcpExecutorProvider } from '../../../../src/plugins/weave/acp/acp-session-provider'
import { DshSubagentExecutorProvider } from '../../../../src/plugins/weave/executors/dsh-subagent-executor-provider'
import type { AcpSessionProvider } from '../../../../src/plugins/weave/acp/acp-session-provider'

describe('ExecutorProviderRegistry', () => {
  it('按注册顺序解析第一个支持 executor 的 Provider', () => {
    const registry = new ExecutorProviderRegistry()
    const specific: ExecutorProvider = {
      id: 'zcode',
      name: 'ZCode',
      kind: 'acp',
      capabilities: { liveOutput: true } as never,
      supports: (executor) => executor === 'zcode',
      start: vi.fn(),
    }
    const fallback: ExecutorProvider = {
      id: 'dsh-subagent',
      name: 'DSH',
      kind: 'dsh_subagent',
      capabilities: { liveOutput: false } as never,
      supports: () => true,
      start: vi.fn(),
    }
    registry.register(specific)
    registry.register(fallback)

    expect(registry.resolve('zcode')).toBe(specific)
    expect(registry.resolve('spawn')).toBe(fallback)
    expect(registry.list()).toEqual([specific, fallback])
  })

  it('同名精确 Provider 优先于注册更早的通配 fallback（动态 ACP 不被 DSH fallback 抢占）', () => {
    const registry = new ExecutorProviderRegistry()
    const fallback: ExecutorProvider = {
      id: 'dsh-subagent',
      name: 'DSH fallback',
      kind: 'dsh_subagent',
      capabilities: { liveOutput: false } as never,
      supports: () => true,
      start: vi.fn(),
    }
    const exact: ExecutorProvider = {
      id: 'agent-x',
      name: '动态 ACP agent-x',
      kind: 'acp',
      capabilities: { liveOutput: true } as never,
      supports: (executor) => executor === 'agent-x',
      start: vi.fn(),
    }
    registry.register(fallback)
    registry.register(exact)

    expect(registry.resolve('agent-x')).toBe(exact)
    expect(registry.resolve('unknown')).toBe(fallback)
  })

  it('重复注册默认拒绝，override 时允许替换', () => {
    const registry = new ExecutorProviderRegistry()
    const make = (suffix: string): ExecutorProvider => ({
      id: 'same-id',
      name: suffix,
      kind: 'custom',
      capabilities: { liveOutput: false } as never,
      supports: () => true,
      start: vi.fn().mockImplementation(async (_request: ExecutorStartRequest) => ({
        output: [],
        stopReason: 'completed',
      })),
    })
    const first = make('first')
    registry.register(first)

    expect(() => registry.register(make('second'))).toThrow(/already registered/)
    const second = make('second')
    registry.register(second, { override: true })
    expect(registry.get('same-id')).toBe(second)
  })
})

describe('ZcodeAcpExecutorProvider', () => {
  it('映射统一运行时参数到 ZCode ACP 扩展，并装饰事件/结果', async () => {
    const start = vi.fn().mockImplementation(async (_request: ExecutorStartRequest) => ({
      id: 'acp-session-42',
      localAgent: undefined,
      result: Promise.resolve({
        output: [{ type: 'text', text: 'ok' }],
        stopReason: 'completed',
      }),
      dispose: async () => undefined,
      readOutput: () => [
        {
          type: 'output',
          text: 'live output',
          at: Date.now(),
        },
      ],
      onEvent: (listener: (event: any) => void) => {
        listener({
          type: 'output',
          text: 'live output',
          at: Date.now(),
        })
        return () => undefined
      },
    }))
    const lowLevel = { name: 'zcode', start } as unknown as AcpSessionProvider
    const provider = new ZcodeAcpExecutorProvider(lowLevel)

    expect(provider.supports('zcode')).toBe(true)
    expect(provider.capabilities.modelSelection).toBe(true)
    expect(provider.capabilities.thoughtControl).toBe(true)
    expect(provider.capabilities.modeControl).toBe(true)

    const events: Array<{ type: string; text?: string }> = []
    const run = await provider.start({
      executor: 'zcode',
      sessionKey: 'team:coder:project:v1',
      prompt: [{ type: 'text', text: 'hello' }],
      signal: new AbortController().signal,
      runtime: {
        model: {
          provider: 'provider-id',
          id: 'deepseek-v4-flash-vision-exp',
        },
        thoughtLevel: 'max',
        mode: 'yolo',
      },
    })

    run.onEvent?.((event) => events.push({ type: event.type, text: event.text }))

    const output = await run.result
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      weave: {
        sessionKey: 'team:coder:project:v1',
        modelProvider: 'provider-id',
        model: 'deepseek-v4-flash-vision-exp',
        thoughtLevel: 'max',
        mode: 'yolo',
      },
    }))
    expect(run.providerId).toBe('zcode')
    expect(run.sessionId).toBe('session-42')
    expect(output.applied?.thinking).toMatchObject({ requested: 'max', effective: 'max', supported: true })
    expect(events[0]?.text).toBe('live output')
  })
})

describe('DshSubagentExecutorProvider thoughtLevel', () => {
  it('把 thought_level 安装到子代理模型选择，agent/request 获得 reasoningEffort', async () => {
    const listeners = new Map<string, Array<(...args: any[]) => Promise<unknown>>>()
    const child = {
      options: { provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' },
      ctx: {
        on: (event: string, listener: (...args: any[]) => Promise<unknown>) => {
          const arr = listeners.get(event) ?? []
          arr.push(listener)
          listeners.set(event, arr)
          return () => undefined
        },
      },
    }
    const subagents = {
      list: () => ['spawn'],
      start: async () => ({
        id: 'child-1',
        localAgent: child,
        result: Promise.resolve({ output: [], stopReason: 'completed' }),
        dispose: async () => undefined,
      }),
    }
    const provider = new DshSubagentExecutorProvider(subagents as never)
    const run = await provider.start({
      executor: 'spawn',
      sessionKey: 'team:spawn:proj:v1',
      prompt: [{ type: 'text', text: 'hi' }],
      signal: new AbortController().signal,
      runtime: {
        model: { provider: 'deepseek-official', id: 'deepseek-v4-flash-vision-exp' },
        thoughtLevel: 'max',
      },
    })

    expect(provider.capabilities.thoughtControl).toBe(true)
    expect(run.applied?.thinking).toMatchObject({ requested: 'max', effective: 'max', supported: true })

    // installModelSelection 先经 system-prompt/assemble 快照，再在 agent/request 应用。
    const assembleListener = listeners.get('system-prompt/assemble')?.[0]
    expect(assembleListener).toBeDefined()
    await assembleListener!({}, {}, async () => ({ variables: {} }))
    const requestListener = listeners.get('agent/request')?.[0]
    expect(requestListener).toBeDefined()
    const resolved = await requestListener!({}, async () => ({ provider: 'old', model: 'old', maxTokens: 100 }))
    expect(resolved).toMatchObject({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash-vision-exp',
      reasoningEffort: 'max',
      maxTokens: 100,
    })
  })

  it('没有 localAgent 时指定 thoughtLevel 明确报错，不静默忽略', async () => {
    const subagents = {
      list: () => ['spawn'],
      start: async () => ({
        id: 'remote-1',
        localAgent: undefined,
        result: Promise.resolve({ output: [], stopReason: 'completed' }),
        dispose: async () => undefined,
      }),
    }
    const provider = new DshSubagentExecutorProvider(subagents as never)
    await expect(provider.start({
      executor: 'spawn',
      sessionKey: 'team:spawn:proj:v1',
      prompt: [{ type: 'text', text: 'hi' }],
      signal: new AbortController().signal,
      runtime: { thoughtLevel: 'high' },
    })).rejects.toThrow(/without an in-process localAgent/)
  })
})


describe('DshSubagentExecutorProvider fork session reuse', () => {
  function makeContinuableChild(id: string) {
    return {
      id,
      whenIdle: async () => undefined,
      session: { events: [] },
      ctx: { on: () => () => undefined },
      options: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }
  }

  it('fork 首次创建 continuable 子会话，后续同 sessionKey 只 followup 不再 fork', async () => {
    const child = makeContinuableChild('fork-child-1')
    const startContinuable = vi.fn().mockResolvedValue({ childId: 'fork-child-1' })
    const followup = vi.fn().mockResolvedValue(undefined)
    const subagents = {
      list: () => ['fork'],
      startContinuable,
      followup,
      listChildren: vi.fn().mockResolvedValue([]),
      agents: { get: (id: string) => (id === 'fork-child-1' ? child : undefined) },
    }
    const provider = new DshSubagentExecutorProvider(subagents as never)

    const first = await provider.start({
      executor: 'fork',
      sessionKey: 'team:fork:project:v1',
      prompt: [{ type: 'text', text: 'first' }],
      signal: new AbortController().signal,
    })
    await first.result

    const second = await provider.start({
      executor: 'fork',
      sessionKey: 'team:fork:project:v1',
      prompt: [{ type: 'text', text: 'second' }],
      signal: new AbortController().signal,
    })
    await second.result

    expect(startContinuable).toHaveBeenCalledTimes(1)
    expect(followup).toHaveBeenCalledTimes(1)
    expect(followup).toHaveBeenCalledWith(
      undefined,
      'fork-child-1',
      [{ type: 'text', text: 'second' }],
      expect.objectContaining({ source: expect.objectContaining({ kind: 'coordinator' }) }),
    )
    expect(first.sessionId).toBe('fork-child-1')
    expect(second.sessionId).toBe('fork-child-1')
    expect(second.id).toBe('fork-child-1')
  })

  it('宿主缺少 continuable API 时 fork 直接失败，不退回一次性 fork', async () => {
    const start = vi.fn()
    const provider = new DshSubagentExecutorProvider({
      list: () => ['fork'],
      start,
    } as never)

    await expect(provider.start({
      executor: 'fork',
      sessionKey: 'team:fork:project:v1',
      prompt: [{ type: 'text', text: 'first' }],
      signal: new AbortController().signal,
    })).rejects.toThrow(/requires continuable session APIs/)
    expect(start).not.toHaveBeenCalled()
  })
})
