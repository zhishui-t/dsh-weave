import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stringify as stringifyYaml } from 'yaml'

import { WeaveScheduler, subjectLabel } from '../../../../src/plugins/weave/scheduling/scheduler'
import { openPersistence, type WeavePersistence } from '../../../../src/plugins/weave/persistence/index'
import { TeamManager, type TeamConfig } from '../../../../src/plugins/weave/team/team-manager.js'
import { TeamPlanner } from '../../../../src/plugins/weave/scheduling/planner'
import type { SchedulerDelegationLike, WeaveSchedulerOptions } from '../../../../src/plugins/weave/scheduling/scheduler'

const TEAM: TeamConfig = {
  team_id: 'alpha',
  name: '阿尔法小队',
  default: true,
  roles: [
    { id: 'coder', name: '程序员', bias: 'dev', executor: 'dsh', stages: ['implement'], max_concurrent_tasks: 1, personality: '实现' },
    { id: 'reviewer', name: '审核员', bias: 'review', executor: 'codex', stages: ['review'], max_concurrent_tasks: 1, personality: '审核' },
  ],
  task_decomposition: { matchers: [], default_difficulty: 'hard', dag_templates: { hard: ['coder'] } },
  knowledge_injection: { max_entries: 5, max_chars_per_entry: 500, max_total_chars: 2500, priority: 'freshness_first' },
  feedback: { feedback_timeout_seconds: 60, max_revisions: 2, reopen_window_seconds: 60 },
}

/** push 路径替身（reviewer 走 codex）：记录 start 调用。 */
function makeDelegation(): SchedulerDelegationLike {
  return {
    supportsSlotAcquiredHook: false,
    executeTask: vi.fn(async () => ({
      output: [{ type: 'text', text: 'push-done' }],
      stopReason: 'completed',
      duration_ms: 5,
    })),
  } as unknown as SchedulerDelegationLike
}

