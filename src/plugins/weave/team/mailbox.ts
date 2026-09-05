import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { readSessionEvents } from '../executors/session-events-adapter.js'

export type MailboxDelivery = 'quiet' | 'wakeup'

export interface MailboxMessage {
  id: string
  from: string
  to: string
  content: string
  ts: number
  /**
   * 投递模式（官方 agent-team mailbox 语义对齐）：
   * - quiet：进收件旁路，不触发成员回合（状态知会类旁路信息，成员下回合自然消费）；
   * - wakeup：现有回灌行为（写目标会话触发成员回合）。
   * 缺省 'wakeup'（兼容既有 jsonl 行与既有调用方）。
   */
  delivery?: MailboxDelivery
  deliveryClaimedAt?: number
  deliveredAt?: number
  readAt?: number
}

function sanitizeKey(key: string): string {
  return key.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown'
}

function mailboxPath(projectRoot: string, sessionId: string, to: string): string {
  return join(projectRoot, '.dsh', 'weave', 'team', 'sessions', sanitizeKey(sessionId), 'inbox', `${sanitizeKey(to)}.jsonl`)
}

/** per-recipient 串行链的键：同收件人读写互斥，跨收件人无谓串行。 */
function boxKey(sessionId: string, to: string): string {
  return `${sessionId}\u0000${to}`
}

/** 投递文本尾部的观察标记：目标会话 durable 事件流据此判定「已持久记录」。 */
export function mailboxMarker(messageId: string): string {
  return `[mailbox:${messageId}]`
}

/**
 * 投递钩子（官方 TeamMailbox.observeSessionEvent/dispatchOnce 的 targetRecorded 语义
 * 在 weave 回灌链路上的对映）：
 * - targetSession()：目标会话句柄（现有回灌链路的 NoticeSessionLike 等任意形状）；
 *   不可用返回 undefined → 消息保持 queued 待重投；
 * - backflow()：wakeup 回灌执行（现有 notify/inject 链路）；text 已含观察标记；
 * - recorded()：观察者确认——目标会话 durable 事件流里是否已记录该消息；
 *   缺省按 `mailbox:<id>` 标记扫描 readSessionEvents 事件流（rc1 适配面）。
 */
export interface MailboxDeliveryHooks {
  targetSession?(message: MailboxMessage): unknown | undefined
  backflow?(message: MailboxMessage, text: string): void
  recorded?(session: unknown, message: MailboxMessage): boolean
}

