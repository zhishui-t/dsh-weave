import { extractKnowledgeBlocks } from './reflection.js'
import {
  LAYER_VISIBILITY,
  type KnowledgeLayer,
  type KnowledgeScope,
  type KnowledgeStore,
} from './knowledge-model.js'
import type { AuditLog } from './audit/audit-log.js'

/**
 * 反思沉淀服务（SDD 增量 doc/05 §3.2）。
 *
 * 职责：
 * - 解析执行器输出中的 WEAVE_KNOWLEDGE 块（复用 reflection.ts 纯函数）；
 * - 按 layer 路由到 KnowledgeStore._agent 四层目录；
 * - 追加 executor/role/source 溯源 tags；统一 status=candidate（AC-KNOW-003）；
 * - 每条成功沉淀追加 `knowledge.deposited` 审计事件（审计失败不回滚沉淀）；
 * - 单块失败不抛错，错误按 `{index, message}` 收集，返回结构化结果。
 */
export interface ReflectionDepositInput {
  taskId: string
  executor: string
  roleId: string
  projectId: string
  version: string
  outputText: string
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

export class ReflectionService {
  readonly #knowledge: KnowledgeStore
  readonly #audit?: AuditLog

  constructor(options: { knowledge: KnowledgeStore; audit?: AuditLog }) {
    this.#knowledge = options.knowledge
    this.#audit = options.audit
  }

  async depositFromOutput(input: ReflectionDepositInput): Promise<ReflectionDepositResult> {
    const { blocks, invalid } = extractKnowledgeBlocks(input.outputText)
    const deposited: ReflectionDepositItem[] = []
    const errors: ReflectionDepositError[] = []

    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index]!
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
            tags: [...block.tags, `executor:${input.executor}`, `role:${input.roleId}`, 'source:weave-reflection'],
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
