import { randomUUID } from 'node:crypto'

import type { DelegationService } from './delegation-service.js'
import { DEFAULT_DIFFICULTY, type Difficulty, type RoleConfig, type TeamConfig } from './team-manager.js'
import type { TaskRecord } from './state/types.js'
import { WeaveError } from './state/weave-error.js'

/* ------------------------------------------------------------------ */
/* t6 —— 当前会话团队选择 → 会话内任务委托编排                          */
/* 红线：委托唯一出口为 DelegationService.executeTask                   */
/* （内部仅 ctx.subagents.start）；本文件不 spawn、不建假数据。          */
/* ------------------------------------------------------------------ */

/** pre-step 消息的最小结构视面（真实 UserMessage 结构化满足；避免依赖宿主包）。 */
export interface PreStepUserMessageLike {
  readonly id: string
  readonly role: string
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>
  readonly source: { readonly kind: string }
}

/**
 * pre-step agent 的最小视面：agent.id 即会话 ID（DSH SessionId）；
 * agent.session 为 durable log 追加面（notice 通道）。
 */
export interface PreStepAgentLike {
  readonly id: string
  readonly session?: NoticeSessionLike
}

export interface PreStepPayloadLike {
  readonly agent: PreStepAgentLike
  readonly messages: ReadonlyArray<PreStepUserMessageLike>
  readonly signal: AbortSignal
}

export type PreStepDecisionLike = { kind: 'reject' } | { kind: 'enter'; messages: ReadonlyArray<unknown> }

/** 会话追加 notice 的最小结构视面（真实 Session.append 结构化满足）。 */
export interface NoticeSessionLike {
  append(
    type: 'user/message',
    data: {
      id: string
      role: 'user'
      content: Array<{ type: 'text'; text: string }>
      source: { kind: 'plugin'; plugin: string }
    },
    opts: { surfaceOp: 'append' },
  ): unknown
}

/**
 * 向会话追加一条插件来源的可见 notice（t6 失败/进度通知通道）。
 * 直接落 durable log（surface append），同步可见、不触发额外 turn；
 * 失败必须显式落进会话——禁止假装成功。
 */
