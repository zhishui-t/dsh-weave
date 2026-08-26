import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AuditLog } from '../audit/audit-log'
import { WeaveCli } from '../cli-mcp'
import { WeaveMcp } from '../cli-mcp'
import { CircuitBreaker } from '../safety/circuit-breaker'
import { DagRepository } from '../dag/repository'
import { ExecutorRegistry } from '../executor-registry'
import { FeedbackRouter } from '../feedback-router'
import { KnowledgeReviewService } from '../knowledge-review'
import { KnowledgeStore } from '../knowledge-model'
import { openPersistence, type WeavePersistence } from '../persistence/index'
import { SessionTracker } from '../session-tracker'
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

async function newEnv(registry?: ExecutorRegistry): Promise<Env> {
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
    teamManager: new (await import('../team-manager')).TeamManager(registry2, { teamsDir: rootDir, persistence: p }),
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

const SUBMIT = { description: '实现 CLI', project_id: 'proj-cli', version: 'v1' }

describe('WeaveMcp（MCP Tool 层）', () => {
  it('submitTask：单任务 DAG 落库（WAITING、stage=execute、角色 coder→executor zcode）', async () => {
    const { mcp, p } = await newEnv()
    const out = await mcp.submitTask(SUBMIT)
    expect(out.status).toBe('submitted')
    expect(out.dag_id).toMatch(/^dag-proj-cli-v1-1$/)
    expect(out.tasks).toHaveLength(1)
    const task = out.tasks[0]!
    expect(task).toMatchObject({ executor: 'zcode', assigned_agent: 'coder', status: 'WAITING', revision_count: 0 })
    const rows = await p.tasks.run((db) => {
      const dag = db.prepare('SELECT * FROM dags WHERE dag_id = ?').get(out.dag_id) as Record<string, unknown>
      const taskRow = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as Record<string, unknown>
      return { dag, taskRow }
    })
    expect(rows.dag).toMatchObject({ team_id: 'alpha-squad', difficulty: 'hard', status: 'created' })
    expect(rows.taskRow).toMatchObject({ stage: 'execute', status: 'WAITING' })
  })

  it('submitTask 入参校验：description/project_id/version 缺失 → invalid_argument', async () => {
    const { mcp } = await newEnv()
    await expect(mcp.submitTask({ description: '', project_id: 'p', version: 'v' })).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(mcp.submitTask({ description: 'd', project_id: '  ', version: 'v' })).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(mcp.submitTask({ description: 'd', project_id: 'p', version: '' })).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('submitTask：team 不存在 → invalid_team；执行器未注册 → executor_unavailable（校验前置）', async () => {
    const { mcp } = await newEnv()
    await expect(mcp.submitTask({ ...SUBMIT, team_id: 'ghost' })).rejects.toMatchObject({ code: 'invalid_team' })
    const { mcp: mcp2 } = await newEnv(new ExecutorRegistry())
    await expect(mcp2.submitTask({ ...SUBMIT, team_id: 'alpha-squad' })).rejects.toMatchObject({ code: 'executor_unavailable' })
  })

  it('submitTask 依赖：上游未完成 → BLOCKED；已完成 → WAITING；依赖不存在 → task_not_found', async () => {
    const { mcp, p } = await newEnv()
    const a = await mcp.submitTask({ ...SUBMIT, description: '上游 A' })
    const aId = a.tasks[0]!.id
    const b = await mcp.submitTask({ ...SUBMIT, description: '下游 B', dependencies: [{ task_id: aId }] })
    expect(b.tasks[0]!.status).toBe('BLOCKED')
    await p.tasks.run((db) => db.prepare("UPDATE tasks SET status = 'COMPLETED' WHERE id = ?").run(aId))
    const c = await mcp.submitTask({ ...SUBMIT, description: '下游 C', dependencies: [{ task_id: aId }] })
    expect(c.tasks[0]!.status).toBe('WAITING')
    await expect(mcp.submitTask({ ...SUBMIT, dependencies: [{ task_id: 'ghost-dep' }] })).rejects.toMatchObject({ code: 'task_not_found' })
  })

  it('任务 ID 连续且递增（task_sequences 按 project+version）', async () => {
    const { mcp } = await newEnv()
    const one = await mcp.submitTask(SUBMIT)
    const two = await mcp.submitTask(SUBMIT)
    expect(one.dag_id).toMatch(/-1$/)
    expect(two.dag_id).toMatch(/-2$/)
    expect(one.tasks[0]!.id).not.toBe(two.tasks[0]!.id)
  })

  it('getStatus：按 dag_id / task_id；缺参数 invalid_argument；未找到 task_not_found', async () => {
    const { mcp } = await newEnv()
    const { dag_id, tasks } = await mcp.submitTask(SUBMIT)
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
    const { tasks } = await mcp.submitTask(SUBMIT)
    const id = tasks[0]!.id
    await p.tasks.run((db) => db.prepare("UPDATE tasks SET status = 'COMPLETED' WHERE id = ?").run(id))
    // 非保温态：revise/accept 均 invalid_status_transition
    await expect(mcp.reviseTask({ task_id: id, feedback: '改成 X' })).rejects.toMatchObject({ code: 'invalid_status_transition' })
    await expect(mcp.acceptTask({ task_id: id })).rejects.toMatchObject({ code: 'invalid_status_transition' })
    await expect(mcp.reviseTask({ task_id: id, feedback: '  ' })).rejects.toMatchObject({ code: 'invalid_argument' })
    // 进入保温期
    const router = new (await import('../feedback-router')).FeedbackRouter({
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

  it('task submit/status：参数解析与 DAG 展示', async () => {
    const { cli } = await newEnv()
    const submitted = await cli.run(['task', 'submit', '修复登录超时', '--project', 'proj-x', '--version', 'v2'])
    expect(submitted.exitCode).toBe(0)
    expect(submitted.text).toContain('已提交 DAG dag-proj-x-v2-1')
    const status = await cli.run(['task', 'status', '--dag', 'dag-proj-x-v2-1'])
    expect(status.text).toContain('[WAITING]')
    expect(status.text).toContain('修复登录超时')
  })

  it('task revise/accept：保温期命令文本输出', async () => {
    const { cli, p } = await newEnv()
    const submit = await cli.run(['task', 'submit', '任务', '--project', 'proj-r', '--version', 'v1'])
    const dagId = /dag-[\w-]+-\d+/.exec(submit.text)?.[0] ?? ''
    const status = await cli.run(['task', 'status', '--dag', dagId])
    const taskId = /^- (\S+)/m.exec(status.text)?.[1] ?? ''
    await p.tasks.run((db) => db.prepare("UPDATE tasks SET status = 'COMPLETED' WHERE id = ?").run(taskId))
    const router = new (await import('../feedback-router')).FeedbackRouter({
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

  it('taskRetry：FAILED/CANCELLED → WAITING；RUNNING → invalid_status_transition', async () => {
    const env = await newEnv()
    const { tasks } = await env.mcp.submitTask(SUBMIT)
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
    const { tasks } = await env.mcp.submitTask(SUBMIT)
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
    const { tasks } = await env.mcp.submitTask(SUBMIT)
    const id = tasks[0]!.id
    const cancelled = await env.mcp.taskCancel(id)
    expect(cancelled.status).toBe('CANCELLED')
    await expect(env.mcp.taskCancel('ghost-task')).rejects.toMatchObject({ code: 'task_not_found' })
  })

  it('taskReopen：关闭后 24h 内 → AWAITING_FEEDBACK；非 CLOSED → invalid_status_transition', async () => {
    const env = await newEnv()
    const { tasks } = await env.mcp.submitTask(SUBMIT)
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
      teamManager: new (await import('../team-manager')).TeamManager(registry, { teamsDir: rootDir, persistence: p }),
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
    const submit = await env.cli.run(['task', 'submit', '运维任务', '--project', 'proj-ops', '--version', 'v1'])
    const dagId = /dag-[\w-]+-\d+/.exec(submit.text)?.[0] ?? ''
    const status = await env.cli.run(['task', 'status', '--dag', dagId])
    const taskId = /^- (\S+)/m.exec(status.text)?.[1] ?? ''
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
