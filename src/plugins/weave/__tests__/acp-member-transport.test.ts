import { describe, expect, it, vi } from 'vitest'

import { AcpMemberTransport, type AcpRunLike } from '../acp-member-transport'
import { ExecutorSessionStore } from '../executor-session-store'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function makeStore(): ExecutorSessionStore {
  const dir = mkdtempSync(join(tmpdir(), 'weave-acp-transport-'))
  return new ExecutorSessionStore(join(dir, 'index.json'))
}

describe('AcpMemberTransport', () => {
  it('deliver starts ACP run and reports settled completed', async () => {
    const store = makeStore()
    const start = vi.fn(async () => ({
      result: Promise.resolve({ output: [{ type: 'text', text: 'done' }], stopReason: 'completed' }),
      dispose: vi.fn(async () => undefined),
    }))
    const transport = new AcpMemberTransport({ start }, store)
    const onSettled = vi.fn(async () => undefined)
    const onStatusChange = vi.fn()
    const result = await transport.deliver({
      captain: { id: 'c' },
      member: { id: 'acp:team:dev', name: 'dev', role: 'dev' },
      team: { id: 'changan-1', name: 'changan' },
      workspace: 'C:/proj',
      prompt: 'task',
      hooks: { onSettled, onStatusChange },
    })
    expect(result.accepted).toBe(true)
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: expect.stringContaining('dev'),
      // 主机解析的工作区必须作为父会话 cwd 传导（ACP 会话创建依赖它）
      parent: { session: { header: { cwd: 'C:/proj' } } },
    }))
    expect(onStatusChange).toHaveBeenCalledWith('working')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ output: 'done', failed: false }))
    expect(onStatusChange).toHaveBeenCalledWith('idle')
  })

  it('returns accepted=false when member is already active', async () => {
    const store = makeStore()
    const start = vi.fn(async (): Promise<AcpRunLike> => ({
      result: new Promise(() => undefined),
      dispose: vi.fn(async () => undefined),
    }))
    const transport = new AcpMemberTransport({ start }, store)
    const first = await transport.deliver({
      captain: {}, member: { id: 'm', name: 'dev' }, team: { id: 't', name: 't' }, workspace: 'w', prompt: 'a',
    })
    expect(first.accepted).toBe(true)
    const second = await transport.deliver({
      captain: {}, member: { id: 'm', name: 'dev' }, team: { id: 't', name: 't' }, workspace: 'w', prompt: 'b',
    })
    expect(second.accepted).toBe(false)
  })
})
