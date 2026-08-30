import type { KnowledgeEngine, KnowledgeInjectionEntry } from './knowledge-engine'
import type { RoleConfig, TeamConfig } from './team-manager'
import type { AgentTeamsProfile } from './team-profile-mapper'

export interface KnowledgeBridgeOptions {
  engine: KnowledgeEngine
}

function formatEntries(entries: readonly KnowledgeInjectionEntry[]): string {
  if (entries.length === 0) return ''
  const lines = entries.map((entry) => `- ${entry.title}: ${entry.content}`)
  return `\n\n相关知识：\n${lines.join('\n')}`
}

export class KnowledgeBridge {
  readonly #engine: KnowledgeEngine

  constructor(options: KnowledgeBridgeOptions) {
    this.#engine = options.engine
  }

  async enrichAssignment(input: {
    team: TeamConfig
    teamId: string
    roleId: string
    taskId: string
    prompt: string
  }): Promise<string> {
    const entries = await this.#search({
      team: input.team,
      teamId: input.teamId,
      roleId: input.roleId,
      taskId: input.taskId,
    })
    if (entries.length === 0) return input.prompt
    return `${input.prompt}${formatEntries(entries)}`
  }

  /** Mutate a mapped profile by appending per-role knowledge to member executionPrompt. */
  async injectOnTeamCreated(
    team: TeamConfig,
    teamId: string,
    profile: AgentTeamsProfile,
  ): Promise<AgentTeamsProfile> {
    const withPrompt: AgentTeamsProfile = {
      ...profile,
      members: [],
    }
    for (const member of profile.members) {
      const role = team.roles.find((candidate) => candidate.id === member.name)
      const entries = await this.#search({
        team,
        teamId,
        roleId: member.name,
        taskId: `bootstrap-${member.name}`,
      })
      const base = member.executionPrompt ?? ''
      const enriched = `${base}${formatEntries(entries)}`
      withPrompt.members.push({
        ...member,
        ...enriched.trim() === '' ? {} : { executionPrompt: enriched.trim() },
      })
    }
    return withPrompt
  }

  async #search(input: {
    team: TeamConfig
    teamId: string
    roleId: string
    taskId: string
  }): Promise<KnowledgeInjectionEntry[]> {
    try {
      return await this.#engine.searchForInjection({
        taskId: input.taskId,
        projectId: input.team.team_id,
        version: input.teamId,
        roleId: input.roleId,
        limit: input.team.knowledge_injection,
        slim: true,
      })
    } catch {
      // Knowledge must never block team lifecycle.
      return []
    }
  }
}

/** Helper used by the session bootstrap to enrich an already mapped profile. */
export function isRoleNeeded(_role: RoleConfig): boolean {
  return true
}
