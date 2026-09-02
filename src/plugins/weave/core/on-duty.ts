export interface OnDutyOptions {
  hasActiveWork(sessionId: string): Promise<boolean>
  hasUnread(sessionId: string): Promise<boolean>
  notify(sessionId: string, text: string): void
  injectNextStep?(sessionId: string, text: string): void
}

export interface MemberEvent {
  id: string
  sessionId: string
  text: string
}

export type TurnDecision = 'allow' | 'keep'

/**
 * 主会话值守控制器：
 * - 事件驱动：成员事件到达立即通知；
 * - 去重：同一事件只注入一次；
 * - 回合控制：有在途任务/未读消息时禁止提前结束回合。
 */
export class OnDutyController {
  readonly #opts: OnDutyOptions
  readonly #handledEvents = new Set<string>()

  constructor(options: OnDutyOptions) {
    this.#opts = options
  }

  async shouldAllowTurnEnd(sessionId: string): Promise<boolean> {
    const [active, unread] = await Promise.all([
      this.#opts.hasActiveWork(sessionId),
      this.#opts.hasUnread(sessionId),
    ])
    return !active && !unread
  }

  async decideTurn(sessionId: string): Promise<TurnDecision> {
    return await this.shouldAllowTurnEnd(sessionId) ? 'allow' : 'keep'
  }

  onMemberEvent(event: MemberEvent): void {
    if (this.#handledEvents.has(event.id)) return
    this.#handledEvents.add(event.id)
    this.#opts.notify(event.sessionId, event.text)
    if (this.#opts.injectNextStep) {
      this.#opts.injectNextStep(event.sessionId, event.text)
    }
  }

  reset(sessionId: string): void {
    for (const id of this.#handledEvents) {
      // 简单按会话 id 前缀清理不精确；保留全局去重即可，重置暂无必要。
      void id
      void sessionId
    }
  }
}
