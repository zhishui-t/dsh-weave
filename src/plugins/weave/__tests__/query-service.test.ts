/**
 * t2 —— Web 真实数据查询/操作服务测试。
 *
 * 覆盖：task/list 分页过滤排序、task/get 双入口、task/create 复用 MCP、
 * task/action 六动作状态机路径、knowledge 三端点、audit/list 过滤校验、
 * 会话绑定直读与复用 TeamManager、session/revisions 最近优先、依赖缺失
 * configuration_error 与 endpoint 分发器。
 *
 * 运行：pnpm vitest run src/plugins/weave/__tests__/query-service.test.ts
 */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AuditLog } from '../audit/audit-log.js'
import { WeaveMcp } from '../cli-mcp.js'
import { DagRepository } from '../dag/repository.js'
import { ExecutorRegistry } from '../executor-registry.js'
import { FeedbackRouter } from '../feedback-router.js'
import { KnowledgeStore, type CreateCandidateInput } from '../knowledge-model.js'
import { KnowledgeReviewService } from '../knowledge-review.js'
import { openPersistence, type WeavePersistence } from '../persistence/index.js'
import { SessionTracker } from '../session-tracker.js'
import { TeamManager } from '../team-manager.js'
import { WeaveError } from '../state/weave-error.js'
import { WeaveQueryService } from '../web/query-service.js'
import { MockSubagentsContext } from './fixtures/mock-subagents.js'

const GOOD_TEAM = `schema_version: "1"
team_id: alpha-squad
name: 阿尔法团队
default: true

roles:
  - id: designer
    name: 方案设计师
    bias: design
    executor: codex
    stages: [prepare, design]
    max_concurrent_tasks: 1
    personality: 你是方案设计师。
  - id: coder
    name: 核心开发
    bias: dev
    executor: zcode
    stages: [implement, test, integrate, execute, deploy]
    max_concurrent_tasks: 2
    personality: 你追求代码质量。
  - id: reviewer
    name: 代码审核
    bias: review
    executor: codex
    stages: [review]
    max_concurrent_tasks: 2
    personality: 你是严格的审核员。

task_decomposition:
  matchers:
    - pattern: "重构|核心|关键|安全"
      difficulty: critical
    - pattern: "新增|实现|集成"
      difficulty: medium
    - pattern: "修复|调整"
      difficulty: easy
  default_difficulty: hard
  dag_templates:
    easy: ["execute"]
    medium: ["design", "implement", "test"]
    hard: ["design", "implement", "review", "test", "integrate"]

knowledge_injection:
  max_entries: 5
  max_chars_per_entry: 500
  max_total_chars: 2500
  priority: freshness_first

feedback:
  feedback_timeout_seconds: 1800
  max_revisions: 5
  reopen_window_seconds: 86400
`

interface Env {
  p: WeavePersistence
  mcp: WeaveMcp
  svc: WeaveQueryService
  audit: AuditLog
  tracker: SessionTracker
  store: KnowledgeStore
  teams: TeamManager
  rootDir: string
  close: () => void
}

const envs: Env[] = []

afterAll(() => {
  for (const env of envs) env.close()
})

