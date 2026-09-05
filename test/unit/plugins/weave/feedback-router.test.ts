import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  FeedbackRouter,
  DEFAULT_FEEDBACK_CONFIG,
  recognizeIntent,
} from '../../../../src/plugins/weave/scheduling/feedback-router'
import { openPersistence, type WeavePersistence } from '../../../../src/plugins/weave/persistence/index'
import { SessionTracker } from '../../../../src/plugins/weave/scheduling/session-tracker'
import { TaskStatusNotifier } from '../../../../src/plugins/weave/scheduling/task-status-notifier'
import { AuditLog } from '../../../../src/plugins/weave/audit/audit-log'
import type { TaskRecord } from '../../../../src/plugins/weave/state/types'

const BASE = new Date('2026-08-25T08:00:00.000Z')

/** 可控时钟：测试内推进。 */
function makeClock(now: { value: Date }) {
  return () => new Date(now.value.getTime())
}

async function insertTask(
  p: WeavePersistence,
  overrides: Partial<TaskRecord> & { id: string },
): Promise<void> {
  const defaults: TaskRecord = {
    session_id: 'sess-1',
    team_id: 'team-1',
    project_id: 'proj-1',
    version: 'v1',
    description: '测试任务',
    dependencies: [],
    write_scopes: [],
    revision: 0,
    attempt_token: null,
    assigned_agent: null,
    executor: 'spawn',
    status: 'COMPLETED',
    revision_count: 0,
    max_revisions: 5,
    feedback_timeout_seconds: 1800,
    feedback_expires_at: null,
    skip_override: false,
    skip_reason: null,
    fail_count: 0,
    result: 'v1 输出',
    error_type: null,
    created_at: BASE.toISOString(),
    updated_at: BASE.toISOString(),
    ...overrides,
  }
  const row = defaults
  await p.tasks.run((raw) => {
    raw
      .prepare(
        `INSERT INTO tasks (id, session_id, team_id, project_id, version, description, dependencies,
         assigned_agent, executor, status, revision_count, max_revisions, feedback_timeout_seconds,
         feedback_expires_at, skip_override, skip_reason, fail_count, result, error_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.session_id,
        row.team_id,
        row.project_id,
        row.version,
        row.description,
        JSON.stringify(row.dependencies),
        row.assigned_agent,
        row.executor,
        row.status,
        row.revision_count,
        row.max_revisions,
        row.feedback_timeout_seconds,
        row.feedback_expires_at,
        row.skip_override ? 1 : 0,
        row.skip_reason,
        row.fail_count,
        row.result,
        row.error_type,
        row.created_at,
        row.updated_at,
      )
  })
}

describe('intent 识别（TDD 1.5.6 表格，CJK 前缀语义）', () => {
  it('accept：可以/确认/就这样/没问题/OK/ok（含尾缀）', () => {
    for (const text of ['确认', '可以', '就这样', '没问题', 'OK', 'ok', '确认了', '没问题吗', '可以关闭']) {
      expect(recognizeIntent(text)).toBe('accept')
    }
  })

  it('revise：不对/改成/修改/重新/换', () => {
    for (const text of ['改成手机号验证码', '不对，颜色错了', '修改样式', '重新生成', '换一个方案']) {
      expect(recognizeIntent(text)).toBe('revise')
    }
  })

  it('cancel：取消/算了/不做了', () => {
    for (const text of ['取消', '算了', '不做了', '取消任务']) {
      expect(recognizeIntent(text)).toBe('cancel')
    }
  })

  it('无法识别 → null（已知否定句、空串）', () => {
    expect(recognizeIntent('')).toBeNull()
    expect(recognizeIntent('   ')).toBeNull()
    expect(recognizeIntent('再来一个')).toBeNull()
    expect(recognizeIntent('已收到')).toBeNull()
  })
})

describe('FeedbackRouter（保温期全链路）', () => {
  let p: WeavePersistence
  let tracker: SessionTracker
  let now: { value: Date }
  let clock: () => Date
  let router: FeedbackRouter

  beforeAll(() => {
    p = openPersistence({ inMemory: true })
    tracker = new SessionTracker(p.feedback)
    now = { value: new Date(BASE) }
    clock = makeClock(now)
    router = new FeedbackRouter({
      tasks: p.tasks,
      feedback: p.feedback,
      sessionTracker: tracker,
      clock,
    })
  })

  afterAll(() => {
    p.close()
  })

  it('#10 enterAwaitingFeedback：COMPLETED→AWAITING_FEEDBACK，expires=now+1800，路由行落库', async () => {
    await insertTask(p, { id: 't-env-1' })
    const task = await router.enterAwaitingFeedback('t-env-1')
    expect(task.status).toBe('AWAITING_FEEDBACK')
    expect(task.feedback_expires_at).toBe(
      new Date(BASE.getTime() + DEFAULT_FEEDBACK_CONFIG.feedback_timeout_seconds * 1000).toISOString(),
    )
    const route = await p.feedback.run((raw) => {
      return raw.prepare('SELECT * FROM feedback_routes WHERE task_id = ?').get('t-env-1') as Record<string, unknown> | undefined
    })
    expect(route).toMatchObject({
      task_id: 't-env-1',
      executor_id: 'spawn',
      revision_count: 0,
      status: 'AWAITING_FEEDBACK',
      previous_result: 'v1 输出',
    })
  })

  it('#10 非法：非 COMPLETED 任务进入保温期 → invalid_status_transition', async () => {
    await insertTask(p, { id: 't-env-bad', status: 'RUNNING' })
    await expect(router.enterAwaitingFeedback('t-env-bad')).rejects.toMatchObject({ code: 'invalid_status_transition' })
  })

  it('route(accept)：AWAITING_FEEDBACK→CLOSED，closed_at 落库，修订上下文清理', async () => {
    await insertTask(p, { id: 't-acc-1' })
    await tracker.recordRevision('t-acc-1', '第一次修订', 'v0 输出')
    await router.enterAwaitingFeedback('t-acc-1')

    const { intent, task } = await router.route('t-acc-1', '确认')
    expect(intent).toBe('accept')
    expect(task.status).toBe('CLOSED')
    const route = await p.feedback.run((raw) => {
      return raw.prepare('SELECT closed_at, status FROM feedback_routes WHERE task_id = ?').get('t-acc-1') as Record<string, unknown>
    })
    expect(route.status).toBe('CLOSED')
    expect(route.closed_at).toBe(BASE.toISOString())
    expect(await tracker.getRevisionRecord('t-acc-1')).toBeNull()
  })

  it('route(revise)：AWAITING_FEEDBACK→REVISION_RUNNING，次数+1，上下文记录，保温期挂起', async () => {
    await insertTask(p, { id: 't-rev-1' })
    await router.enterAwaitingFeedback('t-rev-1')

    const { intent, task } = await router.route('t-rev-1', '改成手机号验证码')
    expect(intent).toBe('revise')
    expect(task.status).toBe('REVISION_RUNNING')
    expect(task.revision_count).toBe(1)
    expect(task.feedback_expires_at).toBeNull()

    const record = await tracker.getRevisionRecord('t-rev-1')
    expect(record).toMatchObject({ revision_count: 1, user_feedback: ['改成手机号验证码'], previous_result: 'v1 输出' })
  })

  it('修订完成回到保温期：保温期重置（重新获得 expires），修订次数保留', async () => {
    await insertTask(p, { id: 't-rev-2' })
    await router.enterAwaitingFeedback('t-rev-2')
    await router.revise('t-rev-2', '改成 A 方案')
    // 模拟修订委托完成（#14 REVISION_RUNNING→COMPLETED 由 DelegationService 执行）
    await p.tasks.run((raw) => {
      raw.prepare("UPDATE tasks SET status = 'COMPLETED', result = ?, updated_at = ? WHERE id = ?").run('v2 输出', new Date(now.value).toISOString(), 't-rev-2')
    })
    const task = await router.enterAwaitingFeedback('t-rev-2')
    expect(task.status).toBe('AWAITING_FEEDBACK')
    expect(task.revision_count).toBe(1)
    expect(task.feedback_expires_at).toBe(new Date(BASE.getTime() + 1800_000).toISOString())
  })

  it('#11 max_revisions：达到上限后拒绝新一轮修订（行级 max_revisions=1）', async () => {
    await insertTask(p, { id: 't-lim-1', max_revisions: 1 })
    await router.enterAwaitingFeedback('t-lim-1')
    await router.revise('t-lim-1', '第一轮')
    expect((await tracker.getRevisionRecord('t-lim-1'))!.revision_count).toBe(1)
    // 模拟完成并回到保温期
    await p.tasks.run((raw) => {
      raw.prepare("UPDATE tasks SET status = 'COMPLETED', updated_at = ? WHERE id = ?").run(new Date().toISOString(), 't-lim-1')
    })
    await router.enterAwaitingFeedback('t-lim-1')
    await expect(router.revise('t-lim-1', '第二轮')).rejects.toMatchObject({ code: 'invalid_status_transition' })
  })

  it('#11 max_revisions 缺省：任务行=0 且 config 缺省 5 生效；config 覆盖生效', async () => {
    await insertTask(p, { id: 't-lim-2', max_revisions: 0 })
    const strict = new FeedbackRouter({
      tasks: p.tasks,
      feedback: p.feedback,
      sessionTracker: tracker,
      clock,
      config: { max_revisions: 2 },
    })
    await strict.enterAwaitingFeedback('t-lim-2')
    expect(DEFAULT_FEEDBACK_CONFIG.max_revisions).toBe(5)
    let counter = 0
    while (true) {
      await strict.revise('t-lim-2', `第${counter + 1}轮`)
      counter += 1
      if (counter >= 2) break
      await p.tasks.run((raw) => {
        raw.prepare("UPDATE tasks SET status = 'COMPLETED', updated_at = ? WHERE id = ?").run(new Date().toISOString(), 't-lim-2')
      })
      await strict.enterAwaitingFeedback('t-lim-2')
    }
    expect(counter).toBe(2)
    await p.tasks.run((raw) => {
      raw.prepare("UPDATE tasks SET status = 'COMPLETED', updated_at = ? WHERE id = ?").run(new Date().toISOString(), 't-lim-2')
    })
    await strict.enterAwaitingFeedback('t-lim-2')
    await expect(strict.revise('t-lim-2', '第3轮')).rejects.toMatchObject({ code: 'invalid_status_transition' })
  })

  it('route(cancel)：→CANCELLED 终态，修订上下文保留（供 retry #29）', async () => {
    await insertTask(p, { id: 't-cxl-1' })
    await tracker.recordRevision('t-cxl-1', '中途反馈', 'v1 输出')
    await router.enterAwaitingFeedback('t-cxl-1')

    const { intent, task } = await router.route('t-cxl-1', '取消了')
    expect(intent).toBe('cancel')
    expect(task.status).toBe('CANCELLED')
    const route = await p.feedback.run((raw) => {
      return raw.prepare('SELECT status, closed_at FROM feedback_routes WHERE task_id = ?').get('t-cxl-1') as Record<string, unknown>
    })
    expect(route.status).toBe('CANCELLED')
    expect(route.closed_at).toBeNull()
    expect(await tracker.getRevisionRecord('t-cxl-1')).not.toBeNull()
  })

  it('route 非法状态：COMPLETED 直接 accept → invalid_status_transition（LO-2）', async () => {
    await insertTask(p, { id: 't-bad-1', status: 'COMPLETED' })
    await expect(router.route('t-bad-1', '确认')).rejects.toMatchObject({ code: 'invalid_status_transition' })
  })

  it('route 未知意图 → invalid_status_transition；任务不存在 → task_not_found', async () => {
    await insertTask(p, { id: 't-unk-1' })
    await router.enterAwaitingFeedback('t-unk-1')
    await expect(router.route('t-unk-1', '再来一个')).rejects.toMatchObject({ code: 'invalid_status_transition' })
    await expect(router.route('ghost-task', '确认')).rejects.toMatchObject({ code: 'task_not_found' })
  })

  it('#17 reopen：窗口内 CLOSED→AWAITING_FEEDBACK，reopen_count+1，保温期重置，上下文保留', async () => {
    await insertTask(p, { id: 't-ro-1' })
    await router.enterAwaitingFeedback('t-ro-1')
    await tracker.recordRevision('t-ro-1', '第一版反馈', 'v0 输出')
    // 120s 后确认
    now.value = new Date(BASE.getTime() + 120_000)
    await router.accept('t-ro-1')
    // 2000s 后 reopen（< 86400s）
    now.value = new Date(BASE.getTime() + 2_000_000)

    const task = await router.reopen('t-ro-1')
    expect(task.status).toBe('AWAITING_FEEDBACK')
    expect(task.feedback_expires_at).toBe(new Date(BASE.getTime() + 2_000_000 + 1800_000).toISOString())
    const route = await p.feedback.run((raw) => {
      return raw.prepare('SELECT reopen_count, status, closed_at, previous_result FROM feedback_routes WHERE task_id = ?').get('t-ro-1') as Record<string, unknown>
    })
    expect(route).toMatchObject({ reopen_count: 1, status: 'AWAITING_FEEDBACK', previous_result: 'v1 输出' })
    expect(route.closed_at).toBeNull()
    // #12 accept 时 clearRevision（矩阵语义）；reopen 保留路由历史（previous_result），
    // 修订计数与上下文在下一轮 revise 时由 SessionTracker 重新记录。
    expect(await tracker.getRevisionRecord('t-ro-1')).toBeNull()
  })

  it('#17 多次 reopen：计数递增并再次 accept 正常', async () => {
    await insertTask(p, { id: 't-ro-2' })
    await router.enterAwaitingFeedback('t-ro-2')
    now.value = new Date(BASE.getTime() + 100_000)
    await router.accept('t-ro-2')
    now.value = new Date(BASE.getTime() + 110_000)
    await router.reopen('t-ro-2')
    now.value = new Date(BASE.getTime() + 120_000)
    await router.accept('t-ro-2')
    now.value = new Date(BASE.getTime() + 130_000)
    await router.reopen('t-ro-2')

    const task = await router.accept('t-ro-2')
    expect(task.status).toBe('CLOSED')
    const route = await p.feedback.run((raw) => {
      return raw.prepare('SELECT reopen_count FROM feedback_routes WHERE task_id = ?').get('t-ro-2') as Record<string, unknown>
    })
    expect(route.reopen_count).toBe(2)
  })

  it('#17 reopen 窗口超出（>86400s）→ invalid_status_transition；非 CLOSED 不可 reopen', async () => {
    await insertTask(p, { id: 't-ro-3' })
    await router.enterAwaitingFeedback('t-ro-3')
    now.value = new Date(BASE.getTime() + 100_000)
    await router.accept('t-ro-3')
    now.value = new Date(BASE.getTime() + 100_000 + 86_400_000 + 1)
    await expect(router.reopen('t-ro-3')).rejects.toMatchObject({ code: 'invalid_status_transition' })

    await insertTask(p, { id: 't-ro-4', status: 'AWAITING_FEEDBACK' })
    await expect(router.reopen('t-ro-4')).rejects.toMatchObject({ code: 'invalid_status_transition' })
  })

  it('#12 timeout：closeExpired 只关闭过期任务，写 closed_at 并清理修订上下文', async () => {
    now.value = new Date(BASE)
    await insertTask(p, { id: 't-exp-1', status: 'AWAITING_FEEDBACK', feedback_expires_at: new Date(BASE.getTime() + 30_000).toISOString() })
    await insertTask(p, { id: 't-exp-2', status: 'AWAITING_FEEDBACK', feedback_expires_at: new Date(BASE.getTime() + 10_000_000).toISOString() })
    await p.feedback.run((raw) => {
      raw.prepare(`INSERT INTO feedback_routes (task_id, executor_id, revision_count, status, closed_at, reopen_count, user_feedback, previous_result)
        VALUES (?, 'spawn', 0, 'AWAITING_FEEDBACK', NULL, 0, '[]', NULL)`).run('t-exp-1')
      raw.prepare(`INSERT INTO feedback_routes (task_id, executor_id, revision_count, status, closed_at, reopen_count, user_feedback, previous_result)
        VALUES (?, 'spawn', 0, 'AWAITING_FEEDBACK', NULL, 0, '[]', NULL)`).run('t-exp-2')
    })
    await tracker.recordRevision('t-exp-1', '超时前反馈', 'v0 输出')
    now.value = new Date(BASE.getTime() + 60_000) // t-exp-1 过期（expires=+30s），t-exp-2 未过期

    const closed = await router.closeExpired()
    expect(closed).toEqual(['t-exp-1'])
    const tasks = await p.tasks.run((raw) => raw.prepare('SELECT id, status FROM tasks WHERE id IN (?, ?)').all('t-exp-1', 't-exp-2')) as { id: string; status: string }[]
    const byId = new Map(tasks.map((t) => [t.id, t.status]))
    expect(byId.get('t-exp-1')).toBe('CLOSED')
    expect(byId.get('t-exp-2')).toBe('AWAITING_FEEDBACK')
    const route = await p.feedback.run((raw) => raw.prepare('SELECT status, closed_at FROM feedback_routes WHERE task_id = ?').get('t-exp-1')) as Record<string, unknown>
    expect(route.status).toBe('CLOSED')
    expect(route.closed_at).toBe(new Date(BASE.getTime() + 60_000).toISOString())
    expect(await tracker.getRevisionRecord('t-exp-1')).toBeNull()
  })

  it('config.feedback_timeout_seconds 覆盖：任务行=0 时用 config（60s）', async () => {
    now.value = new Date(BASE)
    await insertTask(p, { id: 't-cfg-1', feedback_timeout_seconds: 0 })
    const cfgRouter = new FeedbackRouter({
      tasks: p.tasks,
      feedback: p.feedback,
      sessionTracker: tracker,
      clock,
      config: { feedback_timeout_seconds: 60 },
    })
    const task = await cfgRouter.enterAwaitingFeedback('t-cfg-1')
    expect(task.feedback_expires_at).toBe(new Date(BASE.getTime() + 60_000).toISOString())
  })
})

describe('FeedbackRouter 状态变更发电（doc/05 §6.4 P1-D 接线点 5）', () => {
  let p: WeavePersistence
  let tracker: SessionTracker
  let notified: Array<{ sessionId: string; text: string }>
  let auditDir: string
  let audit: AuditLog
  let echoRouter: FeedbackRouter
  let quietRouter: FeedbackRouter

  beforeAll(() => {
    p = openPersistence({ inMemory: true })
    tracker = new SessionTracker(p.feedback)
    notified = []
    auditDir = mkdtempSync(join(tmpdir(), 'weave-audit-fb-'))
    audit = new AuditLog({ dir: auditDir })
    echoRouter = new FeedbackRouter({
      tasks: p.tasks,
      feedback: p.feedback,
      sessionTracker: tracker,
      statusNotifier: new TaskStatusNotifier({
        notify: (sessionId, text) => notified.push({ sessionId, text }),
        echoSelfActions: true, // 验证接线本身；缺省部署 feedback=user 不回声
      }),
      audit,
    })
    quietRouter = new FeedbackRouter({
      tasks: p.tasks,
      feedback: p.feedback,
      sessionTracker: tracker,
    })
  })

  afterAll(() => {
    p.close()
    rmSync(auditDir, { recursive: true, force: true })
  })

  it('五动作依次发电：enter/revise/accept/reopen/cancel 文案含转移与来源', async () => {
    await insertTask(p, { id: 'n-accept' })
    await echoRouter.enterAwaitingFeedback('n-accept')
    await echoRouter.accept('n-accept')
    expect(notified.map((n) => n.text)).toEqual([
      '[weave] 任务「测试任务」COMPLETED → AWAITING_FEEDBACK（feedback_enter_awaiting）',
      '[weave] 任务「测试任务」AWAITING_FEEDBACK → CLOSED（feedback_accept）',
    ])

    await insertTask(p, { id: 'n-revise' })
    await echoRouter.enterAwaitingFeedback('n-revise')
    await echoRouter.revise('n-revise', '改成支持手机号')
    expect(notified.at(-1)!.text).toContain('AWAITING_FEEDBACK → REVISION_RUNNING（feedback_revise）')

    await insertTask(p, { id: 'n-cancel' })
    await echoRouter.enterAwaitingFeedback('n-cancel')
    await echoRouter.cancel('n-cancel')
    expect(notified.at(-1)!.text).toContain('AWAITING_FEEDBACK → CANCELLED（feedback_cancel）')

    await insertTask(p, { id: 'n-reopen' })
    await echoRouter.enterAwaitingFeedback('n-reopen')
    await echoRouter.accept('n-reopen')
    await echoRouter.reopen('n-reopen')
    expect(notified.at(-1)!.text).toContain('CLOSED → AWAITING_FEEDBACK（feedback_reopen）')

    // G1 审计补齐：本测试全部动作入账（by=user，矩阵内合法转移）。
    // 构成：4 次 enter（每任务）+ accept×2（n-accept、n-reopen）+ revise + cancel + reopen = 9 条。
    // query 默认倒序，用排序集合比对防同毫秒顺序歧义。
    const records = await audit.query({ types: ['task.status_changed'] })
    const entries = records
      .map((r) => `${(r as { from: string }).from}|${(r as { to: string }).to}|${(r as { by: string }).by}`)
      .sort()
    expect(entries).toEqual([
      'AWAITING_FEEDBACK|CANCELLED|user',       // n-cancel cancel
      'AWAITING_FEEDBACK|CLOSED|user',          // n-accept accept
      'AWAITING_FEEDBACK|CLOSED|user',          // n-reopen accept（reopen 前置）
      'AWAITING_FEEDBACK|REVISION_RUNNING|user', // n-revise revise
      'CLOSED|AWAITING_FEEDBACK|user',          // n-reopen reopen
      'COMPLETED|AWAITING_FEEDBACK|user',       // n-accept enter
      'COMPLETED|AWAITING_FEEDBACK|user',       // n-revise enter
      'COMPLETED|AWAITING_FEEDBACK|user',       // n-cancel enter
      'COMPLETED|AWAITING_FEEDBACK|user',       // n-reopen enter
    ])
    expect(records.every((r) => (r as { by: string }).by === 'user')).toBe(true)
  })

  it('closeExpired 批量合并为一条汇总（噪声控制②）', async () => {
    await insertTask(p, { id: 'n-exp-1', feedback_expires_at: '2026-08-01T00:00:00.000Z', status: 'AWAITING_FEEDBACK' })
    await insertTask(p, { id: 'n-exp-2', feedback_expires_at: '2026-08-01T00:00:00.000Z', status: 'AWAITING_FEEDBACK' })
    const closed = await echoRouter.closeExpired(new Date('2026-08-28T00:00:00.000Z'))
    expect(closed.sort()).toEqual(['n-exp-1', 'n-exp-2'])
    const batch = notified.at(-1)!.text
    expect(batch).toContain('状态变更 2 项：')
    expect(batch.match(/AWAITING_FEEDBACK → CLOSED（close_expired）/g)).toHaveLength(2)
  })

  it('缺省（未开回声）feedback=user 动作不发电', async () => {
    await insertTask(p, { id: 'n-quiet' })
    const before = notified.length
    await quietRouter.enterAwaitingFeedback('n-quiet')
    expect(notified.length).toBe(before)
  })
})


describe('FeedbackRouter 成员信箱投递分流（delivery 按消息类型）', () => {
  let p: WeavePersistence
  let tracker: SessionTracker
  let now: { value: Date }
  let deliveries: Array<{ to: string; from: string; content: string; delivery: 'quiet' | 'wakeup' }>
  let router: FeedbackRouter

  beforeAll(() => {
    p = openPersistence({ inMemory: true })
    tracker = new SessionTracker(p.feedback)
    now = { value: new Date(BASE) }
    deliveries = []
    router = new FeedbackRouter({
      tasks: p.tasks,
      feedback: p.feedback,
      sessionTracker: tracker,
      clock: makeClock(now),
      memberMailbox: {
        deliverToMember: async (input) => {
          deliveries.push({ to: input.to, from: input.from, content: input.content, delivery: input.delivery })
          return 'delivered'
        },
      },
    })
  })

  afterAll(() => {
    p.close()
  })

  it('revise（指令）→ wakeup；accept（确认）→ quiet；收件人=受派角色', async () => {
    await insertTask(p, { id: 'mb-1', assigned_agent: 'coder-a', executor: 'zcode' })
    await router.enterAwaitingFeedback('mb-1')
    await router.route('mb-1', '改成深色主题')
    expect(deliveries.at(-1)).toMatchObject({
      to: 'coder-a',
      from: 'captain',
      delivery: 'wakeup',
    })
    expect(deliveries.at(-1)!.content).toContain('改成深色主题')

    // accept 需要 AWAITING_FEEDBACK（revise 后任务在 REVISION_RUNNING）→ 用新任务验证确认分流。
    await insertTask(p, { id: 'mb-1b', assigned_agent: 'coder-a' })
    await router.enterAwaitingFeedback('mb-1b')
    await router.route('mb-1b', '确认')
    expect(deliveries.at(-1)).toMatchObject({ to: 'coder-a', delivery: 'quiet' })
  })

  it('cancel/reopen/保温超时 → quiet（状态知会旁路，不触发成员回合）', async () => {
    await insertTask(p, { id: 'mb-2', assigned_agent: 'tester-b' })
    await router.enterAwaitingFeedback('mb-2')
    await router.route('mb-2', '取消')
    expect(deliveries.at(-1)!.delivery).toBe('quiet')

    await insertTask(p, { id: 'mb-3', assigned_agent: 'coder-c' })
    await router.enterAwaitingFeedback('mb-3')
    await router.route('mb-3', '确认')
    await router.reopen('mb-3')
    expect(deliveries.at(-1)!.delivery).toBe('quiet')

    await insertTask(p, { id: 'mb-4', assigned_agent: 'qa-d', feedback_expires_at: '2026-08-01T00:00:00.000Z', status: 'AWAITING_FEEDBACK' })
    await router.closeExpired(new Date('2026-08-28T00:00:00.000Z'))
    expect(deliveries.at(-1)).toMatchObject({ to: 'qa-d', delivery: 'quiet' })
  })

  it('未注入 memberMailbox → 零行为（既有路径不受影响）', async () => {
    const bare = new FeedbackRouter({
      tasks: p.tasks,
      feedback: p.feedback,
      sessionTracker: tracker,
      clock: makeClock(now),
    })
    await insertTask(p, { id: 'mb-5', assigned_agent: 'dev-e' })
    await bare.enterAwaitingFeedback('mb-5')
    const before = deliveries.length
    await bare.route('mb-5', '改成浅色')
    expect(deliveries.length).toBe(before)
  })
})
