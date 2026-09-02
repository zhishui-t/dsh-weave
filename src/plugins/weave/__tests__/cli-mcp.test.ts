import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AuditLog } from '../audit/audit-log'
import { WeaveCli } from '../host/cli-mcp'
import { WeaveMcp } from '../host/cli-mcp'
import { CircuitBreaker } from '../safety/circuit-breaker'
import { DagRepository } from '../dag/repository'
import { ExecutorRegistry } from '../executors/executor-registry'
import { FeedbackRouter } from '../scheduling/feedback-router'
import { KnowledgeReviewService } from '../knowledge/knowledge-review'
import { KnowledgeStore } from '../knowledge/knowledge-model'
import { openPersistence, type WeavePersistence } from '../persistence/index'
import { SessionTracker } from '../scheduling/session-tracker'
import { TaskStatusNotifier } from '../scheduling/task-status-notifier'
import type { GraphService } from '../graph/graph-service'
import { MockSubagentsContext } from './fixtures/mock-subagents'

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
  mcp: WeaveMcp
  cli: WeaveCli
  p: WeavePersistence
  ctx: MockSubagentsContext
  rootDir: string
  router: FeedbackRouter
  breaker: CircuitBreaker
  kstore: KnowledgeStore
  close: () => void
}

const envs: Env[] = []

afterAll(() => {
  for (const env of envs) env.close()
})

async function newEnv(registry?: ExecutorRegistry, statusNotifier?: TaskStatusNotifier, audit?: AuditLog): Promise<Env> {
  const rootDir = mkdtempSync(join(tmpdir(), 'weave-cli-'))
  writeFileSync(join(rootDir, 'alpha-squad.yaml'), GOOD_TEAM)
  const p = openPersistence({ inMemory: true })
  const ctx = new MockSubagentsContext()
  const executorRegistry = registry ?? new ExecutorRegistry()
  const registry2 = executorRegistry
  if (!registry) {
    registry2.load({ subagents: ctx } as never)
  }
  const tracker = new SessionTracker(p.feedback)
  const router = new FeedbackRouter({
    tasks: p.tasks,
    feedback: p.feedback,
    sessionTracker: tracker,
  })
  const kstore = new KnowledgeStore({ rootDir: join(rootDir, 'knowledge'), metaDb: p.knowledgeMeta })
  const kreview = new KnowledgeReviewService({ knowledge: kstore, audit: new AuditLog({ dir: join(rootDir, 'audit') }) })
  const breaker = new CircuitBreaker()
  const mcp = new WeaveMcp({
    persistence: p,
    statusNotifier,
    audit,
    teamManager: new (await import('../team/team-manager')).TeamManager(registry2, { teamsDir: rootDir, persistence: p }),
    executorRegistry: registry2,
    feedbackRouter: router,
    dagRepository: new DagRepository(p),
    knowledgeReview: kreview,
    knowledgeStore: kstore,
    circuitBreaker: breaker,
  })
  const env: Env = {
    mcp,
    cli: new WeaveCli(mcp),
    p,
    ctx,
    rootDir,
    router,
    breaker,
    kstore,
    close: () => {
      p.close()
      rmSync(rootDir, { recursive: true, force: true })
    },
  }
  envs.push(env)
  return env
}

/**
 * 队长模式下发已收敛到 weave_plan_tasks（planner.test 覆盖）；本文件只测 MCP 治理命令，
 * 用 seedTask 直接落一条单任务 DAG 作为夹具（等价旧 submitTask 的产物形状）。
 */
const seedCounters = new WeakMap<object, { n: number }>()
async function seedTask(
  p: WeavePersistence,
  overrides: { description?: string; project_id?: string; version?: string } = {},
): Promise<{ dag_id: string; tasks: Array<{ id: string }> }> {
  const projectId = overrides.project_id ?? 'proj-cli'
  const counter = seedCounters.get(p.tasks as object) ?? { n: 0 }
  const n = (counter.n += 1)
  seedCounters.set(p.tasks as object, counter)
  const version = overrides.version ?? 'v1'
  const dagId = `dag-${projectId}-${version}-${n}`
  const taskId = `${dagId}-t1`
  const now = new Date().toISOString()
  await p.tasks.run((db) => {
    db.prepare(
      `INSERT INTO dags (dag_id, team_id, project_id, version, difficulty, status, created_at, updated_at)
       VALUES (?, 'alpha-squad', ?, ?, 'hard', 'created', ?, ?)`,
    ).run(dagId, projectId, version, now, now)
    db.prepare(
      `INSERT INTO tasks (id, dag_id, session_id, team_id, project_id, version, description, stage,
       dependencies, assigned_agent, executor, status, revision_count, max_revisions,
       feedback_timeout_seconds, feedback_expires_at, skip_override, skip_reason, fail_count,
       result, error_type, created_at, updated_at)
       VALUES (?, ?, 'cli-session', 'alpha-squad', ?, ?, ?, '', '[]', 'coder', 'zcode', 'WAITING',
       0, 5, 1800, NULL, 0, NULL, 0, NULL, NULL, ?, ?)`,
    ).run(taskId, dagId, projectId, version, overrides.description ?? '实现 CLI', now, now)
  })
  return { dag_id: dagId, tasks: [{ id: taskId }] }
}

