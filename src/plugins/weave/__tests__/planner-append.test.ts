import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stringify as stringifyYaml } from 'yaml'

import { WeavePersistence } from '../persistence/persistence'
import { TeamManager, type ExecutorLookup, type TeamConfig } from '../team-manager'
import { TeamPlanner } from '../planner'
import { WeaveScheduler, type SchedulerDelegationLike } from '../scheduler'
import type { SubagentTaskOutput } from '../delegation-service'

const lookup: ExecutorLookup = {
  get(id) {
    return id === 'codex'
      ? { id, name: id, kind: 'codex', capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false } }
      : undefined
  },
}

const TEAM: TeamConfig = {
  team_id: 'alpha',
  name: '阿尔法小队',
  default: false,
  roles: [
    { id: 'designer', name: '设计师', bias: 'design', executor: 'codex', stages: ['design'], max_concurrent_tasks: 1, personality: '设计' },
    { id: 'coder', name: '程序员', bias: 'dev', executor: 'codex', stages: ['implement'], max_concurrent_tasks: 2, personality: '实现' },
    { id: 'reviewer', name: '审核员', bias: 'review', executor: 'codex', stages: ['review'], max_concurrent_tasks: 1, personality: '审核' },
  ],
  task_decomposition: { matchers: [], default_difficulty: 'hard', dag_templates: { hard: ['design'] } },
  knowledge_injection: { max_entries: 1, max_chars_per_entry: 100, max_total_chars: 300, priority: 'freshness_first' },
  feedback: { feedback_timeout_seconds: 60, max_revisions: 2, reopen_window_seconds: 60 },
}

let dir = ''
let persistence: WeavePersistence
let manager: TeamManager
let planner: TeamPlanner

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weave-planner-append-'))
  persistence = new WeavePersistence({ inMemory: true })
  manager = new TeamManager(lookup, { teamsDir: dir, persistence })
  manager.importTeam(stringifyYaml({ schema_version: '1', ...TEAM }))
  planner = new TeamPlanner({ persistence, teamManager: manager })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

class FakeDelegation implements SchedulerDelegationLike {
  calls: Array<{ taskId: string; roleId: string }> = []
  script = new Map<string, Partial<SubagentTaskOutput> | 'throw'>()
  #gates = new Map<string, Promise<void>>()
  #gateResolvers = new Map<string, () => void>()

  /** 让指定任务挂起在执行中（用于构造"在途"现场），release 放行。 */
  gate(taskId: string): void {
    if (this.#gates.has(taskId)) return
    this.#gates.set(
      taskId,
      new Promise<void>((resolve) => {
        this.#gateResolvers.set(taskId, resolve)
      }),
    )
  }

  release(taskId: string): void {
    this.#gateResolvers.get(taskId)?.()
  }

  async executeTask(
    task: { id: string; description: string },
    role: { id: string; provider?: string; fallback_provider?: string; fallback_model?: string },
    _team: unknown,
    _context: unknown,
    signal: AbortSignal,
  ): Promise<SubagentTaskOutput> {
    this.calls.push({ taskId: task.id, roleId: role.id })
    const gate = this.#gates.get(task.id)
    if (gate) {
      await new Promise<void>((resolve) => {
        const onAbort = (): void => resolve()
        signal.addEventListener('abort', onAbort, { once: true })
        void gate.then(() => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        })
      })
    }
    await new Promise((resolve) => setTimeout(resolve, 1))
    if (signal.aborted) return { id: task.id, output: [], stopReason: 'aborted', duration_ms: 0 }
    const step = this.script.get(task.id)
    const scripted = step === 'throw' ? undefined : step
    return {
      id: task.id,
      output: [{ type: 'text' as const, text: scripted?.output?.[0]?.text ?? `${role.id}-done` }],
      stopReason: scripted?.stopReason ?? 'completed',
      duration_ms: 1,
    }
  }
}

async function taskStatus(taskId: string): Promise<string> {
  const row = await persistence.tasks.run((db) =>
    db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string } | undefined,
  )
  return row?.status ?? 'missing'
}

async function dagStatus(dagId: string): Promise<string> {
  const row = await persistence.tasks.run((db) =>
    db.prepare('SELECT status FROM dags WHERE dag_id = ?').get(dagId) as { status: string } | undefined,
  )
  return row?.status ?? 'missing'
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('waitUntil 超时：条件未在时限内满足')
}

function makeScheduler(delegation: FakeDelegation, notices: Array<{ text: string }>): WeaveScheduler {
  return new WeaveScheduler({
    delegation,
    persistence,
    loadTeam: (teamId) => manager.loadTeam(teamId),
    notify: (_sessionId, text) => { notices.push({ text }) },
  })
}

