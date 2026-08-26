import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { WeavePersistence } from '../persistence/persistence'
import { TeamManager, type ExecutorLookup } from '../team-manager'
import { createWeaveRpcHandler, registerWeaveRpc, WEAVE_RPC_CHANNEL } from '../rpc'

const lookup: ExecutorLookup = {
  get(id) {
    return id === 'zcode' ? { id, name: id, kind: 'acp', capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false } } : undefined
  },
}

const EXECUTOR = { id: 'zcode', name: 'zcode', kind: 'acp', capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false } }

const config = {
  schema_version: '1',
  team_id: 'rpc-team',
  name: 'RPC 团队',
  default: false,
  roles: [{
    id: 'member',
    name: '成员',
    bias: 'dev',
    executor: 'zcode',
    stages: ['prepare', 'implement', 'review'],
    max_concurrent_tasks: 1,
    personality: 'test',
    provider: 'provider-id',
    model: 'deepseek-v4-flash',
    thought_level: 'max',
    mode: 'yolo',
  }],
  task_decomposition: {
    matchers: [],
    default_difficulty: 'hard',
    dag_templates: {
      easy: ['prepare', 'implement', 'review'],
      medium: ['prepare', 'implement', 'review'],
      hard: ['prepare', 'implement', 'review'],
      critical: ['prepare', 'implement', 'review'],
    },
  },
  knowledge_injection: { max_entries: 1, max_chars_per_entry: 100, max_total_chars: 300, priority: 'freshness_first' },
  feedback: { feedback_timeout_seconds: 60, max_revisions: 1, reopen_window_seconds: 60 },
}

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'weave-rpc-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function makeEnv(
  catalog?: Parameters<typeof createWeaveRpcHandler>[1],
  settings: Parameters<typeof createWeaveRpcHandler>[2] = {},
) {
  const persistence = new WeavePersistence({ inMemory: true })
  const teamManager = new TeamManager(lookup, { teamsDir: dir, persistence })
  const call = createWeaveRpcHandler({
    teamManager,
    executorRegistry: { list: () => [EXECUTOR], get: (id: string) => (id === 'zcode' ? EXECUTOR : undefined) },
    persistence,
  } as never, catalog, settings)
  return { call, teamManager, persistence }
}

function handler(catalog?: Parameters<typeof createWeaveRpcHandler>[1]) {
  return makeEnv(catalog).call
}

async function importTeam(call: ReturnType<typeof makeEnv>['call'], teamId = 'rpc-team'): Promise<void> {
  const result = await call('team/import', { overwrite: true, config: { ...config, team_id: teamId } })
  expect(result).toMatchObject({ ok: true, value: { team_id: teamId, roles: 1 } })
}

const MODEL_VALUE = ['p', 'm'].join(String.fromCharCode(92))

describe('Weave Connection RPC：snapshot / import（既有契约）', () => {
  it('snapshot 返回团队、执行器与 overview 计数', async () => {
    const env = makeEnv()
    await importTeam(env.call)
    const result = await env.call('snapshot', {})
    expect(result).toMatchObject({
      ok: true,
      value: {
        executors: [{ id: 'zcode' }],
        overview: { teams: 1, roles: 1, executors: 1, bindings: 0 },
      },
    })
  })

  it('snapshot 透出 ZCode session/new 能力目录', async () => {
    const catalog = async () => ({
      modes: { currentModeId: 'yolo', availableModes: [{ id: 'yolo' }] },
      configOptions: [
        { id: 'model', currentValue: MODEL_VALUE, options: [{ value: MODEL_VALUE, name: 'deepseek › m' }] },
        { id: 'thought', currentValue: 'max', options: [{ value: 'off' }, { value: 'max' }] },
      ],
    })
    const result = await handler(catalog)('snapshot', {}, new AbortController().signal)
    expect(result).toMatchObject({
      ok: true,
      value: {
        zcodeCapabilities: {
          currentModel: MODEL_VALUE,
          models: [{ value: MODEL_VALUE, name: 'deepseek › m' }],
          currentMode: 'yolo',
          thoughtLevels: [{ value: 'off' }, { value: 'max' }],
        },
      },
    })
  })

  it('team/import 接收结构化 config 并持久化', async () => {
    const result = await handler()('team/import', { overwrite: true, config })
    expect(result).toMatchObject({ ok: true, value: { team_id: 'rpc-team', roles: 1 } })
    expect(new TeamManager(lookup, { teamsDir: dir }).loadTeam('rpc-team')).toMatchObject({
      roles: [{ provider: 'provider-id', model: 'deepseek-v4-flash' }],
    })
  })

  it('未知 endpoint 返回闭合错误', async () => {
    const result = await handler()('nope', {})
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
  })

  it('channel 常量使用独立命名空间', () => {
    expect(WEAVE_RPC_CHANNEL).toBe('/dsh-weave')
  })
})

