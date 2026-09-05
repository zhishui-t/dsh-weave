import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { Mailbox, mailboxMarker, type MailboxDeliveryHooks } from '../../../../src/plugins/weave/team/mailbox.js'

const dirs: string[] = []
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weave-mailbox-'))
  dirs.push(dir)
  return dir
}
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

describe('Mailbox', () => {
  it('appends and reads unread messages', async () => {
    const projectRoot = root()
    const box = new Mailbox()
    await box.append(projectRoot, 'session-a', 'captain', { id: 'm1', from: 'dev', to: 'captain', content: 'done', ts: 1 })
    const unread = await box.unread(projectRoot, 'session-a', 'captain')
    expect(unread).toHaveLength(1)
    expect(unread[0]!.content).toBe('done')
  })

  it('claim then ack removes from unread', async () => {
    const projectRoot = root()
    const box = new Mailbox()
    await box.append(projectRoot, 'session-a', 'dev', { id: 'm1', from: 'captain', to: 'dev', content: 'do work', ts: 1 })
    await box.claim(projectRoot, 'session-a', 'dev', ['m1'])
    expect(await box.unread(projectRoot, 'session-a', 'dev')).toHaveLength(0)
    await box.release(projectRoot, 'session-a', 'dev', ['m1'])
    expect(await box.unread(projectRoot, 'session-a', 'dev')).toHaveLength(1)
    await box.claim(projectRoot, 'session-a', 'dev', ['m1'])
    await box.ack(projectRoot, 'session-a', 'dev', ['m1'])
    expect(await box.unread(projectRoot, 'session-a', 'dev')).toHaveLength(0)
  })

  it('separates mailboxes by recipient', async () => {
    const projectRoot = root()
    const box = new Mailbox()
    await box.append(projectRoot, 'session-a', 'captain', { id: 'c1', from: 'dev', to: 'captain', content: 'x', ts: 1 })
    await box.append(projectRoot, 'session-a', 'dev', { id: 'd1', from: 'captain', to: 'dev', content: 'y', ts: 1 })
    expect(await box.unread(projectRoot, 'session-a', 'captain')).toHaveLength(1)
    expect(await box.unread(projectRoot, 'session-a', 'dev')).toHaveLength(1)
  })

  it('per-recipient 串行链：并发 append/ack 无交错丢更新（读-改-写竞态根治）', async () => {
    const projectRoot = root()
    const box = new Mailbox()
    const total = 30
    // 同一收件箱并发混批：24 条 append + 6 次对前 6 条的 ack——无链路时读-改-写必然互相覆盖。
    await Promise.all([
      ...Array.from({ length: total }, (_, i) =>
        box.append(projectRoot, 'sess-race', 'dev', { id: `m${i}`, from: 'captain', to: 'dev', content: `c${i}`, ts: i })),
      ...Array.from({ length: 6 }, (_, i) => box.ack(projectRoot, 'sess-race', 'dev', [`m${i}`])),
    ])
    const all = await box.unread(projectRoot, 'sess-race', 'dev')
    const raw = (await import('node:fs/promises')).readFile(
      join(projectRoot, '.dsh', 'weave', 'team', 'sessions', 'sess-race', 'inbox', 'dev.jsonl'), 'utf8')
    const lines = (await raw).trim().split('\n')
    // 无丢更新：文件行数 = 30，id 全唯一；前 6 条已 ack 不再 unread。
    expect(lines).toHaveLength(total)
    const ids = lines.map((line) => (JSON.parse(line) as { id: string }).id)
    expect(new Set(ids).size).toBe(total)
    expect(all.every((message) => !/^m[0-5]$/.test(message.id))).toBe(true)
  })
})

