import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stringify as stringifyYaml } from 'yaml'

import { WeavePersistence } from '../persistence/persistence'
import { SingleWriterQueue } from '../persistence/single-writer-queue'
import { TeamManager, type ExecutorLookup, type TeamConfig } from '../team-manager'
import { TeamPlanner } from '../planner'
import { WeaveScheduler, type SchedulerDelegationLike } from '../scheduler'
import { TaskStatusNotifier } from '../task-status-notifier'
import { AuditLog } from '../audit/index'
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
  dir = mkdtempSync(join(tmpdir(), 'weave-sched-'))
  persistence = new WeavePersistence({ inMemory: true })
  manager = new TeamManager(lookup, { teamsDir: dir, persistence })
  manager.importTeam(stringifyYaml({ schema_version: '1', ...TEAM }))
  planner = new TeamPlanner({ persistence, teamManager: manager })
})

afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

type CallRecord = {
  taskId: string
  roleId: string
  /** 角色执行器（备用重试必须与主调用同 executor，用户裁定锚定点）。 */
  executor?: string
  provider?: string
  model?: string
  upstreamLabels: string[]
  upstreamTexts: string[]
  requirement?: string
}

/** DelegationService 替身：按 taskId 脚本回放结果，记录上游注入。 */
class FakeDelegation implements SchedulerDelegationLike {
  calls: CallRecord[] = []
  script = new Map<string, Partial<SubagentTaskOutput> | 'throw'>()

  async executeTask(
    task: { id: string; description: string },
    role: { id: string; executor?: string; provider?: string; model?: string; fallback_provider?: string; fallback_model?: string },
    _team: unknown,
    context: { upstreamOutputs?: Array<{ label: string; output: string }>; outputRequirements?: string },
    signal: AbortSignal,
  ): Promise<SubagentTaskOutput> {
    this.calls.push({
      taskId: task.id,
      roleId: role.id,
      executor: role.executor,
      provider: role.provider,
      model: role.model,
      upstreamLabels: (context.upstreamOutputs ?? []).map((item) => item.label),
      upstreamTexts: (context.upstreamOutputs ?? []).map((item) => item.output),
      requirement: context.outputRequirements,
    })
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
    await new Promise((resolve) => setTimeout(resolve, 5))
    if (signal.aborted) return { id: task.id, output: [], stopReason: 'aborted', duration_ms: 0 }
    const step = this.script.get(task.id)
    if (step === 'throw') throw new Error('infra-boom')
    return {
      id: task.id,
      output: [{ type: 'text' as const, text: step?.output?.[0]?.text ?? `${role.id}-done` }],
      stopReason: step?.stopReason ?? 'completed',
      duration_ms: 5,
      ...(step?.diagnostic !== undefined ? { diagnostic: step.diagnostic } : {}),
      ...(step?.weave !== undefined ? { weave: step.weave } : {}),
    }
  }

  #gates = new Map<string, Promise<void>>()
  #gateResolvers = new Map<string, () => void>()

  /** 让指定任务挂起在执行中（构造 RUNNING 现场），release 放行。 */
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

  callsFor(taskIdPrefix: string): CallRecord[] {
    return this.calls.filter((call) => call.taskId.includes(taskIdPrefix))
  }
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function taskStatusOf(taskId: string): Promise<string> {
  const row = await persistence.tasks.run((db) =>
    db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string } | undefined,
  )
  return row?.status ?? 'missing'
}