describe('Weave Connection RPC：团队查询与删除', () => {
  it('team/list 返回完整团队与角色信息', async () => {
    const env = makeEnv()
    await importTeam(env.call)
    const result = await env.call('team/list', {})
    expect(result).toMatchObject({
      ok: true,
      value: {
        teams: [{
          team_id: 'rpc-team',
          name: 'RPC 团队',
          default: false,
          roles: [{
            id: 'member',
            name: '成员',
            bias: 'dev',
            executor: 'zcode',
            stages: ['prepare', 'implement', 'review'],
            max_concurrent_tasks: 1,
            personality: 'test',
            provider: 'provider-id',
            model: 'deepseek-v4-flash',
            thought_level: 'max',
            mode: 'yolo',
          }],
        }],
      },
    })
    const teams = (result as { ok: true; value: { teams: Array<Record<string, unknown>> } }).value.teams
    const first = teams[0]!
    expect(first.task_decomposition).toMatchObject({ default_difficulty: 'hard' })
    expect(first.feedback).toMatchObject({ max_revisions: 1 })
  })

  it('team/get 返回团队详情；缺参与未知团队分别报 invalid_argument/invalid_team', async () => {
    const env = makeEnv()
    await importTeam(env.call)
    const found = await env.call('team/get', { teamId: 'rpc-team' })
    expect(found).toMatchObject({ ok: true, value: { team_id: 'rpc-team', roles: [{ id: 'member', executor: 'zcode' }] } })
    await expect(env.call('team/get', {})).resolves.toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    await expect(env.call('team/get', { teamId: 'ghost' })).resolves.toMatchObject({ ok: false, error: { code: 'invalid_team' } })
  })

  it('team/delete 删除 YAML；重复删除 invalid_team；路径穿越拒绝', async () => {
    const env = makeEnv()
    await importTeam(env.call, 'del-team')
    const file = join(dir, 'del-team.yaml')
    expect(existsSync(file)).toBe(true)
    await expect(env.call('team/delete', { teamId: 'del-team' })).resolves.toMatchObject({
      ok: true,
      value: { deleted: true, team_id: 'del-team' },
    })
    expect(existsSync(file)).toBe(false)
    await expect(env.call('team/delete', { teamId: 'del-team' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_team' },
    })
    for (const evil of ['../evil', '..' + String.fromCharCode(92) + 'evil', '.hidden']) {
      await expect(env.call('team/delete', { teamId: evil })).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_argument' },
      })
    }
    expect(existsSync(join(dir, 'evil.yaml'))).toBe(false)
  })
})