describe('WeaveMcp（MCP Tool 层，治理面）', () => {
  it('getStatus：按 dag_id / task_id；缺参数 invalid_argument；未找到 task_not_found', async () => {
    const { mcp, p } = await newEnv()
    const { dag_id, tasks } = await seedTask(p)
    const byDag = await mcp.getStatus({ dag_id })
    expect(byDag.tasks).toHaveLength(1)
    const byTask = await mcp.getStatus({ task_id: tasks[0]!.id })
    expect(byTask.dag_id).toBe(dag_id)
    await expect(mcp.getStatus({})).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(mcp.getStatus({ dag_id: 'dag-nope' })).rejects.toMatchObject({ code: 'task_not_found' })
    await expect(mcp.getStatus({ task_id: 't-nope' })).rejects.toMatchObject({ code: 'task_not_found' })
  })

  it('reviseTask / acceptTask：保温期流转与非法状态拒绝（复用 FeedbackRouter）', async () => {
    const { mcp, p } = await newEnv()
    const { tasks } = await seedTask(p)
    const id = tasks[0]!.id
    await p.tasks.run((db) => db.prepare("UPDATE tasks SET status = 'COMPLETED' WHERE id = ?").run(id))
    // 非保温态：revise/accept 均 invalid_status_transition
    await expect(mcp.reviseTask({ task_id: id, feedback: '改成 X' })).rejects.toMatchObject({ code: 'invalid_status_transition' })
    await expect(mcp.acceptTask({ task_id: id })).rejects.toMatchObject({ code: 'invalid_status_transition' })
    await expect(mcp.reviseTask({ task_id: id, feedback: '  ' })).rejects.toMatchObject({ code: 'invalid_argument' })
    // 进入保温期
    const router = new FeedbackRouter({
      tasks: p.tasks,
      feedback: p.feedback,
      sessionTracker: new SessionTracker(p.feedback),
    })
    await router.enterAwaitingFeedback(id)
    const revised = await mcp.reviseTask({ task_id: id, feedback: '改成手机号验证码' })
    expect(revised.status).toBe('REVISION_RUNNING')
    expect(revised.revision_count).toBe(1)
    await p.tasks.run((db) => db.prepare("UPDATE tasks SET status = 'COMPLETED' WHERE id = ?").run(id))
    await router.enterAwaitingFeedback(id)
    const accepted = await mcp.acceptTask({ task_id: id })
    expect(accepted.status).toBe('CLOSED')
  })

  it('下发通道不存在：MCP 层已无任务创建入口（队长模式唯一入口为 weave_plan_tasks 工具）', async () => {
    const { mcp } = await newEnv()
    expect((mcp as unknown as Record<string, unknown>).submitTask).toBeUndefined()
  })

  it('executionHooks.cancelTask / resumeTask：taskCancel 与 taskRetry 触发联动', async () => {
    const { p } = await newEnv()
    const cancelled: string[] = []
    const resumed: string[] = []
    // WeaveMcp 在动作时读取 deps.executionHooks —— 通过构建同款实例注入 spy。
    const hookMcp = new WeaveMcp({
      persistence: p,
      teamManager: new (await import('../team/team-manager')).TeamManager(new ExecutorRegistry(), { teamsDir: '/nonexistent', persistence: p }),
      executorRegistry: new ExecutorRegistry(),
      feedbackRouter: new FeedbackRouter({ tasks: p.tasks, feedback: p.feedback, sessionTracker: new SessionTracker(p.feedback) }),
      dagRepository: new DagRepository(p),
      executionHooks: {
        cancelTask: async (taskId) => { cancelled.push(taskId) },
        resumeTask: async (taskId) => { resumed.push(taskId) },
      },
    })
    const a = await seedTask(p, { project_id: 'hookp', version: 'v1' })
    await hookMcp.taskCancel(a.tasks[0]!.id)
    expect(cancelled).toEqual([a.tasks[0]!.id])

    const b = await seedTask(p, { project_id: 'hookp', version: 'v2' })
    await p.tasks.run((db) => db.prepare("UPDATE tasks SET status = 'FAILED' WHERE id = ?").run(b.tasks[0]!.id))
    const retried = await hookMcp.taskRetry(b.tasks[0]!.id)
    expect(retried.status).toBe('WAITING')
    expect(resumed).toEqual([b.tasks[0]!.id])
  })
})

