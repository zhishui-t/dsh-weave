import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface SessionTeamState {
  sessionId: string
  teamId: string
  team?: unknown
  dag?: unknown
  tasks?: unknown[]
  members?: unknown[]
  updatedAt: string
}

export interface ProjectTeamSnapshot {
  projectRoot: string
  stateRoot: string
  sessions: SessionTeamState[]
}

/**
 * 项目级团队运行状态存储。
 *
 * 布局：
 *   <projectRoot>/.dsh/weave/team/
 *     sessions/<sessionId>/session.json
 *     archive/<sessionId>/session.json
 */
export class ProjectTeamStore {
  root(projectRoot: string): string {
    return join(projectRoot, '.dsh', 'weave', 'team')
  }

  sessionFile(projectRoot: string, sessionId: string): string {
    return join(this.root(projectRoot), 'sessions', sessionId, 'session.json')
  }

  async loadSession(projectRoot: string, sessionId: string): Promise<SessionTeamState | undefined> {
    try {
      const raw = await readFile(this.sessionFile(projectRoot, sessionId), 'utf8')
      return JSON.parse(raw) as SessionTeamState
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async saveSession(projectRoot: string, state: SessionTeamState): Promise<void> {
    const file = this.sessionFile(projectRoot, state.sessionId)
    await mkdir(join(file, '..'), { recursive: true })
    const tmp = `${file}.tmp`
    await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
    await rename(tmp, file)
  }

  async listSessions(projectRoot: string): Promise<string[]> {
    const dir = join(this.root(projectRoot), 'sessions')
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  async archiveSession(projectRoot: string, sessionId: string): Promise<void> {
    const source = join(this.root(projectRoot), 'sessions', sessionId)
    const archiveRoot = join(this.root(projectRoot), 'archive')
    const target = join(archiveRoot, sessionId)
    await mkdir(archiveRoot, { recursive: true })
    await rm(target, { recursive: true, force: true })
    await rename(source, target)
  }

  async snapshot(projectRoot: string): Promise<ProjectTeamSnapshot> {
    const sessions: SessionTeamState[] = []
    for (const sessionId of await this.listSessions(projectRoot)) {
      const state = await this.loadSession(projectRoot, sessionId)
      if (state !== undefined) sessions.push(state)
    }
    return {
      projectRoot,
      stateRoot: this.root(projectRoot),
      sessions,
    }
  }
}
