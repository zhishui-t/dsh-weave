import { TEAM_MEMBERS_TABLE_DDL } from '../persistence/schemas.js'
import type { WeavePersistence } from '../persistence/index.js'
import { WeaveError } from '../state/weave-error.js'

/**
 * 持久成员域（pull 模型，对标官方 agent-team 的 durable teammate）。
 *
 * 与"每任务一次性 run"的根本区别：每个团队角色对应一个**驻留成员**——
 * - DSH 子代理成员：fork continuable child（首派 seed 队长已完成回合前缀，
 *   成员开局即有上下文），唤醒走 sendMessage/followup（running 插话 / idle 开回合 /
 *   absent 冷恢复——宿主 sendMessage 三态统一）；
 * - ACP 成员（zcode/workbuddy）：sessionKey 复用会话，唤醒 = 对同会话发新回合 prompt；
 *   外部进程无 weave 工具面，不做任务板自拉（写权不外放）。
 *
 * 状态推断（官方 5 态的 weave 子集）：running=有在途交付；idle=成员进程/会话活着
 * 无在途交付；inactive=宿主重启后未物化（消息唤醒即冷恢复，不是失败）；failed=通道故障。
 */

export type MemberState = 'running' | 'idle' | 'inactive' | 'failed'

export interface TeamMemberRecord {
  /** `${teamId}:${roleId}`——团队内角色唯一，即成员身份 */
  member_id: string
  team_id: string
  role_id: string
  /** 'dsh'（fork continuable）| 'zcode' | 'workbuddy' | 动态 ACP provider 名 */
  executor: string
  /** DSH 成员的 continuable childId */
  child_id: string | null
  /** ACP 成员的唤醒 sessionKey */
  session_key: string | null
  /** 成员显示名（child label / 面板展示） */
  label: string
  state: MemberState
  spawned_at: string
  last_active_at: string | null
  last_error: string | null
}

interface MemberRow {
  member_id: string
  team_id: string
  role_id: string
  executor: string
  child_id: string | null
  session_key: string | null
  label: string | null
  state: MemberState
  spawned_at: string
  last_active_at: string | null
  last_error: string | null
}

/** DSH 子代理通道（与 executors/dsh-subagent-executor-provider 同一宿主 API 面）。 */
export interface DshMemberTransport {
  startContinuable(spec: {
    provider: string
    label?: string
    request: {
      prompt: Array<{ type: 'text'; text: string }>
      parent?: unknown
      signal: AbortSignal
    }
    signal: AbortSignal
  }): Promise<{ childId: string }>
  /** running→就近插入 / idle→开回合（需 child live） */
  followup?(parent: unknown, childId: string, content: Array<{ type: 'text'; text: string }>, options: { signal: AbortSignal }): Promise<unknown>
  /** 官方统一投递口：running 插话 / idle 唤醒 / absent 冷恢复（优先于 followup） */
  sendMessage?(sender: unknown, targetId: string, content: Array<{ type: 'text'; text: string }>, options: { signal: AbortSignal }): Promise<unknown>
  /** live Agent 注册表（活性探测/取消） */
  agents?: { get(id: string): unknown }
}

export interface MemberRuntimeOptions {
  persistence: WeavePersistence
  /** DSH 子代理通道；未注入则 'dsh' 成员 ensure/deliver 报 configuration_error。 */
  dsh?: DshMemberTransport
  /**
   * ACP 成员唤醒：经 provider registry 对 sessionKey 会话发新回合 prompt。
   * 实现应自带容错（find provider → start({sessionKey, prompt}) fire-and-forget）。
   */
  acpWake?: (executor: string, sessionKey: string, text: string, parent: unknown) => Promise<void>
  /** 成员 bootstrap 提示词组装（可注入定制）；缺省用内建 pull 工作流模板。 */
  bootstrap?: (input: MemberBootstrapInput) => string
  now?: () => Date
  log?: Pick<Console, 'warn'>
}

export interface MemberBootstrapInput {
  teamId: string
  teamName?: string
  roleId: string
  roleName?: string
  personality?: string
  captainName?: string
}

export interface EnsureMemberInput {
  teamId: string
  teamName?: string
  roleId: string
  roleName?: string
  personality?: string
  executor: string
  parent: unknown
  signal?: AbortSignal
}

export interface DeliverInput {
  teamId: string
  roleId: string
  text: string
  parent: unknown
  signal?: AbortSignal
}

type ContentBlock = { type: 'text'; text: string }

const content = (text: string): ContentBlock[] => [{ type: 'text', text }]

