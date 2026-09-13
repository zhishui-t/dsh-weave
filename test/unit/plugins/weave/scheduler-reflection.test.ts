import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stringify as stringifyYaml } from 'yaml'

import { WeavePersistence } from '../../../../src/plugins/weave/persistence/persistence'
import { TeamManager, type ExecutorLookup, type TeamConfig } from '../../../../src/plugins/weave/team/team-manager.js'
import { TeamPlanner } from '../../../../src/plugins/weave/scheduling/planner'
import { WeaveScheduler, subjectLabel, type SchedulerDelegationLike, type WeaveSchedulerOptions } from '../../../../src/plugins/weave/scheduling/scheduler'
import { PrismGateway } from '../../../../src/plugins/weave/prism/gateway'
import { PrismClient } from '../../../../src/plugins/weave/prism/prism-client'
import { KnowledgeStaging } from '../../../../src/plugins/weave/prism/knowledge-staging'
import { PrismReflectionService } from '../../../../src/plugins/weave/prism/reflection'
import type { SubagentTaskOutput } from '../../../../src/plugins/weave/scheduling/delegation-service'

const lookup: ExecutorLookup = {
  get(id) {
    return id === 'codex'
      ? { id, name: id, kind: 'codex', capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false } }
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

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'weave-sched-reflect-'))
  persistence = new WeavePersistence({ inMemory: true })
  manager = new TeamManager(lookup, { teamsDir: dir, persistence })
  await manager.importTeam(stringifyYaml({ schema_version: '1', ...TEAM }))
  planner = new TeamPlanner({ persistence, teamManager: manager })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

class FakeDelegation implements SchedulerDelegationLike {
  calls: Array<{ taskId: string; roleId: string }> = []
  script = new Map<string, Partial<SubagentTaskOutput> | 'throw'>()

