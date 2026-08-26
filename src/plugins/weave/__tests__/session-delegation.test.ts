import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stringify as stringifyYaml } from 'yaml'

import { WeavePersistence } from '../persistence/persistence'
import { TeamManager, type ExecutorLookup, type TeamConfig } from '../team-manager'
import { createWeaveRpcHandler } from '../rpc'
import {
  SequentialSessionDelegator,
  createPreStepDelegationHook,
  notifySession,
  pickDifficulty,
  planStages,
} from '../session-delegation'

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

/** 真实 DelegationService 的执行替身：捕获调用序列与上游上下文，按脚本回放结果。 */
class FakeDelegation {
  calls: Array<{ taskId: string; roleId: string; stageDescription: string; upstreamLabels: string[]; upstreamText: string[] }> = []
  script: Array<{ stopReason?: string; text?: string; throwInfra?: boolean }> = []

  async executeTask(task: { id: string; description: string }, role: { id: string; name: string }, _team: unknown, context: { upstreamOutputs?: Array<{ label: string; output: string }> }) {
    const upstream = context.upstreamOutputs ?? []
    this.calls.push({
      taskId: task.id,
      roleId: role.id,
      stageDescription: task.description,
      upstreamLabels: upstream.map((item) => item.label),
      upstreamText: upstream.map((item) => item.output),
    })
    const step = this.script[this.calls.length - 1] ?? {}
    if (step.throwInfra) throw new Error('infra-boom')
    return {
      id: task.id,
      output: [{ type: 'text', text: step.text ?? `${role.id}-done` }],
      stopReason: step.stopReason ?? 'completed',
      duration_ms: 5,
    }
  }
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 15))
}

function makeHookEnv() {
  const persistence = new WeavePersistence({ inMemory: true })
  const manager = new TeamManager(lookup, { teamsDir: dir, persistence })
  manager.importTeam(stringifyYaml({ schema_version: '1', ...TEAM }))
  const fake = new FakeDelegation()
  const delegator = new SequentialSessionDelegator(fake as never)
  const notices: Array<{ sessionId: string; text: string }> = []
  const hook = createPreStepDelegationHook({
    getSelection: (sessionId) => manager.getSelection(sessionId),
    loadTeam: (teamId) => manager.loadTeam(teamId),
    delegator,
    notify: (sessionId, text) => { notices.push({ sessionId, text }) },
  })
  return { manager, fake, delegator, notices, hook }
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

describe('pickDifficulty / planStages（t6 顺序计划）', () => {
  it('matchers 首个命中优先，否则 default_difficulty', () => {
    expect(pickDifficulty(TEAM, '请重构整个模块')).toBe('critical')
    expect(pickDifficulty(TEAM, '普通任务')).toBe('hard')
  })

  it('按难度模板展开阶段→角色；缺失难度回退默认模板', () => {
    const plan = planStages(TEAM, 'hard')
    expect(plan.map((step) => step.role.id)).toEqual(['researcher', 'coder', 'reviewer'])
    const fallback = planStages(TEAM, 'easy')
    expect(fallback.map((step) => step.stage)).toEqual(['prepare'])
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
      error: { code: 'invalid_argument', message: expect.stringContaining('显式') },
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
      error: { code: 'invalid_team' },
    })
    await expect(call('session/team-selection/get', {})).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_argument' },
    })
  })
})

describe('agent/pre-step 委托编排（t6 核心）', () => {
  it('未绑定团队：直接放行，零委托零通知', async () => {
    const env = makeHookEnv()
    const { payload } = makePayload()
    const decision = await env.hook(payload, nextOk)
    expect(decision).toEqual({ kind: 'enter', messages: [] })
    expect(env.fake.calls).toHaveLength(0)
    expect(env.notices).toHaveLength(0)
  })

  it('绑定团队后：三阶段顺序委托，前序输出进入后续上游，完成与进度通知齐全', async () => {
    const env = makeHookEnv()
    await env.manager.bindTeam('sess-1', 'pipe-team')
    env.fake.script = [{ text: '调研结论A' }, {}, { stopReason: undefined }]
    const { payload } = makePayload('m1', '帮我实现登录功能')
    await env.hook(payload, nextOk)
    await flushAsync()

    expect(env.fake.calls.map((call) => call.roleId)).toEqual(['researcher', 'coder', 'reviewer'])
    expect(env.fake.calls[1]!.upstreamLabels).toEqual(['方案研究员（prepare）'])
    expect(env.fake.calls[1]!.upstreamText).toEqual(['调研结论A'])
    expect(env.notices.filter((n) => n.text.includes('开始'))).toHaveLength(3)
    const done = env.notices.find((n) => n.text.includes('已完成本次任务委托'))
    expect(done?.text).toContain('reviewer-done')

    // 幂等：同一 message.id 再次投递不重复委托
    await env.hook(payload, nextOk)
    await flushAsync()
    expect(env.fake.calls).toHaveLength(3)
  })

  it('非 user 来源消息忽略；阶段失败落明确失败 notice 且 hook 不抛错', async () => {
    const env = makeHookEnv()
    await env.manager.bindTeam('sess-1', 'pipe-team')
    env.fake.script = [{ stopReason: 'error', text: '执行炸了' }]
    const pluginOnly = makePayload('m2', 'x')
    pluginOnly.payload.messages = pluginOnly.payload.messages.map((message) =>
      message.id === 'm2' ? { ...message, source: { kind: 'plugin' as const } } : message,
    )
    await env.hook(pluginOnly.payload, nextOk)
    await flushAsync()
    expect(env.fake.calls).toHaveLength(0)

    env.fake.script = [{ stopReason: 'error', text: '执行炸了' }]
    const failing = makePayload('m3', '做点事')
    await expect(env.hook(failing.payload, nextOk)).resolves.toEqual({ kind: 'enter', messages: [] })
    await flushAsync()
    const failure = env.notices.find((notice) => notice.text.includes('任务委托失败'))
    expect(failure?.text).toContain('execution_failed')
    expect(failure?.text).toContain('prepare')
  })

  it('绑定行残留而团队 YAML 被外部删除 → 「团队不可用」通知而非崩溃', async () => {
    const env = makeHookEnv()
    await env.manager.bindTeam('sess-1', 'pipe-team')
    // 外部直接删 YAML（绕过 deleteTeam 的绑定清理），制造真实的悬空选择。
    rmSync(join(dir, 'pipe-team.yaml'))
    const { payload } = makePayload('m4', '继续干活')
    await env.hook(payload, nextOk)
    expect(env.notices.some((notice) => notice.text.includes('团队不可用'))).toBe(true)
    expect(env.fake.calls).toHaveLength(0)
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
})
