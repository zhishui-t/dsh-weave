import { describe, expect, it, vi } from 'vitest'

import { mapTaskSettled, ReflectionBridge } from '../reflection-bridge'

describe('reflection-bridge', () => {
  it('maps fork completed event to reflection input', () => {
    const mapped = mapTaskSettled({
      teamId: 'changan-4edcb4c4',
      teamProfileName: 'changan',
      taskId: 't1',
      taskSubject: '实现登录',
      taskStatus: 'completed',
      memberName: 'dev',
      memberRole: '开发者',
      memberExecutor: 'acp',
      output: 'done',
    })
    expect(mapped).toEqual({
      taskId: 't1',
      executor: 'acp',
      roleId: '开发者',
      projectId: 'changan',
      version: 'changan-4edcb4c4',
      outputText: 'done',
      taskSubject: '实现登录',
    })
  })

  it('skips non-terminal events', () => {
    expect(mapTaskSettled({ teamId: 't', taskId: 'x', taskStatus: 'in_progress' })).toBeNull()
  })

  it('calls reflection only for terminal events', async () => {
    const deposit = vi.fn(async () => ({ deposited: [], invalid: 0, errors: [] }))
    const bridge = new ReflectionBridge({ depositFromOutput: deposit })
    const result = await bridge.onTaskSettled({
      teamId: 'changan-x',
      teamProfileName: 'changan',
      taskId: 't1',
      taskStatus: 'failed',
      memberExecutor: 'zcode',
      memberName: 'qa',
      output: 'blocked',
    })
    expect(result).not.toBeNull()
    expect(deposit).toHaveBeenCalledWith(expect.objectContaining({ taskId: 't1', projectId: 'changan' }))
  })
})
