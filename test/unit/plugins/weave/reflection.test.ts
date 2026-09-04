import { describe, expect, it } from 'vitest'
import { extractKnowledgeBlocks } from '../../../../src/plugins/weave/knowledge/reflection'

describe('extractKnowledgeBlocks（doc/05 §3.1 反思解析协议）', () => {
  it('解析 prompt 模板形态的单块（### 前缀 + JSON）', () => {
    const text = [
      '任务完成，结论如下……',
      '',
      '## 知识沉淀要求',
      '### WEAVE_KNOWLEDGE_START',
      '{"type": "pitfall", "title": "SQLite WAL 锁库", "content": "写并发必须开 WAL，否则写写互斥。", "tags": ["sqlite", "db"]}',
      '### WEAVE_KNOWLEDGE_END',
      '',
    ].join('\n')
    const { blocks, invalid } = extractKnowledgeBlocks(text)
    expect(invalid).toBe(0)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!).toEqual({
      type: 'pitfall',
      title: 'SQLite WAL 锁库',
      content: '写并发必须开 WAL，否则写写互斥。',
      tags: ['sqlite', 'db'],
      layer: undefined,
    })
  })

  it('一段输出支持多个块', () => {
    const text = [
      '### WEAVE_KNOWLEDGE_START',
      '{"type": "skill", "title": "vitest 单测过滤", "content": "pnpm vitest run path/to/x.test.ts", "tags": ["test"], "layer": "role"}',
      '### WEAVE_KNOWLEDGE_END',
      '中间正文继续',
      '### WEAVE_KNOWLEDGE_START',
      '{"type": "pattern", "title": "上游产物注入", "content": "upstreamOutputs 按 label 分节拼接。"}',
      '### WEAVE_KNOWLEDGE_END',
    ].join('\n')
    const { blocks, invalid } = extractKnowledgeBlocks(text)
    expect(invalid).toBe(0)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.type).toBe('skill')
    expect(blocks[0]?.layer).toBe('role')
    expect(blocks[1]?.type).toBe('pattern')
    expect(blocks[1]?.layer).toBeUndefined()
  })

  it('JSON 非法 → invalid 计数并跳过，不影响后续合法块', () => {
    const text = [
      '### WEAVE_KNOWLEDGE_START',
      '{"type": "pitfall", "title": "缺引号, }',
      '### WEAVE_KNOWLEDGE_END',
      '### WEAVE_KNOWLEDGE_START',
      '{"type": "doc", "title": "ok", "content": "fine"}',
      '### WEAVE_KNOWLEDGE_END',
    ].join('\n')
    const { blocks, invalid } = extractKnowledgeBlocks(text)
    expect(invalid).toBe(1)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.title).toBe('ok')
  })

  it('START 无 END → invalid+1；空文本/无标记 → 空 result', () => {
    expect(extractKnowledgeBlocks('### WEAVE_KNOWLEDGE_START\n{"title":"t","content":"c"}')).toEqual({ blocks: [], invalid: 1 })
    expect(extractKnowledgeBlocks('')).toEqual({ blocks: [], invalid: 0 })
    expect(extractKnowledgeBlocks('普通输出，无任何标记')).toEqual({ blocks: [], invalid: 0 })
  })

  it('非对象 JSON（数组/字符串/数字）与缺 title/content → invalid', () => {
    const wrap = (inner: string) => `### WEAVE_KNOWLEDGE_START\n${inner}\n### WEAVE_KNOWLEDGE_END`
    expect(extractKnowledgeBlocks(wrap('["a","b"]')).invalid).toBe(1)
    expect(extractKnowledgeBlocks(wrap('"just a string"')).invalid).toBe(1)
    expect(extractKnowledgeBlocks(wrap('{"title":"t"}')).invalid).toBe(1)
    expect(extractKnowledgeBlocks(wrap('{"content":"c"}')).invalid).toBe(1)
    expect(extractKnowledgeBlocks(wrap('{"title":"  ","content":"c"}')).invalid).toBe(1)
  })

  it('字段规整：未知 type → other；非法 tags → []；非法 layer → undefined', () => {
    const text = [
      '### WEAVE_KNOWLEDGE_START',
      '{"type": "unknown-kind", "title": "t", "content": "c", "tags": "not-array", "layer": "galaxy"}',
      '### WEAVE_KNOWLEDGE_END',
    ].join('\n')
    const { blocks } = extractKnowledgeBlocks(text)
    expect(blocks[0]!.type).toBe('other')
    expect(blocks[0]!.tags).toEqual([])
    expect(blocks[0]!.layer).toBeUndefined()
  })

  it('CRLF 与无 # 前缀标记均兼容', () => {
    const text = ['WEAVE_KNOWLEDGE_START', '{"type":"guide","title":"g","content":"c","tags":[]}', 'WEAVE_KNOWLEDGE_END'].join('\r\n')
    const { blocks, invalid } = extractKnowledgeBlocks(text)
    expect(invalid).toBe(0)
    expect(blocks[0]!.type).toBe('guide')
  })

  it('tags 中非字符串项被过滤、字符串项 trim', () => {
    const text = [
      '### WEAVE_KNOWLEDGE_START',
      '{"title":"t","content":"c","tags":[" a ", 1, null, "b", ""]}',
      '### WEAVE_KNOWLEDGE_END',
    ].join('\n')
    const { blocks } = extractKnowledgeBlocks(text)
    expect(blocks[0]!.tags).toEqual(['a', 'b'])
  })
})
