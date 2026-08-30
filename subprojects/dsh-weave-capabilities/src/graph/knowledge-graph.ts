import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'

import type { KnowledgeLayer, KnowledgeStatus, KnowledgeStore } from '../knowledge-model.js'
import { WeaveError } from '../weave-error.js'
import { buildKnowledgeGraph, type KnowledgeGraphResult, type KnowledgeGraphNode } from '../web/knowledge-graph.js'

const execFileAsync = promisify(execFile)

export interface KnowledgeGraphBuildResult {
  graphPath: string
  builtAt: string
  nodeCount: number
  edgeCount: number
}

export interface KnowledgeGraphQueryOptions {
  budget?: number
  dfs?: boolean
}

export interface KnowledgeGraphPathResult {
  source: string
  target: string
  path: string
  text: string
}

export interface KnowledgeGraphExplainResult {
  node: string
  explain: string
  text: string
}

export interface KnowledgeGraphServiceOptions {
  store: KnowledgeStore
  /** 自定义 graph.json 路径；默认 <knowledgeRoot>/.graphify/graph.json */
  graphPath?: string
  /** 自定义 Graphify CLI JS 路径；默认从 @sentropic/graphify 包解析 */
  cliPath?: string
}

/** 供 `knowledge/build` 的语义抽取与 `knowledge/graph` 映射共同使用的条目形状。 */
interface SemanticNode {
  id: string
  label: string
  file_type: 'document'
  source_file: string
  source_location: null
  source_url: null
  captured_at: null
  author: null
  contributor: null
  description: string
  status: string
  layer: string
  tags: string[]
  path: string
  knowledge_id: string
}

interface SemanticEdge {
  source: string
  target: string
  relation: 'references'
  confidence: 'EXTRACTED'
  confidence_score: 1
  source_file: string
  source_location: null
  weight: 1
}

interface SemanticExtraction {
  nodes: SemanticNode[]
  edges: SemanticEdge[]
  hyperedges: []
  input_tokens: number
  output_tokens: number
}

interface GraphifyGraphJson {
  nodes?: Array<Record<string, unknown>>
  links?: Array<{ source: string; target: string; relation?: string; confidence?: string }>
  hyperedges?: unknown[]
}

/**
 * 知识图谱 Graphify 后端（doc/09 §2.3 知识图谱端点）。
 *
 * 知识文件是 Markdown/frontmatter，Graphify 的 AST 通道无法直接抽取；
 * 这里先用 KnowledgeStore 生成确定性 semantic extraction（节点=知识卡片，
 * 边=[[双链]] 引用），再交给 `graphify extract --semantic` 构建 graph.json。
 * 这样：
 * - 不依赖 LLM/API key，构建可离线、可重复；
 * - 节点保留 status/layer/tags/path 等 Weave 生命周期字段，`knowledge/graph`
 *   可继续按 status/layer/project 过滤；
 * - `knowledge/build` 只影响图谱文件，不触碰 candidate→active 审核生命周期。
 */
export class KnowledgeGraphService {
  readonly store: KnowledgeStore
  readonly rootDir: string
  readonly graphPath: string
  readonly #cliPath: string

  constructor(options: KnowledgeGraphServiceOptions) {
    this.store = options.store
    this.rootDir = this.store.rootDir
    this.graphPath = options.graphPath ?? join(this.rootDir, '.graphify', 'graph.json')
    this.#cliPath = options.cliPath ?? resolveGraphifyCli()
  }

  hasGraph(): boolean {
    return existsSync(this.graphPath)
  }

  /** 构建/刷新知识图谱（Graphify extract + 自定义语义 JSON）。 */
  async build(): Promise<KnowledgeGraphBuildResult> {
    const semantic = await this.#buildSemantic()
    const semDir = mkdtempSync(join(tmpdir(), 'weave-kg-semantic-'))
    const semPath = join(semDir, 'semantic.json')
    writeFileSync(semPath, JSON.stringify(semantic), 'utf8')
    try {
      await execFileAsync(
        process.execPath,
        [
          this.#cliPath,
          'extract',
          this.rootDir,
          '--semantic',
          semPath,
          '--out',
          this.rootDir,
          '--no-description',
          '--no-label',
          '--scope',
          'all',
        ],
        {
          cwd: this.rootDir,
          maxBuffer: 32 * 1024 * 1024,
          windowsHide: true,
        },
      )
    } catch (error) {
      const detail = error as { message?: string; stderr?: string; code?: string | number }
      throw new WeaveError('graph_execution_failed', detail.message ?? 'Graphify CLI 执行失败', {
        command: 'graphify extract --semantic',
        ...(typeof detail.stderr === 'string' && detail.stderr !== '' ? { stderr: detail.stderr.slice(0, 2000) } : {}),
        ...(detail.code !== undefined ? { exitCode: String(detail.code) } : {}),
      })
    } finally {
      rmSync(semDir, { recursive: true, force: true })
    }
    const graph = this.#readGraph()
    const nodes = Array.isArray(graph.nodes) ? graph.nodes : []
    const links = Array.isArray(graph.links) ? graph.links : []
    return {
      graphPath: this.graphPath,
      builtAt: new Date().toISOString(),
      nodeCount: nodes.length,
      edgeCount: links.length,
    }
  }

