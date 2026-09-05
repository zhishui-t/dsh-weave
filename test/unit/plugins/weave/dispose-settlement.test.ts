import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify as stringifyYaml } from 'yaml'

import { WeavePersistence } from '../../../../src/plugins/weave/persistence/persistence'
import { TeamManager, type ExecutorLookup, type TeamConfig } from '../../../../src/plugins/weave/team/team-manager.js'
import { TeamPlanner } from '../../../../src/plugins/weave/scheduling/planner'
import { WeaveScheduler, type SchedulerDelegationLike } from '../../../../src/plugins/weave/scheduling/scheduler'
import { BoundedSettlement, DisposedError } from '../../../../src/plugins/weave/scheduling/bounded-settlement.js'
import type { SubagentTaskOutput } from '../../../../src/plugins/weave/scheduling/delegation-service'

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
  ],
  task_decomposition: { matchers: [], default_difficulty: 'hard', dag_templates: { hard: ['design', 'implement'] } },
  knowledge_injection: { max_entries: 1, max_chars_per_entry: 100, max_total_chars: 300, priority: 'freshness_first' },
  feedback: { feedback_timeout_seconds: 60, max_revisions: 2, reopen_window_seconds: 60 },
}

let dir = ''
let persistence: WeavePersistence
let manager: TeamManager
let planner: TeamPlanner

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weave-dispose-'))
  persistence = new WeavePersistence({ inMemory: true })
  manager = new TeamManager(lookup, { teamsDir: dir, persistence })
  manager.importTeam(stringifyYaml({ schema_version: '1', ...TEAM }))
  planner = new TeamPlanner({ persistence, teamManager: manager })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 可挂起的委托替身：ignoreAbort=true 时构造「结算超时」现场；否则 abort 即放行（自收敛现场）。 */
class HangableDelegation implements SchedulerDelegationLike {
  readonly #gates = new Map<string, Promise<void>>()
  readonly #resolvers = new Map<string, () => void>()
  calls: Array<{ taskId: string }> = []

  constructor(private readonly ignoreAbort = false) {}

  async executeTask(
    task: { id: string },
    _role: unknown,
    _team: unknown,
    _context: unknown,
    signal: AbortSignal,
  ): Promise<SubagentTaskOutput> {
    this.calls.push({ taskId: task.id })
    const gate = new Promise<void>((resolve) => {
      this.#resolvers.set(task.id, resolve)
      if (!this.ignoreAbort) signal.addEventListener('abort', () => resolve(), { once: true })
    })
    this.#gates.set(task.id, gate)
    await gate
    if (signal.aborted) return { id: task.id, output: [], stopReason: 'aborted', duration_ms: 0 }
    return { id: task.id, output: [{ type: 'text' as const, text: `${task.id}-done` }], stopReason: 'completed', duration_ms: 1 }
  }

