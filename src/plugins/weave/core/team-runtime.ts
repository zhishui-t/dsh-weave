import type { Context } from '@deepseek-ai/cordis'
import type { CliMcpDeps } from '../cli-mcp.js'
import type { ExecutorProviderRegistry } from '../executors/executor-provider.js'
import { DelegationService } from '../delegation-service.js'
import { SessionTracker } from '../session-tracker.js'
import { KnowledgeEngine } from '../knowledge-engine.js'
import { createExecutorEventNotifier, type StreamOptions } from '../session-stream.js'
import { TaskStatusNotifier } from '../task-status-notifier.js'
import { WeaveScheduler, subjectLabel } from '../scheduler.js'
import type { WeaveCapabilities } from './capabilities.js'
import type { AuditLog } from '../audit/audit-log.js'
import type { ReflectionService } from '../reflection-service.js'
import { TeamPlanner, createPlanTasksHandler } from '../planner.js'
import { CaptainTurnGuard } from '../captain-turn-guard.js'
import { ProjectTeamStore } from '../team/project-team-store.js'
import { Mailbox } from '../team/mailbox.js'
import { ReflectionSink } from '../team/reflection-sink.js'
import { OnDutyController } from './on-duty.js'
import {
  createWeaveNoticeMessage,
  hasPendingToolCall,
  notifySession,
  type NoticeSessionLike,
  type WeaveNoticeMessage,
} from '../session-delegation.js'

export interface TeamRuntimeOptions {
  runtime: Context
  deps: CliMcpDeps
  executorProviders?: ExecutorProviderRegistry
  weaveSettingsFile: string
  executionStream: StreamOptions
  idleTimeoutMs: number
  capabilities: WeaveCapabilities
}

export interface TeamRuntime {
  delegation: DelegationService
  scheduler: WeaveScheduler
  planner: TeamPlanner
  statusNotifier: TaskStatusNotifier
  auditLog: AuditLog
  reflection: ReflectionService
  agentsRegistry: { get(id: string): unknown } | undefined
  notifyWeaveSession(sessionId: string, text: string, session?: NoticeSessionLike): void
  resolveNoticeSession(sessionId: string): NoticeSessionLike | undefined
  planTasks: ReturnType<typeof createPlanTasksHandler>
  projectTeamStore: ProjectTeamStore
  mailbox: Mailbox
  reflectionSink: ReflectionSink
  onDuty: OnDutyController
  disposeScheduler(): void
}

export function createTeamRuntime(options: TeamRuntimeOptions): TeamRuntime {
  const { runtime, deps, executorProviders, weaveSettingsFile, executionStream, idleTimeoutMs, capabilities } = options

  let agentsRegistry: { get(id: string): unknown } | undefined
  try {
    agentsRegistry = (runtime as Context & { reflect?: { get(name: string, fallback?: boolean): unknown } }).reflect?.get('agents', false) as
      | { get(id: string): unknown }
      | undefined
  } catch {
    agentsRegistry = undefined
  }

  const resolveNoticeSession = (sessionId: string): NoticeSessionLike | undefined =>
    (agentsRegistry?.get(sessionId) as { session?: NoticeSessionLike } | undefined)?.session

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

  const { auditLog, reflection } = capabilities

  const statusNotifier = new TaskStatusNotifier({
    notify: (sessionId, text) => {
      notifyWeaveSession(sessionId, text, resolveNoticeSession(sessionId))
    },
  })

  const delegation = new DelegationService(
    { subagents: (runtime as unknown as { subagents: unknown }).subagents } as never,
    {
      executorRegistry: deps.executorRegistry,
      executorProviders,
      sessionTracker: new SessionTracker(deps.persistence.feedback),
      knowledgeEngine: new KnowledgeEngine(deps.knowledgeStore!),
      idleTimeoutMs,
      delegationMaxWallClockMs: 0,
      onExecutorEvent: createExecutorEventNotifier({
        ...executionStream,
        notify: (sessionId, text) => {
          notifyWeaveSession(sessionId, text, resolveNoticeSession(sessionId))
        },
      }),
    },
  )

  const scheduler = new WeaveScheduler({
    delegation,
    persistence: deps.persistence,
    loadTeam: (teamId) => deps.teamManager.loadTeam(teamId),
    notify: (sessionId, text, session) => notifyWeaveSession(sessionId, text, session ?? resolveNoticeSession(sessionId)),
    statusNotifier,
    audit: auditLog,
    onTaskSettledText: async ({ task, role, text }) => {
      const result = await reflection.depositFromOutput({
        taskId: task.id,
        executor: role.executor,
        roleId: role.id,
        projectId: task.project_id,
        version: task.version,
        outputText: text,
        taskSubject: subjectLabel(task),
      })
      return result.deposited.length
    },
  })

  const projectTeamStore = new ProjectTeamStore()
  const mailbox = new Mailbox()
  const reflectionSink = new ReflectionSink(reflection)
  const onDuty = new OnDutyController({
    hasActiveWork: async (sessionId) => scheduler.memberRuntime(sessionId).length > 0,
    hasUnread: async (sessionId) => (await mailbox.unread(process.cwd(), sessionId, Mailbox.CAPTAIN)).length > 0,
    notify: (sessionId, text) => notifyWeaveSession(sessionId, text, resolveNoticeSession(sessionId)),
  })

  deps.executionHooks = {
    cancelTask: async (taskId) => scheduler.onExternalCancel(taskId),
    resumeTask: async (taskId) => scheduler.onExternalRetry(taskId),
  }

  const planner = new TeamPlanner({ persistence: deps.persistence, teamManager: deps.teamManager })
  const planTasks = createPlanTasksHandler({
    planner,
    schedulerStart: async (input) => scheduler.start(input),
    log: console,
    getAgentById: (id) => agentsRegistry?.get(id as never),
  })

  return {
    delegation,
    scheduler,
    planner,
    statusNotifier,
    auditLog,
    reflection,
    agentsRegistry,
    notifyWeaveSession,
    resolveNoticeSession,
    planTasks,
    projectTeamStore,
    mailbox,
    reflectionSink,
    onDuty,
    disposeScheduler: () => scheduler.dispose(),
  }
}
