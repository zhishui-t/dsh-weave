import type { AuditLog } from '../audit/audit-log.js'
import type { PrismGateway } from './gateway.js'
import type { StagedKnowledgeType } from './knowledge-staging.js'

/**
 * 反思沉淀服务（prism 版，先审后发）。
 *
 * 职责（语义对齐旧 knowledge/reflection-service.ts，存储后端换 Prism）：
 * - 解析执行器输出中的 WEAVE_KNOWLEDGE 块（解析器从旧 reflection.ts 移植，纯函数）；
 * - 块写入知识暂存区（KnowledgeStaging）——不再直接落库：prism deposit 即生效
 *   （版次制、无 candidate 态），「先审后发」由暂存区 + 主会话审核兑现；
 * - 整场无有效块且输出非空时自动合成一条 pattern 兑底（source 标签区分）；
 * - 暂存成功追加 `knowledge.status_changed`（reflection → candidate）审计事件。
 * 审核闭环：主会话 weave_knowledge_review/approve/reject → approve 时才
 * deposit 进 Prism（Gateway.approveStaged，审计 knowledge.deposited）。
 */

export const KNOWLEDGE_MARKER_START = 'WEAVE_KNOWLEDGE_START'
export const KNOWLEDGE_MARKER_END = 'WEAVE_KNOWLEDGE_END'

const KNOWLEDGE_TYPES: ReadonlySet<string> = new Set(['doc', 'skill', 'guide', 'pitfall', 'pattern', 'other'])

/** 单条执行器反思知识块（规整后）。 */
export interface WeaveKnowledgeBlock {
  type: StagedKnowledgeType
  title: string
  content: string
  tags: string[]
  /** 兼容保留：暂存区不分层，approve 统一落 prism project 层。 */
  layer?: string
}

export interface ReflectionParseResult {
  blocks: WeaveKnowledgeBlock[]
  /** 畸形块数（JSON 非法/缺 END/字段缺失），用于通知与审计。 */
  invalid: number
}

const MARKER_RE = /^\s*#{0,6}\s*WEAVE_KNOWLEDGE_(START|END)\s*$/

/** WEAVE type → 暂存类型（guide→skill、other→doc）。 */
function toStagedType(type: string): StagedKnowledgeType {
  if (type === 'pitfall' || type === 'pattern' || type === 'skill' || type === 'doc') return type
  if (type === 'guide') return 'skill'
  return 'doc'
}

function markerOf(line: string): 'START' | 'END' | null {
  const m = MARKER_RE.exec(line)
  if (!m) return null
  return m[1] === 'START' ? 'START' : 'END'
}

/** 规整单个 JSON 块；非法返回 null（计入 invalid）。 */
function parseBlock(raw: string): WeaveKnowledgeBlock | null {
  if (raw === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const title = typeof record.title === 'string' ? record.title.trim() : ''
  const content = typeof record.content === 'string' ? record.content.trim() : ''
  if (title === '' || content === '') return null
  const type = typeof record.type === 'string' && KNOWLEDGE_TYPES.has(record.type) ? record.type : 'other'
  const tags = Array.isArray(record.tags)
    ? record.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim() !== '').map((tag) => tag.trim())
    : []
  const layer = typeof record.layer === 'string' ? record.layer : undefined
  return { type: toStagedType(type), title, content, tags, ...(layer !== undefined ? { layer } : {}) }
}

/**
 * 从执行器输出文本解析全部 WEAVE_KNOWLEDGE 块。
 * - 标记行兼容 0..6 个 `#` 前缀与 CRLF；一段输出支持多个块；
 * - START 无 END / 块内 JSON 非法 / title|content 缺失 → invalid+1 并跳过。
 */
export function extractKnowledgeBlocks(text: string): ReflectionParseResult {
  const blocks: WeaveKnowledgeBlock[] = []
  let invalid = 0
  const lines = String(text ?? '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (markerOf(line) !== 'START') continue
    let end = -1
    for (let j = i + 1; j < lines.length; j++) {
      const marker = markerOf(lines[j] ?? '')
      if (marker === 'END') {
        end = j
        break
      }
      if (marker === 'START') break // 未闭合就开新块：当前块畸形
    }
    if (end < 0) {
      invalid += 1
      break
    }
    const raw = lines.slice(i + 1, end).join('\n').trim()
    const block = parseBlock(raw)
    if (block) {
      blocks.push(block)
    } else {
      invalid += 1
    }
    i = end
  }
  return { blocks, invalid }
}

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
  /** 暂存 id（stag_*） */
  id: string
  title: string
  layer: 'project'
  /** 暂存目录 */
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

export class PrismReflectionService {
  readonly #gateway: PrismGateway
  readonly #audit?: AuditLog

  constructor(options: { gateway: PrismGateway; audit?: AuditLog }) {
    this.#gateway = options.gateway
    this.#audit = options.audit
  }

  async depositFromOutput(input: ReflectionDepositInput): Promise<ReflectionDepositResult> {
    const { blocks, invalid } = extractKnowledgeBlocks(input.outputText)
    const pending: Array<{ block: WeaveKnowledgeBlock; sourceTag: string }> = blocks.map((block) => ({
      block,
      sourceTag: SOURCE_TAG_REFLECTION,
    }))
    // 兑底：整场无有效块且输出非空 → 自动合成一条 pattern 候选。
    if (pending.length === 0 && input.outputText.trim() !== '') {
      pending.push({ block: this.#synthesizeAutoCandidate(input), sourceTag: SOURCE_TAG_REFLECTION_AUTO })
    }

    const deposited: ReflectionDepositItem[] = []
    const errors: ReflectionDepositError[] = []

    for (let index = 0; index < pending.length; index += 1) {
      const { block, sourceTag } = pending[index]!
      try {
        const staged = await this.#gateway.stageReflection({
          title: block.title,
          type: block.type,
          content: block.content,
          tags: [...block.tags, `executor:${input.executor}`, `role:${input.roleId}`, sourceTag],
          task_id: input.taskId,
          role_id: input.roleId,
          project_id: input.projectId,
          version: input.version,
          executor: input.executor,
        })
        deposited.push({ id: staged.id, title: block.title, layer: 'project', path: this.#gateway.staging.dir })
        try {
          await this.#audit?.record({
            type: 'knowledge.status_changed',
            knowledge_id: staged.id,
            from: 'reflection',
            to: 'candidate',
          })
        } catch (error) {
          errors.push({
            index,
            message: `审计失败（知识已暂存）: ${error instanceof Error ? error.message : String(error)}`,
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
   * 兑底候选合成：type=pattern、title=任务主题（缺省 taskId）、content=结果摘要前 200 字。
   */
  #synthesizeAutoCandidate(input: ReflectionDepositInput): WeaveKnowledgeBlock {
    return {
      type: 'pattern',
      title: input.taskSubject?.trim() || input.taskId,
      content: input.outputText.trim().slice(0, AUTO_SUMMARY_MAX_CHARS),
      tags: [],
    }
  }
}
