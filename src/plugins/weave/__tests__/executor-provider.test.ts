import { describe, expect, it, vi } from 'vitest'

import {
  ExecutorProviderRegistry,
  type ExecutorProvider,
  type ExecutorStartRequest,
} from '../executors/executor-provider'
import { ZcodeAcpExecutorProvider } from '../acp/acp-session-provider'
import type { AcpSessionProvider } from '../acp/acp-session-provider'

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
