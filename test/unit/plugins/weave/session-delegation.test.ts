import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stringify as stringifyYaml } from 'yaml'

import { WeavePersistence } from '../../../../src/plugins/weave/persistence/persistence'
import { TeamManager, type ExecutorLookup, type TeamConfig } from '../../../../src/plugins/weave/team/team-manager.js'
import { createWeaveRpcHandler } from '../../../../src/plugins/weave/host/rpc'
import {
  createPreStepDelegationHook,
  createWeaveNoticeMessage,
  hasPendingToolCall,
  notifySession,
  parseTeamSelectionCommand,
} from '../../../../src/plugins/weave/scheduling/session-delegation'

const lookup: ExecutorLookup = {
  get(id) {
    return id === 'codex'
      ? { id, name: id, kind: 'codex', capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false } }
      : undefined
  },
}

const TEAM: TeamConfig = {
  team_id: 'pipe-team',
  name: '流水线团队',
  description: '端到端流程团队',
  default: false,
  roles: [
    { id: 'researcher', name: '方案研究员', bias: 'design', executor: 'codex', stages: ['prepare'], max_concurrent_tasks: 1, personality: '调研' },
    { id: 'coder', name: '核心开发', bias: 'dev', executor: 'codex', stages: ['implement'], max_concurrent_tasks: 1, personality: '实现' },
    { id: 'reviewer', name: '审核员', bias: 'review', executor: 'codex', stages: ['review'], max_concurrent_tasks: 1, personality: '审核' },
  ],
  task_decomposition: {
    matchers: [{ pattern: '重构', difficulty: 'critical' }],
    default_difficulty: 'hard',
    dag_templates: {
      easy: ['prepare'],
      medium: ['prepare', 'implement'],
      hard: ['prepare', 'implement', 'review'],
      critical: ['prepare', 'implement', 'review'],
    },
  },
  knowledge_injection: { max_entries: 1, max_chars_per_entry: 100, max_total_chars: 300, priority: 'freshness_first' },
  feedback: { feedback_timeout_seconds: 60, max_revisions: 1, reopen_window_seconds: 60 },
}

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'weave-sessdel-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function makeHookEnv() {
  const persistence = new WeavePersistence({ inMemory: true })
  const manager = new TeamManager(lookup, { teamsDir: dir, persistence })
  manager.importTeam(stringifyYaml({ schema_version: '1', ...TEAM }))
  const notices: Array<{ sessionId: string; text: string }> = []
  const hook = createPreStepDelegationHook({
    listTeams: () => manager.listTeams(),
    setSelection: async (sessionId, teamId) => {
      if (teamId === null) await manager.unbindTeam(sessionId)
      else await manager.bindTeam(sessionId, teamId)
    },
    getSelection: (sessionId) => manager.getSelection(sessionId),
    notify: (sessionId, text) => { notices.push({ sessionId, text }) },
  })
  return { manager, notices, hook }
}

