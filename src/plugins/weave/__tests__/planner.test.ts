import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stringify as stringifyYaml } from 'yaml'

import { WeavePersistence } from '../persistence/persistence'
import { TeamManager, type ExecutorLookup, type TeamConfig } from '../team/team-manager.js'
import { TeamPlanner, assertAcyclic, createPlanTasksHandler, type PlanTasksInput } from '../scheduling/planner'

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
  task_decomposition: {
    matchers: [],
    default_difficulty: 'hard',
    dag_templates: { hard: ['design', 'implement', 'review'] },
  },
  knowledge_injection: { max_entries: 1, max_chars_per_entry: 100, max_total_chars: 300, priority: 'freshness_first' },
  feedback: { feedback_timeout_seconds: 60, max_revisions: 2, reopen_window_seconds: 60 },
}

let dir = ''
let persistence: WeavePersistence
let manager: TeamManager
let planner: TeamPlanner

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weave-planner-'))
  persistence = new WeavePersistence({ inMemory: true })
  manager = new TeamManager(lookup, { teamsDir: dir, persistence })
  manager.importTeam(stringifyYaml({ schema_version: '1', ...TEAM }))
  planner = new TeamPlanner({ persistence, teamManager: manager })
})

afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('TeamPlanner.plan', () => {
  it('按依赖落库三表：无依赖 WAITING、有依赖 BLOCKED，边与依赖一致', async () => {
    await manager.bindTeam('sess-1', 'alpha')
    const output = await planner.plan({
      session_id: 'sess-1',
      goal: '上线登录功能',
      tasks: [
        { id: 'a', description: '设计方案', assignee: 'designer' },
        { id: 'b', description: '实现代码\n第二行说明', assignee: 'coder', depends_on: ['a'] },
        { id: 'c', description: '审核代码', assignee: 'coder', depends_on: ['b'] },
      ],
    })

    expect(output.dag_id).toMatch(/^dag-session-adhoc-\d+$/)
    expect(output.team_id).toBe('alpha')
    expect(output.tasks.map((task) => [task.id.split('-').pop(), task.status])).toEqual([
      ['a', 'WAITING'],
      ['b', 'BLOCKED'],
      ['c', 'BLOCKED'],
    ])

    const dag = await new (await import('../dag/repository')).DagRepository(persistence).loadDag(output.dag_id)
    expect(dag.tasks).toHaveLength(3)
    expect(dag.tasks.map((task) => task.status)).toEqual(['WAITING', 'BLOCKED', 'BLOCKED'])
    // 真实边集合：a→b→c
    const ids = output.tasks.map((task) => task.id)
    expect(dag.edges.map((edge) => [edge.from, edge.to].join('=>'))).toEqual([
      [ids[0], ids[1]].join('=>'),
      [ids[1], ids[2]].join('=>'),
    ])
    expect(dag.tasks[1]!.dependencies).toEqual([ids[0]])
  })

  it('零仪式解析：未绑定时自动回退默认/唯一团队', async () => {
    // 目录里只有一个团队 alpha（无 default 标记）→ 唯一团队自动生效，无需启用
    const out = await planner.plan({
      session_id: 'fresh-session',
      tasks: [{ description: '直接开工', assignee: 'coder' }],
    })
    expect(out.team_id).toBe('alpha')
  })

  it('多团队且无默认且未绑定 → invalid_team 并给出启用指引', async () => {
    manager.importTeam(stringifyYaml({ schema_version: '1', ...TEAM, team_id: 'beta', default: false }), { overwrite: true })
    await expect(planner.plan({
      session_id: 'nobody',
      tasks: [{ description: 'x', assignee: 'coder' }],
    })).rejects.toMatchObject({
      code: 'invalid_team',
      message: expect.stringContaining('启用'),
    })
  })

  it('assignee 不是团队角色 → invalid_argument 并列出可用角色', async () => {
    await manager.bindTeam('sess-1', 'alpha')
    await expect(planner.plan({
      session_id: 'sess-1',
      tasks: [{ description: 'x', assignee: 'ghost' }],
    })).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('designer, coder, reviewer'),
    })
  })

  it('assignee 允许角色名精确匹配', async () => {
    await manager.bindTeam('sess-1', 'alpha')
    const output = await planner.plan({
      session_id: 'sess-1',
      tasks: [{ description: '画原型', assignee: '设计师' }],
    })
    expect(output.tasks[0]!.assignee_role).toBe('designer')
  })

  it('依赖引用计划外任务 → invalid_argument；成环 → invalid_argument', async () => {
    await manager.bindTeam('sess-1', 'alpha')
    await expect(planner.plan({
      session_id: 'sess-1',
      tasks: [{ description: 'x', assignee: 'coder', depends_on: ['missing'] }],
    })).rejects.toMatchObject({ code: 'invalid_argument', message: expect.stringContaining('missing') })

    await expect(planner.plan({
      session_id: 'sess-1',
      tasks: [
        { id: 'a', description: 'x', assignee: 'coder', depends_on: ['b'] },
        { id: 'b', description: 'y', assignee: 'coder', depends_on: ['a'] },
      ],
    })).rejects.toMatchObject({ code: 'invalid_argument', message: expect.stringContaining('成环') })
  })

  it('id 缺省自动编号 T1 且持久化为 ${dagId}-T1；重复 id 拒绝', async () => {
    await manager.bindTeam('sess-1', 'alpha')
    const output = await planner.plan({
      session_id: 'sess-1',
      tasks: [
        { description: '第一步', assignee: 'coder' },
        { description: '第二步', assignee: 'reviewer', depends_on: ['T1'] },
      ],
    })
    expect(output.tasks[0]!.id.endsWith('-T1')).toBe(true)
    expect(output.tasks[1]!.depends_on).toEqual(['T1'])

    await expect(planner.plan({
      session_id: 'sess-1',
      tasks: [
        { id: 'same', description: 'x', assignee: 'coder' },
        { id: 'same', description: 'y', assignee: 'coder' },
      ],
    })).rejects.toMatchObject({ code: 'invalid_argument', message: expect.stringContaining('重复') })
  })

  it('空 tasks / 空 description / 空 session → invalid_argument', async () => {
    await expect(planner.plan({ session_id: 's', tasks: [] })).rejects.toMatchObject({ code: 'invalid_argument' })
    await manager.bindTeam('sess-1', 'alpha')
    await expect(planner.plan({ session_id: 'sess-1', tasks: [{ description: '', assignee: 'coder' }] }))
      .rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(planner.plan({ session_id: '', tasks: [{ description: 'x', assignee: 'coder' }] }))
      .rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('缺省不传 append_to：自动沿用同会话/项目/版本既有任务组（不新建）', async () => {
    await manager.bindTeam('sess-1', 'alpha')
    const first = await planner.plan({ session_id: 'sess-1', tasks: [{ description: '一', assignee: 'coder' }] })
    const second = await planner.plan({ session_id: 'sess-1', tasks: [{ description: '二', assignee: 'coder' }] })
    expect(second.appended).toBe(true)
    expect(second.dag_id).toBe(first.dag_id)
    expect(second.tasks[0]!.id.endsWith('-T2')).toBe(true)
  })
})