async function dagStatusOf(dagId: string): Promise<string> {
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

async function makeScheduler() {
  const delegation = new FakeDelegation()
  const notices: Array<{ sessionId: string; text: string }> = []
  const scheduler = new WeaveScheduler({
    delegation,
    persistence,
    loadTeam: (teamId) => manager.loadTeam(teamId),
    notify: (sessionId, text) => { notices.push({ sessionId, text }) },
  })
  return { delegation, notices, scheduler }
}

async function planChain(): Promise<{ dagId: string; ids: [string, string, string] }> {
  await manager.bindTeam('sess-1', 'alpha')
  const output = await planner.plan({
    session_id: 'sess-1',
    tasks: [
      { id: 'a', description: '设计任务', assignee: 'designer' },
      { id: 'b', description: '开发任务', assignee: 'coder', depends_on: ['a'] },
      { id: 'c', description: '审核任务', assignee: 'reviewer', depends_on: ['b'] },
    ],
  })
  return { dagId: output.dag_id, ids: output.tasks.map((task) => task.id) as [string, string, string] }
}

describe('WeaveScheduler（DAG 依赖调度）', () => {
  it('链式调度：a→b→c 依次执行，前序结果进入下游 upstreamOutputs', async () => {
    const { scheduler, delegation, notices } = await makeScheduler()
    const { dagId, ids } = await planChain()
    await scheduler.start({ dagId, sessionId: 'sess-1', parentAgent: undefined })
    await flush(12)

    expect(delegation.calls.map((call) => call.roleId)).toEqual(['designer', 'coder', 'reviewer'])
    // 上游输出：loadDag 里 result 列 → b 的上游 label 是 设计师（设计任务）
    expect(delegation.calls[1]!.upstreamLabels).toEqual(['设计师（设计任务）'])
    expect(delegation.calls[1]!.upstreamTexts).toEqual(['designer-done'])

    const statuses = await persistence.tasks.run((db) =>
      (db.prepare('SELECT id, status FROM tasks WHERE dag_id = ?').all(dagId) as Array<{ status: string }>).map((row) => row.status),
    )
    expect(statuses).toEqual(['COMPLETED', 'COMPLETED', 'COMPLETED'])
    const dagRow = await persistence.tasks.run((db) =>
      db.prepare('SELECT status FROM dags WHERE dag_id = ?').get(dagId) as { status: string },
    )
    expect(dagRow.status).toBe('completed')

    expect(notices.some((notice) => notice.text.includes('「设计任务」开始'))).toBe(true)
    expect(notices.some((notice) => notice.text.includes('「审核任务」完成 ✓'))).toBe(true)
    const summary = notices.find((notice) => notice.text.includes('已结束'))
    expect(summary?.text).toContain('全部任务已完成')
    void ids
  })

  it('无依赖的多角色任务并行执行；完成后触发下游', async () => {
    await manager.bindTeam('sess-p', 'alpha')
    const { scheduler, delegation } = await makeScheduler()
    const output = await planner.plan({
      session_id: 'sess-p',
      tasks: [
        { description: '并行一', assignee: 'coder' },
        { description: '并行二', assignee: 'reviewer', depends_on: [] },
        { description: '汇聚', assignee: 'designer', depends_on: ['T1', 'T2'] },
      ],
    })
    await scheduler.start({ dagId: output.dag_id, sessionId: 'sess-p' })
    await flush(12)

    // coder 与 reviewer 的任务先于 designer 的汇聚任务
    const firstTwo = delegation.calls.slice(0, 2).map((call) => call.taskId)
    expect(firstTwo.sort()).toEqual(output.tasks.map((task) => task.id).slice(0, 2).sort())
    expect(delegation.calls.at(-1)!.roleId).toBe('designer')
    expect(delegation.calls.at(-1)!.upstreamLabels.length).toBe(2)
  })

  it('失败传播：FAILED 后未运行的下游 SKIPPED，汇总提示存在失败项', async () => {
    const { scheduler, delegation, notices } = await makeScheduler()
    const { dagId, ids } = await planChain()
    delegation.script.set(ids[1]!, { stopReason: 'error', diagnostic: 'boom-diag' })
    await scheduler.start({ dagId, sessionId: 'sess-1' })
    await flush(12)

    const rows = await persistence.tasks.run((db) =>
      db.prepare('SELECT id, status FROM tasks WHERE dag_id = ? ORDER BY rowid').all(dagId) as Array<{ id: string; status: string }>,
    )
    expect(rows.map((row) => row.status)).toEqual(['COMPLETED', 'FAILED', 'SKIPPED'])
    const failed = rows.find((row) => row.status === 'FAILED')!
    const detail = await persistence.tasks.run((db) =>
      db.prepare('SELECT error_type FROM tasks WHERE id = ?').get(failed.id) as { error_type: string },
    )
    expect(detail.error_type).toBe('execution_failed')

    const summary = notices.find((notice) => notice.text.includes('已结束'))
    expect(summary?.text).toContain('失败或跳过')
    expect(notices.some((notice) => notice.text.includes('失败 ✗（execution_failed：boom-diag）'))).toBe(true)
  })

  it('fallback 重试一次成功则继续；主模型异常走备用后收敛 COMPLETED', async () => {
    await manager.bindTeam('sess-fb', 'alpha')
    const delegation = new FakeDelegation()
    const notices: Array<{ text: string }> = []
    const scheduler = new WeaveScheduler({
      delegation,
      persistence,
      loadTeam: (teamId) => manager.loadTeam(teamId),
      notify: (_sessionId, text) => { notices.push({ text }) },
    })
    const imported = { ...TEAM, roles: [{ ...TEAM.roles[0]!, fallback_provider: 'fb', fallback_model: 'fb-model' }, ...TEAM.roles.slice(1)] }
    manager.importTeam(stringifyYaml({ schema_version: '1', ...imported }), { overwrite: true })

    // 主模型抛基础设施异常 → 备用模型（provider='fb'）成功
    delegation.executeTask = async (task, role, _team, context) => {
      delegation.calls.push({
        taskId: task.id,
        roleId: role.id,
        executor: role.executor,
        provider: role.provider,
        model: role.model,
        upstreamLabels: (context.upstreamOutputs ?? []).map((item) => item.label),
        upstreamTexts: (context.upstreamOutputs ?? []).map((item) => item.output),
        requirement: context.outputRequirements,
      })
      if (task.description.startsWith('设计任务')) {
        if (role.provider === 'fb') {
          return { id: task.id, output: [{ type: 'text' as const, text: 'fb-recovered' }], stopReason: 'completed' as const, duration_ms: 1 }
        }
        throw new Error('main-boom')
      }
      return { id: task.id, output: [{ type: 'text' as const, text: `${role.id}-done` }], stopReason: 'completed' as const, duration_ms: 1 }
    }

    const output = await planner.plan({
      session_id: 'sess-fb',
      tasks: [
        { id: 'd', description: '设计任务', assignee: 'designer' },
        { id: 'r', description: '评审任务', assignee: 'reviewer', depends_on: ['d'] },
      ],
    })
    await scheduler.start({ dagId: output.dag_id, sessionId: 'sess-fb' })
    await flush(10)

    const designerCalls = delegation.calls.filter((call) => call.roleId === 'designer')
    expect(designerCalls).toHaveLength(2) // 主 + 备用
    // 同执行器锚定（用户裁定）：备用重试与主调用保持同一 executor，仅覆盖 provider/model
    expect(designerCalls[0]!.executor).toBe('codex')
    expect(designerCalls[1]!.executor).toBe(designerCalls[0]!.executor)
    expect(designerCalls[0]!.provider).toBeUndefined()
    expect(designerCalls[1]!.provider).toBe('fb')
    expect(designerCalls[1]!.model).toBe('fb-model')
    expect(delegation.calls.at(-1)!.roleId).toBe('reviewer')
    expect(delegation.calls.at(-1)!.upstreamTexts).toEqual(['fb-recovered'])
    expect(notices.some((notice) => notice.text.includes('备用模型重试'))).toBe(true)

    const rows = await persistence.tasks.run((db) =>
      db.prepare('SELECT status FROM tasks WHERE dag_id = ? ORDER BY rowid').all(output.dag_id) as Array<{ status: string }>,
    )
    expect(rows.map((row) => row.status)).toEqual(['COMPLETED', 'COMPLETED'])
  })

  it('取消联动：onExternalCancel 中止运行中的任务并保持 CANCELLED，下游 SKIPPED', async () => {
    const { scheduler, delegation, notices } = await makeScheduler()
    const { dagId, ids } = await planChain()
    // 阻塞 a 直到外部取消发生
    let releaseFirst!: () => void
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve })
    delegation.executeTask = async (task, role, _team, _context, signal) => {
      delegation.calls.push({ taskId: task.id, roleId: role.id, upstreamLabels: [], upstreamTexts: [], requirement: undefined })
      if (task.id === ids[0]) {
        await gate
        if (signal.aborted) return { id: task.id, output: [], stopReason: 'aborted', duration_ms: 0 }
        return { id: task.id, output: [{ type: 'text' as const, text: 'late' }], stopReason: 'completed', duration_ms: 0 }
      }
      return { id: task.id, output: [{ type: 'text' as const, text: `${role.id}-done` }], stopReason: 'completed', duration_ms: 0 }
    }

    await scheduler.start({ dagId, sessionId: 'sess-1' })
    await flush(3)
    // 外部取消路径与 mcp.taskCancel 对齐：先把状态写 CANCELLED 再通知调度器
    const now = new Date().toISOString()
    await persistence.tasks.run((db) => {
      db.prepare("UPDATE tasks SET status = 'CANCELLED', updated_at = ? WHERE id = ?").run(now, ids[0])
      db.prepare("UPDATE tasks SET status = 'SKIPPED', updated_at = ? WHERE id = ?").run(now, ids[1])
      db.prepare("UPDATE tasks SET status = 'SKIPPED', updated_at = ? WHERE id = ?").run(now, ids[2])
    })
    await scheduler.onExternalCancel(ids[0])
    releaseFirst()
    await flush(8)

    const rows = await persistence.tasks.run((db) =>
      db.prepare('SELECT status FROM tasks WHERE dag_id = ? ORDER BY rowid').all(dagId) as Array<{ status: string }>,
    )
    expect(rows.map((row) => row.status)).toEqual(['CANCELLED', 'SKIPPED', 'SKIPPED'])
    expect(notices.some((notice) => notice.text.includes('已取消'))).toBe(true)
  })

  it('max_concurrent_tasks=1 的角色串行；运行时占用表反映执行中状态并最终清空', async () => {
    await manager.bindTeam('sess-mc', 'alpha')
    const { scheduler, delegation } = await makeScheduler()
    // 两级同角色依赖链（sequential）→ 同一角色先后两次
    const output = await planner.plan({
      session_id: 'sess-mc',
      tasks: [
        { description: '第一段', assignee: 'coder' },
        { description: '第二段', assignee: 'coder', depends_on: ['T1'] },
      ],
    })
    delegation.executeTask = async (task, role, _team, context, signal) => {
      delegation.calls.push({
        taskId: task.id,
        roleId: role.id,
        upstreamLabels: (context.upstreamOutputs ?? []).map((item) => item.label),
        upstreamTexts: (context.upstreamOutputs ?? []).map((item) => item.output),
        requirement: context.outputRequirements,
      })
      await new Promise((resolve) => setTimeout(resolve, 30))
      if (signal.aborted) return { id: task.id, output: [], stopReason: 'aborted', duration_ms: 0 }
      return { id: task.id, output: [{ type: 'text' as const, text: `${role.id}-done-${task.id}` }], stopReason: 'completed', duration_ms: 0 }
    }

    await scheduler.start({ dagId: output.dag_id, sessionId: 'sess-mc' })
    await flush(4)
    const duringCalls = delegation.calls.length
    const runtimeDuring = scheduler.memberRuntime('sess-mc')
    await flush(14)

    expect(runtimeDuring.every((info) => info.subject === '第二段' || info.subject === '第一段')).toBe(true)
    void duringCalls
    expect(scheduler.memberRuntime('sess-mc')).toHaveLength(0)
    expect(delegation.calls.map((call) => call.taskId.split('-').pop())).toEqual(['T1', 'T2'])
  })

  it('团队角色同时只执行一个任务：同角色双任务串行（忽略 max_concurrent_tasks>1）', async () => {
    // designer 的并发上限改为 3，验证调度器仍强制单并发
    const imported = {
      ...TEAM,
      roles: [{ ...TEAM.roles[0]!, max_concurrent_tasks: 3 }, ...TEAM.roles.slice(1)],
    }
    manager.importTeam(stringifyYaml({ schema_version: '1', ...imported }), { overwrite: true })
    await manager.bindTeam('sess-one', 'alpha')

    const { scheduler, delegation } = await makeScheduler()
    const output = await planner.plan({
      session_id: 'sess-one',
      tasks: [
        { description: '甲任务', assignee: 'designer' },
        { description: '乙任务', assignee: 'designer' },
      ],
    })

    let inFlight = 0
    let peak = 0
    delegation.executeTask = async (task, role, _team, context, signal) => {
      delegation.calls.push({
        taskId: task.id,
        roleId: role.id,
        upstreamLabels: (context.upstreamOutputs ?? []).map((item) => item.label),
        upstreamTexts: (context.upstreamOutputs ?? []).map((item) => item.output),
        requirement: context.outputRequirements,
      })
      inFlight += 1
      peak = Math.max(peak, inFlight)
      try {
        await new Promise((resolve) => setTimeout(resolve, 25))
        if (signal.aborted) return { id: task.id, output: [], stopReason: 'aborted' as const, duration_ms: 0 }
        return {
          id: task.id,
          output: [{ type: 'text' as const, text: `${role.id}-done` }],
          stopReason: 'completed' as const,
          duration_ms: 0,
        }
      } finally {
        inFlight -= 1
      }
    }

    await scheduler.start({ dagId: output.dag_id, sessionId: 'sess-one' })
    await flush(12)

    expect(delegation.calls).toHaveLength(2)
    expect(peak).toBe(1) // 任意时刻最多一个该角色任务在跑
    const rows = await persistence.tasks.run((db) =>
      db.prepare('SELECT status FROM tasks WHERE dag_id = ? ORDER BY rowid').all(output.dag_id) as Array<{ status: string }>,
    )
    expect(rows.map((row) => row.status)).toEqual(['COMPLETED', 'COMPLETED'])
  })

  it('start 引用不存在的 DAG → task_not_found', async () => {
    const { scheduler } = await makeScheduler()
    await expect(scheduler.start({ dagId: 'ghost-dag', sessionId: 's' })).rejects.toMatchObject({
      code: 'task_not_found',
    })
  })
})