async function newEnv(): Promise<Env> {
  const rootDir = mkdtempSync(join(tmpdir(), 'weave-query-'))
  writeFileSync(join(rootDir, 'alpha-squad.yaml'), GOOD_TEAM)
  const p = openPersistence({ inMemory: true })
  const registry = new ExecutorRegistry()
  registry.load({ subagents: new MockSubagentsContext() } as never)
  const tracker = new SessionTracker(p.feedback)
  const router = new FeedbackRouter({ tasks: p.tasks, feedback: p.feedback, sessionTracker: tracker })
  const store = new KnowledgeStore({ rootDir: join(rootDir, 'knowledge'), metaDb: p.knowledgeMeta })
  const audit = new AuditLog({ dir: join(rootDir, 'audit') })
  const review = new KnowledgeReviewService({ knowledge: store, audit })
  const teams = new TeamManager(registry, { teamsDir: rootDir, persistence: p })
  const mcp = new WeaveMcp({
    persistence: p,
    teamManager: teams,
    executorRegistry: registry,
    feedbackRouter: router,
    dagRepository: new DagRepository(p),
    knowledgeReview: review,
    knowledgeStore: store,
  })
  const svc = new WeaveQueryService({
    persistence: p,
    mcp,
    auditLog: audit,
    sessionTracker: tracker,
    teamManager: teams,
    knowledgeStore: store,
  })
  const env: Env = {
    p,
    mcp,
    svc,
    audit,
    tracker,
    store,
    teams,
    rootDir,
    close: () => {
      p.close()
      rmSync(rootDir, { recursive: true, force: true })
    },
  }
  envs.push(env)
  return env
}

/* ------------------------------- 种子/断言助手 ------------------------------- */

interface SeedOverrides {
  id?: string
  dag_id?: string
  team_id?: string
  project_id?: string
  description?: string
  status?: string
  updated_at?: string
}

/** 直插一行真实 tasks 行（绕过状态机的测试种子）。 */
async function seedTask(env: Env, overrides: SeedOverrides = {}): Promise<string> {
  const id = overrides.id ?? `seed-${Math.random().toString(36).slice(2, 10)}`
  await env.p.tasks.run((db) => {
    db.prepare(
      "INSERT INTO tasks (id, dag_id, session_id, team_id, project_id, version, description, stage, dependencies, assigned_agent, executor, status, revision_count, max_revisions, feedback_timeout_seconds, feedback_expires_at, skip_override, skip_reason, fail_count, result, error_type, created_at, updated_at) VALUES (?, ?, 'sess', ?, ?, 'v1', ?, '', '[]', NULL, NULL, ?, 0, 5, 1800, NULL, 0, NULL, 0, NULL, NULL, '2023-12-31T00:00:00.000Z', ?)",
    ).run(
      id,
      overrides.dag_id ?? '',
      overrides.team_id ?? 'alpha-squad',
      overrides.project_id ?? 'proj-x',
      overrides.description ?? '普通任务',
      overrides.status ?? 'WAITING',
      overrides.updated_at ?? '2024-01-01T00:00:00.000Z',
    )
  })
  return id
}

async function forceStatus(env: Env, taskId: string, status: string): Promise<void> {
  await env.p.tasks.run((db) => {
    db.prepare("UPDATE tasks SET status = ?, result = COALESCE(result, '上一版输出'), updated_at = ? WHERE id = ?").run(
      status,
      '2024-01-02T00:00:00.000Z',
      taskId,
    )
  })
}

function codeOf(error: unknown): string {
  return error instanceof WeaveError ? error.code : `unexpected:${String(error)}`
}

const errorCodeOf = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn()
    return 'no-error'
  } catch (error) {
    return codeOf(error)
  }
}

const SUBMIT_INPUT = { description: '实现 Web 查询服务', project_id: 'proj-web', version: 'v1' }

/* --------------------------------- 任务域 --------------------------------- */

