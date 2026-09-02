import type { KnowledgeInjectionLimits } from './scheduling/delegation-service.js'
import { KnowledgeStore, type KnowledgeLayer, type KnowledgeMeta, type Visibility } from './knowledge-model.js'
import { WeaveError } from './state/weave-error.js'

/**
 * P0-KINJECT-013 —— KnowledgeEngine：知识检索、排序与注入（TDD 1.5.7 + 2.2.6 + F-12）。
 *
 * 数据源：KnowledgeStore（P0-KBLD-009）——仅 status='active' 的知识参与注入
 * （candidate 未确认、deprecated/superseded 停用，AC-KNOW-003 生命周期）。
 *
 * 排序（freshness_first，TDD 2.2.6 权重表 × freshness，权重按路径归属判定）：
 *   - 当前版本项目知识  1.0（project + 同 project/同 version）
 *   - 跨版本共享项目知识 0.9（project + 同 project/其它 version）
 *   - 实例知识          0.85（instance；P0 无实例上下文参数，全量参与）
 *   - 角色知识（同项目） 0.8（role + roleId 匹配；路径无项目维度，按 roleId 近似）
 *   - 全局知识          0.6（shared）
 *   - 角色知识（跨项目） 0.4（role + 其它 roleId）
 *   - 其它版本项目知识  0.3（默认不参与 → 直接排除，P0 无开关）
 *
 * 限制（强制，F-12）：max_entries / max_chars_per_entry（超长截断 '…'）/
 * max_total_chars（累计超限停止追加）；priority 仅支持 'freshness_first'。
 * 优雅降级：无匹配/文件缺失/frontmatter 非法 → 跳过该条；全部无 → 返回 []（不抛错），
 * DelegationService 侧以"（无）"注入 prompt。
 */

export interface KnowledgeInjectionEntry {
  id: string
  title: string
  content: string
  layer: KnowledgeLayer
  visibility: Visibility
  freshness_score: number
}

export interface InjectionSearchParams {
  taskId: string
  projectId: string
  version: string
  roleId: string
  limit: KnowledgeInjectionLimits
  /** true 时只注入首段/短摘要，避免初始 prompt 过大；全文由 knowledge_search 按需查。 */
  slim?: boolean
}

export interface KnowledgeReviewFilter {
  layer?: KnowledgeLayer
}

/** 权重表（TDD 2.2.6）。 */
export const SOURCE_WEIGHTS = {
  currentVersionProject: 1.0,
  crossVersionProject: 0.9,
  instance: 0.85,
  roleSameProject: 0.8,
  sharedGlobal: 0.6,
  roleCrossProject: 0.4,
  otherVersionProject: 0.3, // 默认不参与
} as const

const PROJECT_RE = /projects\/([^/]+)\/([^/]+)\//
const ROLE_RE = /roles\/([^/]+)\//

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/**
 * 按来源对单条知识打分：score = weight × freshness；返回 null = 不参与注入。
 * 导出以便单测覆盖权重表与路径解析。
 */
export function scoreKnowledge(meta: Pick<KnowledgeMeta, 'layer' | 'path' | 'freshness_score'>, params: Pick<InjectionSearchParams, 'projectId' | 'version' | 'roleId'>): number | null {
  const freshness = clamp01(meta.freshness_score)
  switch (meta.layer) {
    case 'project': {
      const m = PROJECT_RE.exec(meta.path)
      if (!m) return null
      if (m[1] !== params.projectId) return null // 其它版本项目知识：默认不参与
      return (m[2] === params.version ? SOURCE_WEIGHTS.currentVersionProject : SOURCE_WEIGHTS.crossVersionProject) * freshness
    }
    case 'role': {
      const m = ROLE_RE.exec(meta.path)
      if (!m) return null
      return (m[1] === params.roleId ? SOURCE_WEIGHTS.roleSameProject : SOURCE_WEIGHTS.roleCrossProject) * freshness
    }
    case 'instance':
      return SOURCE_WEIGHTS.instance * freshness
    case 'shared':
      return SOURCE_WEIGHTS.sharedGlobal * freshness
  }
}

export class KnowledgeEngine {
  readonly #store: KnowledgeStore

  constructor(store: KnowledgeStore) {
    this.#store = store
  }

  /**
   * 检索可注入知识（仅 active；freshness_first 排序；限额强制）。
   * 无匹配返回 []（优雅降级）；priority≠'freshness_first' 抛 configuration_error。
   */
  async searchForInjection(params: InjectionSearchParams): Promise<KnowledgeInjectionEntry[]> {
    if (params.limit.priority !== 'freshness_first') {
      throw new WeaveError('configuration_error', `不支持的注入优先级: ${String(params.limit.priority)}`, {
        priority: params.limit.priority,
      })
    }
    const active = await this.#store.listMeta({ status: 'active' })
    const ranked = active
      .map((meta) => ({ meta, score: scoreKnowledge(meta, params) }))
      .filter((item): item is { meta: KnowledgeMeta; score: number } => item.score !== null)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score
        if (b.meta.freshness_score !== a.meta.freshness_score) return b.meta.freshness_score - a.meta.freshness_score
        return b.meta.updated.localeCompare(a.meta.updated)
      })

    const maxEntries = Math.max(0, params.limit.max_entries)
    const maxCharsPerEntry = Math.max(0, params.limit.max_chars_per_entry)
    const maxTotalChars = Math.max(0, params.limit.max_total_chars)
    const entries: KnowledgeInjectionEntry[] = []
    let totalChars = 0

    for (const { meta } of ranked) {
      if (entries.length >= maxEntries) break
      const file = this.#readFile(meta.id)
      if (!file) continue // 文件缺失/frontmatter 非法 → 跳过该条（优雅降级）
      let content = file.body.trim()
      if (params.slim === true) {
        const newline = String.fromCharCode(10)
        const paragraphEnd = content.indexOf(newline + newline)
        content = paragraphEnd >= 0 ? content.slice(0, paragraphEnd) : content.slice(0, 200)
      }
      if (content.length > maxCharsPerEntry) {
        content = `${content.slice(0, maxCharsPerEntry)}…`
      }
      if (totalChars + content.length > maxTotalChars) break
      entries.push({
        id: meta.id,
        title: file.title,
        content,
        layer: meta.layer,
        visibility: file.visibility,
        freshness_score: meta.freshness_score,
      })
      totalChars += content.length
    }
    return entries
  }

  /** 候选审核队列（candidate 状态；t12 的审核/批准流程复用）。 */
  async reviewQueue(filter: KnowledgeReviewFilter = {}): Promise<KnowledgeMeta[]> {
    return this.#store.listMeta({ status: 'candidate', ...(filter.layer ? { layer: filter.layer } : {}) })
  }

  /** 批准：candidate → active（须显式人工确认，AC-KNOW-003）。 */
  async approve(knowledgeId: string): Promise<KnowledgeMeta> {
    return this.#store.activate(knowledgeId, { confirmed: true })
  }

  /** 驳回：candidate → deprecated。 */
  async reject(knowledgeId: string, _reason: string): Promise<void> {
    await this.#store.reject(knowledgeId)
  }

  /** 读取知识文件（缺失/非法 → null，不抛）。 */
  #readFile(id: string): { title: string; body: string; visibility: Visibility } | null {
    try {
      const file = this.#store.getKnowledgeFile(id)
      if (!file) return null
      return { title: file.frontmatter.title, body: file.body, visibility: file.frontmatter.visibility }
    } catch {
      return null
    }
  }
}
