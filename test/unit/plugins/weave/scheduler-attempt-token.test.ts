import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WeavePersistence } from '../../../../src/plugins/weave/persistence/persistence'
import { TeamManager } from '../../../../src/plugins/weave/team/team-manager'
import { TeamPlanner } from '../../../../src/plugins/weave/scheduling/planner'
import { WeaveScheduler, type SchedulerDelegationLike, type WeaveSchedulerOptions } from '../../../../src/plugins/weave/scheduling/scheduler'
import { DagRepository } from '../../../../src/plugins/weave/dag/repository'
import { applyAttemptGuardedWrite, TASK_STALE_REVISION } from '../../../../src/plugins/weave/state/attempt-token'
import type { SubagentTaskOutput } from '../../../../src/plugins/weave/scheduling/delegation-service'
import { WeaveError } from '../../../../src/plugins/weave/state/weave-error'

/**
 * attempt_token + revision 乐观并发（对照 dsh-agent-teams state.ts）：
 * - claim（→RUNNING）签发 UUID 句柄并推进 revision；
 * - 治理（取消/重试/跳过/恢复）作废旧句柄（NULL）+ 推进 revision；
 * - attempt 回写带 { token, expectedRevision } 双验证，迟到写被 task_stale_revision 拒绝。
 */

const lookup = (id: string) => TEAM_ID === id

const TEAM_ID = 'alpha-squad'
const TEAM = {
  id: TEAM_ID,
  name: '阿尔法小队',
  roles: [
    { id: 'coder', name: '程序员', bias: 'dev', executor: 'codex', stages: ['implement'], max_concurrent_tasks: 1, personality: '实现' },
  ],
}

interface AttemptSnapshot {
  token: string | null
  revision: number
  output: string
}

/** Delegation 替身：捕获 claim 后库内句柄，按 (taskId, 第几次进入) 门控放行并脚本输出。 */
class GatedDelegation implements SchedulerDelegationLike {
  readonly captures: Array<{ taskId: string; token: string | null; revision: number }> = []
  private readonly gates = new Map<string, () => void>()
  private readonly waited = new Map<string, Promise<void>>()
  private readonly seq = new Map<string, number>()

  constructor(private readonly persistence: WeavePersistence) {}

  /** 门控：第 occurrence 次（从 1 起）进入 taskId 的执行时挂起，返回放行句柄。 */
  gate(taskId: string, occurrence = 1): () => void {
    const key = `${taskId}#${occurrence}`
    let release!: () => void
    const waited = new Promise<void>((resolve) => {
      release = resolve
    })
    this.gates.set(key, release)
    this.waited.set(key, waited)
    return release
  }

  async executeTask(
    task: { id: string },
    _role: unknown,
    _team: unknown,
    _context: unknown,
    signal: AbortSignal,
  ): Promise<SubagentTaskOutput> {
    const occurrence = (this.seq.get(task.id) ?? 0) + 1
    this.seq.set(task.id, occurrence)
    const row = await this.persistence.tasks.run((db) =>
      db.prepare('SELECT attempt_token, revision FROM tasks WHERE id = ?').get(task.id) as
        | { attempt_token: string | null; revision: number | null }
        | undefined,
    )
    this.captures.push({
      taskId: task.id,
      token: row?.attempt_token ?? null,
      revision: Number(row?.revision ?? 0),
    })
    const waited = this.waited.get(`${task.id}#${occurrence}`)
    if (waited) {
      await Promise.race([
        waited,
        new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
      ])
    }
    if (signal.aborted) return { id: task.id, output: [], stopReason: 'aborted', duration_ms: 0 }
    return {
      id: task.id,
      output: [{ type: 'text' as const, text: `${task.id}-out-gen${occurrence}` }],
      stopReason: 'completed',
      duration_ms: 1,
    }
  }
}