  /**
   * knowledge/graph：优先使用 Graphify graph.json；未构建时回退轻量 `[[双链]]`
   * 预览（K1：空/未构建返回可渲染空图与构建提示）。
   */
  async graph(input: {
    status?: KnowledgeStatus
    layer?: KnowledgeLayer
    project?: string
    limit?: number
    includeLinkedLayers?: boolean
  } = {}): Promise<KnowledgeGraphResult> {
    if (!this.hasGraph()) {
      return buildKnowledgeGraph(this.store, input)
    }
    const graph = this.#readGraph()
    const nodes = Array.isArray(graph.nodes) ? graph.nodes : []
    const links = Array.isArray(graph.links) ? graph.links : []

    const allMetas = await this.store.listMeta({})
    const projects = [
      ...new Set(
        allMetas
          .map((meta) => projectOf(meta.path))
          .filter((item): item is string => item !== null),
      ),
    ].sort()

    const matchesProject = (nodePath: unknown): boolean =>
      input.project === undefined || projectOf(String(nodePath ?? '')) === input.project

    const statusMatched = nodes.filter((node) => {
      const status = String(node['status'] ?? node['kind'] ?? '')
      // 缺失节点不受 status/layer 过滤：只要被保留的知识节点引用，仍然作为 missing 展示。
      if (status === 'missing' || String(node['kind'] ?? '') === 'missing' || String(node['id'] ?? '').startsWith('missing:')) {
        return true
      }
      if (input.status !== undefined && status !== input.status) return false
      const layer = String(node['layer'] ?? '')
      if (input.layer !== undefined && layer !== input.layer) return false
      if (!matchesProject(node['path'])) return false
      return true
    })
    const limited = input.limit !== undefined ? statusMatched.slice(0, input.limit) : statusMatched
    const limitedKnowledgeIds = new Set(
      limited
        .filter((node) => {
          const id = String(node['id'] ?? '')
          return !(node['status'] === 'missing' || node['kind'] === 'missing' || id.startsWith('missing:'))
        })
        .map((node) => String(node['id'])),
    )
    const allIds = new Set(nodes.map((node) => String(node['id'] ?? '')))
    // 补充被保留知识节点引用且当前不在 limited 中的 missing 节点（路径/状态不参与过滤）。
    const missingIds = new Set<string>()
    for (const node of limited) {
      const id = String(node['id'] ?? '')
      if (limitedKnowledgeIds.has(id)) {
        for (const link of links) {
          const source = String(link.source ?? '')
          const target = String(link.target ?? '')
          const other = source === id ? target : source
          if (other !== id && allIds.has(other)) {
            const otherNode = nodes.find((item) => String(item['id']) === other)
            if (otherNode && (otherNode['status'] === 'missing' || otherNode['kind'] === 'missing' || other.startsWith('missing:'))) {
              missingIds.add(other)
            }
          }
        }
      }
    }
    const limitedMissingNodes = nodes.filter((node) => missingIds.has(String(node['id'] ?? '')))
    const kept = new Set([...limitedKnowledgeIds, ...missingIds])

    const mappedNodes: KnowledgeGraphNode[] = []
    for (const node of [...limited.filter((node) => !String(node['id'] ?? '').startsWith('missing:')), ...limitedMissingNodes]) {
      const id = String(node['id'] ?? '')
      const isMissing = node['status'] === 'missing' || node['kind'] === 'missing' || id.startsWith('missing:')
      mappedNodes.push({
        id,
        title: String(node['label'] ?? id),
        status: String(node['status'] ?? (isMissing ? 'missing' : 'active')),
        layer: String(node['layer'] ?? (isMissing ? 'shared' : 'unknown')),
        tags: Array.isArray(node['tags']) ? (node['tags'] as string[]) : [],
        kind: isMissing ? 'missing' : 'knowledge',
        ...(typeof node['path'] === 'string' && node['path'] !== '' && !isMissing ? { path: node['path'] } : {}),
        ...(isMissing ? {} : { linked: false }),
      })
    }

    const edgeKeySet = new Set<string>()
    const edges: Array<{ source: string; target: string }> = []
    for (const link of links) {
      const source = String(link.source ?? '')
      const target = String(link.target ?? '')
      if (!kept.has(source) || !kept.has(target)) continue
      if (source === target) continue
      const key = `${source}->${target}`
      if (edgeKeySet.has(key)) continue
      edgeKeySet.add(key)
      edges.push({ source, target })
    }

    return {
      nodes: mappedNodes,
      edges,
      projects,
      counts: {
        knowledge: mappedNodes.filter((node) => node.kind === 'knowledge').length,
        missing: mappedNodes.filter((node) => node.kind === 'missing').length,
        edges: edges.length,
        unresolved: 0,
        skipped: 0,
      },
    }
  }

