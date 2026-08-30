import { describe, expect, it, vi } from 'vitest'

import { bootstrapSessionTeam } from '../session-bootstrap'
import type { TeamConfig } from '../team-manager'

const TEAM: TeamConfig = {
  team_id: 'changan',
  name: '长安',
  default: true,
  roles: [
    {
      id: 'developer-1',
      name: '开发工程师 1',
      bias: 'dev',
      executor: 'zcode',
      stages: ['implement'],
      max_concurrent_tasks: 1,
      personality: '开发',
    },
  ],
  task_decomposition: { matchers: [], default_difficulty: 'hard', dag_templates: { hard: ['implement'] } },
  knowledge_injection: { max_entries: 1, max_chars_per_entry: 100, max_total_chars: 300, priority: 'freshness_first' },
  feedback: { feedback_timeout_seconds: 60, max_revisions: 2, reopen_window_seconds: 60 },
}

describe('session-bootstrap', () => {
  it('maps team and delegates to fork bootstrapTeam with session-unique id', async () => {
    const bootstrapTeam = vi.fn(async () => ({ team: { id: 'changan-abc12345' }, created: true }))
    const result = await bootstrapSessionTeam(
      { host: { bootstrapTeam } },
      { sessionId: 'session-abc12345-xxxx', team: TEAM, captain: { id: 'captain-1' } },
    )
    expect(bootstrapTeam).toHaveBeenCalledWith({
      captain: { id: 'captain-1' },
      teamName: '长安',
      teamId: 'changan-abc12345',
      profileName: 'changan',
      description: undefined,
      approval: 'automatic',
    })
    expect(result.created).toBe(true)
    expect(result.teamId).toBe('changan-abc12345')
  })

  it('reuses an existing team when fork returns created=false', async () => {
    const bootstrapTeam = vi.fn(async () => ({ team: { id: 'changan-abc12345' }, created: false }))
    const result = await bootstrapSessionTeam(
      { host: { bootstrapTeam } },
      { sessionId: 'session-abc12345-xxxx', team: TEAM, captain: { id: 'captain-1' } },
    )
    expect(result.created).toBe(false)
    expect(result.teamId).toBe('changan-abc12345')
  })
})
