import { randomUUID } from 'node:crypto'

import type { TeamConfig } from '../team/team-manager.js'

/* ------------------------------------------------------------------ */
/* 会话控制通道：自然语言团队启停 + 会话 notice 通知。                  */
/* 任务下发/调度已收敛到 planner.ts（weave_plan_tasks）+ scheduler.ts， */
/* 本文件不再包含任何任务编排逻辑；通知仍直接落 durable log（不触发额外 turn）。 */
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

/** 会话追加 notice 的消息结构（真实 UserMessage 结构化满足）。 */
export interface WeaveNoticeMessage {
  readonly id: string
  readonly role: 'user'
  readonly content: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>
  readonly source: { readonly kind: 'plugin'; readonly plugin: 'dsh-weave' }
}

/** 仅用于检测会话是否正处于「工具调用已发、工具结果未回」的危险窗口。 */
export interface NoticeEventLike {
  readonly seq: number
  readonly type: string
  readonly data?: {
    readonly message?: {
      readonly content?: ReadonlyArray<{
        readonly type?: string
        readonly id?: string
        readonly toolCallId?: string
      }>
    }
  }
}

/** 会话追加 notice 的最小结构视面（真实 Session.append 结构化满足）。 */
export interface NoticeSessionLike {
  append(
    type: 'user/message',
    data: WeaveNoticeMessage,
    opts: { surfaceOp: 'append' },
  ): unknown
  /** 真实 Session 才有；缺失时保守按“无待决工具调用”处理。 */
  readonly surface?: { readonly nodes: readonly number[] }
  readonly events?: readonly NoticeEventLike[]
}

/** 构造一条插件来源的 weave notice。 */
export function createWeaveNoticeMessage(text: string): WeaveNoticeMessage {
  return {
    id: `weave-notice-${randomUUID()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-weave' },
  }
}

/**
 * 判断当前会话表面是否还有未闭合的 assistant tool-call。
 *
 * DSH 的消息历史严格要求：assistant 的 tool_calls 之后必须紧跟对应的
 * tool 结果；如果在工具执行期间把插件 notice 直接 append 成 user/message，
 * 会把 user 消息插到 tool_calls 与 tool/result 之间，导致后续每次请求都被
 * 上游以 “An assistant message with 'tool_calls' must be followed by tool
 * messages” 拒绝。该函数用于在危险窗口改走 Agent.inbox 的 next-step 安全边界。
 */
export function hasPendingToolCall(session: NoticeSessionLike): boolean {
  const surface = session.surface?.nodes
  const events = session.events
  if (!surface || !events) return false
  const bySeq = new Map<number, NoticeEventLike>()
  for (const event of events) bySeq.set(event.seq, event)
  const pending = new Set<string>()
  for (const seq of surface) {
    const event = bySeq.get(seq)
    if (!event) continue
    const blocks = event.data?.message?.content ?? []
    if (event.type === 'assistant/message') {
      for (const block of blocks) {
        if (block.type === 'tool-call' && block.id) pending.add(block.id)
      }
    } else if (event.type === 'tool/result') {
      for (const block of blocks) {
        if (block.type === 'tool-result' && block.toolCallId) pending.delete(block.toolCallId)
      }
    }
  }
  return pending.size > 0
}

/**
 * 向会话追加一条插件来源的可见 notice。
 * 直接落 durable log（surface append），同步可见、不触发额外 turn；
 * 失败必须显式落进会话——禁止假装成功。
 */
export function notifySession(session: NoticeSessionLike, text: string): void {
  session.append(
    'user/message',
    createWeaveNoticeMessage(text),
    { surfaceOp: 'append' },
  )
}

/* ------------------------------ pre-step hook ------------------------------ */

export interface PreStepHookDeps {
  listTeams(): TeamConfig[]
  setSelection(sessionId: string, teamId: string | null): Promise<void>
  /** 会话 notice 写入（prod 绑定 notifySession；session 缺席时实现方自行降级告警）。 */
  notify: (sessionId: string, text: string, session?: NoticeSessionLike) => void
  /**
   * 读取会话当前团队绑定（prod 绑定 teamManager.getSelection）。
   * 可选：缺失或抛错时按「未绑定」降级，不影响主链路。
   */
  getSelection?: (sessionId: string) => Promise<{ team_id: string } | null>
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

/* ------------------------------ 团队感知提醒 ------------------------------ */

/** 团队感知触发词：命中才注入，避免每回合刷屏。 */
const TEAM_AWARENESS_PATTERN = /团队|小队|weave|派单|队长|多[名个]?\s*agent/i

/** 会话级去重：sessionId → 已注入过的（团队清单#绑定）签名。 */
const teamAwarenessNotified = new Map<string, string>()

/**
 * 构建团队感知提醒文本：列出已配置团队、当前绑定与解析去向、启停/派单入口。
 * 目标是让任何 cwd 的会话在第一回合就知道「团队已配置、别自己模拟成员」。
 */
export function buildTeamAwarenessText(teams: readonly TeamConfig[], boundTeamId: string | null): string {
  const lines = teams.map((team) => `- ${team.team_id}（${team.name}）${team.default ? '[默认]' : ''}`)
  const fallback = teams.find((team) => team.default) ?? (teams.length === 1 ? teams[0] : undefined)
  const bound = boundTeamId === null ? undefined : teams.find((team) => team.team_id === boundTeamId)
  const binding = bound
    ? `当前会话已绑定团队「${bound.team_id}」——直接描述目标，队长用 weave_plan_tasks 拆解并派发给成员执行。`
    : `当前会话未绑定团队${fallback ? `，weave_plan_tasks 将解析到${fallback.default ? '默认' : '唯一'}团队「${fallback.team_id}」` : ''}。`
  return [
    '<system-reminder>',
    `[weave] 本机已配置 ${teams.length} 个多 Agent 团队（~/.dsh/teams）：`,
    ...lines,
    binding,
    '启用指定团队：回复“启动团队 <team_id>”；关闭：回复“关闭团队”。',
    '队长派单工具：weave_plan_tasks（未解锁时先用 dev_tool_search 搜 weave 解锁）。',
    '不要凭空模拟团队成员或代替成员产出。',
    '</system-reminder>',
  ].join('\n')
}

/** 是否命中团队感知触发词。 */
export function shouldTriggerTeamAwareness(text: string): boolean {
  return TEAM_AWARENESS_PATTERN.test(text)
}

/**
 * 把团队感知提醒追加进 pre-step 决策：
 * - enter → 追加进 messages（本回合模型可见）；
 * - 其他（被拒等）→ 走 durable notice，不破坏原决策。
 * 每个会话按（团队清单#绑定）签名只注入一次。
 */
async function appendTeamAwareness(
  deps: PreStepHookDeps,
  sessionId: string,
  text: string,
  decision: PreStepDecisionLike,
  session?: NoticeSessionLike,
): Promise<PreStepDecisionLike> {
  try {
    if (!shouldTriggerTeamAwareness(text)) return decision
    const teams = deps.listTeams()
    if (teams.length === 0) return decision
    let boundTeamId: string | null = null
    try {
      boundTeamId = (await deps.getSelection?.(sessionId))?.team_id ?? null
    } catch {
      boundTeamId = null
    }
    const signature = `${teams.map((team) => team.team_id).join('|')}#${boundTeamId ?? 'none'}`
    if (teamAwarenessNotified.get(sessionId) === signature) return decision
    teamAwarenessNotified.set(sessionId, signature)
    const reminderText = buildTeamAwarenessText(teams, boundTeamId)
    if (decision.kind === 'enter') {
      return { kind: 'enter', messages: [...decision.messages, createWeaveNoticeMessage(reminderText)] }
    }
    deps.notify(sessionId, reminderText, session)
    return decision
  } catch (error) {
    deps.log?.warn?.('[dsh-weave] team awareness injection error:', error)
    return decision
  }
}