describe('WeaveScheduler 旁路发电（doc/05 §6.4 P1-D 接线点 1/2）', () => {
  it('onExternalCancel：RUNNING 任务发电「user→CANCELLED」并写 task.status_changed 审计', async () => {
    await manager.bindTeam('sess-1', 'alpha')
    const delegation = new FakeDelegation()
    const notified: Array<{ sessionId: string; text: string }> = []
    const auditDir = mkdtempSync(join(tmpdir(), 'weave-audit-t18-'))
    const audit = new AuditLog({ dir: auditDir, queue: new SingleWriterQueue() })
    const scheduler = new WeaveScheduler({
      delegation,
      persistence,
      loadTeam: (teamId) => manager.loadTeam(teamId),
      notify: () => {},
      // 开启回声验证接线本身（§6.4：user 动作缺省不回声，部署可经 echoSelfActions 打开）
      statusNotifier: new TaskStatusNotifier({ notify: (sessionId, text) => notified.push({ sessionId, text }), echoSelfActions: true }),
      audit,
    })

    const output = await planner.plan({
      session_id: 'sess-1',
      tasks: [{ id: 'a', description: '长任务', assignee: 'coder' }],
    })
    const dagId = output.dag_id
    const taskId = output.tasks[0]!.id
    delegation.gate(taskId)
    await scheduler.start({ dagId, sessionId: 'sess-1' })
    await waitUntil(() => taskStatusOf(taskId).then((s) => s === 'RUNNING'))

    await scheduler.onExternalCancel(taskId)
    await waitUntil(() => taskStatusOf(taskId).then((s) => s === 'CANCELLED'))

    expect(notified).toHaveLength(1)
    expect(notified[0]!.sessionId).toBe('sess-1')
    expect(notified[0]!.text).toContain('「长任务」RUNNING → CANCELLED（task_cancel）')

    const records = await audit.query({ types: ['task.status_changed'] })
    expect(records.some((r) => (r as { task_id: string; from: string; to: string; by: string }).task_id === taskId
      && (r as { from: string }).from === 'RUNNING'
      && (r as { to: string }).to === 'CANCELLED'
      && (r as { by: string }).by === 'user')).toBe(true)
    rmSync(auditDir, { recursive: true, force: true })
  })

  it('onExternalRetry：恢复批量 notifyBatch（SKIPPED→WAITING）+ 审计', async () => {
    await manager.bindTeam('sess-retry', 'alpha')
    const delegation = new FakeDelegation()
    const notified: Array<{ sessionId: string; text: string }> = []
    const auditDir = mkdtempSync(join(tmpdir(), 'weave-audit-t18b-'))
    const audit = new AuditLog({ dir: auditDir, queue: new SingleWriterQueue() })
    const scheduler = new WeaveScheduler({
      delegation,
      persistence,
      loadTeam: (teamId) => manager.loadTeam(teamId),
      notify: () => {},
      statusNotifier: new TaskStatusNotifier({ notify: (sessionId, text) => notified.push({ sessionId, text }), echoSelfActions: true }),
      audit,
    })

    // a(designer,挂起) → b(coder) → c(coder)；d(reviewer,挂起) 独立枝，保持 DAG 在途
    const output = await planner.plan({
      session_id: 'sess-retry',
      tasks: [
        { id: 'a', description: '设计任务', assignee: 'designer' },
        { id: 'b', description: '开发任务', assignee: 'coder', depends_on: ['a'] },
        { id: 'c', description: '复审任务', assignee: 'coder', depends_on: ['b'] },
        { id: 'd', description: '值守任务', assignee: 'reviewer' },
      ],
    })
    const dagId = output.dag_id
    const ids = output.tasks.map((task) => task.id)
    delegation.gate(ids[0]!)
    delegation.gate(ids[3]!)
    await scheduler.start({ dagId, sessionId: 'sess-retry' })
    await waitUntil(() => taskStatusOf(ids[0]!).then((s) => s === 'RUNNING'))

    await scheduler.onExternalCancel(ids[0]!)
    await waitUntil(() => taskStatusOf(ids[2]!).then((s) => s === 'SKIPPED'))
    expect(await taskStatusOf(ids[3]!)).toBe('RUNNING') // d 在途 → DAG 未收敛，run 存活

    // 模拟 task_retry 前置：a 置回 WAITING 后触发重试联动
    await persistence.tasks.run((db) =>
      db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run('WAITING', new Date().toISOString(), ids[0]!),
    )
    await scheduler.onExternalRetry(ids[0]!)

    // 第 1 条为取消发电（接线点 1），第 2 条为恢复批量汇总（接线点 2）
    expect(notified).toHaveLength(2)
    expect(notified[0]!.text).toContain('「设计任务」RUNNING → CANCELLED（task_cancel）')
    expect(notified[1]!.text).toContain(`任务图 ${dagId} 状态变更 2 项：`)
    // b 依赖的 a 处于 WAITING（未完成）→ reactivateSkipped 按就绪度给 BLOCKED；c 依赖 b 同理
    expect(notified[1]!.text.match(/SKIPPED → BLOCKED（task_retry）/g)).toHaveLength(2)
    const records = await audit.query({ types: ['task.status_changed'] })
    // 审计边界（AC-TASK-002）：仅矩阵内转移入账——取消（RUNNING→CANCELLED）在账；
    // SKIPPED→BLOCKED 属派生规则（AC-TASK-004）被审计拒绝，不虚增账目。
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ task_id: ids[0], from: 'RUNNING', to: 'CANCELLED', by: 'user' })

    // 放行后链路恢复执行：a→b→c 依次完成
    delegation.release(ids[0]!)
    await waitUntil(() => taskStatusOf(ids[2]!).then((s) => s === 'COMPLETED'))
    rmSync(auditDir, { recursive: true, force: true })
  })
})

