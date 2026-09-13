import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { PrismClient } from '../../../../src/plugins/weave/prism/prism-client'
import { PrismGateway } from '../../../../src/plugins/weave/prism/gateway'
import { prismRegisterPayload, TaskLedgerMirror } from '../../../../src/plugins/weave/prism/task-ledger'
import { TaskStatusNotifier, type TaskStatusChange } from '../../../../src/plugins/weave/scheduling/task-status-notifier'
import type { TaskRecord } from '../../../../src/plugins/weave/state/types'

function makeTask(): TaskRecord {
  return {
    id: 'T1',
    dag_id: 'dag-p3',
    session_id: 'sess-1',
    team_id: 'alpha',
    project_id: 'proj-a',
    version: 'v1',
    description: '实现某功能',
    dependencies: [],
    write_scopes: [],
    revision: 0,
    attempt_token: null,
    assigned_agent: 'coder',
    executor: 'zcode',
    status: 'WAITING',
  } as unknown as TaskRecord
}

describe('prismRegisterPayload（DAG 登记 → prism 载荷）', () => {
  it('必填元信息 + tasks 条目映射；可选字段按存在性透传', () => {
    const payload = prismRegisterPayload(
      { dag_id: 'dag-p3', session_id: 'sess-1', team_id: 'alpha', project_id: 'proj-a', version: 'v1', difficulty: 'hard' },
      [
        makeTask(),
        { ...makeTask(), id: 'T2', dependencies: ['T1'], assigned_agent: null, executor: null },
      ],
    )
    expect(payload).toEqual({
      dag_id: 'dag-p3',
      session_id: 'sess-1',
      team_id: 'alpha',
      project_id: 'proj-a',
      version: 'v1',
      difficulty: 'hard',
      tasks: [
        { id: 'T1', description: '实现某功能', dependencies: [], assigned_agent: 'coder', executor: 'zcode' },
        { id: 'T2', description: '实现某功能', dependencies: ['T1'] },
      ],
    })
  })
})

describe('TaskLedgerMirror（prism 台账镜像，fire-and-forget）', () => {
  let server: Server
  let baseUrl: string
  let posts: Array<{ path: string; body: unknown }>

  beforeAll(async () => {
    server = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        posts.push({ path: new URL(req.url ?? '/', 'http://localhost').pathname, body })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, value: { dag_id: body.dag_id ?? 'x', tasks: 1, edges: 0 } }))
      })().catch(() => {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: { code: 'internal', message: 'stub' } }))
      })
    })
    posts = []
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(() => {
    server.close()
  })

  function makeMirror(): TaskLedgerMirror {
    return new TaskLedgerMirror({ gateway: new PrismGateway({ client: new PrismClient({ baseUrl }) }) })
  }

  it('registerDag：POST /api/tasks/register 携带映射载荷', async () => {
    const mirror = makeMirror()
    mirror.registerDag(
      { dag_id: 'dag-p3', session_id: 'sess-1', team_id: 'alpha', project_id: 'proj-a', version: 'v1', difficulty: 'hard' },
      [makeTask()],
    )
    await vi.waitFor(() => {
      expect(posts.some((post) => post.path === '/api/tasks/register')).toBe(true)
    })
    expect(posts[0]).toMatchObject({
      path: '/api/tasks/register',
      body: { dag_id: 'dag-p3', session_id: 'sess-1', team_id: 'alpha', difficulty: 'hard' },
    })
  })

  it('report：POST /api/tasks/report 携带状态转移与 actor', async () => {
    const mirror = makeMirror()
    mirror.report({ taskId: 'T1', from: 'RUNNING', to: 'COMPLETED', actor: 'executor' })
    await vi.waitFor(() => {
      expect(posts.some((post) => post.path === '/api/tasks/report')).toBe(true)
    })
    expect(posts.at(-1)).toMatchObject({
      path: '/api/tasks/report',
      body: { task_id: 'T1', from_status: 'RUNNING', to_status: 'COMPLETED', by: 'executor' },
    })
  })

  it('prism 不可用：fire-and-forget 只告警，绝不抛出', async () => {
    const warns: unknown[] = []
    const mirror = new TaskLedgerMirror({
      gateway: new PrismGateway({ client: new PrismClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 500 }) }),
      log: { warn: (...args: unknown[]) => warns.push(args) },
    })
    expect(() =>
      mirror.registerDag({ dag_id: 'd', session_id: 's', team_id: 't', project_id: 'p', version: 'v', difficulty: 'hard' }, [makeTask()]),
    ).not.toThrow()
    expect(() => mirror.report({ taskId: 'T1', to: 'FAILED', actor: 'scheduler' })).not.toThrow()
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 50))
    expect(warns.length).toBeGreaterThanOrEqual(2)
  })
})

describe('TaskStatusNotifier.onChange（台账旁路钩子）', () => {
  function change(overrides: Partial<TaskStatusChange> = {}): TaskStatusChange {
    return {
      taskId: 'T1',
      dagId: 'dag-1',
      sessionId: 'sess-1',
      subject: '任务一',
      from: 'WAITING',
      to: 'RUNNING',
      actor: 'scheduler',
      source: 'dispatch',
      ...overrides,
    }
  }

  it('单条通知触发 onChange；批量逐条触发', () => {
    const seen: TaskStatusChange[] = []
    const notifier = new TaskStatusNotifier({ notify: () => undefined, onChange: (c) => seen.push(c) })
    notifier.notify(change())
    notifier.notifyBatch([change({ taskId: 'T2' }), change({ taskId: 'T3' })])
    expect(seen.map((c) => c.taskId)).toEqual(['T1', 'T2', 'T3'])
  })

  it('回声抑制不影响台账镜像：captain 动作也进入 onChange（台账要全量）', () => {
    const seen: TaskStatusChange[] = []
    const notified: string[] = []
    const notifier = new TaskStatusNotifier({
      notify: (sessionId, text) => notified.push(`${sessionId}:${text}`),
      onChange: (c) => seen.push(c),
    })
    notifier.notify(change({ actor: 'captain', source: 'task_cancel', to: 'CANCELLED' }))
    expect(seen).toHaveLength(1) // 台账镜像拿到全量
    expect(notified).toHaveLength(0) // 会话通知被回声抑制
  })
})