const DEFAULT_PROCESSED_MESSAGE_LIMIT = 2048
/** 模块级去重：所有 hook 实例共享（重复注册/HMR 后同一条 pre-step 消息也不会重复通知）。 */
const processedMessages = new Map<string, true>()

function markProcessed(messageId: string, limit: number): void {
  if (processedMessages.has(messageId)) return
  processedMessages.set(messageId, true)
  while (processedMessages.size > limit) {
    const oldest = processedMessages.keys().next().value
    if (oldest === undefined) break
    processedMessages.delete(oldest)
  }
}

/**
 * agent/pre-step 控制通道 hook：
 * - 仅处理 source.kind === 'user' 的最新一条消息；同一 message.id 只处理一次；
 * - 命中团队启停短句 → 写/清 team_bindings 后 reject（该消息不进入普通模型回合），
 *   并落确认 notice；
 * - 其余消息一律放行（队长模型按需调用 weave_plan_tasks 派发任务）。
 */
export function createPreStepDelegationHook(deps: PreStepHookDeps) {
  return async (
    payload: PreStepPayloadLike,
    next: () => Promise<PreStepDecisionLike>,
  ): Promise<PreStepDecisionLike> => {
    try {
      const userMessages = (payload.messages ?? []).filter((message) => message?.source?.kind === 'user')
      const latest = userMessages[userMessages.length - 1]
      if (!latest || processedMessages.has(latest.id)) return await next()

      const sessionId = String(payload.agent?.id ?? '')
      if (sessionId === '' || !deps.listTeams || !deps.setSelection) return await next()

      const text = (latest.content ?? [])
        .filter((block) => block?.type === 'text')
        .map((block) => block.text ?? '')
        .join('\n')
        .trim()
      if (text === '') return await next()

      const command = parseTeamSelectionCommand(text, deps.listTeams())
      if (!command) {
        const downstream = await next()
        return await appendTeamAwareness(deps, sessionId, text, downstream, payload.agent?.session)
      }

      // 先占位再 await：同一消息并发投递/多 hook 实例共享模块级去重表，
      // 不会在 setSelection 完成前各自通过检查造成 3 条重复 notice。
      markProcessed(latest.id, deps.dedupeLimit ?? DEFAULT_PROCESSED_MESSAGE_LIMIT)
      try {
        await deps.setSelection(sessionId, command.action === 'enable' ? command.team.team_id : null)
      } catch (error) {
        // 绑定失败时释放占位，允许后续重试；异常仍由外层统一降级为放行。
        processedMessages.delete(latest.id)
        throw error
      }
      const teamIntro = command.action === 'enable' && typeof command.team.description === 'string' && command.team.description.trim() !== ''
        ? `团队简介：${command.team.description.trim()}`
        : ''
      deps.notify(
        sessionId,
        command.action === 'enable'
          ? `[weave] 已在当前会话启用团队「${command.team.name}」。${teamIntro ? `${teamIntro}。` : ''}现在可以直接描述目标，我将作为队长拆解并派发任务。`
          : '[weave] 已关闭当前会话的团队。',
        payload.agent?.session,
      )
      return { kind: 'reject' }
    } catch (hookError) {
      // hook 自身异常不得破坏 pre-step 主链路。
      deps.log?.warn?.('[dsh-weave] pre-step control hook error:', hookError)
      try {
        return await next()
      } catch {
        return { kind: 'enter', messages: [] }
      }
    }
  }
}