describe('WeaveQueryService task 域', () => {
  it('task/list：updated_at 降序、total 准确', async () => {
    const env = await newEnv()
    const ids: string[] = []
    for (let i = 0; i < 5; i += 1) {
      ids.push(await seedTask(env, { updated_at: `2024-01-0${i + 1}T00:00:00.000Z` }))
    }
    const out = await env.svc.taskList({})
    expect(out.total).toBe(5)
    expect(out.tasks.map((t) => t.id)).toEqual([...ids].reverse())
  })

  it('task/list：teamId/projectId/status/search 过滤（LIKE 转义）', async () => {
    const env = await newEnv()
    await seedTask(env, { team_id: 'alpha-squad', project_id: 'proj-a', status: 'WAITING', description: '实现登录接口' })
    await seedTask(env, { team_id: 'other-team', project_id: 'proj-a', status: 'RUNNING', description: '实现登出接口' })
    await seedTask(env, { team_id: 'alpha-squad', project_id: 'proj-b', status: 'FAILED', description: '修复进度50%的渲染' })

    expect((await env.svc.taskList({ teamId: 'alpha-squad' })).total).toBe(2)
    expect((await env.svc.taskList({ projectId: 'proj-b' })).tasks.map((t) => t.project_id)).toEqual(['proj-b'])
    expect((await env.svc.taskList({ status: 'RUNNING' })).total).toBe(1)
    expect((await env.svc.taskList({ search: '登录' })).total).toBe(1) // “登出”不含“登录”
    expect((await env.svc.taskList({ search: '接口' })).total).toBe(2)
    // % 已转义为字面量：只命中含“50%”的一行，而不是全部行
    const literalPercent = await env.svc.taskList({ search: '50%' })
    expect(literalPercent.total).toBe(1)
    expect(literalPercent.tasks[0]!.description).toContain('50%')
  })

  it('task/list：page/pageSize 与 limit/offset 分页；混用与非法参报错', async () => {
    const env = await newEnv()
    for (let i = 0; i < 7; i += 1) {
      await seedTask(env, { updated_at: `2024-02-0${i + 1}T00:00:00.000Z` })
    }
    const page2 = await env.svc.taskList({ page: 2, pageSize: 3 })
    expect(page2.total).toBe(7)
    expect(page2.tasks).toHaveLength(3)
    expect(page2.tasks[0]!.updated_at).toBe('2024-02-04T00:00:00.000Z')

    const offsetMode = await env.svc.taskList({ limit: 2, offset: 6 })
    expect(offsetMode.tasks).toHaveLength(1)

    expect(await errorCodeOf(() => env.svc.taskList({ page: 1, limit: 5 }))).toBe('invalid_argument')
    expect(await errorCodeOf(() => env.svc.taskList({ pageSize: 3 }))).toBe('invalid_argument')
    expect(await errorCodeOf(() => env.svc.taskList({ status: 'NOT_A_STATUS' }))).toBe('invalid_argument')
    expect(await errorCodeOf(() => env.svc.taskList({ limit: 0 }))).toBe('invalid_argument')
  })

  it('task/get：dagId/taskId 双入口同结果；早期无 dag_id 行降级单任务视图；缺参与未知 id 报错', async () => {
    const env = await newEnv()
    const submitted = await env.mcp.submitTask(SUBMIT_INPUT)
    const byDag = await env.svc.taskGet({ dagId: submitted.dag_id })
    expect(byDag.dag_id).toBe(submitted.dag_id)
    expect(byDag.tasks.map((t) => t.id)).toEqual(submitted.tasks.map((t) => t.id))
    expect(byDag.edges).toEqual([])

    const byTask = await env.svc.taskGet({ taskId: submitted.tasks[0]!.id })
    expect(byTask).toEqual(byDag)

    const orphan = await seedTask(env, {})
    const orphanView = await env.svc.taskGet({ taskId: orphan })
    expect(orphanView.dag_id).toBe('')
    expect(orphanView.tasks.map((t) => t.id)).toEqual([orphan])

    expect(await errorCodeOf(() => env.svc.taskGet({}))).toBe('invalid_argument')
    expect(await errorCodeOf(() => env.svc.taskGet({ dagId: 'nope' }))).toBe('task_not_found')
    expect(await errorCodeOf(() => env.svc.taskGet({ taskId: 'nope' }))).toBe('task_not_found')
  })

  it('task/create：经 dispatch 复用 submitTask 真实落库', async () => {
    const env = await newEnv()
    const out = (await env.svc.dispatch('task/create', { ...SUBMIT_INPUT, team_id: 'alpha-squad' })) as {
      dag_id: string
      status: string
    }
    expect(out.status).toBe('submitted')
    const rows = await env.p.tasks.run((db) => db.prepare('SELECT id, status FROM tasks WHERE dag_id = ?').all(out.dag_id))
    expect(rows).toHaveLength(1)
  })

  it('task/action：六动作走真实状态机；未知动作与非法转移报错', async () => {
    const env = await newEnv()

    // revise：AWAITING_FEEDBACK → REVISION_RUNNING，revision_count+1
    const rev = (await env.mcp.submitTask(SUBMIT_INPUT)).tasks[0]!.id
    await forceStatus(env, rev, 'AWAITING_FEEDBACK')
    const revised = (await env.svc.taskAction({ action: 'revise', taskId: rev, feedback: '改成暗色主题' })) as {
      status: string
      revision_count: number
    }
    expect(revised.status).toBe('REVISION_RUNNING')
    expect(revised.revision_count).toBe(1)
    expect(await errorCodeOf(() => env.svc.taskAction({ action: 'revise', taskId: rev }))).toBe('invalid_argument')

    // accept：AWAITING_FEEDBACK → CLOSED；reopen：CLOSED → AWAITING_FEEDBACK（窗口内）
    const acc = (await env.mcp.submitTask(SUBMIT_INPUT)).tasks[0]!.id
    await forceStatus(env, acc, 'AWAITING_FEEDBACK')
    expect(((await env.svc.taskAction({ action: 'accept', taskId: acc })) as { status: string }).status).toBe('CLOSED')
    expect(((await env.svc.taskAction({ action: 'reopen', taskId: acc })) as { status: string }).status).toBe('AWAITING_FEEDBACK')

    // retry：FAILED → WAITING
    const ret = (await env.mcp.submitTask(SUBMIT_INPUT)).tasks[0]!.id
    await forceStatus(env, ret, 'FAILED')
    expect(((await env.svc.taskAction({ action: 'retry', taskId: ret })) as { status: string }).status).toBe('WAITING')

    // skip：FAILED → SKIPPED，skip_override=1 落库
    const skp = (await env.mcp.submitTask(SUBMIT_INPUT)).tasks[0]!.id
    await forceStatus(env, skp, 'FAILED')
    expect(((await env.svc.taskAction({ action: 'skip', taskId: skp })) as { status: string }).status).toBe('SKIPPED')
    const skpRow = await env.p.tasks.run((db) => db.prepare('SELECT skip_override FROM tasks WHERE id = ?').get(skp)) as { skip_override: number }
    expect(skpRow.skip_override).toBe(1)

    // cancel：WAITING → CANCELLED（DagRepository 快速取消）
    const cxl = (await env.mcp.submitTask(SUBMIT_INPUT)).tasks[0]!.id
    expect(((await env.svc.taskAction({ action: 'cancel', taskId: cxl })) as { status: string }).status).toBe('CANCELLED')

    // CANCELLED 在 taskRetry 白名单内（#29）：retry 合法回到 WAITING
    const recanceled = (await env.svc.taskAction({ action: 'retry', taskId: cxl })) as { status: string }
    expect(recanceled.status).toBe('WAITING')

    // 未知动作 invalid_argument；WAITING 任务 accept 走前置校验 invalid_status_transition
    expect(await errorCodeOf(() => env.svc.taskAction({ action: 'explode', taskId: cxl }))).toBe('invalid_argument')
    expect(await errorCodeOf(() => env.svc.taskAction({ action: 'accept', taskId: cxl }))).toBe('invalid_status_transition')
  })
})