function makePayload(messageId = 'm1', text = '帮我实现登录功能', agentId = 'sess-1') {
  const appended: Array<{ type: string; data: unknown; opts: unknown }> = []
  return {
    payload: {
      agent: {
        id: agentId,
        session: {
          append: (type: string, data: unknown, opts: unknown) => { appended.push({ type, data, opts }) },
        },
      },
      messages: [
        { id: 'earlier-plugin-msg', role: 'user', content: [{ type: 'text', text: '背景资料' }], source: { kind: 'plugin' } },
        { id: messageId, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
      ],
      signal: new AbortController().signal,
    },
    appended,
  }
}

const nextOk = async () => ({ kind: 'enter' as const, messages: [] })

describe('自然语言团队启停（会话控制通道）', () => {
  it('解析启用指令并按 ID / 名称匹配团队', () => {
    expect(parseTeamSelectionCommand('启用 pipe-team', [TEAM])).toEqual({ action: 'enable', team: TEAM })
    expect(parseTeamSelectionCommand('请切换到 流水线团队。', [TEAM])).toEqual({ action: 'enable', team: TEAM })
    expect(parseTeamSelectionCommand('帮我实现登录功能', [TEAM])).toBeNull()
  })

  it('解析关闭团队指令', () => {
    expect(parseTeamSelectionCommand('关闭团队', [TEAM])).toEqual({ action: 'disable' })
    expect(parseTeamSelectionCommand('请停用小队。', [TEAM])).toEqual({ action: 'disable' })
  })

  it('自然语言启用会写入绑定并通知，然后 reject 该消息', async () => {
    const env = makeHookEnv()
    const payload = makePayload('nl-enable', '启用 pipe-team')
    const decision = await env.hook(payload.payload, nextOk)

    expect(decision).toEqual({ kind: 'reject' })
    expect(await env.manager.getSelection('sess-1')).toMatchObject({ team_id: 'pipe-team' })
    expect(env.notices.at(-1)?.text).toContain('已在当前会话启用团队「流水线团队」')
    expect(env.notices.at(-1)?.text).toContain('团队简介：端到端流程团队')
  })

  it('自然语言关闭会清除绑定并通知', async () => {
    const env = makeHookEnv()
    await env.manager.bindTeam('sess-1', 'pipe-team')
    const payload = makePayload('nl-disable', '关闭团队')
    const decision = await env.hook(payload.payload, nextOk)

    expect(decision).toEqual({ kind: 'reject' })
    expect(await env.manager.getSelection('sess-1')).toBeNull()
    expect(env.notices.at(-1)?.text).toContain('已关闭当前会话的团队')
  })

  it('绑定态目标消息注入纪律后放行（派发仍由队长经 weave_plan_tasks 完成）', async () => {
    const env = makeHookEnv()
    await env.manager.bindTeam('sess-1', 'pipe-team')
    const payload = makePayload('m-task', '做一个新的登录页面')
    const decision = await env.hook(payload.payload, nextOk)
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    expect(decision.messages).toHaveLength(1)
    const injected = decision.messages[0] as { content?: Array<{ type: string; text: string }> }
    expect(injected.content?.[0]?.text).toContain('队长纪律')
    expect(env.notices).toHaveLength(0)
  })

  it('同一 message.id 只处理一次；非 user 来源消息忽略', async () => {
    const env = makeHookEnv()
    const first = makePayload('dup-1', '启用 pipe-team')
    await env.hook(first.payload, nextOk)
    expect(env.notices).toHaveLength(1)

    // 第二次投递同一 id：模块级去重命中，必须放行且不再追加 notice。
    await expect(env.hook(first.payload, nextOk)).resolves.toEqual({ kind: 'enter', messages: [] })
    expect(env.notices).toHaveLength(1)
    expect(await env.manager.getSelection('sess-1')).toMatchObject({ team_id: 'pipe-team' })

    const pluginOnly = makePayload('p-only', '启用 pipe-team')
    pluginOnly.payload.messages = pluginOnly.payload.messages.map((message) =>
      message.id === 'p-only' ? { ...message, source: { kind: 'plugin' as const } } : message,
    )
    await env.hook(pluginOnly.payload, nextOk)
    expect(await env.manager.getSelection('sess-1')).toMatchObject({ team_id: 'pipe-team' }) // 未被改写
    expect(env.notices).toHaveLength(1)
  })

  it('同一消息并发投递只发一条 notice（先占位再 await，防 3 连通知）', async () => {
    const env = makeHookEnv()
    const { payload } = makePayload('dup-concurrent', '启用 pipe-team')
    const decisions = await Promise.all([
      env.hook(payload, nextOk),
      env.hook(payload, nextOk),
      env.hook(payload, nextOk),
    ])
    expect(env.notices).toHaveLength(1)
    expect(decisions.filter((decision) => decision.kind === 'reject')).toHaveLength(1)
    expect(await env.manager.getSelection('sess-1')).toMatchObject({ team_id: 'pipe-team' })
  })

  it('hook 自身异常不破坏 pre-step 主链路（降级为放行）', async () => {
    const badHook = createPreStepDelegationHook({
      listTeams: () => { throw new Error('boom') },
      setSelection: async () => undefined,
      notify: () => undefined,
    })
    const { payload } = makePayload('bad-1', '启用 pipe-team')
    await expect(badHook(payload, nextOk)).resolves.toEqual({ kind: 'enter', messages: [] })
  })

  it('notifySession 写入 durable log：plugin 来源 + surface append', () => {
    const appended: Array<{ type: string; data: unknown; opts: unknown }> = []
    notifySession({ append: (type, data, opts) => { appended.push({ type, data, opts }) } }, '[weave] 测试通知')
    expect(appended).toHaveLength(1)
    const record = appended[0]!
    expect(record.type).toBe('user/message')
    expect(record.opts).toEqual({ surfaceOp: 'append' })
    expect((record.data as { source: { kind: string; plugin: string } }).source).toEqual({ kind: 'plugin', plugin: 'dsh-weave' })
    expect((record.data as { role: string }).role).toBe('user')
  })

  it('createWeaveNoticeMessage 生成稳定形状的 plugin 消息', () => {
    const msg = createWeaveNoticeMessage('[weave] 测试')
    expect(msg.role).toBe('user')
    expect(msg.content).toEqual([{ type: 'text', text: '[weave] 测试' }])
    expect(msg.source).toEqual({ kind: 'plugin', plugin: 'dsh-weave' })
    expect(msg.id.startsWith('weave-notice-')).toBe(true)
  })

  it('hasPendingToolCall：未回结果的 tool-call 会命中，已闭合则不会', () => {
    const base = {
      surface: { nodes: [1, 2] },
      events: [
        { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'call_1' }] } } },
        { seq: 2, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'x' }] } } },
      ],
    }
    expect(hasPendingToolCall(base as never)).toBe(true)

    const closed = {
      surface: { nodes: [1, 2, 3] },
      events: [
        { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'call_1' }] } } },
        { seq: 2, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'x' }] } } },
        { seq: 3, type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'call_1' }] } } },
      ],
    }
    expect(hasPendingToolCall(closed as never)).toBe(false)
  })
})