describe('WeaveScheduler 跨任务组拾取（doc/05 §6.5 P1-G G-①）', () => {
  it('两 DAG 抢同角色：A 组任务完成后 B 组 WAITING 任务被全局重泵拾取执行', async () => {
    await manager.bindTeam('sess-cross', 'alpha')
    const delegation = new FakeDelegation()
    const scheduler = new WeaveScheduler({
      delegation,
      persistence,
      loadTeam: (teamId) => manager.loadTeam(teamId),
      notify: () => {},
    })

    // DAG A：coder 任务挂起在执行中（占住角色互斥额度）
    const planA = await planner.plan({
      session_id: 'sess-cross',
      tasks: [{ id: 'a1', description: 'A 组长任务', assignee: 'coder' }],
    })
    const a1 = planA.tasks[0]!.id
    delegation.gate(a1)
    await scheduler.start({ dagId: planA.dag_id, sessionId: 'sess-cross' })
    await waitUntil(() => taskStatusOf(a1).then((s) => s === 'RUNNING'))

    // DAG B：同角色新任务 → 角色被 A 占用，保持 WAITING（跨 DAG 共占额度）
    const planB = await planner.plan({
      session_id: 'sess-cross',
      tasks: [{ id: 'b1', description: 'B 组任务', assignee: 'coder' }],
    })
    const b1 = planB.tasks[0]!.id
    await scheduler.start({ dagId: planB.dag_id, sessionId: 'sess-cross' })
    await flush(4)
    expect(await taskStatusOf(b1)).toBe('WAITING')

    // 释放 A1：角色释放事件必须唤醒 B 组（修复前只重泵 A 组，B1 永久饿死）
    delegation.release(a1)
    await waitUntil(() => taskStatusOf(a1).then((s) => s === 'COMPLETED'))
    await waitUntil(() => taskStatusOf(b1).then((s) => s === 'COMPLETED'))
    expect(await dagStatusOf(planB.dag_id)).toBe('completed')
  })
})
describe('WeaveScheduler run 冷启动重建（doc/05 §6.5 P1-G G-②）', () => {
  it('已收敛 DAG 任务置回 WAITING 后 onExternalRetry：重建 run → 执行 → 二次收敛', async () => {
    await manager.bindTeam('sess-ensure', 'alpha')
    const delegation = new FakeDelegation()
    const scheduler = new WeaveScheduler({
      delegation,
      persistence,
      loadTeam: (teamId) => manager.loadTeam(teamId),
      notify: () => {},
    })

    const plan = await planner.plan({
      session_id: 'sess-ensure',
      tasks: [{ id: 'r1', description: '重启任务', assignee: 'coder' }],
    })
    const dagId = plan.dag_id
    const taskId = plan.tasks[0]!.id
    await scheduler.start({ dagId, sessionId: 'sess-ensure' })
    await waitUntil(() => dagStatusOf(dagId).then((s) => s === 'completed'))
    expect(await taskStatusOf(taskId)).toBe('COMPLETED')

    // 模拟 retry 前置：任务置回 WAITING（run 已随首次收敛销毁——修复前此入口静默早退）
    await persistence.tasks.run((db) =>
      db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('WAITING', taskId),
    )
    await scheduler.onExternalRetry(taskId)

    await waitUntil(() => taskStatusOf(taskId).then((s) => s === 'COMPLETED'))
    expect(await dagStatusOf(dagId)).toBe('completed')
  })

  it('onExternalRetry 对不存在的任务不抛错（防御不变）', async () => {
    await manager.bindTeam('sess-guard', 'alpha')
    const delegation = new FakeDelegation()
    const scheduler = new WeaveScheduler({
      delegation,
      persistence,
      loadTeam: (teamId) => manager.loadTeam(teamId),
      notify: () => {},
    })
    await expect(scheduler.onExternalRetry('no-such-task')).resolves.toBeUndefined()
  })
})