describe('Mailbox.deliver（quiet/wakeup 分流 + 观察者式确认）', () => {
  function fakeSession(initial: Array<{ type: string; data: Record<string, unknown> }> = []): {
    session: { snapshotEvents: () => Array<{ type: string; data: Record<string, unknown> }> }
    events: Array<{ type: string; data: Record<string, unknown> }>
  } {
    const events = [...initial]
    return { session: { snapshotEvents: () => events }, events }
  }

  it('quiet：只进收件，不回灌不触发回合（旁路信息），保持 queued', async () => {
    const projectRoot = root()
    const box = new Mailbox()
    const backflow = vi.fn()
    const hooks: MailboxDeliveryHooks = {
      targetSession: () => fakeSession().session,
      backflow,
      recorded: () => true,
    }
    const status = await box.deliver(
      projectRoot, 'sess-q', 'dev',
      { id: 'q1', from: 'captain', content: '状态知会', ts: 1, delivery: 'quiet' },
      hooks,
    )
    expect(status).toBe('queued')
    expect(backflow).not.toHaveBeenCalled()
    const unread = await box.unread(projectRoot, 'sess-q', 'dev')
    expect(unread).toHaveLength(1)
    expect(unread[0]!.deliveredAt).toBeUndefined()
  })

  it('wakeup：回灌触发回合，观察者确认已持久记录才算 delivered（文本含观察标记）', async () => {
    const projectRoot = root()
    const box = new Mailbox()
    const { session, events } = fakeSession()
    // 回灌把 notice 写进目标会话 durable 事件流（现有 notify 链路的最小模拟）。
    const hooks: MailboxDeliveryHooks = {
      targetSession: () => session,
      backflow: (_message, text) => {
        events.push({ type: 'user/message', data: { message: { content: [{ type: 'text', text }] } } })
      },
    }
    const status = await box.deliver(
      projectRoot, 'sess-w', 'dev',
      { id: 'w1', from: 'captain', content: '请修订样式', ts: 1, delivery: 'wakeup' },
      hooks,
    )
    expect(status).toBe('delivered')
    const unread = await box.unread(projectRoot, 'sess-w', 'dev')
    expect(unread).toHaveLength(0) // deliveredAt 已入账
    expect(events.some((event) => JSON.stringify(event.data).includes(mailboxMarker('w1')))).toBe(true)
  })

  it('wakeup：观察未确认（回灌丢失）→ 保持 queued，deliveredAt 不写', async () => {
    const projectRoot = root()
    const box = new Mailbox()
    const { session } = fakeSession() // 空事件流：回灌后仍无记录
    const hooks: MailboxDeliveryHooks = {
      targetSession: () => session,
      backflow: () => undefined, // 回灌丢失
    }
    const status = await box.deliver(
      projectRoot, 'sess-lost', 'dev',
      { id: 'l1', from: 'captain', content: '会丢的', ts: 1 },
      hooks,
    )
    expect(status).toBe('queued') // delivery 缺省即 wakeup
    const unread = await box.unread(projectRoot, 'sess-lost', 'dev')
    expect(unread[0]!.deliveredAt).toBeUndefined()
  })

  it('崩溃恢复：queued-minus-delivered 重投；已持久记录的只补确认不重复回灌（去重）', async () => {
    const projectRoot = root()
    const box = new Mailbox()
    // 场景 1：m-ack 上一进程已回灌落 durable 但 ack 丢失；m-new 从未投递。
    const { session, events } = fakeSession([
      { type: 'user/message', data: { message: { content: [{ type: 'text', text: `旧投递 ${mailboxMarker('m-ack')}` }] } } },
    ])
    const backflow = vi.fn((_message: unknown, text: string) => {
      events.push({ type: 'user/message', data: { message: { content: [{ type: 'text', text }] } } })
    })
    await box.append(projectRoot, 'sess-rec', 'dev', { id: 'm-ack', from: 'captain', to: 'dev', content: '旧的', ts: 1 })
    await box.append(projectRoot, 'sess-rec', 'dev', { id: 'm-new', from: 'captain', to: 'dev', content: '新的', ts: 2 })

    const hooks: MailboxDeliveryHooks = { targetSession: () => session, backflow }
    const recovered = await box.recoverPending(projectRoot, 'sess-rec', 'dev', hooks)

    // 去重：m-ack 只补确认不回灌；m-new 真投递。
    expect(recovered).toEqual(['m-ack', 'm-new'])
    expect(backflow).toHaveBeenCalledTimes(1)
    expect((backflow.mock.calls[0]![1] as string)).toContain(mailboxMarker('m-new'))
    expect(await box.unread(projectRoot, 'sess-rec', 'dev')).toHaveLength(0)

    // 再跑一轮恢复：全部已 delivered，零回灌零重投。
    const second = await box.recoverPending(projectRoot, 'sess-rec', 'dev', hooks)
    expect(second).toEqual([])
    expect(backflow).toHaveBeenCalledTimes(1)
  })
})
