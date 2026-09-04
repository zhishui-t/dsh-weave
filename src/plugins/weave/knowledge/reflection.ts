import type { KnowledgeLayer, KnowledgeType } from './knowledge-model.js'

/**
 * 反思解析器（SDD 增量 doc/05 §3.1，兑现 SDD 2.5.8 知识回流承诺）。
 *
 * DelegationService 的 prompt 已要求执行器在输出尾部以标记对包裹知识块：
 *
 *   ### WEAVE_KNOWLEDGE_START
 *   {"type": "pitfall", "title": "...", "content": "...", "tags": ["..."], "layer": "project"}
 *   ### WEAVE_KNOWLEDGE_END
 *
 * 本模块是纯函数解析器：无 IO、不抛错（畸形块计入 invalid 计数后跳过），
 * 供 ReflectionService（沉淀）与单测复用。
 */

export const KNOWLEDGE_MARKER_START = 'WEAVE_KNOWLEDGE_START'
export const KNOWLEDGE_MARKER_END = 'WEAVE_KNOWLEDGE_END'

const KNOWLEDGE_TYPES: ReadonlySet<string> = new Set(['doc', 'skill', 'guide', 'pitfall', 'pattern', 'other'])
const KNOWLEDGE_LAYERS: ReadonlySet<string> = new Set(['project', 'role', 'instance', 'shared'])

/** 单条执行器反思知识块（规整后）。 */
export interface WeaveKnowledgeBlock {
  type: KnowledgeType
  title: string
  content: string
  tags: string[]
  /** 未指定/非法时为 undefined（沉淀侧按 project 层缺省路由）。 */
  layer?: KnowledgeLayer
}

export interface ReflectionParseResult {
  blocks: WeaveKnowledgeBlock[]
  /** 畸形块数（JSON 非法/缺 END/字段缺失），用于通知与审计。 */
  invalid: number
}

const MARKER_RE = /^\s*#{0,6}\s*WEAVE_KNOWLEDGE_(START|END)\s*$/

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
  const type = typeof record.type === 'string' && KNOWLEDGE_TYPES.has(record.type)
    ? (record.type as KnowledgeType)
    : 'other'
  const tags = Array.isArray(record.tags)
    ? record.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim() !== '').map((tag) => tag.trim())
    : []
  const layer = typeof record.layer === 'string' && KNOWLEDGE_LAYERS.has(record.layer)
    ? (record.layer as KnowledgeLayer)
    : undefined
  return { type, title, content, tags, layer }
}

/**
 * 从执行器输出文本解析全部 WEAVE_KNOWLEDGE 块。
 * - 标记行兼容 0..6 个 `#` 前缀与 CRLF；
 * - 一段输出支持多个块；
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
