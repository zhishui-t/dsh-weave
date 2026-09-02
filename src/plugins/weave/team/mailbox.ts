import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface MailboxMessage {
  id: string
  from: string
  to: string
  content: string
  ts: number
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

  async append(projectRoot: string, sessionId: string, to: string, message: MailboxMessage): Promise<void> {
    const messages = await readMessages(projectRoot, sessionId, to)
    messages.push(message)
    await writeMessages(projectRoot, sessionId, to, messages)
  }

  async claim(projectRoot: string, sessionId: string, to: string, ids: string[]): Promise<void> {
    const now = Date.now()
    const messages = await readMessages(projectRoot, sessionId, to)
    const selected = new Set(ids)
    await writeMessages(projectRoot, sessionId, to, messages.map((message) =>
      selected.has(message.id) ? { ...message, deliveryClaimedAt: now } : message,
    ))
  }

  async ack(projectRoot: string, sessionId: string, to: string, ids: string[]): Promise<void> {
    const now = Date.now()
    const selected = new Set(ids)
    const messages = await readMessages(projectRoot, sessionId, to)
    await writeMessages(projectRoot, sessionId, to, messages.map((message) =>
      selected.has(message.id) ? { ...message, deliveredAt: message.deliveredAt ?? now, readAt: message.readAt ?? now } : message,
    ))
  }

  async release(projectRoot: string, sessionId: string, to: string, ids: string[]): Promise<void> {
    const selected = new Set(ids)
    const messages = await readMessages(projectRoot, sessionId, to)
    await writeMessages(projectRoot, sessionId, to, messages.map((message) =>
      selected.has(message.id) ? { ...message, deliveryClaimedAt: undefined } : message,
    ))
  }

  async unread(projectRoot: string, sessionId: string, to: string): Promise<MailboxMessage[]> {
    const now = Date.now()
    return (await readMessages(projectRoot, sessionId, to)).filter((message) =>
      message.readAt === undefined
      && (message.deliveryClaimedAt === undefined || now - message.deliveryClaimedAt >= 60_000),
    )
  }
}
