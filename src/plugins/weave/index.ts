import { Context, Service } from '@deepseek-ai/cordis'
import { DEFAULT_PROVIDERS_FILE, ProviderStore } from './acp/provider-store.js'
import { acpRegistryContextFrom, registerStoredAcpProviders } from './acp/dynamic-provider.js'
import { createCoreDeps, createDefaultExecutorProviderRegistry } from './core-deps.js'
import { KnowledgeEngine } from './knowledge-engine.js'
import { ReflectionService } from './reflection-service.js'
import { ReflectionBridge, type AgentTeamsTaskSettledLike } from './reflection-bridge.js'
import { KnowledgeBridge } from './knowledge-bridge.js'
import { resolveAgentTeamsHost, type AgentTeamsAssignmentLike } from './agent-teams-host.js'
import { bootstrapSessionTeam } from './session-bootstrap.js'
import { teamConfigToAgentTeamsProfile } from './team-profile-mapper.js'
import { ExecutorSessionStore } from './executor-session-store.js'
import { AcpMemberTransport } from './acp-member-transport.js'
import {
  createPreStepDelegationHook,
  createWeaveNoticeMessage,
  hasPendingToolCall,
  notifySession,
  type NoticeSessionLike,
  type WeaveNoticeMessage,
} from './session-delegation.js'
import { DEFAULT_STATE_DIR } from './persistence/persistence.js'
import { DEFAULT_WEAVE_SETTINGS_FILE, loadWeaveSettingsOverrides } from './settings-store.js'
import type { ZcodeAcpExecutorProvider } from './acp/acp-session-provider.js'
import type { ExecutorProviderRegistry } from './executors/executor-provider.js'

export const WEAVE_VERSION = '0.2.0'

export const name = 'dsh-weave'
export const inject = {}

export class WeaveService extends Service {
  readonly pluginName = name
  readonly loadedAt = Date.now()

  executorProviders?: ExecutorProviderRegistry

  version(): string {
    return WEAVE_VERSION
  }

  describe(): string {
    return `dsh-weave v${WEAVE_VERSION} (loaded at ${new Date(this.loadedAt).toISOString()})`
  }
}

