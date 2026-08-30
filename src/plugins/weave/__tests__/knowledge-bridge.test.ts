import { describe, expect, it, vi } from 'vitest'

import { KnowledgeBridge } from '../knowledge-bridge'
import type { KnowledgeEngine, KnowledgeInjectionEntry } from '../knowledge-engine'
import type { TeamConfig } from '../team-manager'

const TEAM: TeamConfig = {
  team_id: 'changan',
  name: '长安',
  default: true,
  roles: [
    { id: 'dev', name: '开发', bias: 'dev', executor: 'acp', stages: ['implement'], max_concurrent_tasks: 1, personality: '开发' },
  ],
  task_decomposition: { matchers: [], default_difficulty: 'hard', dag_templates: { hard: ['implement'] } },
  knowledge_injection: { max_entries: 2, max_chars_per_entry: 200, max_total_chars: 500, priority: 'freshness_first' },
  feedback: { feedback_timeout_seconds: 60, max_revisions: 2, reopen_window_seconds: 60 },
}

const ENTRY: KnowledgeInjectionEntry = {
  id: 'k1',
  title: '项目约定',
  content: '使用 pnpm',
  layer: 'project',
  visibility: 'project_only',
  freshness_score: 1,
}

describe('knowledge-bridge', () => {
  it('enrichAssignment appends knowledge to prompt', async () => {
    const engine = { searchForInjection: vi.fn(async () => [ENTRY]) } as unknown as KnowledgeEngine
    const bridge = new KnowledgeBridge({ engine })
    const prompt = await bridge.enrichAssignment({
      team: TEAM,
      teamId: 'changan-session1',
      roleId: 'dev',
      taskId: 't1',
      prompt: '任务',
    })
    expect(prompt).toContain('任务')
    expect(prompt).toContain('相关知识')
    expect(prompt).toContain('使用 pnpm')
    expect(engine.searchForInjection).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'changan',
      version: 'changan-session1',
      roleId: 'dev',
    }))
  })

  it('injectOnTeamCreated adds knowledge to member executionPrompt', async () => {
    const engine = { searchForInjection: vi.fn(async () => [ENTRY]) } as unknown as KnowledgeEngine
    const bridge = new KnowledgeBridge({ engine })
    const profile = await bridge.injectOnTeamCreated(TEAM, 'changan-session1', {
      taskPlanning: 'captain',
      members: [{ name: 'dev', role: '开发', executor: 'acp', executionPrompt: '基础人格' }],
    })
    expect(profile.members[0]?.executionPrompt).toContain('基础人格')
    expect(profile.members[0]?.executionPrompt).toContain('相关知识')
  })
})