  async executeTask(
    task: { id: string; description: string },
    role: { id: string; provider?: string; fallback_provider?: string; fallback_model?: string },
    _team: unknown,
    _context: unknown,
    signal: AbortSignal,
  ): Promise<SubagentTaskOutput> {
    this.calls.push({ taskId: task.id, roleId: role.id })
    await new Promise((resolve) => setTimeout(resolve, 1))
    if (signal.aborted) return { id: task.id, output: [], stopReason: 'aborted', duration_ms: 0 }
    const step = this.script.get(task.id)
    if (step === 'throw') throw new Error('infra-boom')
    return {
      id: task.id,
      output: [{ type: 'text' as const, text: step?.output?.[0]?.text ?? `${role.id}-done` }],
      stopReason: step?.stopReason ?? 'completed',
      duration_ms: 1,
      ...(step?.diagnostic !== undefined ? { diagnostic: step.diagnostic } : {}),
      ...(step?.weave !== undefined ? { weave: step.weave } : {}),
    }
  }
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function planOneTask(taskId: string, assignee = 'coder'): Promise<{ dagId: string; taskId: string }> {
  await manager.bindTeam('sess-r', 'alpha')
  const output = await planner.plan({
    session_id: 'sess-r',
    tasks: [{ id: taskId, description: '单一任务', assignee }],
  })
  return { dagId: output.dag_id, taskId: output.tasks[0]!.id }
}

describe('WeaveScheduler.onTaskSettledText', () => {
  it('COMPLETED 分支：钩子收到正确 task.id/text/status，返回 2 触发反思沉淀通知', async () => {
    const delegation = new FakeDelegation()
    const settledCalls: Array<{ taskId: string; text: string; status: string }> = []
    const notices: Array<{ text: string }> = []
    const scheduler = new WeaveScheduler({
      delegation,
      persistence,
      loadTeam: (teamId) => manager.loadTeam(teamId),
      notify: (_sessionId, text) => { notices.push({ text }) },
      onTaskSettledText: async (params) => {
        settledCalls.push({ taskId: params.task.id, text: params.text, status: params.status })
        return 2
      },
    })

    const { dagId, taskId: completedTaskId } = await planOneTask('task-completed')
    await scheduler.start({ dagId, sessionId: 'sess-r' })
    await flush()

    expect(settledCalls).toEqual([{ taskId: completedTaskId, text: 'coder-done', status: 'COMPLETED' }])
    expect(notices.some((notice) => notice.text.includes('反思沉淀 2 条候选知识（待审核）'))).toBe(true)

    const rows = await persistence.tasks.run((db) =>
      db.prepare('SELECT id, status FROM tasks WHERE dag_id = ?').all(dagId) as Array<{ id: string; status: string }>,
    )
    expect(rows[0]?.status).toBe('COMPLETED')
  })

  it('FAILED 分支：钩子同样触发并收到 FAILED 状态', async () => {
    const delegation = new FakeDelegation()
    const settledCalls: Array<{ taskId: string; text: string; status: string }> = []
    const notices: Array<{ text: string }> = []
    const scheduler = new WeaveScheduler({
      delegation,
      persistence,
      loadTeam: (teamId) => manager.loadTeam(teamId),
      notify: (_sessionId, text) => { notices.push({ text }) },
      onTaskSettledText: async (params) => {
        settledCalls.push({ taskId: params.task.id, text: params.text, status: params.status })
        return 1
      },
    })

    const { dagId, taskId: failedTaskId } = await planOneTask('task-failed')
    delegation.script.set(failedTaskId, { stopReason: 'error' })
    await scheduler.start({ dagId, sessionId: 'sess-r' })
    await flush()

    expect(settledCalls).toEqual([{ taskId: failedTaskId, text: 'coder-done', status: 'FAILED' }])
    expect(notices.some((notice) => notice.text.includes('反思沉淀 1 条候选知识（待审核）'))).toBe(true)

    const rows = await persistence.tasks.run((db) =>
      db.prepare('SELECT id, status FROM tasks WHERE dag_id = ?').all(dagId) as Array<{ id: string; status: string }>,
    )
    expect(rows[0]?.status).toBe('FAILED')
  })

  it('钩子抛错不阻断任务终态与 DAG 收敛', async () => {
    const delegation = new FakeDelegation()
    const notices: Array<{ text: string }> = []
    const scheduler = new WeaveScheduler({
      delegation,
      persistence,
      loadTeam: (teamId) => manager.loadTeam(teamId),
      notify: (_sessionId, text) => { notices.push({ text }) },
      onTaskSettledText: async () => {
        throw new Error('reflection boom')
      },
    })

    const { dagId } = await planOneTask('task-throw')
    await scheduler.start({ dagId, sessionId: 'sess-r' })
    await flush()

    const rows = await persistence.tasks.run((db) =>
      db.prepare('SELECT id, status FROM tasks WHERE dag_id = ?').all(dagId) as Array<{ id: string; status: string }>,
    )
    expect(rows[0]?.status).toBe('COMPLETED')
    const dagRow = await persistence.tasks.run((db) =>
      db.prepare('SELECT status FROM dags WHERE dag_id = ?').get(dagId) as { status: string },
    )
    expect(dagRow.status).toBe('completed')
    expect(notices.some((notice) => notice.text.includes('反思沉淀'))).toBe(false)
  })

  it('不注入钩子时行为不变：任务正常完成且无反思通知', async () => {
    const delegation = new FakeDelegation()
    const notices: Array<{ text: string }> = []
    const scheduler = new WeaveScheduler({
      delegation,
      persistence,
      loadTeam: (teamId) => manager.loadTeam(teamId),
      notify: (_sessionId, text) => { notices.push({ text }) },
    })

    const { dagId } = await planOneTask('task-no-hook')
    await scheduler.start({ dagId, sessionId: 'sess-r' })
    await flush()

    const rows = await persistence.tasks.run((db) =>
      db.prepare('SELECT id, status FROM tasks WHERE dag_id = ?').all(dagId) as Array<{ id: string; status: string }>,
    )
    expect(rows[0]?.status).toBe('COMPLETED')
    expect(notices.some((notice) => notice.text.includes('反思沉淀'))).toBe(false)
  })
})

describe('WeaveScheduler 反思→暂存区链路兑底（真实 PrismReflectionService）', () => {
  function newKnowledgeEnv(): { staging: KnowledgeStaging; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'weave-sched-kb-'))
    const staging = new KnowledgeStaging({ dir })
    return {
      staging,
      cleanup: () => {
        rmSync(dir, { recursive: true, force: true })
      },
    }
  }