/* --------------------------------- 知识域 --------------------------------- */

describe('WeaveQueryService knowledge 域', () => {
  async function seedCandidate(env: Env, overrides: Partial<CreateCandidateInput> = {}) {
    return env.store.createCandidate({
      layer: 'project',
      scope: { projectId: 'demo', version: 'v1' },
      filename: `k-${Math.random().toString(36).slice(2, 10)}.md`,
      frontmatter: { title: '项目指南', type: 'doc', visibility: 'project_only', tags: ['指南'] },
      body: '# 正文',
      ...overrides,
    })
  }

  it('knowledge/list：默认 candidate 队列带标题标签；layer 过滤；active 走元数据查询', async () => {
    const env = await newEnv()
    const a = await seedCandidate(env, { frontmatter: { title: 'A 指南', type: 'doc', visibility: 'project_only', tags: ['a'] } })
    await seedCandidate(env, {
      layer: 'role',
      scope: { roleId: 'designer' },
      frontmatter: { title: 'C 规范', type: 'guide', visibility: 'role_only', tags: ['c'] },
    })

    const queue = (await env.svc.knowledgeList({})) as { candidates: Array<{ id: string; title?: string }> }
    expect(queue.candidates.map((c) => c.title)).toEqual(['A 指南', 'C 规范'])

    const roleOnly = (await env.svc.knowledgeList({ layer: 'role' })) as { candidates: Array<{ layer: string }> }
    expect(roleOnly.candidates).toHaveLength(1)
    expect(roleOnly.candidates[0]!.layer).toBe('role')

    // approve 一条后 active 状态可查
    await env.svc.knowledgeApprove({ id: a.id })
    const activeList = (await env.svc.knowledgeList({ status: 'active' })) as { candidates: Array<{ id: string }> }
    expect(activeList.candidates.map((c) => c.id)).toEqual([a.id])
  })

  it('knowledge/list：非法 status/layer/limit 报 invalid_argument', async () => {
    const env = await newEnv()
    expect(await errorCodeOf(() => env.svc.knowledgeList({ status: 'archived' }))).toBe('invalid_argument')
    expect(await errorCodeOf(() => env.svc.knowledgeList({ layer: 'galaxy' }))).toBe('invalid_argument')
    expect(await errorCodeOf(() => env.svc.knowledgeList({ limit: -1 }))).toBe('invalid_argument')
  })

  it('knowledge/approve+reject：真实生命周期；重复审核与未知 id 报错', async () => {
    const env = await newEnv()
    const ok = await seedCandidate(env)
    const bad = await seedCandidate(env)

    const approved = (await env.svc.knowledgeApprove({ knowledgeId: ok.id })) as { status: string }
    expect(approved.status).toBe('active')
    const rejected = (await env.svc.knowledgeReject({ id: bad.id, reason: '内容过时' })) as { status: string }
    expect(rejected.status).toBe('deprecated')

    expect(await errorCodeOf(() => env.svc.knowledgeApprove({ id: ok.id }))).toBe('invalid_knowledge_status')
    expect(await errorCodeOf(() => env.svc.knowledgeReject({ id: 'ghost' }))).toBe('knowledge_not_found')
  })
})

