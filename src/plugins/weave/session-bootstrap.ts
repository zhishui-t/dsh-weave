import type { TeamConfig } from './team-manager.js'
import {
  sessionTeamId,
  teamConfigToAgentTeamsProfile,
} from './team-profile-mapper.js'
import type { AgentTeamsHost } from './agent-teams-host.js'

export interface SessionBootstrapOptions {
  host: AgentTeamsHost
}

export interface SessionBootstrapInput {
  sessionId: string
  team: TeamConfig
  captain: unknown
}

export interface SessionBootstrapResult {
  created: boolean
  teamId: string
  profileName: string
  team: unknown
}

/**
 * Convert a yaml team configuration and activate it by creating/reusing a
 * fork team. This is the only weave-side team creation entry point.
 */
export async function bootstrapSessionTeam(
  options: SessionBootstrapOptions,
  input: SessionBootstrapInput,
): Promise<SessionBootstrapResult> {
  const mapping = teamConfigToAgentTeamsProfile(input.team)
  const teamId = sessionTeamId(input.team.team_id, input.sessionId)
  const result = await options.host.bootstrapTeam({
    captain: input.captain,
    teamName: mapping.teamName,
    teamId,
    profileName: mapping.profileName,
    ...input.team.description ? { description: input.team.description } : {},
    approval: 'automatic',
  })
  return {
    created: result.created,
    teamId,
    profileName: mapping.profileName,
    team: result.team,
  }
}