describe('session/team-selection RPC（复用 team_bindings，绑定=启用）', () => {
  function rpcEnv() {
    const persistence = new WeavePersistence({ inMemory: true })
    const teamManager = new TeamManager(lookup, { teamsDir: dir, persistence })
    teamManager.importTeam(stringifyYaml({ schema_version: '1', ...TEAM }))
    return createWeaveRpcHandler({ teamManager, executorRegistry: { list: () => [], get: () => undefined }, persistence } as never)
  }

  it('set 缺 sessionId → 明确拒绝，绝不默认 cli-session', async () => {
    const call = rpcEnv()
    await expect(call('session/team-selection/set', { teamId: 'pipe-team' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'bad-request', message: expect.stringContaining('显式'), details: { original_code: 'invalid_argument' } },
    })
  })

  it('set/get/clear 全链路：enabled 与 updated_at 真实回读', async () => {
    const call = rpcEnv()
    await expect(call('session/team-selection/set', { sessionId: 'web-s1', teamId: 'pipe-team' })).resolves.toMatchObject({
      ok: true,
      value: { session_id: 'web-s1', enabled: true, team_id: 'pipe-team' },
    })
    await expect(call('session/team-selection/get', { sessionId: 'web-s1' })).resolves.toMatchObject({
      ok: true,
      value: { enabled: true, team_id: 'pipe-team', updated_at: expect.any(String) },
    })
    await expect(call('session/team-selection/set', { sessionId: 'web-s1', teamId: null })).resolves.toMatchObject({
      ok: true,
      value: { enabled: false, cleared: true },
    })
    await expect(call('session/team-selection/get', { sessionId: 'web-s1' })).resolves.toMatchObject({
      ok: true,
      value: { enabled: false, team_id: null },
    })
  })

  it('启用未知团队 → invalid_team；get 缺 sessionId 同样明确拒绝', async () => {
    const call = rpcEnv()
    await expect(call('session/team-selection/set', { sessionId: 's', teamId: 'ghost' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'bad-request', details: { original_code: 'invalid_team' } },
    })
    await expect(call('session/team-selection/get', {})).resolves.toMatchObject({
      ok: false,
      error: { code: 'bad-request', details: { original_code: 'invalid_argument' } },
    })
  })
})

