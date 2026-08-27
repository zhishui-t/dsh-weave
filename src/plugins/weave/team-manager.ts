import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import { parse as parseYaml } from 'yaml'

import { WeaveError } from './state/weave-error.js'
import type { ExecutorInfo } from './executor-registry.js'
import type { WeavePersistence } from './persistence/persistence.js'
import { TEAM_BINDINGS_TABLE_DDL } from './persistence/schemas.js'
export { TEAM_BINDINGS_TABLE_DDL } // 兼容旧导入路径

/* ------------------------------------------------------------------ */
/* TDD §2.3 角色与团队模型（第 3 轮修订：stages / default_difficulty /  */
/* executor_limits；pipeline 契约与 doc/ 五份文档一致）                 */
/* ------------------------------------------------------------------ */

export type Difficulty = 'easy' | 'medium' | 'hard' | 'critical'

/** 难度比较序（HI-4：多命中取最高）。 */
export const DIFFICULTY_ORDER: readonly Difficulty[] = ['easy', 'medium', 'hard', 'critical']

/** matcher 未命中时的兜底难度（TDD §2.3，缺省 hard）。 */
export const DEFAULT_DIFFICULTY: Difficulty = 'hard'

export interface MatcherRule {
  pattern: string
  difficulty: Difficulty
}

export interface ExecutorLimit {
  max_concurrent: number
  max_per_hour: number
}

export interface KnowledgeInjection {
  max_entries: number
  max_chars_per_entry: number
  max_total_chars: number
  priority: 'freshness_first'
}

export interface FeedbackConfig {
  feedback_timeout_seconds: number
  max_revisions: number
  reopen_window_seconds: number
}

export interface TaskDecomposition {
  matchers: MatcherRule[]
  /** matcher 未命中兜底难度（HI-4）；缺省 hard */
  default_difficulty?: Difficulty
  dag_templates: Record<string, string[]>
}

export interface RoleConfig {
  id: string
  name: string
  bias: string
  executor: string
  /** P0 必填非空：该角色可执行的 DAG 阶段名集合（HI-4） */
  stages: string[]
  max_concurrent_tasks: number
  personality: string
  /** 可选 LLM provider 覆盖；缺省继承父会话。 */
  provider?: string
  /** 可选模型 id 覆盖；缺省继承父会话。 */
  model?: string
  /** ACP 思考深度 / thought level；例如 max、high、low。 */
  thought_level?: string
  /** ACP/agent 模式；例如 code、architect、build。 */
  mode?: string
  /** 备用推理服务；仅与 fallback_model 成对配置，委托失败时重试一次。 */
  fallback_provider?: string
  /** 备用模型；仅与 fallback_provider 成对配置，委托失败时重试一次。 */
  fallback_model?: string
}

export interface TeamConfig {
  team_id: string
  name: string
  default: boolean
  roles: RoleConfig[]
  task_decomposition: TaskDecomposition
  knowledge_injection: KnowledgeInjection
  feedback: FeedbackConfig
  /** 执行器级限流（ME-6）；键 = role.executor provider 名 */
  executor_limits?: Record<string, ExecutorLimit>
}

/* ------------------------------------------------------------------ */
/* 会话绑定（ME-4）：TDD §2.6.8 team_bindings，DDL 已统一注册于         */
/* persistence/schemas.ts（core.db v2），此处仅保留幂等自建兜底        */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* TeamManager（TDD §1.5.1 + HI-4/ME-4 校验项）                        */
/* ------------------------------------------------------------------ */

/** 执行器存在性查询的最小契约；ExecutorRegistry（P0-REG-002）结构上满足。 */
export interface ExecutorLookup {
  get(id: string): ExecutorInfo | undefined
}

export interface TeamManagerOptions {
  /** 团队配置目录；缺省 ~/.dsh/teams */
  teamsDir?: string
  /** 会话绑定持久化（ME-4）；缺省则 bind/select 的绑定解析不可用 */
  persistence?: WeavePersistence
}

export const DEFAULT_TEAMS_DIR = join(homedir(), '.dsh', 'teams')

/** team_id 白名单形态（import/delete 共用）：禁路径分隔符，杜绝穿越。 */
export const TEAM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * 手术式改写顶层 `default:` 行（setDefaultTeam 专用）：
 * - 仅命中列首无缩进的 `default:` 键（^default 配合 m 标志），嵌套同名键与注释不受影响；
 * - 保留既有行尾风格（CRLF 的 \r 原样带回）；无该行时插到头部元信息
 *   （schema_version/team_id/name 的最后一行）之后，兜底追加文件尾；
 * - 首行 BOM 与其余内容原样保留。
 */