async function readMessages(projectRoot: string, sessionId: string, to: string): Promise<MailboxMessage[]> {
  try {
    const raw = await readFile(mailboxPath(projectRoot, sessionId, to), 'utf8')
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as MailboxMessage)
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function writeMessages(projectRoot: string, sessionId: string, to: string, messages: MailboxMessage[]): Promise<void> {
  const path = mailboxPath(projectRoot, sessionId, to)
  await mkdir(join(path, '..'), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, messages.map((message) => JSON.stringify(message)).join('\n') + (messages.length ? '\n' : ''), 'utf8')
  await rename(tmp, path)
}

export class Mailbox {
  static readonly CAPTAIN = 'captain'

  /**
   * per-recipient 串行链（对齐官方 TeamJournal.transact 的 per-root tails）：
   * 同一 `${sessionId}:${to}` 收件箱的读-改-写操作按到达顺序串行执行，
   * 根治并发 append/ack/release 交错丢更新；前序失败不污染后续（tail 吞 rejection）。
   */
  readonly #tails = new Map<string, Promise<unknown>>()

  async #transact<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.#tails.get(key) ?? Promise.resolve()
    const run = prior.then(operation, operation)
    const tail = run.then(() => undefined, () => undefined)
    this.#tails.set(key, tail)
    try {
      return await run
    } finally {
      if (this.#tails.get(key) === tail) this.#tails.delete(key)
    }
  }

  async append(projectRoot: string, sessionId: string, to: string, message: MailboxMessage): Promise<void> {
    await this.#transact(boxKey(sessionId, to), async () => {
      const messages = await readMessages(projectRoot, sessionId, to)
      messages.push(message)
      await writeMessages(projectRoot, sessionId, to, messages)
    })
  }

  async claim(projectRoot: string, sessionId: string, to: string, ids: string[]): Promise<void> {
    await this.#transact(boxKey(sessionId, to), async () => {
      const now = Date.now()
      const messages = await readMessages(projectRoot, sessionId, to)
      const selected = new Set(ids)
      await writeMessages(projectRoot, sessionId, to, messages.map((message) =>
        selected.has(message.id) ? { ...message, deliveryClaimedAt: now } : message,
      ))
    })
  }

  async ack(projectRoot: string, sessionId: string, to: string, ids: string[]): Promise<void> {
    await this.#transact(boxKey(sessionId, to), async () => {
      const now = Date.now()
      const selected = new Set(ids)
      const messages = await readMessages(projectRoot, sessionId, to)
      await writeMessages(projectRoot, sessionId, to, messages.map((message) =>
        selected.has(message.id) ? { ...message, deliveredAt: message.deliveredAt ?? now, readAt: message.readAt ?? now } : message,
      ))
    })
  }

  async release(projectRoot: string, sessionId: string, to: string, ids: string[]): Promise<void> {
    await this.#transact(boxKey(sessionId, to), async () => {
      const selected = new Set(ids)
      const messages = await readMessages(projectRoot, sessionId, to)
      await writeMessages(projectRoot, sessionId, to, messages.map((message) =>
        selected.has(message.id) ? { ...message, deliveryClaimedAt: undefined } : message,
      ))
    })
  }

  async unread(projectRoot: string, sessionId: string, to: string): Promise<MailboxMessage[]> {
    const now = Date.now()
    return (await readMessages(projectRoot, sessionId, to)).filter((message) =>
      message.readAt === undefined
      && (message.deliveryClaimedAt === undefined || now - message.deliveryClaimedAt >= 60_000),
    )
  }

  /**
   * 投递一条消息（b/c）：先入收件（串行链内），再按 delivery 模式分流——
   * - quiet：仅进收件，不回灌、不触发成员回合（旁路信息）；返回 'queued'；
   * - wakeup：执行回灌钩子，随后观察者式确认——目标会话 durable 事件流已记录
   *   该消息才算 delivered（写 deliveredAt）；未确认则保持 queued。
   * 返回 'delivered' | 'queued'。
   */
  async deliver(
    projectRoot: string,
    sessionId: string,
    to: string,
    input: { id: string; from: string; content: string; ts: number; delivery?: MailboxDelivery },
    hooks: MailboxDeliveryHooks = {},
  ): Promise<'delivered' | 'queued'> {
    const message: MailboxMessage = { ...input, to, delivery: input.delivery ?? 'wakeup' }
    await this.append(projectRoot, sessionId, to, message)
    return await this.#dispatchOne(projectRoot, sessionId, to, message, hooks)
  }

  /**
   * 崩溃恢复（官方 recoverFor 的 queued-minus-delivered 语义）：
   * 重投收件箱内 `deliveredAt === undefined` 的消息；观察者确认目标会话已记录的
   * 只补确认不重复回灌（去重）。@returns 本次补确认/成功投递的消息 id 列表。
   */
  async recoverPending(
    projectRoot: string,
    sessionId: string,
    to: string,
    hooks: MailboxDeliveryHooks = {},
  ): Promise<string[]> {
    const pending = (await readMessages(projectRoot, sessionId, to)).filter((message) => message.deliveredAt === undefined)
    const recovered: string[] = []
    for (const message of pending) {
      if (await this.#dispatchOne(projectRoot, sessionId, to, message, hooks)) {
        recovered.push(message.id)
      }
    }
    return recovered
  }

  /** 单条投递尝试（观察者优先去重 → wakeup 回灌 → 观察确认入账；quiet 直接收队）。 */
  async #dispatchOne(
    projectRoot: string,
    sessionId: string,
    to: string,
    message: MailboxMessage,
    hooks: MailboxDeliveryHooks,
  ): Promise<'delivered' | 'queued'> {
    if ((message.delivery ?? 'wakeup') === 'quiet') return 'queued'
    const session = hooks.targetSession?.(message)
    const recorded = (target: unknown): boolean =>
      hooks.recorded ? hooks.recorded(target, message) : defaultRecorded(target, message)
    // 观察者优先（去重）：此前投递已落 durable 但确认丢失 → 只补确认，不重复回灌。
    if (session !== undefined && session !== null && recorded(session)) {
      await this.ack(projectRoot, sessionId, to, [message.id])
      return 'delivered'
    }
    if (!hooks.backflow) return 'queued'
    hooks.backflow(message, `${message.content} ${mailboxMarker(message.id)}`)
    // 无会话面或观察未确认（回灌丢失/尚未落 durable）→ 保持 queued，崩溃恢复重投兜底。
    if (session === undefined || session === null || !recorded(session)) return 'queued'
    await this.ack(projectRoot, sessionId, to, [message.id])
    return 'delivered'
  }
}

/** 缺省观察者：扫目标会话事件流（rc1 适配面），命中消息观察标记即视为已持久记录。 */
function defaultRecorded(session: unknown, message: MailboxMessage): boolean {
  const events = readSessionEvents(session)
  if (!events) return false
  const marker = mailboxMarker(message.id)
  return events.some((event) => {
    const blocks = (event.data as { message?: { content?: ReadonlyArray<{ text?: string }> } } | undefined)?.message?.content
    if (blocks?.some((block) => typeof block?.text === 'string' && block.text.includes(marker))) return true
    return typeof (event as { text?: string }).text === 'string' && (event as { text?: string }).text!.includes(marker)
  })
}
