import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stringify as stringifyYaml } from 'yaml'

import { WeavePersistence } from '../../../../src/plugins/weave/persistence/persistence'
import { TeamManager, type ExecutorLookup, type TeamConfig } from '../../../../src/plugins/weave/team/team-manager.js'
import { TeamPlanner } from '../../../../src/plugins/weave/scheduling/planner'
import { WeaveScheduler, type SchedulerDelegationLike } from '../../../../src/plugins/weave/scheduling/scheduler'
import { DagActivity } from '../../../../src/plugins/weave/scheduling/activity-waiter'
import type { SubagentTaskOutput } from '../../../../src/plugins/weave/scheduling/delegation-service'

/** 探测 promise 是否仍未结算（50ms 窗口）。 */
async function pendingOf(promise: Promise<unknown>): Promise<boolean> {
  let settled = false
  const probe = promise.then(() => { settled = true }, () => { settled = true })
  await Promise.race([probe, new Promise((resolve) => setTimeout(resolve, 50))])
  return !settled
}

/* ============================ DagActivity 单元 ============================ */

describe('DagActivity（一次性变更等待者）', () => {
  let activity: DagActivity
  const registry: AbortController[] = []

  const newController = (): AbortController => {
    const controller = new AbortController()
    registry.push(controller)
    return controller
  }

  beforeEach(() => {
    activity = new DagActivity()
  })

  afterEach(() => {
    // 兜底唤醒所有残留等待者：清掉其 setTimeout，避免悬挂定时器拖住测试进程。
    activity.close()
    vi.useRealTimers()
  })

  it('notify 唤醒同一 DAG 的全部等待者并从集合移除，其他 DAG 等待者不受影响', async () => {
    const first = activity.wait('dag-a', 10_000, newController().signal)
    const second = activity.wait('dag-a', 10_000, newController().signal)
    const other = activity.wait('dag-b', 10_000, newController().signal)

    activity.notify('dag-a')
    await expect(first).resolves.toEqual({ timedOut: false })
    await expect(second).resolves.toEqual({ timedOut: false })
    // 其他 DAG 的等待者不被误唤醒
    expect(await pendingOf(other)).toBe(true)
    // 唤醒后等待者已移除：重复 notify 是无害的零操作
    activity.notify('dag-a')
    expect(await pendingOf(other)).toBe(true)
  })

  it('超时：等满 timeoutMs 单独返回 timedOut=true（无 notify 时）', async () => {
    vi.useFakeTimers()
    const waiting = activity.wait('dag-a', 10_000, newController().signal)
    let result: { timedOut: boolean } | undefined
    const settled = waiting.then((value) => { result = value })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(result).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await settled
    expect(result).toEqual({ timedOut: true })
  })

  it('abort：等待以 abort 原因拒绝；Error 原因透传，非 Error 原因收敛为 wait_aborted', async () => {
    const errorAbort = newController()
    const waiting = activity.wait('dag-a', 10_000, errorAbort.signal)
    errorAbort.abort(new Error('stop-waiting'))
    await expect(waiting).rejects.toThrow('stop-waiting')

    const plainAbort = newController()
    const plainWait = activity.wait('dag-a', 10_000, plainAbort.signal)
    plainAbort.abort('plain-reason')
    await expect(plainWait).rejects.toMatchObject({
      name: 'WeaveError',
      code: 'wait_aborted',
    })

    const preAborted = newController()
    preAborted.abort()
    await expect(activity.wait('dag-a', 10_000, preAborted.signal)).rejects.toThrow()
  })

  it('单赢家：notify/abort 竞态下 settled 标志保证只结算一次（双向）', async () => {
    // notify 先赢：同一 signal 的后置 abort 不得再产生拒绝（无 unhandled rejection）
    const notifyWon = newController()
    const first = activity.wait('dag-a', 10_000, notifyWon.signal)
    activity.notify('dag-a')
    await expect(first).resolves.toEqual({ timedOut: false })
    notifyWon.abort(new Error('late'))
    await new Promise((resolve) => setTimeout(resolve, 20))

    // abort 先赢：随后 notify 不得覆写结算结果
    const abortWon = newController()
    const second = activity.wait('dag-a', 10_000, abortWon.signal)
    abortWon.abort(new Error('first-wins'))
    activity.notify('dag-a')
    await expect(second).rejects.toThrow('first-wins')
  })

  it('timeoutMs 校验：越界与非整数抛 invalid_argument', async () => {
    for (const bad of [5_000, 3_600_001, 10_000.5, Number.NaN]) {
      await expect(activity.wait('dag-a', bad, newController().signal)).rejects.toMatchObject({
        name: 'WeaveError',
        code: 'invalid_argument',
      })
    }
  })

  it('close：唤醒全部现存等待者并关闭准入（close 后 wait 立即返回）', async () => {
    const first = activity.wait('dag-a', 10_000, newController().signal)
    const second = activity.wait('dag-b', 10_000, newController().signal)
    activity.close()
    await expect(first).resolves.toEqual({ timedOut: false })
    await expect(second).resolves.toEqual({ timedOut: false })
    await expect(activity.wait('dag-a', 10_000, newController().signal)).resolves.toEqual({ timedOut: false })
  })
})

