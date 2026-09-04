import { describe, expect, it, vi } from 'vitest'
import { ReflectionSink } from '../../../../src/plugins/weave/team/reflection-sink.js'

describe('ReflectionSink', () => {
  it('delegates to ReflectionService and returns deposited ids', async () => {
    const depositFromOutput = vi.fn(async () => ({ deposited: [{ title: 'memory-1' } as never] }))
    const sink = new ReflectionSink({ depositFromOutput } as never)
    const result = await sink.deposit({
      taskId: 't1',
      executor: 'developer',
      roleId: 'dev',
      projectId: 'weave',
      version: 'v1',
      outputText: 'done',
    })
    expect(depositFromOutput).toHaveBeenCalledTimes(1)
    expect(result.deposited).toEqual(['memory-1'])
  })
})