/** 成员 bootstrap（pull 工作流约定）：fork seed 队长前缀之后追加本段。 */
export function defaultMemberBootstrap(input: MemberBootstrapInput): string {
  const name = input.roleName ?? input.roleId
  const lines = [
    `## Weave 持久成员约定`,
    `你是团队「${input.teamName ?? input.teamId}」的持久成员 ${name}（角色 ${input.roleId}）。`,
    '成员是长期驻留的会话：任务认领与回报都通过 weave_* 工具完成，不要等待队长逐条派指令。',
    '',
    '### 工作流（pull 模型）',
    '1. 收到唤醒消息后：先用 `weave_task_list` 查看名下（assignee 为你）就绪任务（状态 WAITING）。',
    '2. 认领：`weave_task_claim`（参数 task_id 与 expected_revision 在列表中）——认领成功即开工，任务进入 RUNNING。',
    '3. 回报：完成后 `weave_task_update`（action=complete，result 填交付摘要，供下游任务与队长汇总引用）；',
    '   暂时无法推进时 action=release 释放回 WAITING（附原因），不要静默搁置。',
    '4. 队长的插话/追问若不是新任务，直接以普通回复响应即可。',
    '',
    '### 纪律',
    '- 只认领自己名下且上游依赖已完成的任务；认领即负责到 complete/release，不半途失联。',
    '- 交付摘要写结论与关键产物路径，不写过程流水。',
  ]
  if (input.personality && input.personality.trim() !== '') {
    lines.push('', '### 角色人格', input.personality)
  }
  return lines.join('\n')
}

function isLiveDshChild(agent: unknown): boolean {
  return Boolean(agent) && typeof (agent as { whenIdle?: unknown }).whenIdle === 'function'
}

export class MemberRuntime {
  readonly #persistence: WeavePersistence
  readonly #dsh?: DshMemberTransport
  readonly #acpWake?: MemberRuntimeOptions['acpWake']
  readonly #bootstrap: (input: MemberBootstrapInput) => string
  readonly #now: () => Date
  /** 在途交付追踪（内存）：deliver 后置 running，child.whenIdle 后回 idle。 */
  readonly #inFlight = new Set<string>()
  /** ensureMember 按 memberId 串行：防止并发触发重复 fork 持久子代理。 */
  readonly #ensureInFlight = new Map<string, Promise<TeamMemberRecord>>()

  constructor(options: MemberRuntimeOptions) {
    this.#persistence = options.persistence
    this.#dsh = options.dsh
    this.#acpWake = options.acpWake
    this.#bootstrap = options.bootstrap ?? defaultMemberBootstrap
    this.#now = options.now ?? (() => new Date())
  }

  /* ------------------------------- roster 存储 ------------------------------- */

