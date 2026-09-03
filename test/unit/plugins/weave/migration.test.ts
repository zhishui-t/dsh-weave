import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { decodeSessionDirToProject, migrateLegacyTeamBindings } from '../../../../src/plugins/weave/team/migration.js'

const dirs: string[] = []
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weave-migrate-'))
  dirs.push(dir)
  return dir
}
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

describe('team migration', () => {
  it('decodes session dir to project path', () => {
    expect(decodeSessionDirToProject('--K-work-test--')).toBe('K:' + String.fromCharCode(92) + 'work' + String.fromCharCode(92) + 'test')
  })

  it('migrates legacy team_bindings into project state.json', async () => {
    const base = tmp()
    const sessionsRoot = join(base, 'sessions')
    const projectDir = join(base, 'work', 'test')
    mkdirSync(join(sessionsRoot, '--K-work-test--', 'session-a'), { recursive: true })
    const coreDb = join(base, 'core.db')
    const db = new DatabaseSync(coreDb)
    db.exec('CREATE TABLE team_bindings (session_id TEXT, team_id TEXT, updated_at TEXT)')
    db.prepare('INSERT INTO team_bindings VALUES (?, ?, ?)').run('session-a', 'deepseek-zcode-test', '2026-01-01')
    db.close()

    const result = await migrateLegacyTeamBindings({
      coreDb,
      sessionsRoot,
      decodeProjectRoot: () => projectDir,
    })
    expect(result.migrated).toBe(1)
    const state = JSON.parse(await (await import('node:fs/promises')).readFile(join(projectDir, '.dsh', 'weave', 'team', 'state.json'), 'utf8'))
    expect(state.bindings).toHaveLength(1)
    expect(state.bindings[0].teamId).toBe('deepseek-zcode-test')
  })
})
