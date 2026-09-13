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
import { MemberRuntime, type TeamMemberRecord } from '../team/member-runtime.js'
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
  taskBoard: {
    claim(args: { task_id: string; expected_revision?: number }, exec: unknown): Promise<unknown>
    update(args: { task_id: string; action: 'complete' | 'release' | 'fail'; expected_revision?: number; attempt_token?: string; result?: string; reason?: string; message?: string }, exec: unknown): Promise<unknown>
    listMine(exec: unknown): Promise<unknown>
  }
  memberRuntime: MemberRuntime
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

  // pull 模型成员域：DSH 子代理通道直挂宿主 subagents（fork continuable + sendMessage 唤醒）。
  type MemberDshTransport = ConstructorParameters<typeof MemberRuntime>[0]['dsh']
  const dshTransport = (runtime as unknown as { subagents?: MemberDshTransport }).subagents
  const memberRuntime = new MemberRuntime({
    persistence: deps.persistence,
    ...(dshTransport ? { dsh: dshTransport } : {}),
    log: console,
  })

  /** 成员唤醒消息：任务描述 + 上游产物摘要（成员无 DAG 上下文，见 wake 即可开工）。 */
  const buildWakeText = async (task: { id: string; description: string; dependencies: string[]; dag_id?: string }): Promise<string> => {
    const lines = [
      `任务 ${task.id} 已就绪并指派给你。`,
      `描述：${task.description}`,
    ]
    if (task.dependencies.length > 0) {
      const dagId = task.dag_id ?? ''
      const dag = dagId !== '' ? await deps.dagRepository.loadDag(dagId) : null
      const byId = new Map((dag?.tasks ?? []).map((item) => [item.id, item]))
      for (const depId of task.dependencies) {
        const dep = byId.get(depId)
        const result = typeof dep?.result === 'string' && dep.result.trim() !== '' ? dep.result.slice(0, 800) : '（无文本输出）'
        lines.push(`上游 ${depId}（${dep?.description.split('\n')[0] ?? ''}）产物：${result}`)
      }
    }
    lines.push('请用 weave_task_list 查看名下任务并 weave_task_claim 认领；完成用 weave_task_update 回报。')
    return lines.join('\n')
  }

  /** 成员侧任务板回调（身份经 exec.agent.id → roster 反查）。 */
  const agentIdOf = (exec: unknown): string | undefined =>
    (exec as { agent?: { id?: string } } | undefined)?.agent?.id
  const requireMember = async (exec: unknown): Promise<TeamMemberRecord> => {
    const member = await memberRuntime.findByAgentId(agentIdOf(exec))
    if (!member) {
      throw new (await import('../state/weave-error.js')).WeaveError('member_not_found', '当前会话不是注册的持久成员（weave_task_* 仅对 pull 成员开放）')
    }
    return member
  }
  const taskBoard = {
    claim: async (args: { task_id: string; expected_revision?: number }, exec: unknown) => {
      const member = await requireMember(exec)
      return await scheduler.claimTask({ taskId: args.task_id, memberKey: member.member_id, expectedRevision: args.expected_revision })
    },
    update: async (args: { task_id: string; action: 'complete' | 'release' | 'fail'; expected_revision?: number; attempt_token?: string; result?: string; reason?: string; message?: string }, exec: unknown) => {
      const member = await requireMember(exec)
      const attempt = args.attempt_token !== undefined && args.expected_revision !== undefined
        ? { token: args.attempt_token, expectedRevision: args.expected_revision }
        : undefined
      if (args.action === 'complete') {
        return await scheduler.completeTask({ taskId: args.task_id, memberKey: member.member_id, result: args.result ?? '', ...(attempt ? { attempt } : {}) })
      }
      if (args.action === 'release') {
        return await scheduler.releaseTask({ taskId: args.task_id, memberKey: member.member_id, reason: args.reason, ...(attempt ? { attempt } : {}) })
      }
      return await scheduler.failTask({ taskId: args.task_id, memberKey: member.member_id, message: args.message ?? '（未附失败信息）', ...(attempt ? { attempt } : {}) })
    },
    listMine: async (exec: unknown) => {
      const member = await requireMember(exec)
      return await deps.persistence.tasks.run((db) => {
        const rows = db
          .prepare("SELECT id, description, status, revision, dependencies, result FROM tasks WHERE team_id = ? AND assigned_agent = ? AND status IN ('WAITING','BLOCKED','RUNNING','REVISION_RUNNING','INTERRUPTED') ORDER BY updated_at DESC LIMIT 50")
          .all(member.team_id, member.role_id) as unknown as Array<{ id: string; description: string; status: string; revision: number; dependencies: string; result: string | null }>
        return {
          member: { member_id: member.member_id, role_id: member.role_id, state: member.state },
          tasks: rows.map((row) => ({
            id: row.id,
            subject: row.description.split('\n')[0] ?? row.id,
            status: row.status,
            revision: row.revision,
            claimable: row.status === 'WAITING',
            description: row.description,
          })),
        }
      })
    },
  }

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
    // pull 模型：就绪任务唤醒持久成员（'dsh' 执行器）；未注入通道时退回 push。
    memberWake: dshTransport
      ? async ({ task, role, team, run }) => {
          const member = await memberRuntime.ensureMember({
            teamId: team.team_id,
            teamName: team.name,
            roleId: role.id,
            roleName: role.name,
            personality: role.personality,
            executor: role.executor,
            parent: run.parentAgent,
          })
          const text = await buildWakeText(task)
          await memberRuntime.deliver({ teamId: team.team_id, roleId: role.id, text, parent: run.parentAgent })
        }
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
    taskBoard,
    memberRuntime,
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