export function replaceDefaultFlag(raw: string, value: boolean): string {
  const existing = raw.match(/^default:(.*)$/m)
  if (existing && existing.index !== undefined) {
    const eolCarriage = existing[1]!.endsWith('\r') ? '\r' : ''
    const end = existing.index + existing[0].length
    return `${raw.slice(0, existing.index)}default: ${value ? 'true' : 'false'}${eolCarriage}${raw.slice(end)}`
  }
  const headerPattern = /^(?:schema_version|team_id|name):[^\n]*\n/gm
  let insertAt = -1
  for (const match of raw.matchAll(headerPattern)) {
    if (match.index === undefined) continue
    // 仅认头部区域的元信息行；出现 roles: 后的 name: 属于角色条目，不算。
    if (raw.slice(0, match.index).split('\n').some((row) => row.startsWith('roles:'))) break
    insertAt = match.index + match[0].length
  }
  if (insertAt >= 0) {
    return `${raw.slice(0, insertAt)}default: ${value ? 'true' : 'false'}\n${raw.slice(insertAt)}`
  }
  return `${raw}${raw.endsWith('\n') ? '' : '\n'}default: ${value ? 'true' : 'false'}\n`
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === 'string')) {
    throw new WeaveError('invalid_team', `${field} 必须为非空字符串数组`)
  }
  return value as string[]
}

export class TeamManager {
  readonly teamsDir: string
  readonly persistence?: WeavePersistence
  #bindingsReady = false

  constructor(
    private readonly lookup: ExecutorLookup,
    options: TeamManagerOptions = {},
  ) {
    this.teamsDir = options.teamsDir ?? DEFAULT_TEAMS_DIR
    this.persistence = options.persistence
  }

  /** 团队配置文件的规范路径：{teamsDir}/{team_id}.yaml */
  teamFile(teamId: string): string {
    return join(this.teamsDir, `${teamId}.yaml`)
  }

