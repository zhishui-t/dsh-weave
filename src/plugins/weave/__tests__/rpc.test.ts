import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { WeavePersistence } from '../persistence/persistence'
import { TeamManager, type ExecutorLookup } from '../team-manager'
import { createWeaveRpcHandler, registerWeaveRpc, WEAVE_RPC_CHANNEL } from '../rpc'
import { AuditLog } from '../audit/audit-log'
import { WeaveMcp } from '../cli-mcp'
import { DagRepository } from '../dag/repository'
import { FeedbackRouter } from '../feedback-router'
import { KnowledgeStore } from '../knowledge-model'
import { KnowledgeReviewService } from '../knowledge-review'
import { SessionTracker } from '../session-tracker'
import { WeaveQueryService } from '../web/query-service'

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

  it('webServer 未注入时 getter 抛错也不炸接线：经 inject(["webServer"]) 延迟注册 HTTP fallback（回归）', () => {
    // 还原 cordis 真实行为：未 inject 的服务属性由 getter 抛错（dsh-web-restart.log.err 实证，
    // 曾连坐导致 pre-step 钩子/weave_* 工具全部未注册）。
    const injectCalls: string[][] = []
    const routes: Array<{ kind: string; path: string; handler: unknown }> = []
    const fakeCtx = {
      get webServer(): unknown {
        throw new Error('cannot get property "webServer" without inject')
      },
      inject(services: string[], cb: (scoped: unknown) => unknown) {
        injectCalls.push(services)
        if (services.includes('webServer')) {
          cb({
            webServer: {
              register: (config: { kind: string; path: string; handler: unknown }) => {
                routes.push(config)
              },
            },
          })
        } else {
          cb({ connection: { rpc: { handle: () => () => undefined } } })
        }
      },
    }
    expect(() => registerWeaveRpc(fakeCtx as never, {} as never)).not.toThrow()
    expect(injectCalls).toContainEqual(['webServer'])
    expect(routes[0]).toMatchObject({ kind: 'prefix', path: WEAVE_RPC_CHANNEL })
  })

  it('HTTP fallback 路由可处理 POST 请求并返回 RpcResult 信封', async () => {
    const routes: Array<{ kind: string; path: string; handler: (req: unknown, res: unknown) => Promise<void> }> = []
    const fakeCtx = {
      inject(services: string[], cb: (scoped: unknown) => unknown) {
        if (services.includes('webServer')) {
          cb({
            webServer: {
              register: (config: { kind: string; path: string; handler: (req: unknown, res: unknown) => Promise<void> }) => {
                routes.push(config)
              },
            },
          })
        } else {
          cb({ connection: { rpc: { handle: () => () => undefined } } })
        }
      },
    }
    registerWeaveRpc(fakeCtx as never, {} as never, undefined, { version: 'test' })
    const route = routes[0]
    expect(route).toBeDefined()

    const listeners: Record<string, Array<(chunk?: unknown) => void>> = {}
    const req = {
      url: `${WEAVE_RPC_CHANNEL}/no-such-endpoint`,
      on(event: string, cb: (chunk?: unknown) => void) {
        ;(listeners[event] ??= []).push(cb)
        return req
      },
    }
    const res = {
      statusCode: 0,
      headers: {} as Record<string, string>,
      body: '',
      writeHead(code: number, headers: Record<string, string>) {
        this.statusCode = code
        this.headers = headers
      },
      end(body: string) {
        this.body = body
      },
    }
    const pending = Promise.resolve(route!.handler(req, res))
    listeners['data']?.[0]?.('{}')
    listeners['end']?.[0]?.()
    await pending
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
  })
})

