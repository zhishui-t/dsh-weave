import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ProjectTeamStore } from '../team/project-team-store.js'

const dirs: string[] = []
function projectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weave-team-store-'))
  dirs.push(dir)
  return dir
}
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

describe('ProjectTeamStore', () => {
  it('saves and loads a session under the project directory', async () => {
    const store = new ProjectTeamStore()
    const root = projectRoot()
    const state = { sessionId: 'session-a', teamId: 'deepseek-zcode-test', updatedAt: new Date().toISOString() }
    await store.saveSession(root, state)
    expect(await store.loadSession(root, 'session-a')).toEqual(state)
    expect(store.sessionFile(root, 'session-a')).toBe(join(root, '.dsh', 'weave', 'team', 'sessions', 'session-a', 'session.json'))
  })

  it('lists sessions and creates a snapshot', async () => {
    const store = new ProjectTeamStore()
    const root = projectRoot()
    await store.saveSession(root, { sessionId: 's1', teamId: 'a', updatedAt: '2026-01-01' })
    await store.saveSession(root, { sessionId: 's2', teamId: 'b', updatedAt: '2026-01-01' })
    expect(await store.listSessions(root)).toEqual(['s1', 's2'])
    const snap = await store.snapshot(root)
    expect(snap.sessions).toHaveLength(2)
  })

  it('archives a session', async () => {
    const store = new ProjectTeamStore()
    const root = projectRoot()
    await store.saveSession(root, { sessionId: 's1', teamId: 'a', updatedAt: '2026-01-01' })
    await store.archiveSession(root, 's1')
    expect(await store.loadSession(root, 's1')).toBeUndefined()
  })
})