  /**
   * 解析 YAML → TeamConfig（结构校验 + 默认值归一）。
   * 语义/注册校验见 validateTeam；本方法只保证"文档结构合法"。
   * @throws WeaveError('invalid_team') 解析失败或结构非法
   */
  parseTeam(raw: string, source: string): TeamConfig {
    let doc: unknown
    try {
      doc = parseYaml(raw)
    } catch (error) {
      throw new WeaveError('invalid_team', `团队配置解析失败: ${source}`, {
        cause: String(error),
        source,
      })
    }
    if (!isRecord(doc) || !isRecord(doc.roles) || !Array.isArray(doc.roles)) {
      throw new WeaveError('invalid_team', `团队配置结构非法（缺 roles 数组）: ${source}`)
    }
    const schemaVersion = doc.schema_version
    if (schemaVersion !== '1' && schemaVersion !== 1) {
      throw new WeaveError('invalid_team', `schema_version 必须为 "1"（实际: ${String(schemaVersion)}）`, {
        source,
        field: 'schema_version',
      })
    }
    if (typeof doc.team_id !== 'string' || doc.team_id.length === 0) {
      throw new WeaveError('invalid_team', `team_id 缺失或非法: ${source}`)
    }
    const td = isRecord(doc.task_decomposition) ? doc.task_decomposition : {}
    if (!isRecord(td.dag_templates)) {
      throw new WeaveError('invalid_team', `task_decomposition.dag_templates 缺失: ${source}`)
    }
    const feedback = isRecord(doc.feedback) ? doc.feedback : {}
    const ki = isRecord(doc.knowledge_injection) ? doc.knowledge_injection : {}
    const team: TeamConfig = {
      team_id: doc.team_id,
      name: typeof doc.name === 'string' ? doc.name : doc.team_id,
      default: doc.default === true,
      roles: (doc.roles as unknown[]).map((r, index) => {
        if (!isRecord(r) || typeof r.id !== 'string' || r.id.length === 0) {
          throw new WeaveError('invalid_team', `roles[${index}] 缺 id`, { source })
        }
        return {
          id: r.id,
          name: typeof r.name === 'string' ? r.name : r.id,
          bias: typeof r.bias === 'string' ? r.bias : '',
          executor: typeof r.executor === 'string' ? r.executor : '',
          stages: asStringArray(r.stages, `roles[${index}].stages`),
          max_concurrent_tasks: Number(r.max_concurrent_tasks),
          personality: typeof r.personality === 'string' ? r.personality : '',
          ...(typeof r.provider === 'string' && r.provider !== '' ? { provider: r.provider } : {}),
          ...(typeof r.model === 'string' && r.model !== '' ? { model: r.model } : {}),
          ...(typeof r.thought_level === 'string' && r.thought_level !== '' ? { thought_level: r.thought_level } : {}),
          ...(typeof r.mode === 'string' && r.mode !== '' ? { mode: r.mode } : {}),
          ...(typeof r.fallback_provider === 'string' && r.fallback_provider !== '' ? { fallback_provider: r.fallback_provider } : {}),
          ...(typeof r.fallback_model === 'string' && r.fallback_model !== '' ? { fallback_model: r.fallback_model } : {}),
        }
      }),
      task_decomposition: {
        matchers: Array.isArray(td.matchers)
          ? (td.matchers as unknown[]).map((m, index) => {
              if (!isRecord(m) || typeof m.pattern !== 'string' || typeof m.difficulty !== 'string') {
                throw new WeaveError('invalid_team', `task_decomposition.matchers[${index}] 非法`, { source })
              }
              return { pattern: m.pattern, difficulty: m.difficulty as Difficulty }
            })
          : [],
        default_difficulty: (td.default_difficulty as Difficulty | undefined) ?? DEFAULT_DIFFICULTY,
        dag_templates: td.dag_templates as Record<string, string[]>,
      },
      knowledge_injection: {
        max_entries: Number(ki.max_entries),
        max_chars_per_entry: Number(ki.max_chars_per_entry),
        max_total_chars: Number(ki.max_total_chars),
        priority: 'freshness_first',
      },
      feedback: {
        feedback_timeout_seconds: Number(feedback.feedback_timeout_seconds),
        max_revisions: Number(feedback.max_revisions),
        reopen_window_seconds: Number(feedback.reopen_window_seconds),
      },
    }
    if (isRecord(doc.executor_limits)) {
      const limits: Record<string, ExecutorLimit> = {}
      for (const [executor, value] of Object.entries(doc.executor_limits)) {
        if (!isRecord(value)) continue
        limits[executor] = {
          max_concurrent: Number(value.max_concurrent),
          max_per_hour: Number(value.max_per_hour),
        }
      }
      team.executor_limits = limits
    }
    return team
  }

  /**
   * 语义校验（TDD §1.5.1 + HI-4/ME-3/ME-6 校验项）。
   * @throws WeaveError('executor_unavailable') 角色绑定执行器未注册
   * @throws WeaveError('invalid_team') 其余校验项失败
   */
  validateTeam(team: TeamConfig, lookup: ExecutorLookup = this.lookup): TeamConfig {
    const seen = new Set<string>()
    for (const role of team.roles) {
      if (seen.has(role.id)) {
        throw new WeaveError('invalid_team', `角色 id 重复: ${role.id}`)
      }
      seen.add(role.id)
      if (!Number.isInteger(role.max_concurrent_tasks) || role.max_concurrent_tasks <= 0) {
        throw new WeaveError('invalid_team', `角色 ${role.id} 的 max_concurrent_tasks 必须 > 0`, {
          role: role.id,
        })
      }
      asStringArray(role.stages, `roles[${role.id}].stages`)
      if (role.provider !== undefined && role.provider.trim() === '') {
        throw new WeaveError('invalid_team', `角色 ${role.id} 的 provider 不能为空`, { role: role.id })
      }
      if (role.model !== undefined && role.model.trim() === '') {
        throw new WeaveError('invalid_team', `角色 ${role.id} 的 model 不能为空`, { role: role.id })
      }
      if (role.thought_level !== undefined && role.thought_level.trim() === '') {
        throw new WeaveError('invalid_team', `角色 ${role.id} 的 thought_level 不能为空`, { role: role.id })
      }
      if (role.mode !== undefined && role.mode.trim() === '') {
        throw new WeaveError('invalid_team', `角色 ${role.id} 的 mode 不能为空`, { role: role.id })
      }
      if ((role.fallback_provider !== undefined) !== (role.fallback_model !== undefined)) {
        throw new WeaveError('invalid_team', `角色 ${role.id} 的 fallback_provider 与 fallback_model 必须成对配置`, { role: role.id })
      }
      if (role.fallback_provider !== undefined && role.fallback_provider.trim() === '') {
        throw new WeaveError('invalid_team', `角色 ${role.id} 的 fallback_provider 不能为空`, { role: role.id })
      }
      if (role.fallback_model !== undefined && role.fallback_model.trim() === '') {
        throw new WeaveError('invalid_team', `角色 ${role.id} 的 fallback_model 不能为空`, { role: role.id })
      }
      if (!lookup.get(role.executor)) {
        throw new WeaveError('executor_unavailable', `角色 ${role.id} 的执行器未注册: ${role.executor}`, {
          role: role.id,
          executor: role.executor,
        })
      }
    }
    const td = team.task_decomposition
    for (const [index, matcher] of td.matchers.entries()) {
      try {
        new RegExp(matcher.pattern)
      } catch (error) {
        throw new WeaveError('invalid_team', `matchers[${index}] 正则非法: ${matcher.pattern}`, {
          cause: String(error),
        })
      }
    }
    const fallback = td.default_difficulty ?? DEFAULT_DIFFICULTY
    if (!DIFFICULTY_ORDER.includes(fallback)) {
      throw new WeaveError('invalid_team', `default_difficulty 非法: ${String(fallback)}`)
    }
    if (!(fallback in td.dag_templates)) {
      throw new WeaveError('invalid_team', `dag_templates 缺少默认难度模板: ${fallback}`)
    }
    for (const [executor, limit] of Object.entries(team.executor_limits ?? {})) {
      if (
        !Number.isInteger(limit.max_concurrent) ||
        limit.max_concurrent <= 0 ||
        !Number.isInteger(limit.max_per_hour) ||
        limit.max_per_hour <= 0
      ) {
        throw new WeaveError('invalid_team', `executor_limits.${executor} 的并发/小时频率必须 > 0`, {
          executor,
        })
      }
    }
    return team
  }