/* --------------------------------- 审计域 --------------------------------- */

describe('WeaveQueryService knowledge/graph', () => {
  it('读取真实 Markdown/frontmatter，解析 [[双链]] 并标记缺失目标', async () => {
    const env = await newEnv()
    const a = await env.store.createCandidate({
      layer: 'project',
      scope: { projectId: 'demo', version: 'v1' },
      filename: 'graph-a.md',
      frontmatter: { title: 'A 指南', type: 'doc', visibility: 'project_only', tags: ['图谱'] },
      body: '参见 [[B 指南]] 和 [[缺失想法]]。',
    })
    const b = await env.store.createCandidate({
      layer: 'project',
      scope: { projectId: 'demo', version: 'v1' },
      filename: 'graph-b.md',
      frontmatter: { title: 'B 指南', type: 'guide', visibility: 'project_only', tags: ['双链'] },
      body: '反向引用 [[A 指南]]。',
    })

    const graph = await env.svc.knowledgeGraph({})
    expect(graph.counts).toMatchObject({ knowledge: 2, missing: 1, edges: 3, unresolved: 1, skipped: 0 })
    expect(graph.nodes.find((node) => node.id === a.id)).toMatchObject({ title: 'A 指南', kind: 'knowledge' })
    expect(graph.nodes.find((node) => node.title === '缺失想法')).toMatchObject({ kind: 'missing' })
    expect(graph.edges).toEqual(expect.arrayContaining([
      { source: a.id, target: b.id },
      { source: a.id, target: `missing:缺失想法` },
      { source: b.id, target: a.id },
    ]))

    const activeOnly = await env.svc.knowledgeGraph({ status: 'active' })
    expect(activeOnly.counts.knowledge).toBe(0)
    expect(await errorCodeOf(() => env.svc.knowledgeGraph({ status: 'archived' }))).toBe('invalid_argument')
  })
})