export function apply(ctx: Context): void {
  const service = new WeaveService(ctx, 'weave')

  ctx.inject(['subagents', 'subprocess', 'commands', 'tools', 'llm'], (scoped) => {
    const runtime = scoped as Context
    const weaveSettingsFile = DEFAULT_WEAVE_SETTINGS_FILE
    const settingsOverrides = loadWeaveSettingsOverrides(weaveSettingsFile)
    const effectiveProvidersFile = settingsOverrides.providers_file ?? DEFAULT_PROVIDERS_FILE
    const effectiveStateDir = settingsOverrides.state_dir ?? DEFAULT_STATE_DIR

    let agentsRegistry: { get(id: string): unknown } | undefined
    try {
      agentsRegistry = (runtime as Context & { reflect?: { get(name: string, fallback?: boolean): unknown } }).reflect?.get('agents', false) as
        | { get(id: string): unknown }
        | undefined
    } catch {
      agentsRegistry = undefined
    }

    try {
      service.executorProviders = createDefaultExecutorProviderRegistry(runtime)
      const storedProviders = registerStoredAcpProviders({
        providersFile: effectiveProvidersFile,
        ...acpRegistryContextFrom(runtime),
        registry: service.executorProviders,
      })
      runtime.effect(() => () => {
        for (const disposer of Object.values(storedProviders.disposersByName ?? {})) {
          for (const fn of disposer as Array<() => void>) fn()
        }
      }, 'dsh-weave dynamic provider lifecycle')
    } catch (error) {
      console.warn('[dsh-weave] executor provider registration failed:', error)
    }

    const deps = createCoreDeps(runtime, {
      ...(settingsOverrides.state_dir ? { stateDir: settingsOverrides.state_dir } : {}),
      ...(settingsOverrides.teams_dir ? { teamsDir: settingsOverrides.teams_dir } : {}),
      ...(settingsOverrides.audit_dir ? { auditDir: settingsOverrides.audit_dir } : {}),
      ...(settingsOverrides.knowledge_dir ? { knowledgeDir: settingsOverrides.knowledge_dir } : {}),
    })

    const notifyWeaveSession = (sessionId: string, text: string, session?: NoticeSessionLike): void => {
      if (!session) {
        console.warn('[dsh-weave] cannot notify session', sessionId, '- session surface unavailable')
        return
      }
      try {
        const agent = agentsRegistry?.get(sessionId) as
          | { inject?: (message: WeaveNoticeMessage) => void }
          | undefined
        if (hasPendingToolCall(session) && typeof agent?.inject === 'function') {
          agent.inject(createWeaveNoticeMessage(text))
          return
        }
        notifySession(session, text)
      } catch (error) {
        console.warn('[dsh-weave] notify session failed:', error)
      }
    }

    const resolveNoticeSession = (sessionId: string): NoticeSessionLike | undefined =>
      (agentsRegistry?.get(sessionId) as { session?: NoticeSessionLike } | undefined)?.session

    const reflection = new ReflectionService({ knowledge: deps.knowledgeStore, audit: deps.audit })
    const reflectionBridge = new ReflectionBridge(reflection)
    const agentTeamsHost = resolveAgentTeamsHost(runtime)

    if (agentTeamsHost?.registerProfile) {
      for (const team of deps.teamManager.listTeams()) {
        const mapped = teamConfigToAgentTeamsProfile(team)
        agentTeamsHost.registerProfile(mapped.profileName, mapped.profile)
      }
    }
    agentTeamsHost?.hostHooks?.add({
      onTaskSettled: (input: AgentTeamsTaskSettledLike) => reflectionBridge.onTaskSettled(input),
    })
    const knowledgeBridge = new KnowledgeBridge({ engine: new KnowledgeEngine(deps.knowledgeStore) })
    agentTeamsHost?.hostHooks?.add({
      enrichAssignment: async (input: AgentTeamsAssignmentLike) => {
        const team = input.teamProfileName ? deps.teamManager.loadTeam(input.teamProfileName) : null
        if (!team) return input.prompt
        return knowledgeBridge.enrichAssignment({
          team,
          teamId: input.teamId,
          roleId: input.memberName,
          taskId: input.taskId,
          prompt: input.prompt,
        })
      },
    })
    const zcodeProvider = service.executorProviders?.get('zcode') as ZcodeAcpExecutorProvider | undefined
    if (agentTeamsHost?.memberTransports && zcodeProvider) {
      agentTeamsHost.memberTransports.register('acp', new AcpMemberTransport(
        zcodeProvider as never,
        new ExecutorSessionStore(),
      ))
    }

    try {
      const hook = createPreStepDelegationHook({
        listTeams: () => deps.teamManager.listTeams(),
        setSelection: async (sessionId, teamId) => {
          if (teamId === null) await deps.teamManager.unbindTeam(sessionId)
          else await deps.teamManager.bindTeam(sessionId, teamId)
        },
        onTeamEnabled: async (sessionId, team, agent) => {
          const host = resolveAgentTeamsHost(runtime)
          if (!host) return
          const mapped = teamConfigToAgentTeamsProfile(team)
          if (host.registerProfile) host.registerProfile(mapped.profileName, mapped.profile)
          await bootstrapSessionTeam({ host }, { sessionId, team, captain: agent })
        },
        notify: notifyWeaveSession,
      })
      const evented = runtime as Context & { on?(name: string, listener: unknown): unknown }
      const offHook = evented.on?.('agent/pre-step', hook)
      runtime.effect(() => () => {
        if (typeof offHook === 'function') offHook()
      }, 'dsh-weave pre-step delegation hook')
    } catch (error) {
      console.warn('[dsh-weave] pre-step delegation hook registration failed:', error)
    }
  })
}
