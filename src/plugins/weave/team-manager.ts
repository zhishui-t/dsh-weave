import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
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
    const templateStages = new Set<string>()
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
      if (!lookup.get(role.executor)) {
        throw new WeaveError('executor_unavailable', `角色 ${role.id} 的执行器未注册: ${role.executor}`, {
          role: role.id,
          executor: role.executor,
        })
      }
      for (const stage of role.stages) {
        templateStages.add(stage)
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
    for (const [difficulty, stages] of Object.entries(td.dag_templates)) {
      for (const stage of stages) {
        if (!templateStages.has(stage)) {
          throw new WeaveError(
            'invalid_team',
            `难度 ${difficulty} 的阶段 ${stage} 未绑定任何角色（roles 需声明 stages，HI-4）`,
            { stage },
          )
        }
      }
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
}
