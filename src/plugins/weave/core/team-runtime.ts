import type { Context } from '@deepseek-ai/cordis'
import type { CliMcpDeps } from '../host/cli-mcp.js'
import type { ExecutorProviderRegistry } from '../executors/executor-provider.js'
import { DelegationService } from '../scheduling/delegation-service.js'
import { SessionTracker } from '../scheduling/session-tracker.js'
import { createExecutorEventNotifier, type StreamOptions } from '../scheduling/session-stream.js'
import { TaskStatusNotifier } from '../scheduling/task-status-notifier.js'
import { WeaveScheduler, subjectLabel } from '../scheduling/scheduler.js'
import type { WeaveCapabilities } from './capabilities.js'
import type { AuditLog } from '../audit/audit-log.js'
import type { PrismReflectionService } from '../prism/reflection.js'
import { TeamPlanner, createPlanTasksHandler } from '../scheduling/planner.js'
import { ProjectTeamStore } from '../team/project-team-store.js'
import { Mailbox } from '../team/mailbox.js'
import { ReflectionSink } from '../team/reflection-sink.js'
import { GraphRefresher } from './graph-refresh.js'
import { TaskLedgerMirror } from '../prism/task-ledger.js'
import { OnDutyController } from './on-duty.js'
import {
  createWeaveNoticeMessage,
  hasPendingToolCall,
  notifySession,
  type NoticeSessionLike,
  type WeaveNoticeMessage,
} from '../scheduling/session-delegation.js'

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
  reflection: PrismReflectionService
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
  const { runtime, deps, executorProviders, executionStream, idleTimeoutMs, capabilities } = options

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

  // P3 任务台账镜像（prism 承接）：状态变更逐条回报，prism 故障只告警。
  const ledgerMirror = deps.prism ? new TaskLedgerMirror({ gateway: deps.prism }) : undefined

  const statusNotifier = new TaskStatusNotifier({
    notify: (sessionId, text) => {
      notifyWeaveSession(sessionId, text, resolveNoticeSession(sessionId))
    },
    ...(ledgerMirror ? { onChange: (change) => ledgerMirror.report(change) } : {}),
  })

  const delegation = new DelegationService(
    { subagents: (runtime as unknown as { subagents: unknown }).subagents } as never,
    {
      executorRegistry: deps.executorRegistry,
      executorProviders,
      sessionTracker: new SessionTracker(deps.persistence.feedback),
      // 派发注入（HTTP 一次调用）：gateway.searchForInjection 结构化满足 KnowledgeEngineLike；
      // 注入失败由 delegation 内部降级为无知识，不阻断派发。
      knowledgeEngine: deps.prism!,
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

  // 代码图谱自动刷新（prism 承接，weave 只发薄触发；去抖合并）。
  const graphRefresher = new GraphRefresher({
    ...(deps.prism ? { build: () => deps.prism!.graphBuild() } : {}),
    notify: (sessionId, text) => notifyWeaveSession(sessionId, text, resolveNoticeSession(sessionId)),
    log: console,
  })

  const scheduler = new WeaveScheduler({
    delegation,
    persistence: deps.persistence,
    loadTeam: (teamId) => deps.teamManager.loadTeam(teamId),
    notify: (sessionId, text, session) => notifyWeaveSession(sessionId, text, session ?? resolveNoticeSession(sessionId)),
    statusNotifier,
    audit: auditLog,
    // 知识审核闭环：DAG 收敛时把暂存区待审数量交还队长（/weave knowledge review|approve|reject）。
    countKnowledgeCandidates: deps.prism
      ? () => deps.prism!.countStaged()
      : undefined,
    onTaskSettledText: async ({ task, role, text, status }) => {
      const result = await reflection.depositFromOutput({
        taskId: task.id,
        executor: role.executor,
        roleId: role.id,
        projectId: task.project_id,
        version: task.version,
        outputText: text,
        taskSubject: subjectLabel(task),
      })
      if (status === 'COMPLETED') graphRefresher.request('task-settled', task.session_id)
      return result.deposited.length
    },
    // 交付目录代码图谱薄触发（prism 承接；失败静默降级）
    graphBuild: deps.prism
      ? (projectRoot: string) => deps.prism!.graphBuild({ projectRoot })
      : undefined,
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
    // 队长值守等待（weave_wait_dag_change）：状态变更边沿唤醒替代高频轮询。
    waitForChange: async ({ dagId, timeoutMs, signal }) => scheduler.waitForChange(dagId, timeoutMs, signal),
  }

  const planner = new TeamPlanner({ persistence: deps.persistence, teamManager: deps.teamManager })
  const planTasks = createPlanTasksHandler({
    planner,
    schedulerStart: async (input) => {
      // 团队启动：先新建/更新代码图谱（去抖合并，不阻塞派发）。
      graphRefresher.request('team-start', input.sessionId)
      await scheduler.start(input)
      // P3：DAG 派发后向 prism 台账登记（fire-and-forget，不阻塞派发主链路）。
      if (ledgerMirror) {
        void (async () => {
          try {
            const dag = await deps.dagRepository.loadDag(input.dagId)
            const meta = await deps.persistence.tasks.run((db) => {
              return db.prepare('SELECT team_id, project_id, version, difficulty FROM dags WHERE dag_id = ?').get(input.dagId) as
                | { team_id: string; project_id: string; version: string; difficulty: string }
                | undefined
            })
            if (!meta) return
            ledgerMirror.registerDag({
              dag_id: input.dagId,
              session_id: input.sessionId,
              team_id: meta.team_id,
              project_id: meta.project_id,
              version: meta.version,
              difficulty: meta.difficulty,
            }, dag.tasks)
          } catch (error) {
            console.warn('[dsh-weave] prism 任务台账登记读取失败（不影响调度）:', error)
          }
        })()
      }
    },
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
    disposeScheduler: () => {
      graphRefresher.dispose()
      // 宿主卸载走有界结算（官方 lifecycle 模式）：准入截止 + allSettled+超时 + 在途任务
      // 状态兜底落库后再退出；此处无法 await（Cordis 清理同步），后台收敛并以日志兜底。
      void scheduler.disposeGracefully().catch((error) => {
        console.warn('[dsh-weave] scheduler graceful dispose failed, falling back to hard abort:', error)
        scheduler.dispose()
      })
    },
  }
}