describe('WeaveMcp：团队与执行器', () => {
  it('teamList：结构正确（team_id/name/default/roles）', async () => {
    const { mcp } = await newEnv()
    const { teams } = await mcp.teamList()
    expect(teams).toHaveLength(1)
    expect(teams[0]).toMatchObject({ team_id: 'alpha-squad', name: '阿尔法团队', default: true })
    expect(teams[0]!.roles).toEqual(['designer', 'coder', 'reviewer'])
  })

  it('teamSwitch：绑定持久化到 team_bindings；不存在团队 invalid_team', async () => {
    const { mcp, p } = await newEnv()
    const out = await mcp.teamSwitch({ team_id: 'alpha-squad', session_id: 'sess-cli' })
    expect(out).toEqual({ session_id: 'sess-cli', team_id: 'alpha-squad' })
    const row = await p.core.run((db) => db.prepare('SELECT team_id FROM team_bindings WHERE session_id = ?').get('sess-cli')) as { team_id: string } | undefined
    expect(row?.team_id).toBe('alpha-squad')
    await expect(mcp.teamSwitch({ team_id: 'ghost', session_id: 's' })).rejects.toMatchObject({ code: 'invalid_team' })
  })

  it('executorList：四类执行器分类输出（spawn/fork/codex/claude-code/zcode）', async () => {
    const { mcp } = await newEnv()
    const { executors } = await mcp.executorList()
    const byId = new Map(executors.map((e) => [e.id, e.kind]))
    expect(byId.get('spawn')).toBe('dsh_subagent')
    expect(byId.get('fork')).toBe('dsh_subagent')
    expect(byId.get('codex')).toBe('codex')
    expect(byId.get('claude-code')).toBe('claude_code')
    expect(byId.get('zcode')).toBe('acp')
  })
})

describe('WeaveCli（/weave 命令）', () => {
  it('team list：人类可读 + --json 结构化', async () => {
    const { cli } = await newEnv()
    const text = await cli.run(['team', 'list'])
    expect(text.exitCode).toBe(0)
    expect(text.text).toContain('alpha-squad')
    expect(text.text).toContain('coder')
    const parsed = JSON.parse(text.json) as { ok: boolean; data: { teams: unknown[] } }
    expect(parsed.ok).toBe(true)
    expect(parsed.data.teams).toHaveLength(1)
  })

  it('executor list：输出执行器与分类', async () => {
    const { cli } = await newEnv()
    const result = await cli.run(['executor', 'list'])
    expect(result.text).toContain('zcode（acp）')
    expect(result.text).toContain('codex（codex）')
    expect(result.text).toContain('claude-code（claude_code）')
  })

  it('task status：DAG 状态展示；task submit 已移除（下发只走对话）', async () => {
    const { cli, p } = await newEnv()
    await seedTask(p, { description: '修复登录超时', project_id: 'proj-x', version: 'v2' })
    const status = await cli.run(['task', 'status', '--dag', 'dag-proj-x-v2-1'])
    expect(status.text).toContain('[WAITING]')
    expect(status.text).toContain('修复登录超时')

    // 命令式提交通道已删除：未知命令报错，帮助文本不再出现 submit
    const submitted = await cli.run(['task', 'submit', '修复登录超时'])
    expect(submitted.exitCode).toBe(1)
    expect(submitted.text).toContain('invalid_argument')
    const help = await cli.run([])
    expect(help.text).not.toContain('task submit')
  })

  it('task revise/accept：保温期命令文本输出', async () => {
    const { cli, p } = await newEnv()
    const seeded = await seedTask(p, { description: '任务', project_id: 'proj-r', version: 'v1' })
    const taskId = seeded.tasks[0]!.id
    await p.tasks.run((db) => db.prepare("UPDATE tasks SET status = 'COMPLETED' WHERE id = ?").run(taskId))
    const router = new (await import('../scheduling/feedback-router')).FeedbackRouter({
      tasks: p.tasks,
      feedback: p.feedback,
      sessionTracker: new SessionTracker(p.feedback),
    })
    await router.enterAwaitingFeedback(taskId)
    const revised = await cli.run(['task', 'revise', taskId, '改成邮箱验证'])
    expect(revised.text).toContain('REVISION_RUNNING')
    expect(revised.exitCode).toBe(0)
    await p.tasks.run((db) => db.prepare("UPDATE tasks SET status = 'COMPLETED' WHERE id = ?").run(taskId))
    await router.enterAwaitingFeedback(taskId)
    const accepted = await cli.run(['task', 'accept', taskId])
    expect(accepted.text).toContain('CLOSED')
  })

  it('错误可读：error: {code}: {message}；--json 输出 {ok:false,error}', async () => {
    const { cli } = await newEnv()
    const bad = await cli.run(['team', 'switch', 'ghost'])
    expect(bad.exitCode).toBe(1)
    expect(bad.text).toContain('error: invalid_team:')
    const parsed = JSON.parse(bad.json) as { ok: boolean; error: { code: string } }
    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe('invalid_team')
    const unknown = await cli.run(['bogus', 'x'])
    expect(unknown.text).toContain('error: invalid_argument:')
  })

  it('help 与未知域', async () => {
    const { cli } = await newEnv()
    const help = await cli.run([])
    expect(help.exitCode).toBe(0)
    expect(help.text).toContain('用法: /weave')
    const dag = await cli.run(['dag', 'dag-nope'])
    expect(dag.exitCode).toBe(1)
    expect(dag.text).toContain('error: task_not_found:')
  })
})