  /** 生产同构钩子（team-runtime onTaskSettledText）：真实 PrismReflectionService + taskSubject 溯源。 */
  function makeHook(staging: KnowledgeStaging): NonNullable<WeaveSchedulerOptions['onTaskSettledText']> {
    const gateway = new PrismGateway({
      client: new PrismClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 500 }),
      staging,
    })
    const reflection = new PrismReflectionService({ gateway })
    return async ({ task, role, text }) => {
      const result = await reflection.depositFromOutput({
        taskId: task.id,
        executor: role.executor,
        roleId: role.id,
        projectId: task.project_id,
        version: task.version,
        outputText: text,
        taskSubject: subjectLabel(task),
      })
      return result.deposited.length
    }
  }

  it('输出无 WEAVE_KNOWLEDGE 标记 → 自动合成 1 条候选（source:weave-reflection-auto）并通知', async () => {
    const delegation = new FakeDelegation() // FakeDelegation 输出 'coder-done'，无标记
    const { staging, cleanup } = newKnowledgeEnv()
    const notices: Array<{ text: string }> = []
    const scheduler = new WeaveScheduler({
      delegation,
      persistence,
      loadTeam: (teamId) => manager.loadTeam(teamId),
      notify: (_sessionId, text) => { notices.push({ text }) },
      onTaskSettledText: makeHook(staging),
    })

    try {
      const { dagId } = await planOneTask('task-auto-fallback')
      await scheduler.start({ dagId, sessionId: 'sess-r' })
      await flush()

      expect(notices.some((notice) => notice.text.includes('反思沉淀 1 条候选知识（待审核）'))).toBe(true)
      const staged = await staging.list()
      expect(staged).toHaveLength(1)
      expect(staged[0]?.type).toBe('pattern')
      expect(staged[0]?.title).toBe('单一任务')
      expect(staged[0]?.tags).toEqual(
        expect.arrayContaining(['executor:codex', 'role:coder', 'source:weave-reflection-auto']),
      )
      expect(staged[0]?.content.trim()).toBe('coder-done')
    } finally {
      cleanup()
    }
  })

  it('输出带标记 → 只沉淀真实块，不追加自动合成候选', async () => {
    const delegation = new FakeDelegation()
    const { staging, cleanup } = newKnowledgeEnv()
    const scheduler = new WeaveScheduler({
      delegation,
      persistence,
      loadTeam: (teamId) => manager.loadTeam(teamId),
      notify: () => undefined,
      onTaskSettledText: makeHook(staging),
    })

    try {
      const { dagId, taskId } = await planOneTask('task-explicit-block')
      delegation.script.set(taskId, {
        output: [{
          type: 'text' as const,
          text: '结论正文\n### WEAVE_KNOWLEDGE_START\n{"type": "pitfall", "title": "显式经验", "content": "执行器自己写的", "tags": ["x"]}\n### WEAVE_KNOWLEDGE_END\n',
        }],
      })
      await scheduler.start({ dagId, sessionId: 'sess-r' })
      await flush()

      const staged = await staging.list()
      expect(staged).toHaveLength(1)
      expect(staged[0]?.title).toBe('显式经验')
      expect(staged[0]?.tags).toEqual(expect.arrayContaining(['source:weave-reflection']))
      expect(staged[0]?.tags).not.toContain('source:weave-reflection-auto')
    } finally {
      cleanup()
    }
  })
})