export function notifySession(session: NoticeSessionLike, text: string): void {
  session.append(
    'user/message',
    {
      id: `weave-notice-${randomUUID()}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'dsh-weave' },
    },
    { surfaceOp: 'append' },
  )
}

/** 难度选择：matchers 按序首个命中，否则 default_difficulty（TDD §2.3 HI-4）。 */
export function pickDifficulty(team: TeamConfig, text: string): Difficulty {
  for (const matcher of team.task_decomposition.matchers) {
    try {
      if (new RegExp(matcher.pattern).test(text)) return matcher.difficulty
    } catch {
      // 非法正则已被 validateTeam 拦截；此处兜底跳过。
    }
  }
  return team.task_decomposition.default_difficulty ?? DEFAULT_DIFFICULTY
}

export interface PlannedStage {
  stage: string
  role: RoleConfig
}

/** 阶段→角色计划：按难度模板顺序展开；validateTeam 已保证每阶段均有角色绑定。 */
export function planStages(team: TeamConfig, difficulty: Difficulty): PlannedStage[] {
  const td = team.task_decomposition
  const template = td.dag_templates[difficulty] ?? td.dag_templates[td.default_difficulty ?? DEFAULT_DIFFICULTY]
  if (!template || template.length === 0) {
    throw new WeaveError('invalid_team', `团队 ${team.team_id} 缺少难度 ${difficulty} 的 dag_templates`, {
      team_id: team.team_id,
      difficulty,
    })
  }
  const plan: PlannedStage[] = []
  for (const stage of template) {
    const role = team.roles.find((candidate) => candidate.stages.includes(stage))
    if (!role) {
      throw new WeaveError('configuration_error', `阶段 ${stage} 无角色绑定（团队 ${team.team_id}）`, {
        team_id: team.team_id,
        stage,
      })
    }
    plan.push({ stage, role })
  }
  return plan
}

/* ------------------------------ 顺序阶段委托 ------------------------------ */

let adhocSeq = 0

/** 会话内临时任务记录（仅存在于内存，供 executeTask 的 prompt/日志字段消费）。 */
function synthesizeTaskRecord(sessionId: string, teamId: string, seq: number, description: string): TaskRecord {
  const nowIso = new Date().toISOString()
  return {
    id: `sess-${sessionId}-${(adhocSeq += 1)}-${seq}`,
    session_id: sessionId,
    team_id: teamId,
    project_id: 'session',
    version: 'adhoc',
    description,
    dependencies: [],
    assigned_agent: null,
    executor: null,
    status: 'RUNNING',
    revision_count: 0,
    max_revisions: 0,
    feedback_timeout_seconds: 0,
    feedback_expires_at: null,
    skip_override: false,
    skip_reason: null,
    fail_count: 0,
    result: null,
    error_type: null,
    created_at: nowIso,
    updated_at: nowIso,
  }
}

export interface StageOutcome {
  stage: string
  roleId: string
  roleName: string
  stopReason: string
  duration_ms: number
  outputText: string
}

export interface SequentialRunInput {
  team: TeamConfig
  sessionId: string
  text: string
  /** 真实父 Agent（DelegationService 要求 parent 必填；从 pre-step payload.agent 透传）。 */
  parentAgent: unknown
  signal: AbortSignal
  onStageStart?: (info: { index: number; total: number; stage: string; roleName: string }) => void
}

/** 顺序阶段执行器：前序角色输出作为后续角色上下文，逐阶段走真实委托。 */
export class SequentialSessionDelegator {
  constructor(private readonly delegation: DelegationService) {}

  async run(input: SequentialRunInput): Promise<StageOutcome[]> {
    const difficulty = pickDifficulty(input.team, input.text)
    const plan = planStages(input.team, difficulty)
    const upstreamOutputs: Array<{ label: string; output: string }> = []
    const outcomes: StageOutcome[] = []
    for (const [index, step] of plan.entries()) {
      input.onStageStart?.({ index, total: plan.length, stage: step.stage, roleName: step.role.name })
      const task = synthesizeTaskRecord(input.sessionId, input.team.team_id, index + 1, input.text)
      const output = await this.delegation.executeTask(task, step.role, input.team, {
        parentAgent: input.parentAgent,
        upstreamOutputs: [...upstreamOutputs],
        outputRequirements:
          `这是团队「${input.team.name}」（${input.team.team_id}）顺序流水线的第 ${index + 1}/${plan.length} 阶段「${step.stage}」。` +
          '聚焦完成本阶段目标；后续阶段由后续角色基于你的产出继续。',
      }, input.signal)
      const outputText = output.output.map((block) => block.text).join('')
      outcomes.push({
        stage: step.stage,
        roleId: step.role.id,
        roleName: step.role.name,
        stopReason: output.stopReason,
        duration_ms: output.duration_ms,
        outputText,
      })
      upstreamOutputs.push({ label: `${step.role.name}（${step.stage}）`, output: outputText === '' ? '（无文本输出）' : outputText })
      if (output.stopReason !== 'completed') {
        throw new WeaveError(
          'execution_failed',
          `阶段 ${step.stage}（${step.role.name}）未完成：${output.stopReason}${output.diagnostic ? ` - ${output.diagnostic}` : ''}`,
          { stage: step.stage, role_id: step.role.id, stop_reason: output.stopReason },
        )
      }
    }
    return outcomes
  }
}

/* ------------------------------ pre-step hook ------------------------------ */

export interface PreStepHookDeps {
  /** 会话选择读取（复用 team_bindings：绑定=启用）。 */
  getSelection: (sessionId: string) => Promise<{ team_id: string } | null>
  /** 团队加载（选择指向已删团队时走失败通知路径）。 */
  loadTeam: (teamId: string) => TeamConfig
  listTeams(): TeamConfig[]
  setSelection(sessionId: string, teamId: string | null): Promise<void>
  delegator: SequentialSessionDelegator
  /** 会话 notice 写入（prod 绑定 notifySession；session 缺席时实现方自行降级告警）。 */
  notify: (sessionId: string, text: string, session?: NoticeSessionLike) => void
  log?: { warn?: (...args: unknown[]) => void }
  /** 去重表容量上限（FIFO 淘汰；默认 512）。 */
  dedupeLimit?: number
}

export type TeamSelectionCommand =
  | { action: 'enable'; team: TeamConfig }
  | { action: 'disable' }

/**
 * 解析当前会话中的团队启停指令。
 * 只匹配以启停动词开头的短句，避免把普通任务误判为控制指令。
 */
export function parseTeamSelectionCommand(text: string, teams: readonly TeamConfig[]): TeamSelectionCommand | null {
  const raw = text.trim()
  if (raw === '' || raw.length > 120) return null

  const BS = String.fromCharCode(92)
  const space = BS + 's*'
  const boundary = '(?:[。.!！?？]|$)'
  const teamWord = '(?:当前)?(?:的)?(?:团队|小队)'
  const disablePattern = new RegExp('(?:^|' + space + ')' + '(?:关闭|停用|禁用|取消启用|不启用)' + teamWord + boundary)

  const verb = '(?:启用|开启|启动|激活|使用|切换到|切换)'
  const prefix = '^(?:' + BS + '/weave' + space + ')?(?:请|帮我|麻烦)?(?:立即)?' + verb + space
  const enabledPattern = new RegExp(prefix + '(?:' + teamWord + ')?(?:[:：]?' + space + ')?(.+?)' + boundary)

  if (disablePattern.test(raw)) return { action: 'disable' }

  const enabled = raw.match(enabledPattern)
  if (!enabled) return null

  const target = (enabled[1] ?? '').trim().replace(/^["'“”]+|["'“”]+$/g, '')
  if (target === '') return null
  const needle = target.toLowerCase()
  const team =
    teams.find((item) => item.team_id.toLowerCase() === needle) ??
    teams.find((item) => item.name.toLowerCase() === needle) ??
    teams.find((item) => item.team_id.toLowerCase().includes(needle)) ??
    teams.find((item) => item.name.toLowerCase().includes(needle))
  return team ? { action: 'enable', team } : null
}

function markProcessed(seen: Map<string, true>, messageId: string, limit: number): void {
  if (seen.has(messageId)) return
  seen.set(messageId, true)
  while (seen.size > limit) {
    const oldest = seen.keys().next().value
    if (oldest === undefined) break
    seen.delete(oldest)
  }
}

/**
 * agent/pre-step 编排 hook（t6）：
 * - 仅处理 source.kind === 'user' 的最新一条消息；
 * - 同一 message.id 只处理一次（FIFO 去重）；
 * - 会话未启用团队 → 直接 next() 放行；
 * - 已启用 → 先 await next() 保持 waterfall 主链路，再后台发起真实顺序委托；
 *   失败经 notify 落明确 notice，绝不假装成功。
 */
export function createPreStepDelegationHook(deps: PreStepHookDeps) {
  const processed = new Map<string, true>()
  return async (
    payload: PreStepPayloadLike,
    next: () => Promise<PreStepDecisionLike>,
  ): Promise<PreStepDecisionLike> => {
    let decision: PreStepDecisionLike = { kind: 'enter', messages: [] }
    try {
      // 当前会话自然语言团队控制优先于任务委托；命中后不进入普通模型回合。
      const controlMessages = (payload.messages ?? []).filter((message) => message?.source?.kind === 'user')
      const controlMessage = controlMessages[controlMessages.length - 1]
      if (controlMessage && !processed.has(controlMessage.id)) {
        const sessionId = String(payload.agent?.id ?? '')
        const controlText = (controlMessage.content ?? [])
          .filter((block) => block?.type === 'text')
          .map((block) => block.text ?? '')
          .join(String.fromCharCode(10))
          .trim()
        if (sessionId !== '' && controlText !== '' && deps.listTeams && deps.setSelection) {
          const command = parseTeamSelectionCommand(controlText, deps.listTeams())
          if (command) {
            await deps.setSelection(
              sessionId,
              command.action === 'enable' ? command.team.team_id : null,
            )
            markProcessed(processed, controlMessage.id, deps.dedupeLimit ?? 512)
            deps.notify(
              sessionId,
              command.action === 'enable'
                ? `[weave] 已在当前会话启用团队「${command.team.name}」。`
                : '[weave] 已关闭当前会话的团队。',
              payload.agent?.session,
            )
            return { kind: 'reject' }
          }
        }
      }

      decision = await next()
      try {
      const userMessages = (payload.messages ?? []).filter((message) => message?.source?.kind === 'user')
      const latest = userMessages[userMessages.length - 1]
      if (!latest || processed.has(latest.id)) return decision
      markProcessed(processed, latest.id, deps.dedupeLimit ?? 512)

      const sessionId = String(payload.agent?.id ?? '')
      if (sessionId === '') return decision
      const selection = await deps.getSelection(sessionId)
      if (!selection) return decision // 未绑定团队：直接放行（需求语义）

      const text = (latest.content ?? [])
        .filter((block) => block?.type === 'text')
        .map((block) => block.text ?? '')
        .join('\n')
        .trim()
      if (text === '') return decision

      let team: TeamConfig
      try {
        team = deps.loadTeam(selection.team_id)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        deps.notify(sessionId, `[weave] 会话启用的团队不可用（${selection.team_id}）：${message}\n请重新选择团队。`, payload.agent?.session)
        return decision
      }

      const runPromise = deps.delegator.run({
        team,
        sessionId,
        text,
        parentAgent: payload.agent,
        signal: payload.signal,
        onStageStart: (info) => {
          deps.notify(sessionId, `[weave] 团队「${team.name}」阶段 ${info.index + 1}/${info.total}：${info.roleName}（${info.stage}）开始`, payload.agent?.session)
        },
      })
      void runPromise
        .then((outcomes) => {
          const summary = outcomes
            .map((outcome) => `- ${outcome.roleName}（${outcome.stage}）：${outcome.outputText.slice(0, 800)}${outcome.outputText.length > 800 ? '…' : ''}`)
            .join('\n')
          deps.notify(sessionId, `[weave] 团队「${team.name}」已完成本次任务委托（共 ${outcomes.length} 个阶段）\n${summary}`, payload.agent?.session)
        })
        .catch((error) => {
          const code = error instanceof WeaveError ? error.code : 'internal'
          const message = error instanceof Error ? error.message : String(error)
          deps.notify(sessionId, `[weave] 任务委托失败（${code}）：${message}`, payload.agent?.session)
          deps.log?.warn?.('[dsh-weave] session delegation failed:', error)
        })
      } catch (delegationHookError) {
        deps.log?.warn?.('[dsh-weave] session delegation hook error:', delegationHookError)
      }
    } catch (hookError) {
      // hook 自身异常不得破坏 pre-step 主链路。
      deps.log?.warn?.('[dsh-weave] pre-step delegation hook error:', hookError)
      return { kind: 'enter', messages: [] }
    }
    return decision
  }
}