/**
 * 支持槽位回调的替身（假并行修复）：acquiredGate 模拟排队/放行窗口——
 * executeTask 先卡在「等槽」，releaseAcquired 放行后才触发 context.onAcquired，
 * 再进入基类执行流。复刻真实 DelegationService 的时序契约。
 */
class HookedDelegation extends FakeDelegation {
  readonly supportsSlotAcquiredHook = true
  acquiredSequence: string[] = []
  /** 进入 executeTask 即记派发（真实 DelegationService 语义：先入队等槽）。 */
  dispatched: string[] = []
  #acquiredGates = new Map<string, Promise<void>>()
  #acquiredResolvers = new Map<string, () => void>()

  gateAcquired(taskId: string): void {
    if (this.#acquiredGates.has(taskId)) return
    this.#acquiredGates.set(
      taskId,
      new Promise<void>((resolve) => {
        this.#acquiredResolvers.set(taskId, resolve)
      }),
    )
  }

  releaseAcquired(taskId: string): void {
    this.#acquiredResolvers.get(taskId)?.()
  }

  async executeTask(
    task: { id: string; description: string },
    role: { id: string; provider?: string; fallback_provider?: string; fallback_model?: string },
    team: unknown,
    context: {
      onAcquired?: () => void | Promise<void>
      upstreamOutputs?: Array<{ label: string; output: string }>
      outputRequirements?: string
    },
    signal: AbortSignal,
  ): Promise<SubagentTaskOutput> {
    this.dispatched.push(task.id)
    const gate = this.#acquiredGates.get(task.id)
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
    if (signal.aborted) return { id: task.id, output: [], stopReason: 'aborted', duration_ms: 0 }
    if (context.onAcquired) {
      this.acquiredSequence.push(task.id)
      await context.onAcquired()
    }
    return super.executeTask(task, role, team, context, signal)
  }
}