describe('团队感知提醒（非控制指令路径）', () => {
  it('命中团队关键词时注入提醒并放行本回合', async () => {
    const env = makeHookEnv()
    const { payload } = makePayload('aw-1', '启动 deepseek zcode 测试小队开发个小游戏', 'aw-sess-1')
    const decision = await env.hook(payload, nextOk)

    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    expect(decision.messages).toHaveLength(1)
    const injected = decision.messages[0] as { content?: Array<{ type: string; text: string }>; source?: { kind: string; plugin: string } }
    expect(injected.source).toEqual({ kind: 'plugin', plugin: 'dsh-weave' })
    const text = injected.content?.[0]?.text ?? ''
    expect(text).toContain('pipe-team')
    expect(text).toContain('weave_plan_tasks')
    expect(text).toContain('唯一团队')
    expect(text).toContain('不要凭空模拟团队成员')
  })

  it('同一会话同一团队清单只注入一次', async () => {
    const env = makeHookEnv()
    const first = await env.hook(makePayload('aw-2a', '用团队做个工具', 'aw-sess-2').payload, nextOk)
    const second = await env.hook(makePayload('aw-2b', '再说一次团队派单', 'aw-sess-2').payload, nextOk)
    expect(first.kind).toBe('enter')
    expect(second.kind).toBe('enter')
    if (first.kind !== 'enter' || second.kind !== 'enter') return
    expect(first.messages).toHaveLength(1)
    expect(second.messages).toHaveLength(0)
  })

  it('未命中关键词不注入', async () => {
    const env = makeHookEnv()
    const decision = await env.hook(makePayload('aw-3', '帮我写一个纯函数', 'aw-sess-3').payload, nextOk)
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    expect(decision.messages).toHaveLength(0)
  })

  it('已绑定会话的目标消息注入队长纪律硬指令（按消息 id 去重）', async () => {
    const env = makeHookEnv()
    await env.manager.bindTeam('aw-sess-4', 'pipe-team')
    const decision = await env.hook(makePayload('aw-4', 'weave 派单：重构登录模块', 'aw-sess-4').payload, nextOk)
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    expect(decision.messages).toHaveLength(1)
    const injected = decision.messages[0] as { content?: Array<{ type: string; text: string }> }
    const text = injected.content?.[0]?.text ?? ''
    expect(text).toContain('队长纪律')
    expect(text).toContain('pipe-team')
    expect(text).toContain('weave_plan_tasks')
    expect(text).toContain('禁止你亲自实现')

    const replay = await env.hook(makePayload('aw-4', 'weave 派单：重构登录模块', 'aw-sess-4').payload, nextOk)
    expect(replay.kind).toBe('enter')
    if (replay.kind !== 'enter') return
    expect(replay.messages).toHaveLength(0)
  })

  it('绑定态下的非目标短消息仍走团队感知提醒', async () => {
    const env = makeHookEnv()
    await env.manager.bindTeam('aw-sess-5', 'pipe-team')
    const decision = await env.hook(makePayload('aw-5', '团队现在有哪些人', 'aw-sess-5').payload, nextOk)
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    expect(decision.messages).toHaveLength(1)
    const injected = decision.messages[0] as { content?: Array<{ type: string; text: string }> }
    expect(injected.content?.[0]?.text).toContain('已绑定团队「pipe-team」')
  })
})
