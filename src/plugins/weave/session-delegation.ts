import { randomUUID } from 'node:crypto'

import type { TeamConfig } from './team-manager.js'

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
 * 向会话追加一条插件来源的可见 notice。
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

/* ------------------------------ pre-step hook ------------------------------ */

export interface PreStepHookDeps {
  listTeams(): TeamConfig[]
  setSelection(sessionId: string, teamId: string | null): Promise<void>
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
 * agent/pre-step 控制通道 hook：
 * - 仅处理 source.kind === 'user' 的最新一条消息；同一 message.id 只处理一次；
 * - 命中团队启停短句 → 写/清 team_bindings 后 reject（该消息不进入普通模型回合），
 *   并落确认 notice；
 * - 其余消息一律放行（队长模型按需调用 weave_plan_tasks 派发任务）。
 */
export function createPreStepDelegationHook(deps: PreStepHookDeps) {
  const processed = new Map<string, true>()
  return async (
    payload: PreStepPayloadLike,
    next: () => Promise<PreStepDecisionLike>,
  ): Promise<PreStepDecisionLike> => {
    try {
      const userMessages = (payload.messages ?? []).filter((message) => message?.source?.kind === 'user')
      const latest = userMessages[userMessages.length - 1]
      if (!latest || processed.has(latest.id)) return await next()

      const sessionId = String(payload.agent?.id ?? '')
      if (sessionId === '' || !deps.listTeams || !deps.setSelection) return await next()

      const text = (latest.content ?? [])
        .filter((block) => block?.type === 'text')
        .map((block) => block.text ?? '')
        .join('\n')
        .trim()
      if (text === '') return await next()

      const command = parseTeamSelectionCommand(text, deps.listTeams())
      if (!command) return await next()

      await deps.setSelection(sessionId, command.action === 'enable' ? command.team.team_id : null)
      markProcessed(processed, latest.id, deps.dedupeLimit ?? 512)
      deps.notify(
        sessionId,
        command.action === 'enable'
          ? `[weave] 已在当前会话启用团队「${command.team.name}」。现在可以直接描述目标，我将作为队长拆解并派发任务。`
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