  release(taskId: string): void {
    this.#resolvers.get(taskId)?.()
  }
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function taskRowOf(taskId: string): Promise<{ status: string; attempt_token: string | null; revision: number }> {
  const row = await persistence.tasks.run((db) =>
    db.prepare('SELECT status, attempt_token, revision FROM tasks WHERE id = ?').get(taskId) as
      | { status: string; attempt_token: string | null; revision: number }
      | undefined,
  )
  if (!row) throw new Error(`task missing: ${taskId}`)
  return row
}

describe('scheduler.disposeGracefully（准入截止 + 有界结算 + 兜底落库）', () => {
  it('在途任务自收敛路径：abort → 委托返回 aborted → CANCELLED 落库，sweep 无事可做', async () => {
    const delegation = new HangableDelegation(false)
    const scheduler = new WeaveScheduler({
      delegation,
      persistence,
      loadTeam: (teamId) => manager.loadTeam(teamId),
      notify: () => undefined,
    })
    await manager.bindTeam('sess-1', 'alpha')
    const planned = await planner.plan({
      session_id: 'sess-1',
      tasks: [{ id: 'a', description: '设计任务', assignee: 'designer' }],
    })
    const taskId = planned.tasks[0]!.id // planner 会改写 id，落库以计划输出为准
    await scheduler.start({ dagId: planned.dag_id, sessionId: 'sess-1' })
    await flush(4) // 等 claim RUNNING（gate 已挂起）
    expect((await taskRowOf(taskId)).status).toBe('RUNNING')

    const report = await scheduler.disposeGracefully({ settlementTimeoutMs: 2_000 })
    // abort 触发委托返回 aborted → #executeReady 既有收敛路径写 CANCELLED → sweep 无需兜底
    expect(report.drained).toBe(1)
    expect(report.interrupted).toBe(0)
    expect(report.failures).toEqual([])
    expect((await taskRowOf(taskId)).status).toBe('CANCELLED')
  })

  it('结算超时兜底：挂起执行超时限 → sweep 落 CANCELLED + 作废 token；迟到回写被守卫拒绝', async () => {
    const warn = vi.fn()
    const delegation = new HangableDelegation(true)
    const scheduler = new WeaveScheduler({
      delegation,
      persistence,
      loadTeam: (teamId) => manager.loadTeam(teamId),
      notify: () => undefined,
      log: { warn },
    })
    await manager.bindTeam('sess-1', 'alpha')
    const planned = await planner.plan({
      session_id: 'sess-1',
      tasks: [{ id: 'a', description: '设计任务', assignee: 'designer' }],
    })
    const taskId = planned.tasks[0]!.id
    await scheduler.start({ dagId: planned.dag_id, sessionId: 'sess-1' })
    await flush(4)
    const before = await taskRowOf(taskId)
    expect(before.status).toBe('RUNNING')
    expect(before.attempt_token).not.toBeNull()

    const report = await scheduler.disposeGracefully({ settlementTimeoutMs: 120 })
    // 挂起执行无视 abort → 结算超时进 failures；sweep 把中间态落 CANCELLED 并作废 token
    expect(report.failures.length).toBeGreaterThan(0)
    expect(report.drained).toBe(1)
    expect(report.interrupted).toBe(1)
    const swept = await taskRowOf(taskId)
    expect(swept.status).toBe('CANCELLED')
    expect(swept.attempt_token).toBeNull()
    expect(swept.revision).toBeGreaterThan(before.revision)

    // 事后释放挂起执行：迟到收敛被双重闸挡住——sweep 已写 CANCELLED，#executeReady 的
    // 「尊重 CANCELLED 现状」前置检查短路（守卫拒绝的同义收敛），revision 不再前进。
    delegation.release(taskId)
    await flush(6)
    const after = await taskRowOf(taskId)
    expect(after.status).toBe('CANCELLED')
    expect(after.revision).toBe(swept.revision)
  })

  it('准入截止：disposeGracefully 之后 start 不再派发新工作', async () => {
    const delegation = new HangableDelegation()
    const scheduler = new WeaveScheduler({
      delegation,
      persistence,
      loadTeam: (teamId) => manager.loadTeam(teamId),
      notify: () => undefined,
    })
    await manager.bindTeam('sess-1', 'alpha')
    const planned = await planner.plan({
      session_id: 'sess-1',
      tasks: [{ id: 'a', description: '设计任务', assignee: 'designer' }],
    })
    const taskId = planned.tasks[0]!.id
    await scheduler.disposeGracefully({ settlementTimeoutMs: 100 })
    await scheduler.start({ dagId: planned.dag_id, sessionId: 'sess-1' })
    await flush(6)
    expect(delegation.calls).toEqual([])
    expect((await taskRowOf(taskId)).status).toBe('WAITING')
  })

  it('无在途：drained/interrupted/failures 全零，幂等可重复调用', async () => {
    const scheduler = new WeaveScheduler({
      delegation: new HangableDelegation(),
      persistence,
      loadTeam: (teamId) => manager.loadTeam(teamId),
      notify: () => undefined,
    })
    const report = await scheduler.disposeGracefully()
    expect(report).toEqual({ drained: 0, interrupted: 0, failures: [] })
    const again = await scheduler.disposeGracefully()
    expect(again).toEqual({ drained: 0, interrupted: 0, failures: [] })
  })
})

describe('BoundedSettlement（官方 lifecycle 模式移植）', () => {
  it('非取消失败收集进 failures；预期取消（DisposedError 直连或 cause 链）静默', async () => {
    const settlement = new BoundedSettlement(1_000)
    settlement.close()
    const disposedError = new DisposedError()
    const chained = new Error('wrapper', { cause: disposedError })
    const operations = [
      Promise.resolve(1),
      Promise.reject(disposedError), // 直接命中
      Promise.reject(chained), // cause 链命中
      Promise.reject(new Error('real-failure')), // 非取消 → 收集
    ]
    const failures: unknown[] = []
    await settlement.settle(operations, failures)
    expect(failures).toHaveLength(1)
    expect((failures[0] as Error).message).toBe('real-failure')
  })

  it('整体超时：超时错误进 failures 而非抛出（处置必须走到收尾）', async () => {
    const settlement = new BoundedSettlement(80)
    const failures: unknown[] = []
    await settlement.settle([new Promise<void>(() => undefined)], failures)
    expect(failures).toHaveLength(1)
    expect((failures[0] as Error).name).toBe('SettlementTimeoutError')
  })
})