describe('WeaveMcp 补充：知识审核 / 任务运维 / 禁令列表（t36）', () => {
  async function makeCandidate(env: Env, id: string): Promise<string> {
    const meta = await env.kstore.createCandidate({
      layer: 'shared',
      scope: {},
      filename: `${id}.md`,
      frontmatter: { title: `知识-${id}`, type: 'pitfall', visibility: 'global', tags: ['t36'] },
      body: `正文 ${id}`,
    })
    return meta.id
  }

  it('knowledgeReview：空队列 []；candidate 队列含标题字段；limit 生效', async () => {
    const env = await newEnv()
    expect(await env.mcp.knowledgeReview()).toEqual({ candidates: [] })
    const candId = await makeCandidate(env, 'k1')
    const { candidates } = await env.mcp.knowledgeReview()
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ id: candId, status: 'candidate', title: '知识-k1' })
    const limited = await env.mcp.knowledgeReview({ limit: 1 })
    expect(limited.candidates).toHaveLength(1)
    await expect(env.mcp.knowledgeReview({ limit: 0 })).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(env.mcp.knowledgeReview({ status: 'nope' })).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('knowledgeReview status=active：走 listMeta；approve/reject 生命周期与非法态', async () => {
    const env = await newEnv()
    const candId = await makeCandidate(env, 'k2')
    await env.mcp.knowledgeApprove(candId)
    const active = await env.mcp.knowledgeReview({ status: 'active' })
    expect(active.candidates.map((c) => c.id)).toContain(candId)
    // 非 candidate 不可再审核
    await expect(env.mcp.knowledgeApprove(candId)).rejects.toMatchObject({ code: 'invalid_knowledge_status' })
    const cand2 = await makeCandidate(env, 'k3')
    await env.mcp.knowledgeReject(cand2, '与现有重复')
    const deprecated = await env.mcp.knowledgeReview({ status: 'deprecated' })
    expect(deprecated.candidates.map((c) => c.id)).toContain(cand2)
    await expect(env.mcp.knowledgeApprove('ghost-id')).rejects.toMatchObject({ code: 'knowledge_not_found' })
  })

  it('knowledgeSearch：只检索 active，支持关键词命中；缺 query 报错', async () => {
    const env = await newEnv()
    const candId = await makeCandidate(env, 'search1')
    // candidate 不应被检索到
    const before = await env.mcp.knowledgeSearch({ query: '正文' })
    expect(before.total_hits).toBe(0)
    await env.mcp.knowledgeApprove(candId)
    const after = await env.mcp.knowledgeSearch({ query: 'search1' })
    expect(after.total_hits).toBeGreaterThan(0)
    expect(after.results.some((r) => r.id === candId)).toBe(true)
    await expect(env.mcp.knowledgeSearch({})).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('taskRetry：FAILED/CANCELLED → WAITING；RUNNING → invalid_status_transition', async () => {
    const env = await newEnv()
    const { tasks } = await seedTask(env.p)
    const id = tasks[0]!.id
    await env.p.tasks.run((db) => db.prepare("UPDATE tasks SET status = 'FAILED' WHERE id = ?").run(id))
    expect((await env.mcp.taskRetry(id)).status).toBe('WAITING')
    await env.p.tasks.run((db) => db.prepare("UPDATE tasks SET status = 'RUNNING' WHERE id = ?").run(id))
    await expect(env.mcp.taskRetry(id)).rejects.toMatchObject({ code: 'invalid_status_transition' })
    await env.p.tasks.run((db) => db.prepare("UPDATE tasks SET status = 'CANCELLED' WHERE id = ?").run(id))
    expect((await env.mcp.taskRetry(id)).status).toBe('WAITING')
  })

  it('taskSkip：FAILED → SKIPPED+skip_override；COMPLETED → invalid_status_transition', async () => {
    const env = await newEnv()
    const { tasks } = await seedTask(env.p)
    const id = tasks[0]!.id
    await env.p.tasks.run((db) => db.prepare("UPDATE tasks SET status = 'FAILED' WHERE id = ?").run(id))
    const skipped = await env.mcp.taskSkip(id)
    expect(skipped.status).toBe('SKIPPED')
    const row = await env.p.tasks.run((db) => db.prepare('SELECT skip_override, skip_reason FROM tasks WHERE id = ?').get(id)) as { skip_override: number; skip_reason: string | null }
    expect(row.skip_override).toBe(1)
    await env.p.tasks.run((db) => db.prepare("UPDATE tasks SET status = 'COMPLETED' WHERE id = ?").run(id))
    await expect(env.mcp.taskSkip(id)).rejects.toMatchObject({ code: 'invalid_status_transition' })
  })

  it('taskCancel：提交后取消 → CANCELLED（DagRepository 路径）；未知任务 → task_not_found', async () => {
    const env = await newEnv()
    const { tasks } = await seedTask(env.p)
    const id = tasks[0]!.id
    const cancelled = await env.mcp.taskCancel(id)
    expect(cancelled.status).toBe('CANCELLED')
    await expect(env.mcp.taskCancel('ghost-task')).rejects.toMatchObject({ code: 'task_not_found' })
  })

  it('taskReopen：关闭后 24h 内 → AWAITING_FEEDBACK；非 CLOSED → invalid_status_transition', async () => {
    const env = await newEnv()
    const { tasks } = await seedTask(env.p)
    const id = tasks[0]!.id
    await env.p.tasks.run((db) => db.prepare("UPDATE tasks SET status = 'COMPLETED' WHERE id = ?").run(id))
    await env.router.enterAwaitingFeedback(id)
    await env.mcp.acceptTask({ task_id: id })
    const reopened = await env.mcp.taskReopen(id)
    expect(reopened.status).toBe('AWAITING_FEEDBACK')
    await expect(env.mcp.taskReopen(id)).rejects.toMatchObject({ code: 'invalid_status_transition' })
  })

  it('banList：无记录 → []；连续失败 3 次 → BANNED 出现在列表', async () => {
    const env = await newEnv()
    expect((await env.mcp.banList()).bans).toEqual([])
    for (let i = 0; i < 3; i += 1) await env.breaker.recordFailure('executor', 'spawn')
    const { bans } = await env.mcp.banList()
    expect(bans).toHaveLength(1)
    expect(bans[0]).toMatchObject({ scope: 'executor', entityKey: 'spawn', state: 'BANNED' })
  })

  it('配置缺失：无 knowledgeReview/circuitBreaker 时 configuration_error', async () => {
    const registry = new ExecutorRegistry()
    const rootDir = mkdtempSync(join(tmpdir(), 'weave-cli-'))
    writeFileSync(join(rootDir, 'alpha-squad.yaml'), GOOD_TEAM)
    const p = openPersistence({ inMemory: true })
    const ctx = new MockSubagentsContext()
    registry.load({ subagents: ctx } as never)
    const mcp = new WeaveMcp({
      persistence: p,
      teamManager: new (await import('../team/team-manager')).TeamManager(registry, { teamsDir: rootDir, persistence: p }),
      executorRegistry: registry,
      feedbackRouter: new FeedbackRouter({ tasks: p.tasks, feedback: p.feedback, sessionTracker: new SessionTracker(p.feedback) }),
      dagRepository: new DagRepository(p),
    })
    await expect(mcp.knowledgeReview()).rejects.toMatchObject({ code: 'configuration_error' })
    await expect(mcp.banList()).rejects.toMatchObject({ code: 'configuration_error' })
    p.close()
    rmSync(rootDir, { recursive: true, force: true })
  })
})

describe('WeaveCli 补充命令（t36）', () => {
  it('knowledge review/approve/reject：文本与 --json', async () => {
    const env = await newEnv()
    const candId = await env.kstore.createCandidate({
      layer: 'shared',
      scope: {},
      filename: 'cli-k.md',
      frontmatter: { title: 'CLI 审核', type: 'pitfall', visibility: 'global', tags: [] },
      body: '内容',
    })
    const list = await env.cli.run(['knowledge', 'review'])
    expect(list.exitCode).toBe(0)
    expect(list.text).toContain(candId.id)
    const approved = await env.cli.run(['knowledge', 'approve', candId.id])
    expect(approved.text).toContain('active')
    const parsed = JSON.parse(approved.json) as { ok: boolean; data: { status: string } }
    expect(parsed.data.status).toBe('active')
    const cand2 = await env.kstore.createCandidate({
      layer: 'shared', scope: {}, filename: 'cli-k2.md',
      frontmatter: { title: 'CLI 驳回', type: 'pitfall', visibility: 'global', tags: [] },
      body: '内容',
    })
    const rejected = await env.cli.run(['knowledge', 'reject', cand2.id, '重复'])
    expect(rejected.text).toContain('deprecated')
  })

  it('task retry/skip/cancel/reopen：文本输出与 --json', async () => {
    const env = await newEnv()
    const seeded = await seedTask(env.p, { description: '运维任务', project_id: 'proj-ops', version: 'v1' })
    const taskId = seeded.tasks[0]!.id
    // retry（先置 FAILED）
    await env.p.tasks.run((db) => db.prepare("UPDATE tasks SET status = 'FAILED' WHERE id = ?").run(taskId))
    const retried = await env.cli.run(['task', 'retry', taskId])
    expect(retried.text).toContain('WAITING')
    expect(retried.exitCode).toBe(0)
    // cancel（RUNNING → CANCELLED，经 DagRepository）
    await env.p.tasks.run((db) => db.prepare("UPDATE tasks SET status = 'RUNNING' WHERE id = ?").run(taskId))
    const cancelled = await env.cli.run(['task', 'cancel', taskId])
    expect(cancelled.text).toContain('CANCELLED')
    // skip（CANCELLED → SKIPPED 合法）
    const skipped = await env.cli.run(['task', 'skip', taskId])
    expect(skipped.text).toContain('SKIPPED')
    // reopen 失败路径：非 CLOSED 报错可读
    const bad = await env.cli.run(['task', 'reopen', taskId])
    expect(bad.exitCode).toBe(1)
    expect(bad.text).toContain('error: invalid_status_transition:')
    const parsed = JSON.parse(bad.json) as { ok: boolean; error: { code: string } }
    expect(parsed.error.code).toBe('invalid_status_transition')
  })

  it('ban list：文本输出（--json 结构化）', async () => {
    const env = await newEnv()
    const empty = await env.cli.run(['ban', 'list'])
    expect(empty.text).toContain('（无熔断/冷却中实体）')
    for (let i = 0; i < 3; i += 1) await env.breaker.recordFailure('executor', 'codex')
    const listed = await env.cli.run(['ban', 'list'])
    expect(listed.text).toContain('executor/codex')
    expect(listed.text).toContain('BANNED')
    const parsed = JSON.parse(await env.cli.run(['ban', 'list']).then((r) => r.json)) as { ok: boolean; data: { bans: unknown[] } }
    expect(parsed.data.bans).toHaveLength(1)
  })
})

describe('WeaveMcp/WeaveCli：图谱工具（doc/09 §2.4）', () => {
  function fakeGraphService(): GraphService {
    return {
      build: async () => ({ graphPath: '/tmp/.graphify/graph.json', flowsPath: '/tmp/.graphify/flows.json' }),
      query: async (question: string) => `查询结果:${question}`,
      path: async (source: string, target: string) => `路径:${source} -> ${target}`,
      explain: async (node: string) => `解释:${node}`,
      affectedFlows: async (files: string[]) => ({
        changedFiles: files,
        matchedNodeIds: files.length === 0 ? [] : ['src/login.ts'],
        unmatchedFiles: [],
        affectedFlows: files.length === 0 ? [] : [{
          id: 'flow-1',
          name: '登录',
          entryPoint: 'src/login.ts',
          entryPointId: 'n1',
          path: ['n1'],
          qualifiedPath: ['Q.n1'],
          depth: 1,
          nodeCount: 1,
          fileCount: 1,
          files: ['src/login.ts'],
          criticality: 1,
          warnings: [],
        }],
      }),
      hasGraph: () => true,
      listFlows: async () => [],
      getFlow: async () => ({} as never),
    } as unknown as GraphService
  }

  function graphMcp(): WeaveMcp {
    return new WeaveMcp({ graphService: fakeGraphService() } as never)
  }

  it('WeaveMcp graph* 正常路径与入参校验', async () => {
    const mcp = graphMcp()
    expect(await mcp.graphBuild()).toEqual({ graphPath: '/tmp/.graphify/graph.json', flowsPath: '/tmp/.graphify/flows.json' })
    expect(await mcp.graphQuery({ question: '登录调用链' })).toMatchObject({
      question: '登录调用链',
      result: '查询结果:登录调用链',
    })
    expect(await mcp.graphPath({ source: 'a', target: 'b' })).toMatchObject({
      source: 'a',
      target: 'b',
      path: '路径:a -> b',
    })
    expect(await mcp.graphExplain({ node: 'n1' })).toMatchObject({
      node: 'n1',
      explain: '解释:n1',
    })
    const affected = await mcp.graphAffected({ files: ['src/login.ts'] })
    expect(affected.changedFiles).toEqual(['src/login.ts'])
    expect(affected.affectedFlows).toHaveLength(1)

    await expect(mcp.graphQuery({ question: '  ' })).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(mcp.graphPath({ source: '', target: 'b' })).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(mcp.graphExplain({ node: '' })).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(mcp.graphAffected({ files: [1 as unknown as string] })).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(mcp.graphAffected({ files: [''] })).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(await mcp.graphAffected({ files: [] })).toMatchObject({ changedFiles: [], affectedFlows: [] })
  })

  it('WeaveMcp 未注入 graphService 时返回 configuration_error', async () => {
    const mcp = new WeaveMcp({} as never)
    await expect(mcp.graphBuild()).rejects.toMatchObject({ code: 'configuration_error' })
    await expect(mcp.graphQuery({ question: 'x' })).rejects.toMatchObject({ code: 'configuration_error' })
    await expect(mcp.graphPath({ source: 'a', target: 'b' })).rejects.toMatchObject({ code: 'configuration_error' })
    await expect(mcp.graphExplain({ node: 'n' })).rejects.toMatchObject({ code: 'configuration_error' })
    await expect(mcp.graphAffected({ files: ['a'] })).rejects.toMatchObject({ code: 'configuration_error' })
  })

  it('WeaveCli graph 子命令：build/query/path/explain/affected 与 --json', async () => {
    const cli = new WeaveCli(graphMcp())
    const build = await cli.run(['graph', 'build'])
    expect(build.exitCode).toBe(0)
    expect(build.text).toContain('图谱已构建')
    expect(build.text).toContain('flows.json')

    const query = await cli.run(['graph', 'query', '登录', '链路', '--dfs'])
    expect(query.exitCode).toBe(0)
    expect(query.text).toContain('查询结果:登录 链路')
    const parsedQuery = JSON.parse(query.json) as { ok: boolean; data: { question: string; result: string } }
    expect(parsedQuery.data.question).toBe('登录 链路')

    const path = await cli.run(['graph', 'path', 'a', 'b'])
    expect(path.text).toContain('路径:a -> b')
    const explain = await cli.run(['graph', 'explain', 'n1'])
    expect(explain.text).toContain('解释:n1')

    const affected = await cli.run(['graph', 'affected', 'src/login.ts'])
    expect(affected.exitCode).toBe(0)
    expect(affected.text).toContain('影响执行流 1 条')
    expect(affected.text).toContain('flow-1')

    const bad = await cli.run(['graph', 'path', 'only-source'])
    expect(bad.exitCode).toBe(1)
    expect(bad.text).toContain('invalid_argument')
  })
})

describe('WeaveCli 动态 provider 路由', () => {
  it('provider add/list/remove 统一走 provider 域', async () => {
    const calls: string[][] = []
    const cli = new WeaveCli({} as WeaveMcp, async (args) => {
      calls.push(args)
      return { kind: 'success', text: `ok:${args.join('|')}` }
    })

    const added = await cli.run(['provider', 'add', '{"name":"agent-x"}'])
    expect(calls.at(-1)).toEqual(['add', '{"name":"agent-x"}'])
    expect(added.exitCode).toBe(0)
    const addedJson = JSON.parse(added.json) as { data: { text: string } }
    expect(addedJson.data.text).toBe('ok:add|{"name":"agent-x"}')

    await cli.run(['provider', 'list'])
    expect(calls.at(-1)).toEqual(['list'])

    await cli.run(['provider', 'remove', 'agent-x'])
    expect(calls.at(-1)).toEqual(['remove', 'agent-x'])
  })

  it('provider 命令失败时返回结构化错误和 exitCode=1', async () => {
    const cli = new WeaveCli({} as WeaveMcp, async () => ({ kind: 'error', text: 'registry boom' }))
    const result = await cli.run(['provider', 'list'])
    expect(result.exitCode).toBe(1)
    expect(result.text).toContain('internal_error: registry boom')
    const parsed = JSON.parse(result.json) as { ok: boolean; error: { code: string; message: string } }
    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe('internal_error')
    expect(parsed.error.message).toBe('registry boom')
  })
})

describe('WeaveMcp 治理发电（doc/05 §6.4 P1-D 接线点 3）', () => {
  it('taskSkip/taskRetry 发电：actor=captain，文案含转移与来源；审计同步入账', async () => {
    const notified: Array<{ sessionId: string; text: string }> = []
    // echoSelfActions=true 验证接线本身；缺省部署下 captain 动作不回声（§6.4 噪声控制①）
    const auditDir = mkdtempSync(join(tmpdir(), 'weave-audit-cli-'))
    const audit = new AuditLog({ dir: auditDir })
    const { mcp, p } = await newEnv(undefined, new TaskStatusNotifier({
      notify: (sessionId, text) => notified.push({ sessionId, text }),
      echoSelfActions: true,
    }), audit)
    const seeded = await seedTask(p)
    const taskId = seeded.tasks[0]!.id

    // 置 FAILED：FAILED→SKIPPED / FAILED→WAITING 均为矩阵内合法转移
    const markFailed = async (): Promise<void> => {
      await p.tasks.run((db) => db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('FAILED', taskId))
    }
    await markFailed()

    await mcp.taskSkip(taskId)
    expect(notified).toHaveLength(1)
    expect(notified[0]!.sessionId).toBe('cli-session')
    expect(notified[0]!.text).toContain('「实现 CLI」FAILED → SKIPPED（task_skip）')

    // SKIPPED 不可重试 → 置 FAILED 后重试：FAILED → WAITING（task_retry）
    await markFailed()
    await mcp.taskRetry(taskId)
    expect(notified).toHaveLength(2)
    expect(notified[1]!.text).toContain('「实现 CLI」FAILED → WAITING（task_retry）')

    // G1 审计补齐：两次治理动作各入账一条 task.status_changed（by=captain）。
    // query 默认按时间倒序，断言用集合比对防同毫秒顺序歧义。
    const records = await audit.query({ types: ['task.status_changed'] })
    const entries = records
      .map((r) => `${(r as { from: string }).from}|${(r as { to: string }).to}|${(r as { by: string }).by}`)
      .sort()
    expect(entries).toEqual(['FAILED|SKIPPED|captain', 'FAILED|WAITING|captain'])
    rmSync(auditDir, { recursive: true, force: true })
  })

  it('缺省（未开回声）captain 动作不发电', async () => {
    const notified: Array<{ sessionId: string; text: string }> = []
    const { mcp, p } = await newEnv(undefined, new TaskStatusNotifier({
      notify: (sessionId, text) => notified.push({ sessionId, text }),
    }))
    const seeded = await seedTask(p)
    const taskId = seeded.tasks[0]!.id
    // WAITING→SKIPPED 非法；置 FAILED（矩阵内合法转移）后再跳过
    await p.tasks.run((db) =>
      db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('FAILED', taskId),
    )
    await mcp.taskSkip(taskId)
    expect(notified).toHaveLength(0)
  })
})