  /** 知识语义查询：Graphify 图 JSON BFS + 中文友好的本地命中。 */
  async query(question: string, options: KnowledgeGraphQueryOptions = {}): Promise<string> {
    this.#requireBuilt()
    const q = question.trim()
    if (q === '') {
      throw new WeaveError('invalid_argument', 'question 不能为空')
    }
    const graph = this.#readGraph()
    const nodes = Array.isArray(graph.nodes) ? graph.nodes : []
    const links = Array.isArray(graph.links) ? graph.links : []

    const scored: Array<{ id: string; score: number }> = []
    for (const node of nodes) {
      const id = String(node['id'] ?? '')
      if (id.startsWith('missing:')) continue
      const title = String(node['label'] ?? '')
      const path = String(node['path'] ?? '')
      const tags = Array.isArray(node['tags']) ? (node['tags'] as string[]).join(' ') : ''
      const desc = String(node['description'] ?? '')
      const file = this.store.getKnowledgeFile(id)
      const body = file ? file.body : ''

      let score = 0
      if (title.toLowerCase().includes(q.toLowerCase())) score += 5
      if (desc.toLowerCase().includes(q.toLowerCase())) score += 3
      if (tags.toLowerCase().includes(q.toLowerCase())) score += 3
      if (path.toLowerCase().includes(q.toLowerCase())) score += 2
      if (body.toLowerCase().includes(q.toLowerCase())) score += 1
      if (score > 0) scored.push({ id, score })
    }
    if (scored.length === 0) return ''
    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    const startNodes = scored.slice(0, 5).map((item) => item.id)
    const visited = new Set(startNodes)
    const edgeLines: Array<{ u: string; v: string }> = []
    const depth = options.dfs === true ? 3 : 2
    let frontier = new Set(startNodes)
    for (let level = 0; level < depth; level += 1) {
      const next = new Set<string>()
      for (const u of frontier) {
        for (const link of links) {
          let v = ''
          if (link.source === u) v = String(link.target ?? '')
          else if (link.target === u) v = String(link.source ?? '')
          if (v === '' || visited.has(v)) continue
          next.add(v)
          edgeLines.push({ u, v })
        }
      }
      for (const v of next) visited.add(v)
      frontier = next
      if (frontier.size === 0) break
    }
    const labelOf = (id: string): string => {
      const node = nodes.find((item) => String(item['id']) === id)
      return String(node?.['label'] ?? id)
    }
    const lines: string[] = []
    for (const id of [...visited]) {
      const node = nodes.find((item) => String(item['id']) === id)
      lines.push(
        `NODE ${labelOf(id)} [path=${String(node?.['path'] ?? '')} status=${String(node?.['status'] ?? '')} layer=${String(node?.['layer'] ?? '')}]`,
      )
    }
    for (const edge of edgeLines) {
      lines.push(`EDGE ${labelOf(edge.u)} --references--> ${labelOf(edge.v)}`)
    }
    return lines.join('\n')
  }