describe('TeamPlanner 追加 → 调度器入泵（doc/05 §6.1 P1-A e2e）', () => {
  it('在途 DAG（已收敛）追加 2 任务：start 重入后全部收敛 COMPLETED，执行顺序符合依赖', async () => {
    await manager.bindTeam('sess-append', 'alpha')
    const delegation = new FakeDelegation()
    const notices: Array<{ text: string }> = []
    const scheduler = makeScheduler(delegation, notices)

    const first = await planner.plan({
      session_id: 'sess-append',
      tasks: [{ description: '首批', assignee: 'coder' }],
    })
    const dagId = first.dag_id
    const t1 = first.tasks[0]!.id
    await scheduler.start({ dagId, sessionId: 'sess-append' })
    await waitUntil(() => taskStatus(t1).then((s) => s === 'COMPLETED'))
    expect(await dagStatus(dagId)).toBe('completed')

    // 在已收敛的 DAG 上追加：新编号 T2/T3（DAG 域递增公式 T${既有任务数+i}，首批 1 任务后从 T2 起），
    // T3 依赖新任务 T2 与既有 T1
    const second = await planner.plan({
      session_id: 'sess-append',
      append_to: dagId,
      tasks: [
        { description: '追加一', assignee: 'coder' },
        { description: '追加二', assignee: 'designer', depends_on: ['T2', 'T1'] },
      ],
    })
    expect(second.appended).toBe(true)
    const t2 = second.tasks[0]!.id
    const t3 = second.tasks[1]!.id
    await scheduler.start({ dagId, sessionId: 'sess-append' }) // 幂等重入 → 重泵拾取新任务

    await waitUntil(() => taskStatus(t3).then((s) => s === 'COMPLETED'))
    expect(await taskStatus(t1)).toBe('COMPLETED')
    expect(await taskStatus(t2)).toBe('COMPLETED')
    // 执行顺序符合依赖：T2 先于 T3（T3 依赖 T2）
    const order = delegation.calls.map((c) => c.taskId)
    expect(order.indexOf(t2)).toBeGreaterThanOrEqual(0)
    expect(order.indexOf(t3)).toBeGreaterThan(order.indexOf(t2))
    expect(await dagStatus(dagId)).toBe('completed')
  })

  it('completed DAG 追加 → dags.status 复活 created → 新任务执行 → 重新收敛 completed', async () => {
    await manager.bindTeam('sess-revive', 'alpha')
    const delegation = new FakeDelegation()
    const notices: Array<{ text: string }> = []
    const scheduler = makeScheduler(delegation, notices)

    const first = await planner.plan({
      session_id: 'sess-revive',
      tasks: [{ description: '原始任务', assignee: 'coder' }],
    })
    const dagId = first.dag_id
    await scheduler.start({ dagId, sessionId: 'sess-revive' })
    await waitUntil(() => dagStatus(dagId).then((s) => s === 'completed'))

    const second = await planner.plan({
      session_id: 'sess-revive',
      append_to: dagId,
      tasks: [{ description: '复活任务', assignee: 'coder' }],
    })
    expect(second.appended).toBe(true)
    expect(await dagStatus(dagId)).toBe('created') // planner 侧复活

    await scheduler.start({ dagId, sessionId: 'sess-revive' }) // start 重建运行上下文
    await waitUntil(() => taskStatus(second.tasks[0]!.id).then((s) => s === 'COMPLETED'))
    expect(await dagStatus(dagId)).toBe('completed') // 二次收敛
  })

  it('追加依赖在途既有任务：既有完成前新任务保持 BLOCKED，完成后放行执行', async () => {
    await manager.bindTeam('sess-hold', 'alpha')
    const delegation = new FakeDelegation()
    const notices: Array<{ text: string }> = []
    const scheduler = makeScheduler(delegation, notices)

    const first = await planner.plan({
      session_id: 'sess-hold',
      tasks: [{ description: '长任务', assignee: 'coder' }],
    })
    const dagId = first.dag_id
    const t1 = first.tasks[0]!.id
    delegation.gate(t1) // T1 挂起在执行中
    await scheduler.start({ dagId, sessionId: 'sess-hold' })
    await waitUntil(() => taskStatus(t1).then((s) => s === 'RUNNING'))

    const second = await planner.plan({
      session_id: 'sess-hold',
      append_to: dagId,
      tasks: [{ description: '依赖在途任务', assignee: 'designer', depends_on: ['T1'] }],
    })
    const t2 = second.tasks[0]!.id
    await scheduler.start({ dagId, sessionId: 'sess-hold' })

    // T1 未完成：多次泵节拍后 T2 仍保持 BLOCKED（就绪晋升不误放行）
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(await taskStatus(t2)).toBe('BLOCKED')

    delegation.release(t1)
    await waitUntil(() => taskStatus(t2).then((s) => s === 'COMPLETED'))
    expect(await taskStatus(t1)).toBe('COMPLETED')
    const order = delegation.calls.map((c) => c.taskId)
    expect(order.indexOf(t2)).toBeGreaterThan(order.indexOf(t1))
  })

  it('追加的任务无依赖时立即执行（WAITING 直派，不依赖既有任务状态）', async () => {
    await manager.bindTeam('sess-free', 'alpha')
    const delegation = new FakeDelegation()
    const notices: Array<{ text: string }> = []
    const scheduler = makeScheduler(delegation, notices)

    const first = await planner.plan({
      session_id: 'sess-free',
      tasks: [{ description: '首批', assignee: 'coder' }],
    })
    const dagId = first.dag_id
    await scheduler.start({ dagId, sessionId: 'sess-free' })
    await waitUntil(() => dagStatus(dagId).then((s) => s === 'completed'))

    const second = await planner.plan({
      session_id: 'sess-free',
      append_to: dagId,
      tasks: [{ description: '独立追加', assignee: 'reviewer' }],
    })
    await scheduler.start({ dagId, sessionId: 'sess-free' })
    await waitUntil(() => taskStatus(second.tasks[0]!.id).then((s) => s === 'COMPLETED'))
    expect(delegation.calls.some((c) => c.taskId === second.tasks[0]!.id)).toBe(true)
  })
})
