import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export interface LegacyBinding {
  sessionId: string
  teamId: string
  updatedAt: string
}

export interface MigrationOptions {
  coreDb?: string
  sessionsRoot?: string
  /** 测试/特殊环境可覆盖项目根解码逻辑。 */
  decodeProjectRoot?: (sessionDir: string) => string
}

/** 把 DSH session 目录名解码为项目根，例如 `--K-work-test--` → `K:\work\test`。 */
export function decodeSessionDirToProject(sessionDir: string): string {
  const name = sessionDir.replace(/^--+/, '').replace(/--+$/, '')
  const parts = name.split('-')
  const drive = parts[0] ?? ''
  const rest = parts.slice(1)
  const sep = String.fromCharCode(92)
  return drive + String.fromCharCode(58) + (rest.length > 0 ? sep + rest.join(sep) : '')
}

export async function migrateLegacyTeamBindings(options: MigrationOptions = {}): Promise<{ migrated: number; projects: string[] }> {
  const coreDb = options.coreDb ?? join(homedir(), '.dsh', 'state', 'core.db')
  const sessionsRoot = options.sessionsRoot ?? join(homedir(), '.dsh', 'sessions')

  let rows: LegacyBinding[] = []
  try {
    const db = new DatabaseSync(coreDb, { readOnly: true })
    try {
      const stmt = db.prepare('SELECT session_id, team_id, updated_at FROM team_bindings')
      rows = (stmt.all() as Array<{ session_id: string; team_id: string; updated_at: string }>).map((row) => ({
        sessionId: row.session_id,
        teamId: row.team_id,
        updatedAt: row.updated_at,
      }))
    } finally {
      db.close()
    }
  } catch {
    return { migrated: 0, projects: [] }
  }

  const workspaceDirs = await readdir(sessionsRoot, { withFileTypes: true }).catch(() => [])
  const dirBySession = new Map<string, string>()
  for (const entry of workspaceDirs) {
    if (!entry.isDirectory()) continue
    const sessions = await readdir(join(sessionsRoot, entry.name)).catch(() => [])
    for (const sessionId of sessions) dirBySession.set(sessionId, entry.name)
  }

  const byProject = new Map<string, LegacyBinding[]>()
  for (const binding of rows) {
    const workspace = dirBySession.get(binding.sessionId)
    if (!workspace) continue
    const projectRoot = resolve(options.decodeProjectRoot?.(workspace) ?? decodeSessionDirToProject(workspace))
    const list = byProject.get(projectRoot) ?? []
    list.push(binding)
    byProject.set(projectRoot, list)
  }

  const projects: string[] = []
  for (const [projectRoot, bindings] of byProject) {
    const stateFile = join(projectRoot, '.dsh', 'weave', 'team', 'state.json')
    await mkdir(join(stateFile, '..'), { recursive: true })
    await writeFile(stateFile, JSON.stringify({ bindings }, null, 2), 'utf8')
    projects.push(projectRoot)
  }

  return { migrated: rows.length, projects }
}