  /** 两个知识节点之间的最短路径（基于 Graphify graph.json 的权值为 1 的 BFS）。 */
  async path(source: string, target: string): Promise<string> {
    this.#requireBuilt()
    const graph = this.#readGraph()
    const nodes = Array.isArray(graph.nodes) ? graph.nodes : []
    const links = Array.isArray(graph.links) ? graph.links : []
    const sourceId = this.#resolveNode(nodes, source)
    const targetId = this.#resolveNode(nodes, target)
    if (!sourceId) {
      throw new WeaveError('invalid_argument', `未找到知识节点: ${source}`, { node: source })
    }
    if (!targetId) {
      throw new WeaveError('invalid_argument', `未找到知识节点: ${target}`, { node: target })
    }
    if (sourceId === targetId) {
      return `最短路径:\n  ${labelOf(nodes, sourceId)}`
    }
    const adjacency = buildAdjacency(nodes, links)
    const queue: string[] = [sourceId]
    const prev = new Map<string, string | null>([[sourceId, null]])
    while (queue.length > 0) {
      const current = queue.shift()!
      for (const next of adjacency.get(current) ?? []) {
        if (!prev.has(next)) {
          prev.set(next, current)
          queue.push(next)
        }
      }
    }
    if (!prev.has(targetId)) {
      throw new WeaveError('invalid_argument', `知识节点之间不存在路径: ${source} → ${target}`, {
        source,
        target,
      })
    }
    const chain: string[] = []
    let cursor: string | null = targetId
    while (cursor) {
      chain.push(cursor)
      cursor = prev.get(cursor) ?? null
    }
    chain.reverse()
    const lines = chain.map((id, index) => {
      const prefix = index === 0 ? '最短路径:' : '  ->'
      return `${prefix} ${labelOf(nodes, id)}`
    })
    return lines.join('\n')
  }

  /** 知识节点解释：节点详情 + 邻居。 */
  async explain(node: string): Promise<string> {
    this.#requireBuilt()
    const graph = this.#readGraph()
    const nodes = Array.isArray(graph.nodes) ? graph.nodes : []
    const links = Array.isArray(graph.links) ? graph.links : []
    const nodeId = this.#resolveNode(nodes, node)
    if (!nodeId) {
      throw new WeaveError('invalid_argument', `未找到知识节点: ${node}`, { node })
    }
    const current = nodes.find((item) => String(item['id']) === nodeId)
    const lines = [
      `Node: ${String(current?.['label'] ?? nodeId)}`,
      `  ID: ${nodeId}`,
      `  Source: ${String(current?.['path'] ?? '')}`,
      `  Type: ${String(current?.['file_type'] ?? 'document')}`,
      `  Status: ${String(current?.['status'] ?? '')}`,
      `  Layer: ${String(current?.['layer'] ?? '')}`,
      `  Tags: ${Array.isArray(current?.['tags']) ? (current?.['tags'] as string[]).join(', ') : ''}`,
    ]
    const neighbors: Array<{ id: string; relation?: string }> = []
    for (const link of links) {
      if (link.source === nodeId) neighbors.push({ id: String(link.target ?? ''), relation: link.relation })
      else if (link.target === nodeId) neighbors.push({ id: String(link.source ?? ''), relation: link.relation })
    }
    if (neighbors.length > 0) {
      lines.push('', 'Connections:')
      for (const neighbor of neighbors) {
        lines.push(`  --> ${labelOf(nodes, neighbor.id)} [${neighbor.relation ?? 'references'}]`)
      }
    }
    return lines.join('\n')
  }