describe('WeaveScheduler 假并行修复（RUNNING 时点后移到槽位获得）', () => {
  it('槽位回调路径：排队期任务保持 WAITING（memberRuntime=queued、无开始通知），onAcquired 后才 RUNNING', async () => {
    await manager.bindTeam('sess-hook', 'alpha')
    const delegation = new HookedDelegation()
    const notices: Array<{ text: string }> = []
    const scheduler = new WeaveScheduler({
      delegation,
      persistence,
      loadTeam: (teamId) => manager.loadTeam(teamId),
      notify: (_sessionId, text) => { notices.push({ text }) },
    })
    const plan = await planner.plan({
      session_id: 'sess-hook',
      tasks: [{ id: 'h1', description: '排队任务', assignee: 'coder' }],
    })
    const taskId = plan.tasks[0]!.id
    // 模拟执行器槽被占：任务卡在排队窗口；再 gate 基类执行流，让 RUNNING 态可观察
    delegation.gateAcquired(taskId)
    delegation.gate(taskId)

    await scheduler.start({ dagId: plan.dag_id, sessionId: 'sess-hook' })
    await flush(4)

    // 已派发（executeTask 已进入）但仍在排队：状态不得显示 RUNNING
    expect(delegation.dispatched).toEqual([taskId])
    expect(await taskStatusOf(taskId)).toBe('WAITING')
    expect(scheduler.memberRuntime('sess-hook').map((info) => info.phase)).toEqual(['queued'])
    expect(notices.some((notice) => notice.text.includes('「排队任务」开始'))).toBe(false)
    expect(delegation.acquiredSequence).toEqual([])

    // 拿到槽：onAcquired 触发 → RUNNING + 开始通知 + 阶段翻转
    delegation.releaseAcquired(taskId)
    await waitUntil(() => taskStatusOf(taskId).then((s) => s === 'RUNNING'))
    expect(delegation.acquiredSequence).toEqual([taskId])
    expect(scheduler.memberRuntime('sess-hook').map((info) => info.phase)).toEqual(['running'])
    expect(notices.some((notice) => notice.text.includes('「排队任务」开始'))).toBe(true)

    delegation.release(taskId)
    await waitUntil(() => taskStatusOf(taskId).then((s) => s === 'COMPLETED'))
    expect(scheduler.memberRuntime('sess-hook')).toHaveLength(0)
  })

  it('排队期被外部取消：onAcquired 不把终态覆写成 RUNNING', async () => {
    await manager.bindTeam('sess-hook-cancel', 'alpha')
    const delegation = new HookedDelegation()
    const scheduler = new WeaveScheduler({
      delegation,
      persistence,
      loadTeam: (teamId) => manager.loadTeam(teamId),
      notify: () => {},
    })
    const plan = await planner.plan({
      session_id: 'sess-hook-cancel',
      tasks: [{ id: 'hc1', description: '排队即取消任务', assignee: 'coder' }],
    })
    const taskId = plan.tasks[0]!.id
    delegation.gateAcquired(taskId)
    await scheduler.start({ dagId: plan.dag_id, sessionId: 'sess-hook-cancel' })
    await flush(4)
    expect(await taskStatusOf(taskId)).toBe('WAITING')

    // 排队窗口内外部取消（与 mcp.taskCancel 对齐：先写 CANCELLED 再中止）
    const now = new Date().toISOString()
    await persistence.tasks.run((db) =>
      db.prepare("UPDATE tasks SET status = 'CANCELLED', updated_at = ? WHERE id = ?").run(now, taskId),
    )
    await scheduler.onExternalCancel(taskId)
    delegation.releaseAcquired(taskId)
    await flush(6)

    expect(delegation.acquiredSequence).toEqual([]) // signal 先行中止，onAcquired 未触发
    expect(await taskStatusOf(taskId)).toBe('CANCELLED')
  })

  it('无槽位回调（历史委托实现）：派发点立即写 RUNNING + 开始通知，行为不变', async () => {
    await manager.bindTeam('sess-legacy', 'alpha')
    const delegation = new FakeDelegation()
    const notices: Array<{ text: string }> = []
    const scheduler = new WeaveScheduler({
      delegation,
      persistence,
      loadTeam: (teamId) => manager.loadTeam(teamId),
      notify: (_sessionId, text) => { notices.push({ text }) },
    })
    const plan = await planner.plan({
      session_id: 'sess-legacy',
      tasks: [{ id: 'l1', description: '历史行为任务', assignee: 'coder' }],
    })
    const taskId = plan.tasks[0]!.id
    delegation.gate(taskId)

    await scheduler.start({ dagId: plan.dag_id, sessionId: 'sess-legacy' })
    await waitUntil(() => taskStatusOf(taskId).then((s) => s === 'RUNNING'))

    expect(delegation.calls).toHaveLength(1)
    expect(scheduler.memberRuntime('sess-legacy').map((info) => info.phase)).toEqual(['running'])
    expect(notices.some((notice) => notice.text.includes('「历史行为任务」开始'))).toBe(true)

    delegation.release(taskId)
    await waitUntil(() => taskStatusOf(taskId).then((s) => s === 'COMPLETED'))
  })
})