function makeScheduler(
  persistence: WeavePersistence,
  delegation: SchedulerDelegationLike,
  logWarn?: (...args: unknown[]) => void,
): WeaveScheduler {
  const options: WeaveSchedulerOptions = {
    delegation,
    persistence,
    loadTeam: () => TEAM as never,
    notify: () => undefined,
    ...(logWarn !== undefined ? { log: { warn: logWarn } } : {}),
  }
  return new WeaveScheduler(options)
}

async function seedDag(persistence: WeavePersistence, taskId: string): Promise<string> {
  const dagId = `dag-${taskId}`
  const now = new Date().toISOString()
  await persistence.tasks.run((db) => {
    db.prepare(
      `INSERT INTO dags (dag_id, team_id, project_id, version, difficulty, status, created_at, updated_at)
       VALUES (?, ?, 'proj', 'v0', 'normal', 'created', ?, ?)`,
    ).run(dagId, TEAM_ID, now, now)
    db.prepare(
      `INSERT INTO tasks (id, dag_id, session_id, team_id, project_id, version, description,
         dependencies, assigned_agent, executor, status)
       VALUES (?, ?, 'sess-1', ?, 'proj', 'v0', '测试任务', '[]', 'coder', 'codex', 'WAITING')`,
    ).run(taskId, dagId, TEAM_ID)
  })
  return dagId
}

async function readTask(persistence: WeavePersistence, taskId: string): Promise<Record<string, unknown>> {
  return persistence.tasks.run((db) =>
    db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown>,
  )
}

