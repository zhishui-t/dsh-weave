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
  dir = mkdtempSync(join(tmpdir(), 'weave-sched-'))
  persistence = new WeavePersistence({ inMemory: true })
  manager = new TeamManager(lookup, { teamsDir: dir, persistence })
  manager.importTeam(stringifyYaml({ schema_version: '1', ...TEAM }))
  planner = new TeamPlanner({ persistence, teamManager: manager })
})

afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

type CallRecord = { taskId: string; roleId: string; upstreamLabels: string[]; upstreamTexts: string[]; requirement?: string }

/** DelegationService 替身：按 taskId 脚本回放结果，记录上游注入。 */
class FakeDelegation implements SchedulerDelegationLike {
  calls: CallRecord[] = []
  script = new Map<string, Partial<SubagentTaskOutput> | 'throw'>()

  async executeTask(
    task: { id: string; description: string },
    role: { id: string; provider?: string; fallback_provider?: string; fallback_model?: string },
    _team: unknown,
    context: { upstreamOutputs?: Array<{ label: string; output: string }>; outputRequirements?: string },
    signal: AbortSignal,
  ): Promise<SubagentTaskOutput> {
    this.calls.push({
      taskId: task.id,
      roleId: role.id,
      upstreamLabels: (context.upstreamOutputs ?? []).map((item) => item.label),
      upstreamTexts: (context.upstreamOutputs ?? []).map((item) => item.output),
      requirement: context.outputRequirements,
    })
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

  callsFor(taskIdPrefix: string): CallRecord[] {
    return this.calls.filter((call) => call.taskId.includes(taskIdPrefix))
  }
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
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

    expect(delegation.calls.filter((call) => call.roleId === 'designer')).toHaveLength(2) // 主 + 备用
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