describe('Weave Connection RPC：会话绑定（core.db.team_bindings）', () => {
  it('team/bind 校验团队后写入 core.db，并计入 overview.bindings', async () => {
    const env = makeEnv()
    await importTeam(env.call)
    await expect(env.call('team/bind', { sessionId: 's1', teamId: 'rpc-team' })).resolves.toMatchObject({
      ok: true,
      value: { session_id: 's1', team_id: 'rpc-team' },
    })
    expect(await env.teamManager.getBoundTeam('s1')).toBe('rpc-team')
    expect(env.persistence.core.tables()).toContain('team_bindings')
    await expect(env.call('snapshot', {})).resolves.toMatchObject({
      ok: true,
      value: { overview: { bindings: 1 } },
    })
  })

  it('team/bind 绑定不存在的团队 → invalid_team 且不落绑定', async () => {
    const env = makeEnv()
    await expect(env.call('team/bind', { sessionId: 's1', teamId: 'ghost' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_team' },
    })
    expect(await env.teamManager.getBoundTeam('s1')).toBeNull()
  })

  it('team/bindings 列出全部绑定；team/unbind 解绑并返回是否存在', async () => {
    const env = makeEnv()
    await importTeam(env.call)
    await env.call('team/bind', { sessionId: 's2', teamId: 'rpc-team' })
    await env.call('team/bind', { sessionId: 's1', teamId: 'rpc-team' })
    await expect(env.call('team/bindings', {})).resolves.toMatchObject({
      ok: true,
      value: {
        bindings: [
          { session_id: 's1', team_id: 'rpc-team' },
          { session_id: 's2', team_id: 'rpc-team' },
        ],
      },
    })
    await expect(env.call('team/unbind', { sessionId: 's2' })).resolves.toMatchObject({
      ok: true,
      value: { session_id: 's2', unbound: true },
    })
    await expect(env.call('team/unbind', { sessionId: 's2' })).resolves.toMatchObject({
      ok: true,
      value: { session_id: 's2', unbound: false },
    })
    await expect(env.call('team/bindings', {})).resolves.toMatchObject({
      ok: true,
      value: { bindings: [{ session_id: 's1', team_id: 'rpc-team' }] },
    })
  })
})

describe('Weave Connection RPC：settings/describe 与协议约定', () => {
  it('settings/describe 返回版本/目录/ZCode 发现状态', async () => {
    const env = makeEnv(undefined, { version: '9.9.9-test', auditDir: '/audit-custom' })
    await expect(env.call('settings/describe', {})).resolves.toMatchObject({
      ok: true,
      value: {
        version: '9.9.9-test',
        node_version: process.version,
        state_dir: expect.any(String),
        teams_dir: dir,
        audit_dir: '/audit-custom',
        zcode: { configured: false, registered: true },
      },
    })
  })

  it('settings/describe.zcode.configured 随能力目录装配翻转', async () => {
    const env = makeEnv(async () => undefined)
    await expect(env.call('settings/describe', {})).resolves.toMatchObject({
      ok: true,
      value: { zcode: { configured: true, registered: true } },
    })
  })

  it('payload 非对象 → invalid_argument（数组/字符串均拒绝）', async () => {
    const call = handler()
    await expect(call('team/get', ['nope'])).resolves.toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    await expect(call('team/get', 'boom' as unknown as Record<string, never>)).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_argument' },
    })
  })

  it('registerWeaveRpc 以 trusted-host 权限把 channel 注册到 connection', () => {
    const recorded: Array<{ channel: string; options: unknown }> = []
    const fakeScoped = {
      connection: {
        rpc: {
          handle(channel: string, _handler: unknown, options: unknown) {
            recorded.push({ channel, options })
            return () => undefined
          },
        },
      },
    }
    const fakeCtx = {
      inject(_services: string[], cb: (scoped: unknown) => unknown) {
        cb(fakeScoped)
      },
    }
    const registered = registerWeaveRpc(fakeCtx as never, {} as never, undefined, { version: 'test' })
    expect(registered).toBe(true)
    expect(recorded[0]?.channel).toBe('/dsh-weave')
    expect(recorded[0]?.options).toEqual({ authority: 'trusted-host' })
  })

  it('无 inject 能力的宿主自动降级（返回 false，仅 MCP/CLI）', () => {
    expect(registerWeaveRpc({} as never, {} as never)).toBe(false)
  })
})
