import type { RoleConfig, TeamConfig } from './team-manager.js'

/**
 * Minimal structural types of dsh-agent-teams profiles.
 *
 * We deliberately avoid importing fork at compile time here so the mapper can
 * be unit-tested without installing the fork package. The shape mirrors
 * `TeamProfileConfig` from dsh-agent-teams.
 */
export interface AgentTeamsProfileMember {
  name: string
  role?: string
  executor?: string
  provider?: string
  model?: string
  reasoning_effort?: string
  executionPrompt?: string
  fallback?: { provider: string; model: string }
}

export interface AgentTeamsProfile {
  description?: string
  protocol?: string
  executionPrompt?: string
  members: AgentTeamsProfileMember[]
  taskPlanning?: 'captain' | 'seed'
  tasks?: Array<{
    id: string
    subject: string
    description?: string
    assignee?: string
    dependencies: string[]
  }>
}

export interface TeamProfileMapping {
  /** Stable profile name = yaml team_id */
  profileName: string
  /** User-visible team name */
  teamName: string
  profile: AgentTeamsProfile
}

/** Normalize our yaml executor name to a dsh-agent-teams transport kind. */
export function normalizeExecutorKind(executor: string | undefined): string | undefined {
  if (!executor || executor.trim() === '') return undefined
  const value = executor.trim().toLowerCase()
  if (value === 'zcode' || value === 'acp') return 'acp'
  if (value === 'spawn' || value === 'fork') return 'dsh'
  return value
}

/**
 * Deterministic session-scoped team id.
 *
 * AgentTeams requires a unique team id per workspace; a session that enables
 * the same yaml team must get its own instance id.
 */
export function sessionTeamId(yamlTeamId: string, sessionId: string): string {
  const base = yamlTeamId.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  const cleanedSession = String(sessionId ?? '').replace(/[^A-Za-z0-9]+/g, '').replace(/^session/i, '')
  const short = cleanedSession.slice(0, 8)
  const raw = short === '' ? base : `${base}-${short}`
  return raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'team'
}

function roleProtocol(role: RoleConfig): string[] {
  const lines = [
    `- ${role.id} (${role.name})`,
    `  executor: ${role.executor}`,
    `  stages: ${role.stages.join(', ')}`,
  ]
  if (role.mode) lines.push(`  mode: ${role.mode}`)
  if (role.max_concurrent_tasks !== undefined) lines.push(`  max_concurrent_tasks: ${String(role.max_concurrent_tasks)}`)
  if (role.priority !== undefined) lines.push(`  priority: ${String(role.priority)}`)
  if (role.strengths && role.strengths.length > 0) lines.push(`  strengths: ${role.strengths.join(', ')}`)
  if (role.bias) lines.push(`  bias: ${role.bias}`)
  return lines
}

/**
 * Convert our yaml TeamConfig to a dsh-agent-teams named profile.
 *
 * Profile uses captain planning: fork's captain will design the task DAG from
 * the user goal. Our old task-template decomposition is intentionally not
 * replicated.
 */
export function teamConfigToAgentTeamsProfile(team: TeamConfig): TeamProfileMapping {
  const protocolLines = [
    team.description ? `团队简介：${team.description}` : '',
    '角色配置：',
  ]
  for (const role of team.roles) {
    protocolLines.push(...roleProtocol(role))
  }
  const protocol = protocolLines.filter((line) => line.trim() !== '').join('\n')

  return {
    profileName: team.team_id,
    teamName: team.name,
    profile: {
      ...team.description ? { description: team.description } : {},
      ...protocol ? { protocol } : {},
      taskPlanning: 'captain',
      members: team.roles.map((role) => {
        const fallbackProvider = role.fallback_provider?.trim()
        const fallbackModel = role.fallback_model?.trim()
        return {
          name: role.id,
          ...role.name ? { role: role.name } : {},
          ...normalizeExecutorKind(role.executor) ? { executor: normalizeExecutorKind(role.executor)! } : {},
          ...role.provider ? { provider: role.provider } : {},
          ...role.model ? { model: role.model } : {},
          ...role.thought_level ? { reasoning_effort: role.thought_level } : {},
          ...role.personality ? { executionPrompt: role.personality } : {},
          ...fallbackProvider && fallbackModel ? { fallback: { provider: fallbackProvider, model: fallbackModel } } : {},
        }
      }),
    },
  }
}