  #ensureTable(db: import('node:sqlite').DatabaseSync): void {
    db.exec(TEAM_MEMBERS_TABLE_DDL)
  }

  #rowToRecord(row: MemberRow): TeamMemberRecord {
    return {
      member_id: row.member_id,
      team_id: row.team_id,
      role_id: row.role_id,
      executor: row.executor,
      child_id: row.child_id,
      session_key: row.session_key,
      label: row.label ?? row.role_id,
      state: row.state,
      spawned_at: row.spawned_at,
      last_active_at: row.last_active_at,
      last_error: row.last_error,
    }
  }

  async #read(memberId: string): Promise<TeamMemberRecord | undefined> {
    return await this.#persistence.core.run((db) => {
      this.#ensureTable(db)
      const row = db.prepare('SELECT * FROM team_members WHERE member_id = ?').get(memberId) as unknown as MemberRow | undefined
      return row ? this.#rowToRecord(row) : undefined
    })
  }

  async #upsert(record: TeamMemberRecord): Promise<void> {
    await this.#persistence.core.run((db) => {
      this.#ensureTable(db)
      db.prepare(
        `INSERT INTO team_members (member_id, team_id, role_id, executor, child_id, session_key, label, state, spawned_at, last_active_at, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(member_id) DO UPDATE SET
           executor=excluded.executor, child_id=excluded.child_id, session_key=excluded.session_key,
           label=excluded.label, state=excluded.state, last_active_at=excluded.last_active_at, last_error=excluded.last_error`,
      ).run(
        record.member_id,
        record.team_id,
        record.role_id,
        record.executor,
        record.child_id,
        record.session_key,
        record.label,
        record.state,
        record.spawned_at,
        record.last_active_at,
        record.last_error,
      )
    })
  }

  /* ------------------------------- 成员操作 ------------------------------- */

  memberIdOf(teamId: string, roleId: string): string {
    return `${teamId}:${roleId}`
  }

  /** 取或创建持久成员。已存在直接返回（幂等）；'dsh' 成员创建即 fork 首派。
   *  按 memberKey 串行：两个并发触发（双 DAG 泵 / 队长 spawn 竞泵）都通过
   *  先读后 fork 时会各自 startContinuable 出一个持久子代理（孤儿、耗 token），
   *  这里以 in-flight promise 保证同成员只 fork 一次。 */
  ensureMember(input: EnsureMemberInput): Promise<TeamMemberRecord> {
    const memberId = this.memberIdOf(input.teamId, input.roleId)
    const inFlight = this.#ensureInFlight.get(memberId)
    if (inFlight) return inFlight
    const promise = this.#ensureMemberInner(input, memberId).finally(() => {
      if (this.#ensureInFlight.get(memberId) === promise) this.#ensureInFlight.delete(memberId)
    })
    this.#ensureInFlight.set(memberId, promise)
    return promise
  }

  async #ensureMemberInner(input: EnsureMemberInput, memberId: string): Promise<TeamMemberRecord> {
    const existing = await this.#read(memberId)
    if (existing) return await this.#refreshState(existing)

    const signal = input.signal ?? new AbortController().signal
    if (input.executor === 'dsh') {
      if (!this.#dsh?.startContinuable) {
        throw new WeaveError('configuration_error', 'DSH 子代理通道未注入（dsh 成员创建需要 startContinuable）')
      }
      const bootstrap = this.#bootstrap({
        teamId: input.teamId,
        ...(input.teamName !== undefined ? { teamName: input.teamName } : {}),
        roleId: input.roleId,
        ...(input.roleName !== undefined ? { roleName: input.roleName } : {}),
        ...(input.personality !== undefined ? { personality: input.personality } : {}),
      })
      const started = await this.#dsh.startContinuable({
        provider: 'fork',
        label: memberId,
        request: { prompt: content(bootstrap), parent: input.parent, signal },
        signal,
      })
      const record: TeamMemberRecord = {
        member_id: memberId,
        team_id: input.teamId,
        role_id: input.roleId,
        executor: 'dsh',
        child_id: started.childId,
        session_key: null,
        label: input.roleName ?? input.roleId,
        state: 'idle',
        spawned_at: this.#now().toISOString(),
        last_active_at: null,
        last_error: null,
      }
      await this.#upsert(record)
      return record
    }

    // ACP成员（zcode/workbuddy/动态）：会话懒创建——首个唤醒回合由 acpWake 建立。
    const record: TeamMemberRecord = {
      member_id: memberId,
      team_id: input.teamId,
      role_id: input.roleId,
      executor: input.executor,
      child_id: null,
      session_key: `${input.teamId}:${input.roleId}:member`,
      label: input.roleName ?? input.roleId,
      state: 'inactive',
      spawned_at: this.#now().toISOString(),
      last_active_at: null,
      last_error: null,
    }
    await this.#upsert(record)
    return record
  }

  /**
   * 唤醒/插话（fire-and-forget 语义由调用方决定是否 await）：
   * DSH 成员优先 sendMessage（running 插话 / idle 唤醒 / absent 冷恢复），
   * 退化 followup（需 live）；ACP 成员走 acpWake 对 sessionKey 会话发新回合。
   */
  async deliver(input: DeliverInput): Promise<void> {
    const memberId = this.memberIdOf(input.teamId, input.roleId)
    const member = await this.#read(memberId)
    if (!member) {
      throw new WeaveError('member_not_found', `成员不存在: ${memberId}（先 ensureMember 创建）`)
    }
    const now = this.#now().toISOString()
    try {
      if (member.executor === 'dsh') {
        await this.#deliverDsh(member, input)
      } else {
        if (!this.#acpWake) {
          throw new WeaveError('configuration_error', `ACP 成员唤醒通道未注入（executor=${member.executor}）`)
        }
        await this.#acpWake(member.executor, member.session_key ?? memberId, input.text, input.parent)
      }
      await this.#upsert({ ...member, state: 'running', last_active_at: now, last_error: null })
      this.#inFlight.add(memberId)
    } catch (error) {
      await this.#upsert({ ...member, state: 'failed', last_active_at: now, last_error: error instanceof Error ? error.message : String(error) })
      throw error instanceof WeaveError ? error : new WeaveError('member_unreachable', `成员唤醒失败: ${memberId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async #deliverDsh(member: TeamMemberRecord, input: DeliverInput): Promise<void> {
    const dsh = this.#dsh
    if (!dsh) {
      throw new WeaveError('configuration_error', 'DSH 子代理通道未注入')
    }
    const blocks = content(input.text)
    // 官方统一投递口：running 插话 / idle 唤醒 / absent 冷恢复（无 childId 也可冷恢复——child 按标签持久）。
    if (dsh.sendMessage) {
      await dsh.sendMessage(input.parent, member.child_id ?? member.member_id, blocks, { signal: input.signal ?? new AbortController().signal })
      return
    }
    if (!dsh.followup) {
      throw new WeaveError('configuration_error', 'DSH 子代理通道缺少 followup/sendMessage')
    }
    const childId = member.child_id
    if (!childId) throw new WeaveError('member_unreachable', `成员 ${member.member_id} 无 childId（从未物化）`)
    const child = dsh.agents?.get(childId)
    if (!isLiveDshChild(child)) {
      throw new WeaveError('member_unreachable', `成员 ${member.member_id} 的子代理不在线且无 sendMessage 冷恢复通道`)
    }
    await dsh.followup(input.parent, childId, blocks, { signal: input.signal ?? new AbortController().signal })
  }

  /** 成员清单（读时刷新状态：DSH child 活性 + 在途交付）。 */
  async list(teamId?: string): Promise<TeamMemberRecord[]> {
    const rows = await this.#persistence.core.run((db) => {
      this.#ensureTable(db)
      const raw = (teamId !== undefined
        ? db.prepare('SELECT * FROM team_members WHERE team_id = ? ORDER BY role_id').all(teamId)
        : db.prepare('SELECT * FROM team_members ORDER BY team_id, role_id').all()) as unknown as MemberRow[]
      return raw.map((row) => this.#rowToRecord(row))
    })
    const refreshed: TeamMemberRecord[] = []
    for (const record of rows) {
      refreshed.push(await this.#refreshState(record))
    }
    return refreshed
  }

  async get(teamId: string, roleId: string): Promise<TeamMemberRecord | undefined> {
    const record = await this.#read(this.memberIdOf(teamId, roleId))
    return record ? await this.#refreshState(record) : undefined
  }

  /**
   * 按宿主 agent 会话 id 反查成员（成员侧工具身份解析）：
   * DSH 成员的 childId 即其会话 id；roster 小表全扫即可。
   */
  async findByAgentId(agentId: string | undefined): Promise<TeamMemberRecord | undefined> {
    if (!agentId || agentId.trim() === '') return undefined
    const all = await this.list()
    return all.find((member) => member.child_id === agentId)
  }

  /**
   * 读时状态刷新。优先级：在途交付（deliver 已受理）→ running（sendMessage 冷恢复
   * 场景 child 尚未物化也算在途）；child live 无在途 → idle；child 失联 → inactive
   * （可冷恢复，非失败）；failed 仅由 deliver 故障写入，读时不改判。
   */
  async #refreshState(record: TeamMemberRecord): Promise<TeamMemberRecord> {
    if (record.executor !== 'dsh' || !record.child_id) return record
    const agent = this.#dsh?.agents?.get(record.child_id)
    const live = isLiveDshChild(agent)
    if (this.#inFlight.has(record.member_id)) {
      if (live) {
        // 挂 whenIdle 清退钩子（幂等）：交付回合结束 → 回 idle。
        void Promise.resolve((agent as { whenIdle?: () => Promise<void> }).whenIdle?.())
          .catch(() => undefined)
          .then(async () => {
            this.#inFlight.delete(record.member_id)
            const fresh = await this.#read(record.member_id)
            if (fresh && fresh.state === 'running') {
              await this.#upsert({ ...fresh, state: 'idle' })
            }
          })
      }
      return { ...record, state: 'running' }
    }
    if (live) {
      if (record.state !== 'idle') {
        const updated: TeamMemberRecord = { ...record, state: 'idle' }
        await this.#upsert(updated)
        return updated
      }
      return record
    }
    if (record.state !== 'failed' && record.state !== 'inactive') {
      const updated: TeamMemberRecord = { ...record, state: 'inactive' }
      await this.#upsert(updated)
      return updated
    }
    return record
  }

  /** 打断在途交付（DSH 成员：child.cancel({kind:'parent'})）。 */
  async interrupt(input: { teamId: string; roleId: string; cause?: string }): Promise<void> {
    const member = await this.#read(this.memberIdOf(input.teamId, input.roleId))
    if (!member) throw new WeaveError('member_not_found', `成员不存在: ${input.teamId}:${input.roleId}`)
    if (member.executor !== 'dsh' || !member.child_id) {
      throw new WeaveError('not_implemented', `成员类型 ${member.executor} 暂不支持 interrupt`)
    }
    const child = this.#dsh?.agents?.get(member.child_id) as
      | { cancel?: (cause: unknown, options?: unknown) => void }
      | undefined
    if (!child) throw new WeaveError('member_unreachable', `成员 ${member.member_id} 的子代理不在线`)
    child.cancel?.({ kind: 'parent' })
    await this.#upsert({ ...member, state: 'idle' })
  }
}