describe('TeamPlanner.plan 追加模式（doc/05 §6.1 P1-A）', () => {
  it('正常追加：编号 DAG 域递增 T3/T4、appended=true、tasks 仅含新增、落库合并为 4 任务', async () => {
    await manager.bindTeam('sess-1', 'alpha')
    const first = await planner.plan({
      session_id: 'sess-1',
      tasks: [
        { description: '第一批一', assignee: 'coder' },
        { description: '第一批二', assignee: 'reviewer', depends_on: ['T1'] },
      ],
    })
    expect(first.appended).toBe(false)
    const second = await planner.plan({
      session_id: 'sess-1',
      append_to: first.dag_id,
      tasks: [
        { description: '第二批一', assignee: 'coder' },
        { description: '第二批二', assignee: 'designer', depends_on: ['T3', 'T1'] },
      ],
    })
    expect(second.appended).toBe(true)
    expect(second.dag_id).toBe(first.dag_id)
    expect(second.tasks.map((t) => [t.id.split('-').pop(), t.status])).toEqual([
      ['T3', 'WAITING'],
      ['T4', 'BLOCKED'], // 依赖新任务 T3 与既有任务 T1
    ])
    expect(second.tasks[1]!.depends_on).toEqual(['T3', 'T1'])

    const dag = await new (await import('../dag/repository')).DagRepository(persistence).loadDag(first.dag_id)
    expect(dag.tasks).toHaveLength(4)
    const t4 = dag.tasks.find((t) => t.id.endsWith('-T4'))!
    expect(t4.dependencies).toContain(`${first.dag_id}-T1`)
    expect(dag.edges.some((e) => e.from === `${first.dag_id}-T1` && e.to === `${first.dag_id}-T4`)).toBe(true)
  })

  it('显式 id 与 DAG 域既有任务撞名 → invalid_argument', async () => {
    await manager.bindTeam('sess-1', 'alpha')
    const first = await planner.plan({ session_id: 'sess-1', tasks: [{ description: '一', assignee: 'coder' }] })
    await expect(planner.plan({
      session_id: 'sess-1',
      append_to: first.dag_id,
      tasks: [{ id: 'T1', description: '撞名', assignee: 'coder' }],
    })).rejects.toMatchObject({ code: 'invalid_argument', message: expect.stringContaining('冲突') })
  })

  it('append_to 不存在 → invalid_argument；跨团队 DAG → invalid_argument', async () => {
    await manager.bindTeam('sess-1', 'alpha')
    await expect(planner.plan({
      session_id: 'sess-1',
      append_to: 'dag-nope',
      tasks: [{ description: 'x', assignee: 'coder' }],
    })).rejects.toMatchObject({ code: 'invalid_argument', message: expect.stringContaining('不存在') })

    const first = await planner.plan({ session_id: 'sess-1', tasks: [{ description: '一', assignee: 'coder' }] })
    manager.importTeam(stringifyYaml({ schema_version: '1', ...TEAM, team_id: 'beta', default: false }), { overwrite: true })
    await manager.bindTeam('sess-beta', 'beta')
    await expect(planner.plan({
      session_id: 'sess-beta',
      append_to: first.dag_id,
      tasks: [{ description: 'y', assignee: 'coder' }],
    })).rejects.toMatchObject({ code: 'invalid_argument', message: expect.stringContaining('不一致') })
  })

  it('依赖引用计划外任务在扩展域下仍拒绝', async () => {
    await manager.bindTeam('sess-1', 'alpha')
    const first = await planner.plan({ session_id: 'sess-1', tasks: [{ description: '一', assignee: 'coder' }] })
    await expect(planner.plan({
      session_id: 'sess-1',
      append_to: first.dag_id,
      tasks: [{ description: 'x', assignee: 'coder', depends_on: ['ghost'] }],
    })).rejects.toMatchObject({ code: 'invalid_argument', message: expect.stringContaining('ghost') })
  })

  it('追加批次内成环 → invalid_argument（批内∪既有联合判环）', async () => {
    await manager.bindTeam('sess-1', 'alpha')
    const first = await planner.plan({ session_id: 'sess-1', tasks: [{ description: '一', assignee: 'coder' }] })
    await expect(planner.plan({
      session_id: 'sess-1',
      append_to: first.dag_id,
      tasks: [
        { id: 'p', description: 'x', assignee: 'coder', depends_on: ['q'] },
        { id: 'q', description: 'y', assignee: 'coder', depends_on: ['p'] },
      ],
    })).rejects.toMatchObject({ code: 'invalid_argument', message: expect.stringContaining('成环') })
  })

  it('终态 DAG 追加 → 复活：dags.status 置回 created', async () => {
    await manager.bindTeam('sess-1', 'alpha')
    const first = await planner.plan({ session_id: 'sess-1', tasks: [{ description: '一', assignee: 'coder' }] })
    await persistence.tasks.run((db) =>
      db.prepare('UPDATE dags SET status = ? WHERE dag_id = ?').run('completed', first.dag_id),
    )
    const second = await planner.plan({
      session_id: 'sess-1',
      append_to: first.dag_id,
      tasks: [{ description: '二', assignee: 'coder' }],
    })
    expect(second.appended).toBe(true)
    const status = await persistence.tasks.run((db) =>
      (db.prepare('SELECT status FROM dags WHERE dag_id = ?').get(first.dag_id) as { status: string }).status,
    )
    expect(status).toBe('created')
  })

  it('缺省自动沿用既有任务组：不传 append_to 时 appended=true，编号 DAG 域递增', async () => {
    await manager.bindTeam('sess-1', 'alpha')
    const first = await planner.plan({ session_id: 'sess-1', tasks: [{ description: '一', assignee: 'coder' }] })
    const second = await planner.plan({ session_id: 'sess-1', tasks: [{ description: '二', assignee: 'coder' }] })
    expect(second.appended).toBe(true)
    expect(second.dag_id).toBe(first.dag_id)
    expect(second.tasks[0]!.id.endsWith('-T2')).toBe(true)
  })
})

