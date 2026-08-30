import { describe, expect, it } from 'vitest'

import type { TeamConfig } from '../team-manager'
import {
  normalizeExecutorKind,
  sessionTeamId,
  teamConfigToAgentTeamsProfile,
} from '../team-profile-mapper'

const TEAM: TeamConfig = {
  team_id: 'changan',
  name: '长安',
  description: '测试团队',
  default: true,
  roles: [
    {
      id: 'developer-1',
      name: '开发工程师 1',
      bias: 'dev',
      executor: 'zcode',
      stages: ['implement', 'test'],
      max_concurrent_tasks: 1,
      personality: '核心开发工程师',
      model: 'GLM-5.3-Flash',
      mode: 'yolo',
      thought_level: 'max',
      fallback_provider: 'zcode',
      fallback_model: 'GLM-5.3',
      priority: 1,
      strengths: ['编码', '调试'],
    },
    {
      id: 'qa',
      name: '质量审核',
      bias: 'qa',
      executor: 'fork',
      stages: ['review'],
      max_concurrent_tasks: 1,
      personality: '质量审核负责人',
      model: 'deepseek',
    },
  ],
  task_decomposition: {
    matchers: [],
    default_difficulty: 'hard',
    dag_templates: { hard: ['implement', 'review'] },
  },
  knowledge_injection: {
    max_entries: 1,
    max_chars_per_entry: 100,
    max_total_chars: 300,
    priority: 'freshness_first',
  },
  feedback: {
    feedback_timeout_seconds: 60,
    max_revisions: 2,
    reopen_window_seconds: 60,
  },
}

describe('team-profile-mapper', () => {
  it('normalizeExecutorKind 将 zcode/acp 归为 acp，spawn/fork 归为 dsh', () => {
    expect(normalizeExecutorKind('zcode')).toBe('acp')
    expect(normalizeExecutorKind('acp')).toBe('acp')
    expect(normalizeExecutorKind('fork')).toBe('dsh')
    expect(normalizeExecutorKind('spawn')).toBe('dsh')
    expect(normalizeExecutorKind(undefined)).toBeUndefined()
  })

  it('sessionTeamId 使用 yaml team id 加会话短 id', () => {
    const id = sessionTeamId('changan', 'session-4edcb4c4-05e2-4d70-96f7-3d0233748d4e')
    expect(id).toBe('changan-4edcb4c4')
    expect(sessionTeamId('changan', '')).toBe('changan')
  })

  it('teamConfigToAgentTeamsProfile 映射成员和协议', () => {
    const mapping = teamConfigToAgentTeamsProfile(TEAM)
    expect(mapping.profileName).toBe('changan')
    expect(mapping.teamName).toBe('长安')
    expect(mapping.profile.taskPlanning).toBe('captain')
    expect(mapping.profile.members).toHaveLength(2)

    const dev = mapping.profile.members[0]!
    expect(dev.name).toBe('developer-1')
    expect(dev.executor).toBe('acp')
    expect(dev.model).toBe('GLM-5.3-Flash')
    expect(dev.reasoning_effort).toBe('max')
    expect(dev.fallback).toEqual({ provider: 'zcode', model: 'GLM-5.3' })
    expect(dev.executionPrompt).toContain('核心开发工程师')

    const qa = mapping.profile.members[1]!
    expect(qa.executor).toBe('dsh')
    expect(mapping.profile.protocol).toContain('developer-1')
    expect(mapping.profile.protocol).toContain('mode: yolo')
    expect(mapping.profile.protocol).toContain('strengths: 编码, 调试')
  })
})