describe('WeaveQueryService audit 域', () => {
  async function seedAudit(env: Env): Promise<void> {
    await env.audit.record({
      type: 'task.status_changed',
      task_id: 't1',
      from: 'WAITING',
      to: 'RUNNING',
      by: 'tester',
      occurred_at: '2024-03-01T00:00:00.000Z',
    })
    await env.audit.record({
      type: 'knowledge.status_changed',
      knowledge_id: 'k1',
      from: 'candidate',
      to: 'active',
      occurred_at: '2024-03-02T00:00:00.000Z',
    })
    await env.audit.record({
      type: 'ban.created',
      ban_id: 'b1',
      scope: 'executor',
      entity_key: 'codex',
      occurred_at: '2024-03-03T00:00:00.000Z',
    })
  }

  it('audit/list：默认 desc；types/from/to/limit/order 过滤生效', async () => {
    const env = await newEnv()
    await seedAudit(env)

    const all = (await env.svc.auditList({})) as { events: Array<{ type: string; occurred_at: string }> }
    expect(all.events.map((e) => e.type)).toEqual(['ban.created', 'knowledge.status_changed', 'task.status_changed'])

    const asc = (await env.svc.auditList({ order: 'asc' })) as { events: Array<{ type: string }> }
    expect(asc.events.map((e) => e.type)).toEqual(['task.status_changed', 'knowledge.status_changed', 'ban.created'])

    const typed = (await env.svc.auditList({ types: ['ban.created'] })) as { events: Array<{ type: string }> }
    expect(typed.events).toHaveLength(1)

    const windowed = (await env.svc.auditList({ from: '2024-03-02T00:00:00.000Z' })) as { events: unknown[] }
    expect(windowed.events).toHaveLength(2)

    const limited = (await env.svc.auditList({ limit: 1 })) as { events: unknown[] }
    expect(limited.events).toHaveLength(1)
  })

  it('audit/list：未知类型、坏时间、坏 order 报 invalid_argument', async () => {
    const env = await newEnv()
    expect(await errorCodeOf(() => env.svc.auditList({ types: ['not.a.type'] }))).toBe('invalid_argument')
    expect(await errorCodeOf(() => env.svc.auditList({ from: 'yesterday-ish' }))).toBe('invalid_argument')
    expect(await errorCodeOf(() => env.svc.auditList({ order: 'sideways' }))).toBe('invalid_argument')
  })
})

/* --------------------------------- 会话域 --------------------------------- */