  /** 读取并校验单个团队（校验失败抛 invalid_team / executor_unavailable）。 */
  loadTeam(teamId: string): TeamConfig {
    const file = this.teamFile(teamId)
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      throw new WeaveError('invalid_team', `未找到团队配置: ${file}`, { teamId })
    }
    const team = this.parseTeam(raw, file)
    if (team.team_id !== teamId) {
      throw new WeaveError('invalid_team', `文件 ${teamId}.yaml 内 team_id 不一致: ${team.team_id}`, {
        teamId,
        declared: team.team_id,
      })
    }
    return this.validateTeam(team)
  }

  /**
   * 全部可用团队（按文件名排序）。
   * 仅返回校验通过的团队；单个团队的具体错误用 loadTeam 诊断。
   */
  listTeams(): TeamConfig[] {
    let files: string[]
    try {
      files = readdirSync(this.teamsDir)
    } catch {
      return []
    }
    const teams: TeamConfig[] = []
    for (const file of files.filter((f) => f.endsWith('.yaml')).sort()) {
      const teamId = file.slice(0, -'.yaml'.length)
      try {
        teams.push(this.loadTeam(teamId))
      } catch {
        // 非法团队不进入调度（TDD §1.5.1：非法团队直接加载失败）
      }
    }
    return teams
  }

  /**
   * 校验并持久化团队 YAML。用于 Web/CLI 导入：先完整解析与语义校验，
   * 再落盘，避免把不可用团队写入调度目录。
   */
  importTeam(raw: string, options: { overwrite?: boolean } = {}): TeamConfig {
    const team = this.validateTeam(this.parseTeam(raw, 'inline'))
    if (!TEAM_ID_PATTERN.test(team.team_id)) {
      throw new WeaveError('invalid_team', `team_id 含非法字符: ${team.team_id}`, { teamId: team.team_id })
    }

    const file = this.teamFile(team.team_id)
    if (!options.overwrite && existsSync(file)) {
      throw new WeaveError('conflict', `团队已存在: ${team.team_id}`, { teamId: team.team_id })
    }

    try {
      mkdirSync(this.teamsDir, { recursive: true })
      // 保留原始 YAML（含 schema_version 与注释）；parse/validate 已确认其结构安全。
      writeFileSync(file, raw, { encoding: 'utf8', flag: 'w' })
    } catch (error) {
      throw new WeaveError('configuration_error', `团队配置写入失败: ${file}`, {
        teamId: team.team_id,
        cause: String(error),
      })
    }
    return team
  }

  /* --------------------- Web RPC 支撑：设置默认团队 --------------------- */

  /**
   * 设置默认团队（Web team/set-default，全局互斥唯一）。
   * - 目标已是 default → 幂等 no-op；
   * - 其余 default:true 的团队一并翻转（顺带收敛历史脏数据的多默认并存）；
   * - 手术式文本替换只改顶层 `default:` 一行，原 YAML 注释/字段顺序/其余内容不动
   *   （changan.yaml 等手工调优文件不受损；importTeam 的整文件重写做不到这点）；
   * - 缺行时插入到头部元信息之后；写后 parse 校验翻转结果，失败即抛不落盘。
   */
  setDefaultTeam(teamId: string): { team_id: string; flipped: string[] } {
    const target = this.loadTeam(teamId) // invalid_team / executor_unavailable 冒泡
    const flipped: string[] = []
    for (const other of this.listTeams()) {
      if (other.team_id !== teamId && other.default === true) {
        this.#writeDefaultFlag(other.team_id, false)
        flipped.push(other.team_id)
      }
    }
    if (target.default !== true) {
      this.#writeDefaultFlag(teamId, true)
    }
    return { team_id: teamId, flipped }
  }

  /** 改写单个团队 YAML 的顶层 default 标记；写前解析自检，异常即抛不落盘。 */
  #writeDefaultFlag(teamId: string, value: boolean): void {
    const file = this.teamFile(teamId)
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      throw new WeaveError('invalid_team', `未找到团队配置: ${file}`, { teamId })
    }
    const updated = replaceDefaultFlag(raw, value)
    // 写前结构自检：default 值必须读回一致；替换意外破坏文档则拒绝写入。
    const doc = parseYaml(updated) as { default?: unknown } | null
    if ((doc?.default === true) !== value) {
      throw new WeaveError('invalid_team', `default 标记改写失败（解析结果不一致）: ${file}`, { teamId, want: value })
    }
    try {
      writeFileSync(file, updated, { encoding: 'utf8', flag: 'w' })
    } catch (error) {
      throw new WeaveError('configuration_error', `团队配置写入失败: ${file}`, {
        teamId,
        cause: String(error),
      })
    }
  }

    /* ----------------------------- 会话绑定（ME-4） ----------------------------- */

  async #ensureBindings(): Promise<void> {
    if (!this.persistence) {
      throw new WeaveError('configuration_error', '会话绑定需要 persistence（weave 持久化层）')
    }
    if (this.#bindingsReady) return
    await this.persistence.core.run((db) => db.exec(TEAM_BINDINGS_TABLE_DDL))
    this.#bindingsReady = true
  }

  /** 持久化会话绑定（team_switch 调用，TDD §1.2.6/ME-4）；重复绑定为 upsert。 */
  async bindTeam(sessionId: string, teamId: string): Promise<void> {
    await this.#ensureBindings()
    const now = new Date().toISOString()
    await this.persistence!.core.run((db) =>
      db
        .prepare(
          `INSERT INTO team_bindings (session_id, team_id, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET team_id = excluded.team_id, updated_at = excluded.updated_at`,
        )
        .run(sessionId, teamId, now),
    )
  }

  /** 读取会话绑定的团队 id；无绑定（或无 persistence）返回 null。 */
  async getBoundTeam(sessionId: string): Promise<string | null> {
    if (!this.persistence) {
      // 无持久化 = 无会话绑定；优先级链在此级优雅降级（ME-4）
      return null
    }
    await this.#ensureBindings()
    const row = await this.persistence!.core.run((db) =>
      db.prepare('SELECT team_id FROM team_bindings WHERE session_id = ?').get(sessionId),
    ) as { team_id: string } | undefined
    return row?.team_id ?? null
  }

  /**
   * 团队选择优先级链（TDD §1.1.3）：显式指定 > 会话绑定 > default 团队 > 仅一个团队 > 提示选择（null）。
   * @returns null 表示需要用户显式选择（调用方提示后 team_switch/bindTeam）。
   */
  async selectTeam(sessionId: string, explicit?: string): Promise<TeamConfig | null> {
    if (explicit !== undefined && explicit !== '') {
      return this.loadTeam(explicit)
    }
    const bound = await this.getBoundTeam(sessionId)
    if (bound) {
      return this.loadTeam(bound)
    }
    const teams = this.listTeams()
    const fallback = teams.find((t) => t.default) ?? (teams.length === 1 ? teams[0] : undefined)
    return fallback ?? null
  }

  /* --------------------- Web RPC 支撑：删除 / 解绑 / 绑定清单 --------------------- */

  /**
   * 删除团队 YAML（Web team/delete）。双保险防路径穿越：
   * 1) team_id 白名单正则（禁路径分隔符与首字符点）；2) 解析路径必须仍在 teamsDir 内。
   * 该团队遗留会话绑定一并清理（绑定库异常不阻断文件删除）。
   */
  async deleteTeam(teamId: string): Promise<{ team_id: string; path: string }> {
    if (typeof teamId !== 'string' || !TEAM_ID_PATTERN.test(teamId)) {
      throw new WeaveError('invalid_argument', `team_id 含非法字符: ${String(teamId)}`, { teamId })
    }
    const resolvedDir = resolve(this.teamsDir)
    const resolvedFile = resolve(this.teamFile(teamId))
    if (!resolvedFile.startsWith(resolvedDir + sep)) {
      throw new WeaveError('invalid_argument', `拒绝路径穿越: ${teamId}`, { teamId })
    }
    if (!existsSync(resolvedFile)) {
      throw new WeaveError('invalid_team', `未找到团队配置: ${resolvedFile}`, { teamId })
    }
    try {
      unlinkSync(resolvedFile)
    } catch (error) {
      throw new WeaveError('configuration_error', `团队配置删除失败: ${resolvedFile}`, {
        teamId,
        cause: String(error),
      })
    }
    if (this.persistence) {
      try {
        await this.persistence.core.run((db) => db.prepare('DELETE FROM team_bindings WHERE team_id = ?').run(teamId))
      } catch {
        // 绑定清理失败不阻断删除；selectTeam 对悬空绑定本就按 invalid_team 拒绝。
      }
    }
    return { team_id: teamId, path: resolvedFile }
  }

  /** 解除会话绑定（Web team/unbind）；返回是否确实存在绑定。 */
  async unbindTeam(sessionId: string): Promise<boolean> {
    await this.#ensureBindings()
    const result = (await this.persistence!.core.run((db) =>
      db.prepare('DELETE FROM team_bindings WHERE session_id = ?').run(sessionId),
    )) as unknown as { changes?: number }
    return (result?.changes ?? 0) > 0
  }

  /** 全部会话绑定（core.db.team_bindings，按 session_id 排序）。 */
  async listBindings(): Promise<Array<{ session_id: string; team_id: string; updated_at: string }>> {
    await this.#ensureBindings()
    return (await this.persistence!.core.run((db) =>
      db.prepare('SELECT session_id, team_id, updated_at FROM team_bindings ORDER BY session_id').all(),
    )) as Array<{ session_id: string; team_id: string; updated_at: string }>
  }

  /**
   * 读取会话当前团队选择（t6 会话任务入口）。
   * 复用 core.db.team_bindings：绑定行存在 = 该会话已启用该团队（enabled ≡ row 存在），
   * 绑定/解绑语义与 team/bind・team/unbind 完全一致；无选择返回 null。
   */
  async getSelection(sessionId: string): Promise<{ session_id: string; team_id: string; updated_at: string } | null> {
    if (!this.persistence) return null
    await this.#ensureBindings()
    const row = await this.persistence!.core.run((db) =>
      db.prepare('SELECT session_id, team_id, updated_at FROM team_bindings WHERE session_id = ?').get(sessionId),
    ) as { session_id: string; team_id: string; updated_at: string } | undefined
    return row ?? null
  }

  /**
   * 队长模式的零仪式团队解析（绑定 > 默认团队 > 唯一团队）：
   * 配置好了小队就该直接可用——只有「多团队且无默认」才需要显式启用。
   * 返回 via 供 UI 标注来源；无可解析团队时 {team:null, via:null}。
   */
  async resolveSessionTeam(
    sessionId: string,
  ): Promise<{ team: TeamConfig | null; via: 'binding' | 'default' | 'single' | null }> {
    const bound = await this.getSelection(sessionId)
    if (bound) {
      return { team: this.loadTeam(bound.team_id), via: 'binding' }
    }
    const teams = this.listTeams()
    const fallback = teams.find((t) => t.default) ?? (teams.length === 1 ? teams[0] : undefined)
    if (!fallback) return { team: null, via: null }
    return { team: this.loadTeam(fallback.team_id), via: fallback.default ? 'default' : 'single' }
  }
}
