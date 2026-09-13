import { describe, expect, it, vi } from 'vitest'

import { MemberRuntime, defaultMemberBootstrap } from '../../../../src/plugins/weave/team/member-runtime'
import { openPersistence } from '../../../../src/plugins/weave/persistence/index'

interface FakeDsh {
  startContinuable: ReturnType<typeof vi.fn>
  followup: ReturnType<typeof vi.fn>
  sendMessage: ReturnType<typeof vi.fn>
  agents: { get: (id: string) => unknown }
}

function makeDsh(overrides: Partial<FakeDsh> = {}): FakeDsh {
  return {
    startContinuable: vi.fn(async () => ({ childId: 'child-1' })),
    followup: vi.fn(async () => 'message-2'),
    sendMessage: vi.fn(async () => 'message-1'),
    agents: { get: () => undefined },
    ...overrides,
  }
}

function makeRuntime(options: { dsh?: FakeDsh; acpWake?: (executor: string, sessionKey: string, text: string, parent: unknown) => Promise<void> } = {}) {
  const persistence = openPersistence({ inMemory: true })
  const runtime = new MemberRuntime({
    persistence,
    dsh: options.dsh ?? makeDsh(),
    ...(options.acpWake ? { acpWake: options.acpWake } : {}),
  })
  return { runtime, persistence }
}

const PARENT = { session: { header: { cwd: '/tmp/p' } } }