  #requireBuilt(): void {
    if (!this.hasGraph()) {
      throw new WeaveError('configuration_error', `知识图谱尚未构建，请先执行 knowledge/build: ${this.graphPath}`, {
        graphPath: this.graphPath,
      })
    }
  }

  #readGraph(): GraphifyGraphJson {
    try {
      return JSON.parse(readFileSync(this.graphPath, 'utf8')) as GraphifyGraphJson
    } catch (error) {
      throw new WeaveError('internal', `知识图谱解析失败: ${this.graphPath}`, {
        graphPath: this.graphPath,
        cause: error instanceof Error ? error.message : String(error),
      })
    }
  }

  #resolveNode(nodes: Array<Record<string, unknown>>, query: string): string | null {
    const term = query.trim().toLowerCase()
    if (term === '') return null
    for (const node of nodes) {
      const id = String(node['id'] ?? '')
      const knowledgeId = String(node['knowledge_id'] ?? '')
      if (id.toLowerCase() === term || knowledgeId.toLowerCase() === term) return id
    }
    for (const node of nodes) {
      const title = String(node['label'] ?? '').toLowerCase()
      const path = String(node['path'] ?? '').toLowerCase()
      if (title === term || path === term) return String(node['id'] ?? '')
    }
    // 支持标题/路径模糊唯一命中
    const fuzzy = nodes.filter((node) => {
      const title = String(node['label'] ?? '').toLowerCase()
      const path = String(node['path'] ?? '').toLowerCase()
      return title.includes(term) || path.includes(term)
    })
    if (fuzzy.length === 1) return String(fuzzy[0]!['id'] ?? '')
    return null
  }

  async #buildSemantic(): Promise<SemanticExtraction> {
    const metas = await this.store.listMeta({})
    const nodes: SemanticNode[] = []
    const edges: SemanticEdge[] = []
    const ids = new Set<string>()
    const byTitle = new Map<string, string>()
    const byPathStem = new Map<string, string>()

    for (const meta of metas) {
      ids.add(meta.id)
      const file = this.store.getKnowledgeFile(meta.id)
      if (!file) continue
      nodes.push({
        id: meta.id,
        label: file.frontmatter.title,
        file_type: 'document',
        source_file: meta.path,
        source_location: null,
        source_url: null,
        captured_at: null,
        author: null,
        contributor: null,
        description: firstParagraph(file.body),
        status: meta.status,
        layer: meta.layer,
        tags: [...file.frontmatter.tags],
        path: meta.path,
        knowledge_id: meta.id,
      })
      byTitle.set(normalize(file.frontmatter.title), meta.id)
      byPathStem.set(normalize(pathStem(meta.path)), meta.id)
    }

    for (const meta of metas) {
      const file = this.store.getKnowledgeFile(meta.id)
      if (!file) continue
      for (const rawTarget of extractWikiLinks(file.body)) {
        const normalized = normalize(rawTarget)
        const resolved = ids.has(rawTarget) ? rawTarget : byTitle.get(normalized) ?? byPathStem.get(normalized)
        const targetId = resolved ?? `missing:${normalized}`
        if (meta.id === targetId) continue
        if (!resolved) {
          if (!ids.has(targetId)) {
            ids.add(targetId)
            nodes.push({
              id: targetId,
              label: rawTarget,
              file_type: 'document',
              source_file: '',
              source_location: null,
              source_url: null,
              captured_at: null,
              author: null,
              contributor: null,
              description: '',
              status: 'missing',
              layer: 'shared',
              tags: [],
              path: '',
              knowledge_id: targetId,
            })
          }
        }
        edges.push({
          source: meta.id,
          target: targetId,
          relation: 'references',
          confidence: 'EXTRACTED',
          confidence_score: 1,
          source_file: meta.path,
          source_location: null,
          weight: 1,
        })
      }
    }

    return {
      nodes,
      edges,
      hyperedges: [],
      input_tokens: 0,
      output_tokens: 0,
    }
  }
}

function resolveGraphifyCli(): string {
  const require = createRequire(import.meta.url)
  const entryPath = require.resolve('@sentropic/graphify')
  return join(dirname(entryPath), 'cli.js')
}

function normalize(value: string): string {
  return value.trim().toLowerCase()
}

function pathStem(path: string): string {
  const base = path.split('/').at(-1) ?? path
  return base.replace(/\.md$/i, '')
}

function projectOf(path: string): string | null {
  const segments = path.split('/')
  const projectId = segments.length >= 4 && segments[0] === '_agent' && segments[1] === 'projects' ? segments[2] : undefined
  return projectId ? projectId : null
}

function firstParagraph(body: string): string {
  const paragraph = body.split(/\n\s*\n/)[0]?.trim() ?? ''
  return paragraph.slice(0, 500)
}

function extractWikiLinks(body: string): string[] {
  const links: string[] = []
  let cursor = 0
  while (cursor < body.length) {
    const start = body.indexOf('[', cursor)
    const close = body.indexOf(']', cursor)
    const open = start >= 0 && (close < 0 || start < close) ? start : close
    if (open < 0 || body.slice(open, open + 2) !== '[[') break
    const end = body.indexOf(']]', open + 2)
    if (end < 0) break
    const raw = body.slice(open + 2, end).split('|')[0]?.trim() ?? ''
    if (raw !== '') links.push(raw)
    cursor = end + 2
  }
  return links
}

function labelOf(nodes: Array<Record<string, unknown>>, id: string): string {
  const node = nodes.find((item) => String(item['id']) === id)
  return String(node?.['label'] ?? id)
}

function buildAdjacency(
  nodes: Array<Record<string, unknown>>,
  links: Array<{ source: string; target: string }>,
): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>()
  for (const node of nodes) {
    adjacency.set(String(node['id'] ?? ''), new Set())
  }
  for (const link of links) {
    const source = String(link.source ?? '')
    const target = String(link.target ?? '')
    if (!adjacency.has(source)) adjacency.set(source, new Set())
    if (!adjacency.has(target)) adjacency.set(target, new Set())
    adjacency.get(source)!.add(target)
    adjacency.get(target)!.add(source)
  }
  return adjacency
}

