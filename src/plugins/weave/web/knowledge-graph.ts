import { KnowledgeStore, type KnowledgeLayer, type KnowledgeStatus } from '../knowledge-model.js'
import { WeaveError } from '../state/weave-error.js'

export interface KnowledgeGraphNode {
  id: string
  title: string
  status: string
  layer: string
  tags: string[]
  kind: 'knowledge' | 'missing'
  path?: string
}

export interface KnowledgeGraphEdge {
  source: string
  target: string
}

export interface KnowledgeGraphResult {
  nodes: KnowledgeGraphNode[]
  edges: KnowledgeGraphEdge[]
  counts: {
    knowledge: number
    missing: number
    edges: number
    unresolved: number
    skipped: number
  }
}

const STATUSES: ReadonlySet<string> = new Set(['candidate', 'active', 'deprecated', 'superseded'])
const LAYERS: ReadonlySet<string> = new Set(['project', 'role', 'instance', 'shared'])

function normalize(value: string): string {
  return value.trim().toLowerCase()
}

function pathTitle(path: string): string {
  const base = path.split('/').at(-1) ?? path
  return base.replace(/\.md$/i, '')
}

/**
 * 从真实 Markdown/frontmatter 构建轻量 [[双链]] 图谱。
 * 这是 P1 Graphify 的前置预览；不伪造 Cytoscape query/path/explain 能力。
 */
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

export async function buildKnowledgeGraph(
  store: KnowledgeStore,
  input: {
    status?: KnowledgeStatus
    layer?: KnowledgeLayer
    limit?: number
  } = {},
): Promise<KnowledgeGraphResult> {
  if (input.status !== undefined && !STATUSES.has(input.status)) {
    throw new WeaveError('invalid_argument', `不支持的知识状态: ${input.status}`, { status: input.status })
  }
  if (input.layer !== undefined && !LAYERS.has(input.layer)) {
    throw new WeaveError('invalid_argument', `不支持的知识层级: ${input.layer}`, { layer: input.layer })
  }
  if (input.limit !== undefined && (input.limit <= 0 || input.limit > 500)) {
    throw new WeaveError('invalid_argument', 'limit 必须在 1..500 之间', { limit: input.limit })
  }

  const metas = await store.listMeta({
    ...(input.status ? { status: input.status } : {}),
    ...(input.layer ? { layer: input.layer } : {}),
  })
  const selected = metas.slice(0, input.limit ?? 200)

  type LoadedEntry = {
    id: string
    title: string
    status: string
    layer: string
    tags: string[]
    path: string
    body: string
  }
  const entries: LoadedEntry[] = []
  let skipped = 0

  for (const meta of selected) {
    try {
      const file = store.getKnowledgeFile(meta.id)
      if (!file) throw new Error('missing')
      entries.push({
        id: meta.id,
        title: file.frontmatter.title,
        status: meta.status,
        layer: meta.layer,
        tags: [...file.frontmatter.tags],
        path: meta.path,
        body: file.body,
      })
    } catch {
      skipped += 1
    }
  }

  const nodes = new Map<string, KnowledgeGraphNode>()
  const ids = new Set(entries.map((entry) => entry.id))
  const titles = new Map<string, string>()
  const fileNames = new Map<string, string>()

  for (const entry of entries) {
    nodes.set(entry.id, {
      id: entry.id,
      title: entry.title,
      status: entry.status,
      layer: entry.layer,
      tags: [...entry.tags],
      kind: 'knowledge',
      path: entry.path,
    })
    titles.set(normalize(entry.title), entry.id)
    titles.set(normalize(pathTitle(entry.path)), entry.id)
    fileNames.set(normalize(pathTitle(entry.path)), entry.id)
  }

  const edges = new Map<string, KnowledgeGraphEdge>()
  let unresolvedCount = 0

  for (const entry of entries) {
    for (const rawTarget of extractWikiLinks(entry.body)) {
      if (!rawTarget) continue
      const normalized = normalize(rawTarget)
      const resolvedId = ids.has(rawTarget)
        ? rawTarget
        : titles.get(normalized)
      const targetId = resolvedId ?? `missing:${normalized}`
      if (!resolvedId) {
        unresolvedCount += 1
        if (!nodes.has(targetId)) {
          nodes.set(targetId, {
            id: targetId,
            title: rawTarget,
            status: 'missing',
            layer: 'shared',
            tags: [],
            kind: 'missing',
          })
        }
      }
      if (entry.id === targetId) continue
      const key = `${entry.id}->${targetId}`
      if (!edges.has(key)) edges.set(key, { source: entry.id, target: targetId })
    }
  }

  const nodeList = [...nodes.values()]
  return {
    nodes: nodeList,
    edges: [...edges.values()],
    counts: {
      knowledge: entries.length,
      missing: nodeList.filter((node) => node.kind === 'missing').length,
      edges: edges.size,
      unresolved: unresolvedCount,
      skipped,
    },
  }
}
