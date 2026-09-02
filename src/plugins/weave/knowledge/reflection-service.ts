import { extractKnowledgeBlocks, type WeaveKnowledgeBlock } from './reflection.js'
import {
  LAYER_VISIBILITY,
  type KnowledgeLayer,
  type KnowledgeScope,
  type KnowledgeStore,
} from './knowledge-model.js'
import type { AuditLog } from '../audit/audit-log.js'

/**
 * 反思沉淀服务（SDD 增量 doc/05 §3.2）。
 *
 * 职责：
 * - 解析执行器输出中的 WEAVE_KNOWLEDGE 块（复用 reflection.ts 纯函数）；
 * - 按 layer 路由到 KnowledgeStore._agent 四层目录；
 * - 追加 executor/role/source 溯源 tags；统一 status=candidate（AC-KNOW-003）；
 * - 每条成功沉淀追加 `knowledge.deposited` 审计事件（审计失败不回滚沉淀）；
 * - 单块失败不抛错，错误按 `{index, message}` 收集，返回结构化结果；
 * - 兑底（反思→知识库链路源头打通）：输出整场无有效块时自动合成一条
 *   pattern 候选（title=任务主题、content=结果前 200 字），保证知识库不空转；
 *   仍走 candidate+审计，source 标签用 `weave-reflection-auto` 区分自动合成。
 */
export interface ReflectionDepositInput {
  taskId: string
  executor: string
  roleId: string
  projectId: string
  version: string
  outputText: string
  /** 任务主题（描述首行）：兑底候选的标题来源；缺省退回 taskId。 */
  taskSubject?: string
}

export interface ReflectionDepositError {
  index: number
  message: string
}

export interface ReflectionDepositItem {
  id: string
  title: string
  layer: KnowledgeLayer
  path: string
}

export interface ReflectionDepositResult {
  deposited: ReflectionDepositItem[]
  invalid: number
  errors: ReflectionDepositError[]
}

/** source 溯源标签：执行器显式输出块 vs 无标记时的自动合成兑底。 */
const SOURCE_TAG_REFLECTION = 'source:weave-reflection'
const SOURCE_TAG_REFLECTION_AUTO = 'source:weave-reflection-auto'
/** 兑底候选正文长度：取结果摘要前 200 字。 */
const AUTO_SUMMARY_MAX_CHARS = 200

export class ReflectionService {
  readonly #knowledge: KnowledgeStore
  readonly #audit?: AuditLog

  constructor(options: { knowledge: KnowledgeStore; audit?: AuditLog }) {
    this.#knowledge = options.knowledge
    this.#audit = options.audit
  }

  async depositFromOutput(input: ReflectionDepositInput): Promise<ReflectionDepositResult> {
    const { blocks, invalid } = extractKnowledgeBlocks(input.outputText)
    const pending: Array<{ block: WeaveKnowledgeBlock; sourceTag: string }> = blocks.map((block) => ({
      block,
      sourceTag: SOURCE_TAG_REFLECTION,
    }))
    // 兑底：整场无有效块且输出非空 → 自动合成一条 pattern 候选（复用下方同一路由与审计）。
    if (pending.length === 0 && input.outputText.trim() !== '') {
      pending.push({ block: this.#synthesizeAutoCandidate(input), sourceTag: SOURCE_TAG_REFLECTION_AUTO })
    }

    const deposited: ReflectionDepositItem[] = []
    const errors: ReflectionDepositError[] = []

    for (let index = 0; index < pending.length; index += 1) {
      const { block, sourceTag } = pending[index]!
      const requestedLayer = block.layer ?? 'project'
      const effectiveLayer: KnowledgeLayer = requestedLayer === 'instance' ? 'project' : requestedLayer

      if (requestedLayer === 'instance') {
        errors.push({
          index,
          message: 'instance 层需要 instanceId，已降级 project',
        })
      }

      try {
        const scope = this.#scopeFor(effectiveLayer, input)
        const meta = await this.#knowledge.createCandidate({
          layer: effectiveLayer,
          scope,
          filename: this.#filename(input.taskId, index + 1),
          frontmatter: {
            title: block.title,
            type: block.type,
            visibility: LAYER_VISIBILITY[effectiveLayer],
            tags: [...block.tags, `executor:${input.executor}`, `role:${input.roleId}`, sourceTag],
          },
          body: block.content,
        })
        deposited.push({
          id: meta.id,
          title: block.title,
          layer: effectiveLayer,
          path: meta.path,
        })

        try {
          await this.#audit?.record({
            type: 'knowledge.deposited',
            knowledge_id: meta.id,
            task_id: input.taskId,
            executor: input.executor,
            layer: effectiveLayer,
          })
        } catch (error) {
          errors.push({
            index,
            message: `审计失败（知识已沉淀）: ${error instanceof Error ? error.message : String(error)}`,
          })
        }
      } catch (error) {
        errors.push({
          index,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return { deposited, invalid, errors }
  }

  /**
   * 兑底候选合成：type=pattern、title=任务主题（缺省 taskId）、
   * content=结果摘要前 200 字；tags 溯源由沉淀路径统一追加。
   */
  #synthesizeAutoCandidate(input: ReflectionDepositInput): WeaveKnowledgeBlock {
    return {
      type: 'pattern',
      title: input.taskSubject?.trim() || input.taskId,
      content: input.outputText.trim().slice(0, AUTO_SUMMARY_MAX_CHARS),
      tags: [],
    }
  }

  #scopeFor(layer: KnowledgeLayer, input: ReflectionDepositInput): KnowledgeScope {
    switch (layer) {
      case 'project':
        return { projectId: input.projectId, version: input.version }
      case 'role':
        return { roleId: input.roleId }
      case 'shared':
        return {}
      case 'instance':
        // depositFromOutput 会把无 instanceId 的 instance 降级为 project，此处防御性兜底。
        return { projectId: input.projectId, version: input.version }
    }
  }

  #filename(taskId: string, sequence: number): string {
    // 文件名消毒：文件系统非法字符与 C0 控制字符（code point < 0x20）统一替换为 '-'。
    const safeTaskId = Array.from(String(taskId))
      .map((ch) => (ch.codePointAt(0)! < 0x20 || '\\/:*?"<>|'.includes(ch) ? '-' : ch))
      .join('')
    return `reflect-${safeTaskId}-${sequence}.md`
  }
}