/* ============================ 调度器 waitForChange ============================ */

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
    { id: 'coder', name: '程序员', bias: 'dev', executor: 'codex', stages: ['implement'], max_concurrent_tasks: 1, personality: '实现' },
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
  dir = mkdtempSync(join(tmpdir(), 'weave-activity-'))
  persistence = new WeavePersistence({ inMemory: true })
  manager = new TeamManager(lookup, { teamsDir: dir, persistence })
  manager.importTeam(stringifyYaml({ schema_version: '1', ...TEAM }))
  planner = new TeamPlanner({ persistence, teamManager: manager })
})

afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** 单任务挂起替身：gate 让任务停在执行中，release 放行收敛。 */
class GatedDelegation implements SchedulerDelegationLike {
  #gates = new Map<string, Promise<void>>()
  #resolvers = new Map<string, () => void>()

  async executeTask(
    task: { id: string },
    _role: unknown,
    _team: unknown,
    _context: unknown,
    signal: AbortSignal,
  ): Promise<SubagentTaskOutput> {
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
    return { id: task.id, output: [{ type: 'text' as const, text: 'done' }], stopReason: 'completed', duration_ms: 1 }
  }

  gate(taskId: string): void {
    if (this.#gates.has(taskId)) return
    this.#gates.set(taskId, new Promise<void>((resolve) => { this.#resolvers.set(taskId, resolve) }))
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

async function planSingle(): Promise<{ dagId: string; taskId: string }> {
  await manager.bindTeam('sess-1', 'alpha')
  const output = await planner.plan({
    session_id: 'sess-1',
    tasks: [{ id: 'a', description: '单独任务', assignee: 'coder' }],
  })
  return { dagId: output.dag_id, taskId: output.tasks[0]!.id }
}

describe('WeaveScheduler.waitForChange（队长值守等待）', () => {
  it('noProgress：DAG 无在途任务时立即返回，不空等', async () => {
    const { dagId } = await planSingle()
    const scheduler = new WeaveScheduler({
      delegation: new GatedDelegation(),
      persistence,
      loadTeam: (teamId) => manager.loadTeam(teamId),
      notify: () => {},
    })
    // 未 start：全部任务非在途 → 立即 noProgress
    const started = Date.now()
    await expect(scheduler.waitForChange(dagId, 10_000, new AbortController().signal))
      .resolves.toEqual({ timedOut: false, noProgress: true })
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('在途任务收敛时被唤醒：timedOut=false 且 noProgress=false', async () => {
    const { dagId, taskId } = await planSingle()
    const delegation = new GatedDelegation()
    delegation.gate(taskId)
    const scheduler = new WeaveScheduler({
      delegation,
      persistence,
      loadTeam: (teamId) => manager.loadTeam(teamId),
      notify: () => {},
    })
    try {
      await scheduler.start({ dagId, sessionId: 'sess-1' })
      await flush()

      const waiting = scheduler.waitForChange(dagId, 10_000, new AbortController().signal)
      expect(await pendingOf(waiting)).toBe(true)
      delegation.release(taskId)
      await expect(waiting).resolves.toEqual({ timedOut: false, noProgress: false })
    } finally {
      scheduler.dispose()
    }
  })

  it('不存在的 DAG：抛 task_not_found（与 loadDag 语义一致）', async () => {
    const scheduler = new WeaveScheduler({
      delegation: new GatedDelegation(),
      persistence,
      loadTeam: (teamId) => manager.loadTeam(teamId),
      notify: () => {},
    })
    await expect(scheduler.waitForChange('dag-missing', 10_000, new AbortController().signal))
      .rejects.toMatchObject({ name: 'WeaveError', code: 'task_not_found' })
  })
})
