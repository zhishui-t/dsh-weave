import { KnowledgeStore, type KnowledgeLayer, type KnowledgeStatus } from '../knowledge/knowledge-model.js'
import { WeaveError } from '../state/weave-error.js'

export interface KnowledgeGraphNode {
  id: string
  title: string
  status: string
  layer: string
  tags: string[]
  kind: 'knowledge' | 'missing'
  path?: string
  /** 跨层关联节点：当前筛选层外、但因 [[双链]] 被引用的真实知识条目。 */
  linked?: boolean
}

export interface KnowledgeGraphEdge {
  source: string
  target: string
}

export interface KnowledgeGraphResult {
  nodes: KnowledgeGraphNode[]
  edges: KnowledgeGraphEdge[]
  /** 知识库实际出现的项目 id（listMeta 全量去重排序；供控制台「按项目看图」下拉，与 project 过滤无关）。 */
  projects: string[]
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

/** 解析条目所属项目 id（path 前缀 _agent/projects/{projectId}/…）；非项目区返回 null。 */
function projectOf(path: string): string | null {
  const segments = path.split('/')
  const projectId = segments.length >= 4 && segments[0] === '_agent' && segments[1] === 'projects' ? segments[2] : undefined
  return projectId ? projectId : null
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
    includeLinkedLayers?: boolean
    /** 按项目过滤：只保留 path 前缀为 _agent/projects/{project}/ 的条目（includeLinkedLayers 时跨层引用边保留）。 */
    project?: string
  } = {},
): Promise<KnowledgeGraphResult> {
  if (input.status !== undefined && !STATUSES.has(input.status)) {
    throw new WeaveError('invalid_argument', `不支持的知识状态: ${input.status}`, { status: input.status })
  }
  if (input.layer !== undefined && !LAYERS.has(input.layer)) {
    throw new WeaveError('invalid_argument', `不支持的知识层级: ${input.layer}`, { layer: input.layer })
  }
  if (input.project !== undefined && input.project.trim() === '') {
    throw new WeaveError('invalid_argument', 'project 不能为空白字符串', { project: input.project })
  }
  if (input.limit !== undefined && (input.limit <= 0 || input.limit > 500)) {
    throw new WeaveError('invalid_argument', 'limit 必须在 1..500 之间', { limit: input.limit })
  }

  const metas = await store.listMeta({
    ...(input.status ? { status: input.status } : {}),
    ...(input.layer ? { layer: input.layer } : {}),
  })
  // 全量元数据一次查询两用：projects 下拉去重来源 + includeLinkedLayers 跨层解析。
  const allMetas = await store.listMeta({})

  const matchesProject = (path: string): boolean =>
    input.project === undefined || projectOf(path) === input.project
  // project 过滤先于 limit：limit 语义是「该筛选下最多 N 条」，不是「前 N 条里再筛」。
  const selected = metas.filter((meta) => matchesProject(meta.path)).slice(0, input.limit ?? 200)

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

  const allEntries: LoadedEntry[] = []
  if (input.includeLinkedLayers === true) {
    // 跨层解析不做 project 过滤：项目内条目引用其他项目/层的 [[双链]] 仍解析为 linked 节点。
    for (const meta of allMetas) {
      try {
        const file = store.getKnowledgeFile(meta.id)
        if (!file) continue
        allEntries.push({
          id: meta.id,
          title: file.frontmatter.title,
          status: meta.status,
          layer: meta.layer,
          tags: [...file.frontmatter.tags],
          path: meta.path,
          body: file.body,
        })
      } catch {
        // 跨层解析时单个损坏文件跳过，不阻断。
      }
    }
  }
  const resolutionEntries = input.includeLinkedLayers === true ? allEntries : entries

  const nodes = new Map<string, KnowledgeGraphNode>()
  const ids = new Set(resolutionEntries.map((entry) => entry.id))
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
  }
  for (const entry of resolutionEntries) {
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
      } else if (!nodes.has(targetId) && input.includeLinkedLayers === true) {
        const linked = allEntries.find((item) => item.id === targetId)
        if (linked) {
          nodes.set(targetId, {
            id: linked.id,
            title: linked.title,
            status: linked.status,
            layer: linked.layer,
            tags: [...linked.tags],
            kind: 'knowledge',
            path: linked.path,
            linked: true,
          })
        }
      }
      if (entry.id === targetId) continue
      const key = `${entry.id}->${targetId}`
      if (!edges.has(key)) edges.set(key, { source: entry.id, target: targetId })
    }
  }

  const nodeList = [...nodes.values()]
  const projects = [
    ...new Set(
      allMetas
        .map((meta) => projectOf(meta.path))
        .filter((item): item is string => item !== null),
    ),
  ].sort()
  return {
    nodes: nodeList,
    edges: [...edges.values()],
    projects,
    counts: {
      knowledge: entries.length,
      missing: nodeList.filter((node) => node.kind === 'missing').length,
      edges: edges.size,
      unresolved: unresolvedCount,
      skipped,
    },
  }
}
