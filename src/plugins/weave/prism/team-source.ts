import type { ExternalTeamSource, TeamConfig } from '../team/team-manager.js'
import type { PrismGateway } from './gateway.js'

/**
 * Prism 团队源（P2：角色/团队定义由 prism 承接）。
 *
 * prism v4 口径：角色/团队直接住在宿主目录（roles_dir / teams_dir），prism 只做
 * 解析/校验/激活。weave 通过 /api/teams 与 /api/teams/:id/activate 把 prism 团队
 * 映射为调度用 TeamConfig——**本地 ~/.dsh/teams/*.yaml 优先**（DSH 原生字段完整：
 * executor/stages/feedback/task_decomposition），prism 团队按缺省值补齐 DSH 专属
 * 字段后作为"编制来源"接入（default_executor 可经 settings prism_default_executor 覆盖）。
 *
 * prism 不可用/未定义团队时静默返回空——团队清单波动不得影响调度主链路。
 */

/** prism 团队定义（/api/teams 条目；按结构化最小面消费）。 */
export interface PrismTeamDefinitionLike {
  team_id: string
  name: string
  description?: string
  default?: boolean
  members?: Array<{ role: string; count?: number }>
  workflow?: unknown
  deposit?: unknown
  arbitration?: string[]
  rework_limit?: number
}

/** prism 团队激活返回成员（/api/teams/:id/activate；definition 含角色正文）。 */
export interface PrismActivationMemberLike {
  role: string
  count?: number
  definition?: {
    name?: string
    description?: string
    principle?: string
    body?: string
  }
}

export interface PrismTeamActivationLike {
  team_id: string
  team_name?: string
  members?: PrismActivationMemberLike[]
  workflow?: unknown
}

export interface PrismTeamSourceOptions {
  gateway: PrismGateway
  /** 映射缺省值：prism 角色无 DSH 执行器概念，落到这里（缺省 codex）。 */
  defaultExecutor?: string
  /** 角色默认并发（缺省 1）。 */
  defaultMaxConcurrentTasks?: number
}

export const DEFAULT_PRISM_TEAM_EXECUTOR = 'codex'
export const DEFAULT_PRISM_TEAM_STAGES = ['implement'] as const

const DEFAULT_FEEDBACK = {
  feedback_timeout_seconds: 60,
  max_revisions: 2,
  reopen_window_seconds: 60,
} as const

const DEFAULT_KNOWLEDGE_INJECTION = {
  max_entries: 5,
  max_chars_per_entry: 500,
  max_total_chars: 2500,
  priority: 'freshness_first',
} as const

/** prism 团队定义 → weave TeamConfig（纯函数；DSH 专属字段按缺省值补齐）。 */
export function prismTeamToConfig(
  team: PrismTeamDefinitionLike,
  options: { defaultExecutor?: string; activationMembers?: PrismActivationMemberLike[] } = {},
): TeamConfig {
  const roles = (team.members ?? []).map((member) => {
    const definition = options.activationMembers?.find((item) => item.role === member.role)?.definition
    const personality = (definition?.principle ?? definition?.description ?? definition?.body ?? '').trim()
    return {
      id: member.role,
      name: definition?.name ?? member.role,
      bias: 'general',
      executor: options.defaultExecutor ?? DEFAULT_PRISM_TEAM_EXECUTOR,
      stages: [...DEFAULT_PRISM_TEAM_STAGES],
      max_concurrent_tasks: member.count && member.count > 0 ? member.count : 1,
      personality: personality !== '' ? personality.slice(0, 2000) : `（prism 角色 ${member.role}，正文见 prism 控制台）`,
    }
  })
  const firstRole = roles[0]?.id ?? ''
  return {
    team_id: team.team_id,
    name: team.name,
    ...(team.description !== undefined ? { description: team.description } : {}),
    default: team.default === true,
    roles,
    source: 'prism',
    // DSH 专属字段：prism 团队不携带，按缺省补齐（先保证可调度）。
    task_decomposition: {
      matchers: [],
      default_difficulty: 'hard',
      dag_templates: { hard: firstRole !== '' ? [firstRole] : [] },
    },
    knowledge_injection: { ...DEFAULT_KNOWLEDGE_INJECTION },
    feedback: { ...DEFAULT_FEEDBACK },
  }
}

export class PrismTeamSource {
  readonly #gateway: PrismGateway
  readonly #defaultExecutor?: string
  readonly #defaultMaxConcurrentTasks?: number

  constructor(options: PrismTeamSourceOptions) {
    this.#gateway = options.gateway
    this.#defaultExecutor = options.defaultExecutor
    this.#defaultMaxConcurrentTasks = options.defaultMaxConcurrentTasks
  }

  /** prism 团队清单（映射为 TeamConfig）；prism 故障/为空 → []。 */
  async listTeams(): Promise<TeamConfig[]> {
    let definitions: PrismTeamDefinitionLike[]
    try {
      const result = await this.#gateway.listTeams()
      definitions = (result.teams ?? []) as unknown as PrismTeamDefinitionLike[]
    } catch {
      return []
    }
    const mapped: TeamConfig[] = []
    for (const definition of definitions) {
      try {
        mapped.push(prismTeamToConfig(definition, {
          defaultExecutor: this.#defaultExecutor,
          ...(this.#defaultMaxConcurrentTasks !== undefined ? { defaultMaxConcurrentTasks: this.#defaultMaxConcurrentTasks } : {}),
        }))
      } catch {
        // 单个团队映射失败不拖垮清单
      }
    }
    return mapped
  }

  /** 激活单个 prism 团队（携带角色定义 → 人格注入更完整）；失败抛回调用方。 */
  async loadTeam(teamId: string): Promise<TeamConfig> {
    const activation = await this.#gateway.teamActivate(teamId) as unknown as PrismTeamActivationLike
    return prismTeamToConfig(
      {
        team_id: activation.team_id,
        name: activation.team_name ?? activation.team_id,
        members: (activation.members ?? []).map((member) => ({ role: member.role, count: member.count })),
      },
      {
        defaultExecutor: this.#defaultExecutor,
        activationMembers: activation.members,
        ...(this.#defaultMaxConcurrentTasks !== undefined ? { defaultMaxConcurrentTasks: this.#defaultMaxConcurrentTasks } : {}),
      },
    )
  }
}

/** 结构化满足 team-manager 的 ExternalTeamSource 契约（由接线方传入 TeamManager）。 */
export type { PrismTeamSource as PrismTeamSourceService }
