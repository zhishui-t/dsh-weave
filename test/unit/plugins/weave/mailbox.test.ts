import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Mailbox } from '../../../../src/plugins/weave/team/mailbox.js'

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
})
