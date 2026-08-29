import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CaptainTurnGuard } from '../captain-turn-guard.js'
import { WeavePersistence } from '../persistence/persistence.js'

describe('CaptainTurnGuard', () => {
  let persistence: WeavePersistence
  let guard: CaptainTurnGuard

  beforeEach(() => {
    persistence = new WeavePersistence({ inMemory: true })
    guard = new CaptainTurnGuard({ persistence, pluginName: 'dsh-weave' })
  })

  afterEach(() => {
    persistence.close()
  })

  async function insertTask(id: string, status: string, sessionId = 'sess-1'): Promise<void> {
    await persistence.tasks.run((db) => {
      db.prepare(
        `INSERT INTO tasks (id, dag_id, session_id, team_id, project_id, version, description, dependencies, status, created_at, updated_at)
         VALUES (?, '', ?, 'team', 'proj', 'v1', ?, '[]', ?, ?, ?)`,
      ).run(id, sessionId, `task ${id}`, status, new Date().toISOString(), new Date().toISOString())
    })
  }

  it('有非终态任务时 activeTasks 返回任务，并生成禁止结束回合的注入消息', async () => {
    await insertTask('t-running', 'RUNNING')
    await insertTask('t-finished', 'COMPLETED')
    const active = await guard.activeTasks('sess-1')
    expect(active.map((t) => t.id)).toEqual(['t-running'])

    const message = guard.buildInjectedMessage(active)
    expect(message).not.toBeNull()
    expect(message!.content[0]?.text).toContain('禁止结束回合')
    expect(message!.source).toMatchObject({ kind: 'plugin', plugin: 'dsh-weave', form: 'notice' })
  })

  it('全部终态时不生成注入消息', async () => {
    await insertTask('t-finished', 'COMPLETED')
    await insertTask('t-skipped', 'SKIPPED')
    expect(await guard.activeTasks('sess-1')).toEqual([])
    expect(guard.buildInjectedMessage([])).toBeNull()
  })
})