describe('Weave Connection RPC：任务/知识/审计/会话四域（t4）', () => {
  interface QuadEnv {
    call: ReturnType<typeof makeEnv>['call']
    persistence: WeavePersistence
    teamManager: TeamManager
    auditLog: AuditLog
    tracker: SessionTracker
  }
  const quadRoots: string[] = []
  afterEach(() => {
    for (const root of quadRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function makeQuadEnv(withQueryService = true): QuadEnv {
    const rootDir = mkdtempSync(join(tmpdir(), 'weave-rpc-quad-'))
    quadRoots.push(rootDir)
    const persistence = new WeavePersistence({ inMemory: true })
    const teamManager = new TeamManager(lookup, { teamsDir: dir, persistence })
    const auditLog = new AuditLog({ dir: join(rootDir, 'audit') })
    const tracker = new SessionTracker(persistence.feedback)
    const router = new FeedbackRouter({ tasks: persistence.tasks, feedback: persistence.feedback, sessionTracker: tracker })
    const kstore = new KnowledgeStore({ rootDir: join(rootDir, 'knowledge'), metaDb: persistence.knowledgeMeta })
    const kreview = new KnowledgeReviewService({ knowledge: kstore, audit: auditLog })
    const registryStub = { list: () => [EXECUTOR], get: (id: string) => (id === 'zcode' ? EXECUTOR : undefined) }
    const mcp = new WeaveMcp({
      persistence,
      teamManager,
      executorRegistry: registryStub as never,
      feedbackRouter: router,
      dagRepository: new DagRepository(persistence),
      knowledgeReview: kreview,
      knowledgeStore: kstore,
    })
    const queryService = new WeaveQueryService({ persistence, mcp, auditLog, sessionTracker: tracker, teamManager })
    const call = createWeaveRpcHandler({
      teamManager,
      executorRegistry: registryStub,
      persistence,
      ...(withQueryService ? { queryService } : {}),
    } as never)
    return { call, persistence, teamManager, auditLog, tracker }
  }

  async function seedTask(env: QuadEnv, updatedAt: string): Promise<string> {
    const id = `seed-${Math.random().toString(36).slice(2, 10)}`
    await env.persistence.tasks.run((db) => {
      db.prepare(
        "INSERT INTO tasks (id, dag_id, session_id, team_id, project_id, version, description, stage, dependencies, status, created_at, updated_at) VALUES (?, '', 's', 'rpc-team', 'proj', 'v1', '种子任务', '', '[]', 'WAITING', '2024-01-01T00:00:00.000Z', ?)",
      ).run(id, updatedAt)
    })
    return id
  }

  const errCodeOf = async (call: QuadEnv['call'], endpoint: string, payload: unknown): Promise<string> => {
    const result = (await call(endpoint, payload)) as { ok: boolean; error?: { code: string } }
    return result.ok === false ? result.error!.code : 'unexpected-ok'
  }

  it('task/list：信封返回 total 与 updated_at 降序；分页生效', async () => {
    const env = makeQuadEnv()
    await seedTask(env, '2024-01-01T00:00:00.000Z')
    await seedTask(env, '2024-01-02T00:00:00.000Z')
    const all = (await env.call('task/list', {})) as { ok: true; value: { total: number; tasks: Array<{ updated_at: string }> } }
    expect(all.value.total).toBe(2)
    expect(all.value.tasks[0]!.updated_at).toBe('2024-01-02T00:00:00.000Z')
    const page = (await env.call('task/list', { page: 2, pageSize: 1 })) as { ok: true; value: { total: number; tasks: unknown[] } }
    expect(page.value.total).toBe(2)
    expect(page.value.tasks).toHaveLength(1)
  })

  it('task/create 通道已删除；task/get 未知 id 报业务码', async () => {
    const env = makeQuadEnv()
    await importTeam(env.call, 'rpc-team')
    // 队长模式下发唯一入口为 weave_plan_tasks 工具，RPC 层不再提供 task/create
    expect(await errCodeOf(env.call, 'task/create', { description: 'x' })).toBe('invalid_argument')
    expect(await errCodeOf(env.call, 'task/get', { dagId: 'nope-dag' })).toBe('task_not_found')
    expect(await errCodeOf(env.call, 'task/get', { taskId: 'nope' })).toBe('task_not_found')
  })

  it('task/action：未知动作 invalid_argument；CANCELLED retry 经信封回 WAITING', async () => {
    const env = makeQuadEnv()
    await importTeam(env.call, 'rpc-team')
    // 种子一条单任务 DAG（下发不在 RPC 层）
    const now = new Date().toISOString()
    const dagId = 'dag-proj-a-v1-seed'
    const taskId = `${dagId}-t1`
    await env.persistence.tasks.run((db) => {
      db.prepare(
        `INSERT INTO dags (dag_id, team_id, project_id, version, difficulty, status, created_at, updated_at)
         VALUES (?, 'rpc-team', 'proj-a', 'v1', 'captain', 'created', ?, ?)`,
      ).run(dagId, now, now)
      db.prepare(
        `INSERT INTO tasks (id, dag_id, session_id, team_id, project_id, version, description, stage,
         dependencies, assigned_agent, executor, status, revision_count, max_revisions,
         feedback_timeout_seconds, feedback_expires_at, skip_override, skip_reason, fail_count,
         result, error_type, created_at, updated_at)
         VALUES (?, ?, 'sess-rpc', 'rpc-team', 'proj-a', 'v1', '动作联调', '', '[]', 'coder', 'zcode', 'WAITING',
         0, 5, 1800, NULL, 0, NULL, 0, NULL, NULL, ?, ?)`,
      ).run(taskId, dagId, now, now)
    })
    expect(await errCodeOf(env.call, 'task/action', { action: 'explode', taskId })).toBe('invalid_argument')
    await env.persistence.tasks.run((db) => {
      db.prepare("UPDATE tasks SET status = 'CANCELLED', updated_at = '2024-01-03T00:00:00.000Z' WHERE id = ?").run(taskId)
    })
    const retried = (await env.call('task/action', { action: 'retry', taskId })) as { ok: true; value: { status: string } }
    expect(retried.value.status).toBe('WAITING')
  })

  it('knowledge/list 空队列；approve/reject 未知 id knowledge_not_found', async () => {
    const env = makeQuadEnv()
    const empty = (await env.call('knowledge/list', {})) as { ok: true; value: { candidates: unknown[] } }
    expect(empty.value.candidates).toEqual([])
    expect(await errCodeOf(env.call, 'knowledge/approve', { id: 'ghost' })).toBe('knowledge_not_found')
    expect(await errCodeOf(env.call, 'knowledge/reject', { id: 'ghost' })).toBe('knowledge_not_found')
  })

  it('audit/list：真实事件过信封；坏类型与坏时间 invalid_argument', async () => {
    const env = makeQuadEnv()
    await env.auditLog.record({
      type: 'task.status_changed',
      task_id: 't1',
      from: 'WAITING',
      to: 'RUNNING',
      by: 'tester',
      occurred_at: '2024-05-01T00:00:00.000Z',
    })
    const listed = (await env.call('audit/list', {})) as { ok: true; value: { events: Array<{ type: string }> } }
    expect(listed.value.events.map((e) => e.type)).toEqual(['task.status_changed'])
    expect(await errCodeOf(env.call, 'audit/list', { types: ['not.a.type'] })).toBe('invalid_argument')
    expect(await errCodeOf(env.call, 'audit/list', { from: 'yesterday-ish' })).toBe('invalid_argument')
  })

  it('session/bindings → set-binding → clear-binding 全链路；ghost 团队 invalid_team', async () => {
    const env = makeQuadEnv()
    await importTeam(env.call, 'rpc-team')
    const empty = (await env.call('session/bindings', {})) as { ok: true; value: { bindings: unknown[] } }
    expect(empty.value.bindings).toEqual([])
    const bound = (await env.call('session/set-binding', { sessionId: 's9', teamId: 'rpc-team' })) as { ok: true; value: { session_id: string } }
    expect(bound.value.session_id).toBe('s9')
    const listed = (await env.call('session/bindings', {})) as { ok: true; value: { bindings: Array<{ team_id: string }> } }
    expect(listed.value.bindings.map((b) => b.team_id)).toEqual(['rpc-team'])
    expect(await errCodeOf(env.call, 'session/set-binding', { sessionId: 'sx', teamId: 'ghost-team' })).toBe('invalid_team')
    const cleared = (await env.call('session/clear-binding', { sessionId: 's9' })) as { ok: true; value: { unbound: boolean } }
    expect(cleared.value.unbound).toBe(true)
  })

  it('session/revisions：修订记录经信封返回；limit≤0 invalid_argument', async () => {
    const env = makeQuadEnv()
    await env.tracker.recordRevision('task-x', '第一轮意见', null)
    const revs = (await env.call('session/revisions', {})) as { ok: true; value: { revisions: Array<{ task_id: string }> } }
    expect(revs.value.revisions.map((r) => r.task_id)).toEqual(['task-x'])
    expect(await errCodeOf(env.call, 'session/revisions', { limit: 0 })).toBe('invalid_argument')
  })

  it('未注入 queryService：四域端点 configuration_error 而非伪造数据', async () => {
    const env = makeQuadEnv(false)
    expect(await errCodeOf(env.call, 'task/list', {})).toBe('configuration_error')
    expect(await errCodeOf(env.call, 'knowledge/list', {})).toBe('configuration_error')
    expect(await errCodeOf(env.call, 'audit/list', {})).toBe('configuration_error')
    expect(await errCodeOf(env.call, 'session/set-binding', { sessionId: 's', teamId: 't' })).toBe('configuration_error')
  })

  it('payload 非对象与未知端点均 invalid_argument', async () => {
    const env = makeQuadEnv()
    expect(await errCodeOf(env.call, 'task/get', null)).toBe('invalid_argument')
    expect(await errCodeOf(env.call, 'task/nope', {})).toBe('invalid_argument')
  })
})