let dir = ''
let persistence: WeavePersistence

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weave-attempt-'))
  persistence = new WeavePersistence({ inMemory: true })
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('attempt_token + revision 乐观并发（claim/迟到写/重派）', () => {
  it('claim 签发句柄：RUNNING 行带 attempt_token 且 revision≥1；终态回写胜出', async () => {
    const delegation = new GatedDelegation(persistence)
    const scheduler = makeScheduler(persistence, delegation)
    const dagId = await seedDag(persistence, 't1')
    const release = delegation.gate('t1', 1)
    await scheduler.start({ dagId, sessionId: 'sess-1' })

    await vi.waitFor(() => {
      expect(delegation.captures.at(-1)?.taskId).toBe('t1')
    })
    const captured = delegation.captures.at(-1)!
    expect(captured.token).not.toBeNull()
    expect(captured.revision).toBeGreaterThanOrEqual(1)
    const running = await readTask(persistence, 't1')
    expect(running.status).toBe('RUNNING')
    expect(running.attempt_token).toBe(captured.token)

    release()
    await vi.waitFor(async () => {
      expect((await readTask(persistence, 't1')).status).toBe('COMPLETED')
    })
    const done = await readTask(persistence, 't1')
    expect(done.result).toBe('t1-out-gen1')
    expect(Number(done.revision)).toBeGreaterThan(captured.revision)
  })

  it('并发双写一胜一拒（协议层）：同 token 双写，携带最新 revision 的一方胜出', () => {
    const db = persistence.tasks.raw
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO tasks (id, dag_id, session_id, team_id, project_id, version, description,
         dependencies, assigned_agent, executor, status, attempt_token, revision)
       VALUES ('t-protocol', 'dag-protocol', 's', 'alpha-squad', 'proj', 'v0', 'x', '[]', 'coder', 'codex', 'RUNNING', 'tok-1', 3)`,
    ).run()
    const guard = { token: 'tok-1', expectedRevision: 3 }
    // 第一写胜出：命中并推进 revision（3 → 4）
    expect(applyAttemptGuardedWrite(db, 't-protocol', { status: 'COMPLETED', result: 'winner' }, guard, now)).toBe(1)
    // 第二写（同句柄、旧 revision）被拒：0 行命中
    expect(applyAttemptGuardedWrite(db, 't-protocol', { status: 'FAILED' }, guard, now)).toBe(0)
    const row = db.prepare('SELECT status, result, revision FROM tasks WHERE id = ?').get('t-protocol') as Record<string, unknown>
    expect(row.status).toBe('COMPLETED')
    expect(row.result).toBe('winner')
    expect(row.revision).toBe(4)
  })

  it('迟到 token：取消作废句柄后，旧 attempt 的完成不被采纳（终态与空 result 保持）', async () => {
    const delegation = new GatedDelegation(persistence)
    const scheduler = makeScheduler(persistence, delegation)
    const dagRepository = new DagRepository(persistence)
    const dagId = await seedDag(persistence, 't2')
    await scheduler.start({ dagId, sessionId: 'sess-1' })
    const release = delegation.gate('t2', 1)
    await vi.waitFor(() => {
      expect(delegation.captures.at(-1)?.taskId).toBe('t2')
    })
    const staleToken = delegation.captures.at(-1)!.token
    expect(staleToken).not.toBeNull()

    // 治理取消：作废句柄（attempt_token=NULL）+ revision+1（invalidateTaskAttempt 语义）
    await dagRepository.cancelTask(dagId, 't2')
    const cancelled = await readTask(persistence, 't2')
    expect(cancelled.status).toBe('CANCELLED')
    expect(cancelled.attempt_token).toBeNull()

    // 旧 attempt 迟到完成：调度器收敛路径尊重终态，不覆写 result
    release()
    await vi.waitFor(async () => {
      expect((await readTask(persistence, 't2')).result).toBeNull()
    })
    const after = await readTask(persistence, 't2')
    expect(after.status).toBe('CANCELLED')
    expect(after.result).toBeNull()
  })

  it('重派后旧 token 失效：取消+重试 → 迟到 COMPLETED 守卫拒绝，新 claim 胜出（一胜一拒）', async () => {
    const logWarn = vi.fn()
    const delegation = new GatedDelegation(persistence)
    const scheduler = makeScheduler(persistence, delegation, logWarn)
    const dagRepository = new DagRepository(persistence)
    const dagId = await seedDag(persistence, 't3')
    await scheduler.start({ dagId, sessionId: 'sess-1' })
    const releaseGen1 = delegation.gate('t3', 1)
    await vi.waitFor(() => {
      expect(delegation.captures.at(-1)?.taskId).toBe('t3')
    })
    const gen1Token = delegation.captures[0]!.token

    // 取消（作废 gen1 句柄）→ 重试（cli task_retry 同形态治理写：WAITING + NULL + rev+1）
    await dagRepository.cancelTask(dagId, 't3')
    await persistence.tasks.run((db) => {
      db.prepare("UPDATE tasks SET status = 'WAITING', attempt_token = NULL, revision = revision + 1, updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), 't3')
    })
    expect((await readTask(persistence, 't3')).attempt_token).toBeNull()

    // 放行 gen1：任务已是 WAITING（重派中）→ 迟到 COMPLETED 走守卫回写 → 被拒；
    // 随后 settle 收尾的重泵自动换代：新 claim 签发新句柄（≠ 旧 token），新代完成胜出。
    releaseGen1()
    await vi.waitFor(() => {
      expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('迟到回写被拒'))
    })
    await vi.waitFor(async () => {
      expect((await readTask(persistence, 't3')).status).toBe('COMPLETED')
    })
    expect(delegation.captures).toHaveLength(2)
    const gen2 = delegation.captures[1]!
    expect(gen2.token).not.toBeNull()
    expect(gen2.token).not.toBe(gen1Token)
    // gen1 的迟到产物不得成为最终交付物
    const final = await readTask(persistence, 't3')
    expect(final.result).toBe('t3-out-gen2')
  })

  it('task_stale_revision 语义：guard 未命中抛 WeaveError(task_stale_revision)（协议函数 0 行 → 调用方折算）', async () => {
    // 调度器侧：迟到回写在 settleWrite 内被折算为告警+拒绝（上一用例覆盖）；
    // 本用例锁定错误码语义本身：WeaveError('task_stale_revision') 可被 code 识别。
    const error = new WeaveError(TASK_STALE_REVISION, 'stale')
    expect(error.code).toBe('task_stale_revision')
    expect(error instanceof WeaveError).toBe(true)
  })
})
