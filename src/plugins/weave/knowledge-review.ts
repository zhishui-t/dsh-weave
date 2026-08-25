/**
 * P0-KREVIEW-012 —— 候选知识审核（审核队列 + approve/reject + candidate→active 生命周期）。
 *
 * 职责边界（FDD 4.6 / TDD 2.2.5 / AC-KNOW-003）：
 *  - 审核队列：按 created 升序列出全部 candidate（可过滤 layer），带标题/标签（读 frontmatter）。
 *  - approve：candidate → active，**只能由显式 approve 触发**——本服务先校验 status='candidate'，
 *    再调 KnowledgeStore.activate({ confirmed: true })（第二层强制：未确认不写 active）；
 *  - reject：candidate → deprecated（不转正）；
 *  - supersede：active → superseded（F-23 P1 功能，P0 提供语义与文件保留保证：仅改写
 *    frontmatter status，**不删除旧文件**；superseded_by 仅记录于返回对象，元数据列留待
 *    DDL 扩展，见 knowledge-model.supersede 说明）；
 *  - 审计：每次审核动作写 audit（knowledge.status_changed / knowledge.superseded，
 *    TDD 2.7 / 架构 9.3）。注意：审计在状态变更后写入；若审计写入失败，调用方会看到异常，
 *    但状态已生效（追加式审计与业务状态非同一事务，P0 接受）。
 *
 * 本服务不直接触碰 KnowledgeStore 之外的写入路径；知识文件生命周期语义（不删除/仅改
 * frontmatter）由 KnowledgeStore 实现保证，本层以测试固化。
 */
import { KnowledgeStore, type KnowledgeLayer, type KnowledgeMeta } from './knowledge-model.js'
import { AuditLog, type AuditQuery } from './audit/audit-log.js'
import { WeaveError } from './state/weave-error.js'

/** 审核队列条目：元数据 + frontmatter 摘要（标题/标签）。 */
export interface ReviewQueueItem {
  meta: KnowledgeMeta
  title: string
  tags: string[]
}

export interface ReviewQueueFilter {
  layer?: KnowledgeLayer
}

export interface KnowledgeReviewOptions {
  knowledge: KnowledgeStore
  audit: AuditLog
}

export class KnowledgeReviewService {
  readonly #knowledge: KnowledgeStore
  readonly #audit: AuditLog

  constructor(options: KnowledgeReviewOptions) {
    this.#knowledge = options.knowledge
    this.#audit = options.audit
  }

  /** 审核队列：全部 candidate（可按层过滤），created 升序（FIFO 先审）。 */
  async listQueue(filter: ReviewQueueFilter = {}): Promise<ReviewQueueItem[]> {
    const metas = await this.#knowledge.listMeta({ status: 'candidate', layer: filter.layer })
    const items: ReviewQueueItem[] = []
    for (const meta of metas) {
      const file = this.#knowledge.getKnowledgeFile(meta.id)
      items.push({
        meta,
        title: file?.frontmatter.title ?? '(无标题)',
        tags: file?.frontmatter.tags ?? [],
      })
    }
    return items.sort((a, b) => a.meta.created.localeCompare(b.meta.created))
  }

  /** 待审核数量。 */
  async queueSize(filter: ReviewQueueFilter = {}): Promise<number> {
    return (await this.listQueue(filter)).length
  }

  /**
   * 审核通过：candidate → active（显式 approve）。
   * @throws WeaveError knowledge_not_found / invalid_knowledge_status
   */
  async approve(id: string): Promise<KnowledgeMeta> {
    await this.#requireCandidate(id)
    const activated = await this.#knowledge.activate(id, { confirmed: true })
    await this.#audit.record({
      type: 'knowledge.status_changed',
      knowledge_id: id,
      from: 'candidate',
      to: 'active',
    })
    return activated
  }

  /**
   * 驳回：candidate → deprecated（不转正，文件保留仅改状态）。
   * @throws WeaveError knowledge_not_found / invalid_knowledge_status
   */
  async reject(id: string): Promise<KnowledgeMeta> {
    await this.#requireCandidate(id)
    const deprecated = await this.#knowledge.reject(id)
    await this.#audit.record({
      type: 'knowledge.status_changed',
      knowledge_id: id,
      from: 'candidate',
      to: 'deprecated',
    })
    return deprecated
  }

  /**
   * 替代：active → superseded，关联新 id（旧文件保留不删除）。
   * @throws WeaveError knowledge_not_found / invalid_knowledge_status（仅 active 可 supersede）
   */
  async supersede(oldId: string, newId: string, reason: string): Promise<KnowledgeMeta> {
    const meta = await this.#knowledge.getMeta(oldId)
    if (!meta) {
      throw new WeaveError('knowledge_not_found', `知识不存在: ${oldId}`)
    }
    if (meta.status !== 'active') {
      throw new WeaveError(
        'invalid_knowledge_status',
        `仅 active 知识可被替代（当前 ${meta.status}: ${oldId}）`,
      )
    }
    const superseded = await this.#knowledge.supersede(oldId, newId)
    await this.#audit.record({
      type: 'knowledge.superseded',
      new_id: newId,
      old_id: oldId,
      reason,
    })
    return superseded
  }

  /** 审核相关审计查询入口（按类型/知识 id 过滤，默认 desc）。 */
  auditLog(query: AuditQuery = {}): Promise<unknown[]> {
    return this.#audit.query(query)
  }

  async #requireCandidate(id: string): Promise<KnowledgeMeta> {
    const meta = await this.#knowledge.getMeta(id)
    if (!meta) {
      throw new WeaveError('knowledge_not_found', `知识不存在: ${id}`)
    }
    if (meta.status !== 'candidate') {
      throw new WeaveError(
        'invalid_knowledge_status',
        `仅 candidate 可审核（当前 ${meta.status}: ${id}）`,
      )
    }
    return meta
  }
}
