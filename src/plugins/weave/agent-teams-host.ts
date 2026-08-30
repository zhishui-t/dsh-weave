/**
 * Minimal structural view of fork's Cordis services.
 *
 * We keep this structural so weave does not need a compile-time dependency on
 * fork; at runtime the fork plugin must provide:
 *   - agentTeams/runtime
 *   - agentTeams/bootstrapTeam
 *   - agentTeams/hostHooks
 */

export interface AgentTeamsBootstrapInput {
  captain: unknown
  teamName: string
  teamId: string
  profileName: string
  description?: string
  approval?: 'automatic' | 'required'
}

export interface AgentTeamsBootstrapResult {
  team: unknown
  created: boolean
}

export interface AgentTeamsHostHooks {
  add(hooks: unknown): () => void
}

export interface MemberTransportRegistrar {
  register(kind: string, transport: unknown): unknown
}

export interface AgentTeamsHost {
  bootstrapTeam(input: AgentTeamsBootstrapInput): Promise<AgentTeamsBootstrapResult>
  hostHooks?: AgentTeamsHostHooks
  memberTransports?: MemberTransportRegistrar
}

interface CordisLike {
  get?(name: string): unknown
}

export function resolveAgentTeamsHost(ctx: CordisLike | undefined | null): AgentTeamsHost | null {
  if (!ctx || typeof ctx.get !== 'function') return null
  const runtime = ctx.get('agentTeams/runtime') as { bootstrapTeam?: unknown } | undefined
  const directBootstrap = ctx.get('agentTeams/bootstrapTeam') as unknown
  const hostHooks = ctx.get('agentTeams/hostHooks') as AgentTeamsHostHooks | undefined
  const memberTransports = ctx.get('agentTeams/memberTransports') as MemberTransportRegistrar | undefined
  const bootstrapTeam =
    (runtime && typeof (runtime as { bootstrapTeam?: unknown }).bootstrapTeam === 'function'
      ? (runtime as { bootstrapTeam: unknown }).bootstrapTeam
      : typeof directBootstrap === 'function' ? directBootstrap : undefined) as
    ((input: AgentTeamsBootstrapInput) => Promise<AgentTeamsBootstrapResult>) | undefined
  if (typeof bootstrapTeam !== 'function') return null
  return { bootstrapTeam, ...hostHooks ? { hostHooks } : {}, ...memberTransports ? { memberTransports } : {} }
}