describe('assertAcyclic', () => {
  it('非环通过，环拒绝并列出参与节点', () => {
    expect(() => assertAcyclic([
      { refId: 'a', dependsOn: [] },
      { refId: 'b', dependsOn: ['a'] },
    ])).not.toThrow()
    expect(() => assertAcyclic([
      { refId: 'a', dependsOn: ['c'] },
      { refId: 'b', dependsOn: ['a'] },
      { refId: 'c', dependsOn: ['b'] },
    ])).toThrow(/成环/)
  })
})

describe('createPlanTasksHandler', () => {
  it('从 exec.agent.id 解析会话，规划成功即触发 schedulerStart', async () => {
    await manager.bindTeam('sess-exec', 'alpha')
    const started: Array<{ dagId: string; sessionId: string }> = []
    const handler = createPlanTasksHandler({
      planner,
      schedulerStart: async (input) => { started.push(input) },
    })
    const output = await handler(
      { goal: 'g', tasks: [{ description: '写代码', assignee: 'coder' }] },
      { agent: { id: 'sess-exec' }, signal: new AbortController().signal },
    )
    expect(output.session_id).toBe('sess-exec')
    expect(started).toEqual([{ dagId: output.dag_id, sessionId: 'sess-exec', parentAgent: { id: 'sess-exec' } }])
  })

  it('exec.agent 缺失且无显式 session_id → invalid_argument；args 显式 session_id 可覆盖', async () => {
    const handler = createPlanTasksHandler({ planner, schedulerStart: async () => {} })
    await expect(handler({ tasks: [{ description: 'x', assignee: 'coder' }] }, undefined))
      .rejects.toMatchObject({ code: 'invalid_argument' })

    await manager.bindTeam('explicit-sess', 'alpha')
    const output = await handler(
      { session_id: 'explicit-sess', tasks: [{ description: 'x', assignee: 'coder' }] },
      { agent: { id: 'other' } },
    )
    expect(output.session_id).toBe('explicit-sess')
  })

  it('schedulerStart 抛错不冒泡（调度失败经日志观察）', async () => {
    await manager.bindTeam('sess-x', 'alpha')
    const handler = createPlanTasksHandler({
      planner,
      schedulerStart: async () => { throw new Error('start-boom') },
    })
    await expect(handler({ tasks: [{ description: 'x', assignee: 'coder' }] }, { agent: { id: 'sess-x' } }))
      .resolves.toMatchObject({ team_name: '阿尔法小队' })
  })

  it('append_to 经 payload 透传：追加目标 DAG 并对其触发 schedulerStart', async () => {
    await manager.bindTeam('sess-h', 'alpha')
    const first = await planner.plan({ session_id: 'sess-h', tasks: [{ description: 'a', assignee: 'coder' }] })
    const started: Array<{ dagId: string; sessionId: string }> = []
    const handler = createPlanTasksHandler({
      planner,
      schedulerStart: async (input) => { started.push(input) },
    })
    const output = await handler(
      { append_to: first.dag_id, tasks: [{ description: 'b', assignee: 'coder' }] },
      { agent: { id: 'sess-h' }, signal: new AbortController().signal },
    )
    expect(output.appended).toBe(true)
    expect(output.dag_id).toBe(first.dag_id)
    expect(started).toEqual([{ dagId: first.dag_id, sessionId: 'sess-h', parentAgent: { id: 'sess-h' } }])
  })
})

describe('createPlanTasksHandler append_to 透传契约（增量下发最后一厘米）', () => {
  it('工具入参 append_to 原样到达 planner.plan（装配层不过滤入参）', async () => {
    await manager.bindTeam('sess-t', 'alpha')
    const received: PlanTasksInput[] = []
    const stubPlanner = {
      plan: async (input: PlanTasksInput) => {
        received.push(input)
        return {
          dag_id: 'dag-session-adhoc-7',
          session_id: input.session_id,
          team_id: 'alpha',
          team_name: '阿尔法小队',
          goal: null,
          appended: true,
          tasks: [],
        }
      },
    } as unknown as TeamPlanner
    const handler = createPlanTasksHandler({ planner: stubPlanner, schedulerStart: async () => {} })
    const output = await handler(
      {
        append_to: 'dag-session-adhoc-7',
        goal: '增量追加',
        tasks: [{ description: 'x', assignee: 'coder' }],
      },
      { agent: { id: 'sess-t' }, signal: new AbortController().signal },
    )
    expect(received).toHaveLength(1)
    expect(received[0]!.append_to).toBe('dag-session-adhoc-7')
    expect(output.appended).toBe(true)
    expect(output.dag_id).toBe('dag-session-adhoc-7')
  })
})