describe('WeaveScheduler pull 模型（成员自拉）', () => {
  let persistence: WeavePersistence
  let manager: TeamManager
  let dir = ''

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'weave-pull-'))
    persistence = openPersistence({ inMemory: true })
    const lookup = { get: (id: string) => (id === 'codex' ? { id, name: id, kind: 'codex', capabilities: {} } : undefined) }
    manager = new TeamManager(lookup as never, { teamsDir: dir, persistence })
    await manager.importTeam(stringifyYaml({ schema_version: '1', ...TEAM }))
  })

  afterEach(() => {
    persistence.close()
    rmSync(dir, { recursive: true, force: true })
  })

  async function planTwoTasks(scheduler: WeaveScheduler): Promise<{ dagId: string; ids: [string, string] }> {
    const planner = new TeamPlanner({ persistence, teamManager: manager })
    const output = await planner.plan({
      session_id: 'sess-pull',
      tasks: [
        { id: 'a', description: '实现功能', assignee: 'coder' },
        { id: 'b', description: '审核实现', assignee: 'reviewer', depends_on: ['a'] },
      ],
    } as never)
    await scheduler.start({ dagId: output.dag_id, sessionId: 'sess-pull' })
    return { dagId: output.dag_id, ids: output.tasks.map((task) => task.id) as [string, string] }
  }

  function makeScheduler(overrides: Partial<WeaveSchedulerOptions> = {}, delegation = makeDelegation()): WeaveScheduler {
    return new WeaveScheduler({
      delegation,
      persistence,
      loadTeam: (teamId) => manager.loadTeam(teamId),
      notify: () => undefined,
      ...overrides,
    })
  }

  it('就绪任务不推执行：wake 钩子触发、任务保持 WAITING 等成员认领', async () => {
    const wake = vi.fn(async () => undefined)
    const delegation = makeDelegation()
    const scheduler = makeScheduler({ memberWake: wake as never })
    const { ids } = await planTwoTasks(scheduler)
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1))
    // coder 任务就绪 → 只唤醒不派发（delegation 未被调用）
    expect(delegation.executeTask).not.toHaveBeenCalled()
    const woken = (wake as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { task: { id: string } }
    expect(woken.task.id).toBe(ids[0])
    // reviewer（codex，非 pull 执行器）被阻塞在 'a' 上，'a' 未完成 → 不派发
    const status = await scheduler.loadDag((await persistence.tasks.run((db) => db.prepare('SELECT dag_id FROM tasks WHERE id = ?').get(ids[0]) as { dag_id: string })).dag_id)
    const byId = new Map(status.tasks.map((task) => [task.id, task]))
    expect(byId.get(ids[0])?.status).toBe('WAITING')
    scheduler.dispose()
  })

  it('claim：成员认领 WAITING→RUNNING（attempt 签发 + revision+1）；重复认领拒绝', async () => {
    const wake = vi.fn(async () => undefined)
    const scheduler = makeScheduler({ memberWake: wake as never })
    const { ids } = await planTwoTasks(scheduler)
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1))

    const claimed = await scheduler.claimTask({ taskId: ids[0], memberKey: 'alpha:coder' })
    expect(claimed.ok).toBe(true)
    if (claimed.ok) {
      expect(claimed.task.status).toBe('RUNNING')
      expect(claimed.attempt.token).toBeTruthy()
      expect(claimed.attempt.expectedRevision).toBeGreaterThan(0)
    }
    // 已 RUNNING → 二次认领拒绝
    const again = await scheduler.claimTask({ taskId: ids[0], memberKey: 'alpha:coder' })
    expect(again.ok).toBe(false)
    scheduler.dispose()
  })

  it('claim CAS：expectedRevision 过期 → task_stale_revision', async () => {
    const wake = vi.fn(async () => undefined)
    const scheduler = makeScheduler({ memberWake: wake as never })
    const { ids } = await planTwoTasks(scheduler)
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1))
    const result = await scheduler.claimTask({ taskId: ids[0], memberKey: 'alpha:coder', expectedRevision: 999 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('task_stale_revision')
    scheduler.dispose()
  })

  it('claim 非名下任务 → not_assignee；上游未完成 → task_not_ready', async () => {
    const wake = vi.fn(async () => undefined)
    const scheduler = makeScheduler({ memberWake: wake as never })
    const { ids } = await planTwoTasks(scheduler)
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1))
    const notMine = await scheduler.claimTask({ taskId: ids[0], memberKey: 'alpha:reviewer' })
    expect(notMine.ok).toBe(false)
    if (!notMine.ok) expect(notMine.code).toBe('not_assignee')
    const notReady = await scheduler.claimTask({ taskId: ids[1], memberKey: 'alpha:reviewer' })
    expect(notReady.ok).toBe(false)
    if (!notReady.ok) expect(notReady.code).toBe('task_not_ready')
    scheduler.dispose()
  })

  it('P0 回归：同角色双就绪任务，认领其一后另一任务的 role_busy 拒绝不楔死唤醒守卫', async () => {
    const wake = vi.fn(async () => undefined)
    const scheduler = makeScheduler({ memberWake: wake as never })
    const planner = new TeamPlanner({ persistence, teamManager: manager })
    // 两个同角色、无依赖的任务：同一泵轮次会先后唤醒（两守卫都置位）。
    const output = await planner.plan({
      session_id: 'sess-pull',
      tasks: [
        { id: 'a', description: '实现功能A', assignee: 'coder' },
        { id: 'b', description: '实现功能B', assignee: 'coder' },
      ],
    } as never)
    await scheduler.start({ dagId: output.dag_id, sessionId: 'sess-pull' })
    const ids = output.tasks.map((task) => task.id) as [string, string]
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(2))
    // 成员先认领 a → 成功（守卫清）；再试 b → role_busy 拒绝（旧实现守卫残留）
    const first = await scheduler.claimTask({ taskId: ids[0], memberKey: 'alpha:coder' })
    if (!first.ok) throw new Error('claim failed')
    const busy = await scheduler.claimTask({ taskId: ids[1], memberKey: 'alpha:coder' })
    expect(busy.ok).toBe(false)
    if (!busy.ok) expect(busy.code).toBe('role_busy')
    // a 完成 → 角色释放 → 重泵必须能再次唤醒 b（守卫已被清）
    const completed = await scheduler.completeTask({ taskId: ids[0], memberKey: 'alpha:coder', result: 'ok', attempt: first.attempt })
    expect(completed.ok).toBe(true)
    await vi.waitFor(() => expect(wake.mock.calls.length).toBeGreaterThanOrEqual(3))
    const wokenAgain = (wake as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as { task: { id: string } }
    expect(wokenAgain.task.id).toBe(ids[1])
    scheduler.dispose()
  })

  it('P1 回归：结算缺 attempt 句柄 → attempt_required（无守卫裸写被拒）', async () => {
    const wake = vi.fn(async () => undefined)
    const scheduler = makeScheduler({ memberWake: wake as never })
    const { ids } = await planTwoTasks(scheduler)
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1))
    const claimed = await scheduler.claimTask({ taskId: ids[0], memberKey: 'alpha:coder' })
    if (!claimed.ok) throw new Error('claim failed')
    const noGuard = await scheduler.completeTask({
      taskId: ids[0],
      memberKey: 'alpha:coder',
      result: '越权迟到写',
      // @ts-expect-error 协议回归：模拟调用方丢失句柄
      attempt: undefined,
    })
    expect(noGuard.ok).toBe(false)
    if (!noGuard.ok) expect(noGuard.code).toBe('attempt_required')
    // 句柄仍有效：正常结算应成功
    const ok = await scheduler.completeTask({ taskId: ids[0], memberKey: 'alpha:coder', result: 'ok', attempt: claimed.attempt })
    expect(ok.ok).toBe(true)
    scheduler.dispose()
  })

  it('P2 回归：跨团队同角色名认领 → not_assignee（团队级授权）', async () => {
    const wake = vi.fn(async () => undefined)
    const scheduler = makeScheduler({ memberWake: wake as never })
    const { ids } = await planTwoTasks(scheduler)
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1))
    // memberKey 角色名匹配但 memberTeamId 不一致 → 拒绝
    const cross = await scheduler.claimTask({ taskId: ids[0], memberKey: 'alpha:coder', memberTeamId: 'other-team' })
    expect(cross.ok).toBe(false)
    if (!cross.ok) expect(cross.code).toBe('not_assignee')
    scheduler.dispose()
  })

  it('complete：RUNNING→COMPLETED 走结算链（反思钩子/下游晋升/收敛通知）', async () => {
    const wake = vi.fn(async () => undefined)
    const settled = vi.fn(async () => 1)
    const notifications: string[] = []
    const delegation = makeDelegation()
    const scheduler = makeScheduler({
      memberWake: wake as never,
      onTaskSettledText: settled as never,
      notify: (_sessionId, text) => notifications.push(text),
    }, delegation)
    const { ids } = await planTwoTasks(scheduler)
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1))
    const claimed = await scheduler.claimTask({ taskId: ids[0], memberKey: 'alpha:coder' })
    if (!claimed.ok) throw new Error('claim failed')

    const completed = await scheduler.completeTask({
      taskId: ids[0],
      memberKey: 'alpha:coder',
      result: '功能已实现并通过自测',
      attempt: claimed.attempt,
    })
    expect(completed.ok).toBe(true)
    // 结算链：反思钩子被调（text=result）
    await vi.waitFor(() => expect(settled).toHaveBeenCalled())
    // 下游晋升：reviewer 的 'b' 依赖完成 → codex 是 push 路径 → delegation 被调用
    await vi.waitFor(() => {
      expect((delegation.executeTask as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0)
    })
    // 完成通知入队（终态必达）
    expect(notifications.some((text) => text.includes('完成 ✓'))).toBe(true)
    scheduler.dispose()
  })

  it('release：RUNNING→INTERRUPTED（不自动重唤醒）；队长重开后再次唤醒', async () => {
    const wake = vi.fn(async () => undefined)
    const scheduler = makeScheduler({ memberWake: wake as never })
    const { dagId, ids } = await planTwoTasks(scheduler)
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1))
    const claimed = await scheduler.claimTask({ taskId: ids[0], memberKey: 'alpha:coder' })
    if (!claimed.ok) throw new Error('claim failed')
    const released = await scheduler.releaseTask({ taskId: ids[0], memberKey: 'alpha:coder', reason: '缺上游资料', attempt: claimed.attempt })
    expect(released.ok).toBe(true)
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 30))
    // 不自动重唤醒（任务处于 INTERRUPTED 终态，pump 只唤醒 WAITING）
    expect(wake).toHaveBeenCalledTimes(1)
    // 队长重开（task_retry 语义：INTERRUPTED→WAITING）→ 重泵后再次唤醒
    await persistence.tasks.run((db) =>
      db.prepare("UPDATE tasks SET status = 'WAITING', updated_at = ? WHERE id = ?").run(new Date().toISOString(), ids[0]),
    )
    await scheduler.start({ dagId, sessionId: 'sess-pull' })
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(2))
    scheduler.dispose()
  })

  it('fail：RUNNING→FAILED + 下游 SKIPPED 传播', async () => {
    const wake = vi.fn(async () => undefined)
    const scheduler = makeScheduler({ memberWake: wake as never })
    const { ids } = await planTwoTasks(scheduler)
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1))
    const claimed = await scheduler.claimTask({ taskId: ids[0], memberKey: 'alpha:coder' })
    if (!claimed.ok) throw new Error('claim failed')
    const failed = await scheduler.failTask({ taskId: ids[0], memberKey: 'alpha:coder', message: '实现遇到不可恢复阻塞', attempt: claimed.attempt })
    expect(failed.ok).toBe(true)
    const dag = await scheduler.loadDag((await persistence.tasks.run((db) => db.prepare('SELECT dag_id FROM tasks WHERE id = ?').get(ids[0]) as { dag_id: string })).dag_id)
    const byId = new Map(dag.tasks.map((task) => [task.id, task]))
    expect(byId.get(ids[0])?.status).toBe('FAILED')
    expect(byId.get(ids[1])?.status).toBe('SKIPPED')
    scheduler.dispose()
  })

  it('subjectLabel 与计划衔接：plan_tasks 仍可批量建任务（批量糖）', async () => {
    const wake = vi.fn(async () => undefined)
    const scheduler = makeScheduler({ memberWake: wake as never })
    const { ids } = await planTwoTasks(scheduler)
    expect(ids).toHaveLength(2)
    scheduler.dispose()
    expect(subjectLabel({ id: 'a', description: '实现功能\n第二行' } as never)).toBe('实现功能')
  })
})