describe('WeaveQueryService session 域', () => {
  it('session/set-binding → bindings 直读 core.db；clear-binding 返回真实清除结果', async () => {
    const env = await newEnv()
    expect(((await env.svc.sessionBindings()) as { bindings: unknown[] }).bindings).toEqual([])

    const bound = (await env.svc.dispatch('session/set-binding', { sessionId: 's1', teamId: 'alpha-squad' })) as {
      session_id: string
      team_id: string
    }
    expect(bound).toEqual({ session_id: 's1', team_id: 'alpha-squad' })

    // upsert 重绑
    await env.svc.sessionSetBinding({ sessionId: 's1', teamId: 'alpha-squad' })
    const list = (await env.svc.sessionBindings()) as { bindings: Array<{ session_id: string; team_id: string }> }
    expect(list.bindings).toEqual([{ session_id: 's1', team_id: 'alpha-squad', updated_at: expect.any(String) }])

    // 与 TeamManager.listBindings 同源（读的都是 core.db team_bindings）
    const viaManager = await env.teams.listBindings()
    expect(viaManager).toHaveLength(1)

    // 未知团队 invalid_team
    expect(await errorCodeOf(() => env.svc.sessionSetBinding({ sessionId: 's2', teamId: 'ghost-team' }))).toBe('invalid_team')

    expect(((await env.svc.sessionClearBinding({ sessionId: 's1' })) as { unbound: boolean }).unbound).toBe(true)
    expect(((await env.svc.sessionClearBinding({ sessionId: 's1' })) as { unbound: boolean }).unbound).toBe(false)
  })

  it('session/revisions：最近优先（updated_at desc）；taskId 过滤零或一', async () => {
    const env = await newEnv()
    await env.tracker.recordRevision('task-b', '第二轮意见', null)
    await env.tracker.recordRevision('task-a', '第一轮意见', null)
    // 强制可区分的 updated_at，消除同刻不确定性
    await env.p.feedback.run((db) => {
      db.prepare("UPDATE revision_records SET updated_at = '2024-04-01T00:00:00.000Z' WHERE task_id = 'task-b'").run()
      db.prepare("UPDATE revision_records SET updated_at = '2024-04-02T00:00:00.000Z' WHERE task_id = 'task-a'").run()
    })

    const all = (await env.svc.dispatch('session/revisions', {})) as {
      revisions: Array<{ task_id: string; user_feedback: string[] }>
    }
    expect(all.revisions.map((r) => r.task_id)).toEqual(['task-a', 'task-b'])
    expect(all.revisions[0]!.user_feedback).toEqual(['第一轮意见'])

    const single = (await env.svc.sessionRevisions({ taskId: 'task-b' })) as { revisions: Array<{ task_id: string }> }
    expect(single.revisions.map((r) => r.task_id)).toEqual(['task-b'])

    const none = (await env.svc.sessionRevisions({ taskId: 'nope' })) as { revisions: unknown[] }
    expect(none.revisions).toEqual([])

    expect(await errorCodeOf(() => env.svc.sessionRevisions({ limit: 0 }))).toBe('invalid_argument')
  })
})

/* ------------------------------- 分发器与依赖缺失 ------------------------------- */

describe('WeaveQueryService dispatch 与依赖降级', () => {
  it('dispatch：未知端点与非对象 payload 报 invalid_argument', async () => {
    const env = await newEnv()
    expect(await errorCodeOf(() => env.svc.dispatch('task/nope', {}))).toBe('invalid_argument')
    expect(await errorCodeOf(() => env.svc.dispatch('task/get', [1, 2]))).toBe('invalid_argument')
    expect(await errorCodeOf(() => env.svc.dispatch('task/get', null))).toBe('invalid_argument')
  })

  it('依赖缺失时相应端点 configuration_error 而非伪造空数据', async () => {
    const p = openPersistence({ inMemory: true })
    try {
      const bare = new WeaveQueryService({ persistence: p })
      expect(await errorCodeOf(() => bare.taskCreate(SUBMIT_INPUT))).toBe('configuration_error')
      expect(await errorCodeOf(() => bare.taskAction({ action: 'accept', taskId: 'x' }))).toBe('configuration_error')
      expect(await errorCodeOf(() => bare.knowledgeList({}))).toBe('configuration_error')
      expect(await errorCodeOf(() => bare.auditList({}))).toBe('configuration_error')
      expect(await errorCodeOf(() => bare.sessionRevisions({}))).toBe('configuration_error')
      expect(await errorCodeOf(() => bare.sessionSetBinding({ sessionId: 's', teamId: 't' }))).toBe('configuration_error')
      // 纯持久化读取端点不受影响
      expect(((await bare.sessionBindings()) as { bindings: unknown[] }).bindings).toEqual([])
      const listed = await bare.taskList({})
      expect(listed.total).toBe(0)
    } finally {
      p.close()
    }
  })
})