describe('MemberRuntime（pull 模型持久成员域）', () => {
  it("ensureMember 'dsh'：fork continuable 创建 + bootstrap 注入 + roster 落库；幂等", async () => {
    const dsh = makeDsh()
    const { runtime, persistence } = makeRuntime({ dsh })
    const member = await runtime.ensureMember({
      teamId: 'alpha',
      teamName: '阿尔法',
      roleId: 'coder',
      roleName: '程序员',
      personality: '写码如飞',
      executor: 'dsh',
      parent: PARENT,
    })
    expect(member).toMatchObject({ member_id: 'alpha:coder', executor: 'dsh', child_id: 'child-1', state: 'idle', label: '程序员' })
    expect(dsh.startContinuable).toHaveBeenCalledTimes(1)
    const spec = dsh.startContinuable.mock.calls[0]?.[0] as { provider: string; label: string; request: { prompt: Array<{ text: string }> } }
    expect(spec.provider).toBe('fork')
    expect(spec.label).toBe('alpha:coder')
    expect(spec.request.prompt[0]?.text).toContain('持久成员')
    expect(spec.request.prompt[0]?.text).toContain('weave_task_claim')
    expect(spec.request.prompt[0]?.text).toContain('写码如飞')
    // roster 真实落库
    const rows = await persistence.core.run((db) => db.prepare('SELECT member_id FROM team_members').all()) as unknown as Array<{ member_id: string }>
    expect(rows.map((r) => r.member_id)).toEqual(['alpha:coder'])
    // 幂等：再 ensure 不重复创建
    await runtime.ensureMember({ teamId: 'alpha', roleId: 'coder', executor: 'dsh', parent: PARENT })
    expect(dsh.startContinuable).toHaveBeenCalledTimes(1)
  })

  it("ensureMember ACP 执行器：懒创建（不调 startContinuable），sessionKey 为成员专用键", async () => {
    const dsh = makeDsh()
    const { runtime } = makeRuntime({ dsh })
    const member = await runtime.ensureMember({ teamId: 'alpha', roleId: 'writer', executor: 'zcode', parent: PARENT })
    expect(member.child_id).toBeNull()
    expect(member.session_key).toBe('alpha:writer:member')
    expect(member.state).toBe('inactive')
    expect(dsh.startContinuable).not.toHaveBeenCalled()
  })

  it("deliver 'dsh'：优先 sendMessage（running 插话/idle 唤醒/absent 冷恢复三态统一），成功置 running", async () => {
    const dsh = makeDsh()
    const { runtime } = makeRuntime({ dsh })
    await runtime.ensureMember({ teamId: 'alpha', roleId: 'coder', executor: 'dsh', parent: PARENT })
    await runtime.deliver({ teamId: 'alpha', roleId: 'coder', text: '任务 T5 已就绪', parent: PARENT })
    expect(dsh.sendMessage).toHaveBeenCalledTimes(1)
    const call = dsh.sendMessage.mock.calls[0] as unknown as [unknown, string, Array<{ text: string }>, unknown]
    expect(call[1]).toBe('child-1')
    expect(call[2][0]?.text).toContain('T5')
    const member = await runtime.get('alpha', 'coder')
    expect(member?.state).toBe('running')
  })

  it("deliver ACP 成员：走 acpWake（sessionKey 专用键）", async () => {
    const acpWake = vi.fn(async () => undefined)
    const { runtime } = makeRuntime({ acpWake })
    await runtime.ensureMember({ teamId: 'alpha', roleId: 'writer', executor: 'zcode', parent: PARENT })
    await runtime.deliver({ teamId: 'alpha', roleId: 'writer', text: '新任务', parent: PARENT })
    expect(acpWake).toHaveBeenCalledWith('zcode', 'alpha:writer:member', '新任务', PARENT)
  })

  it('deliver 失败 → 成员置 failed 并上抛 WeaveError', async () => {
    const dsh = makeDsh({
      sendMessage: vi.fn(async () => { throw new Error('bridge dead') }),
    })
    const { runtime } = makeRuntime({ dsh })
    await runtime.ensureMember({ teamId: 'alpha', roleId: 'coder', executor: 'dsh', parent: PARENT })
    await expect(runtime.deliver({ teamId: 'alpha', roleId: 'coder', text: 'x', parent: PARENT })).rejects.toMatchObject({ code: 'member_unreachable' })
    expect((await runtime.get('alpha', 'coder'))?.state).toBe('failed')
  })

  it('deliver 未创建的成员 → member_not_found', async () => {
    const { runtime } = makeRuntime({})
    await expect(runtime.deliver({ teamId: 'alpha', roleId: 'ghost', text: 'x', parent: PARENT })).rejects.toMatchObject({ code: 'member_not_found' })
  })

  it('list：读时状态刷新——child 失联 → inactive（可冷恢复，非失败）', async () => {
    let childLive = true
    const child = { whenIdle: async () => undefined }
    const dsh = makeDsh({ agents: { get: () => (childLive ? child : undefined) } })
    const { runtime } = makeRuntime({ dsh })
    await runtime.ensureMember({ teamId: 'alpha', roleId: 'coder', executor: 'dsh', parent: PARENT })
    expect((await runtime.list('alpha'))[0]?.state).toBe('idle')
    childLive = false // 模拟宿主重启后未物化
    expect((await runtime.list('alpha'))[0]?.state).toBe('inactive')
  })

  it("interrupt 'dsh'：child.cancel({kind:'parent'})", async () => {
    const cancel = vi.fn()
    const child = { whenIdle: async () => undefined, cancel }
    const dsh = makeDsh({ agents: { get: () => child } })
    const { runtime } = makeRuntime({ dsh })
    await runtime.ensureMember({ teamId: 'alpha', roleId: 'coder', executor: 'dsh', parent: PARENT })
    await runtime.interrupt({ teamId: 'alpha', roleId: 'coder' })
    expect(cancel).toHaveBeenCalledWith({ kind: 'parent' })
  })
})

describe('defaultMemberBootstrap', () => {
  it('包含 pull 工作流三步与人格段', () => {
    const text = defaultMemberBootstrap({ teamId: 'alpha', roleId: 'coder', roleName: '程序员', personality: '严谨' })
    expect(text).toContain('weave_task_list')
    expect(text).toContain('weave_task_claim')
    expect(text).toContain('action=complete')
    expect(text).toContain('严谨')
  })
})
