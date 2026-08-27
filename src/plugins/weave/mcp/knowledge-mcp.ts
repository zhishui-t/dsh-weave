#!/usr/bin/env node
/**
 * dsh-mcp-knowledge —— Weave 知识库 MCP Server（stdio）。
 * 外部 ACP 可通过 provider 配置的 mcp_servers 引用本服务，调用 knowledge_search。
 */
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { openPersistence } from '../persistence/persistence.js'
import { KnowledgeStore, type KnowledgeLayer, type KnowledgeMeta, type KnowledgeFile, type Visibility } from '../knowledge-model.js'

interface ToolResult {
  ok: boolean
  query: string
  total_hits: number
  results: Array<{
    id: string
    title: string
    path: string
    layer: string
    status: string
    visibility: string
    freshness_score: number
    content: string
  }>
  error?: string
}

function normalizeQuery(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

function scopeMatch(meta: KnowledgeMeta, input: Record<string, unknown>): boolean {
  const path = meta.path.toLowerCase()
  if (input.project_id !== undefined && !path.includes(String(input.project_id).toLowerCase())) return false
  if (input.version !== undefined && !path.includes(String(input.version).toLowerCase())) return false
  if (input.role_id !== undefined && !path.includes(String(input.role_id).toLowerCase())) return false
  if (input.instance_id !== undefined && !path.includes(String(input.instance_id).toLowerCase())) return false
  return true
}

async function searchKnowledge(store: KnowledgeStore, input: Record<string, unknown>): Promise<ToolResult> {
  const query = normalizeQuery(input.query)
  if (query === '') return { ok: false, query, total_hits: 0, results: [], error: 'query 不能为空' }
  const limit = Math.max(1, Math.min(20, Number(input.limit ?? 5) || 5))
  const layer = input.layer !== undefined && input.layer !== '' ? String(input.layer) as KnowledgeLayer : undefined
  const visibility = input.visibility !== undefined && input.visibility !== '' ? String(input.visibility) as Visibility : undefined

  const metas = await store.listMeta({ status: 'active', ...(layer ? { layer } : {}) })
  const scored: Array<{ meta: KnowledgeMeta; score: number; file: KnowledgeFile }> = []
  let totalChars = 0

  for (const meta of metas) {
    const file = store.getKnowledgeFile(meta.id)
    if (!file) continue
    if (visibility !== undefined && file.frontmatter.visibility !== visibility) continue
    if (!scopeMatch(meta, input)) continue
    const title = file.frontmatter.title.toLowerCase()
    const body = file.body.toLowerCase()
    let score = 0
    if (title.includes(query)) score += 5
    if (body.includes(query)) score += 1
    if (meta.path.toLowerCase().includes(query)) score += 2
    if (score === 0) continue
    scored.push({ meta, score, file })
  }

  scored.sort((a, b) => b.score - a.score || b.meta.freshness_score - a.meta.freshness_score)
  const results: ToolResult['results'] = []
  for (const item of scored.slice(0, limit)) {
    const content = item.file.body
    const clamped = totalChars + content.length > 2500 ? content.slice(0, Math.max(0, 2500 - totalChars)) : content
    totalChars += clamped.length
    results.push({
      id: item.meta.id,
      title: item.file.frontmatter.title,
      path: item.meta.path,
      layer: item.meta.layer,
      status: item.meta.status,
      visibility: item.file.frontmatter.visibility,
      freshness_score: item.meta.freshness_score,
      content: clamped,
    })
    if (totalChars >= 2500) break
  }
  return { ok: true, query: String(input.query ?? ''), total_hits: scored.length, results }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
const persistence = openPersistence()
const store = new KnowledgeStore({ rootDir: join(homedir(), '.dsh', 'knowledge'), metaDb: persistence.knowledgeMeta })

rl.on('line', (line) => {
  let req: { id?: unknown; method?: string; params?: Record<string, unknown> }
  try {
    req = JSON.parse(line)
  } catch {
    return
  }
  if (!req || typeof req !== 'object' || typeof req.method !== 'string') return

  const respond = (result: unknown): void => {
    if (req.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n')
  }
  const respondError = (code: number, message: string): void => {
    if (req.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code, message } }) + '\n')
  }

  void (async () => {
    try {
      if (req.method === 'initialize') {
        respond({
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'dsh-mcp-knowledge', version: '0.1.0' },
        })
        return
      }
      if (req.method === 'ping') {
        respond({})
        return
      }
      if (req.method === 'notifications/initialized' || req.method === 'notifications/cancelled') {
        respond(undefined)
        return
      }
      if (req.method === 'tools/list') {
        respond({
          tools: [
            {
              name: 'knowledge_search',
              description: 'Search active Weave knowledge by query/project/role/version/visibility.',
              inputSchema: {
                type: 'object',
                properties: {
                  query: { type: 'string' },
                  project_id: { type: 'string' },
                  version: { type: 'string' },
                  role_id: { type: 'string' },
                  instance_id: { type: 'string' },
                  layer: { type: 'string' },
                  visibility: { type: 'string' },
                  limit: { type: 'number' },
                },
                required: ['query'],
              },
            },
          ],
        })
        return
      }
      if (req.method === 'tools/call') {
        const input = (req.params?.arguments ?? {}) as Record<string, unknown>
        const result = await searchKnowledge(store, input)
        respond({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: result.ok ? false : true })
        return
      }
      respondError(-32601, `Method not found: ${String(req.method)}`)
    } catch (error) {
      respondError(-32603, error instanceof Error ? error.message : String(error))
    }
  })()
})
