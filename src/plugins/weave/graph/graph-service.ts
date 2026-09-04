import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { WeaveError } from '../state/weave-error.js'

const execFileAsync = promisify(execFile)

export interface GraphFlowStep {
  nodeId: string
  name: string
  kind: string
  file: string
  lineStart: number
  lineEnd: number
  qualifiedName: string
}

export interface GraphFlow {
  id: string
  name: string
  entryPoint: string
  entryPointId: string
  path: string[]
  qualifiedPath: string[]
  depth: number
  nodeCount: number
  fileCount: number
  files: string[]
  criticality: number
  warnings: string[]
  steps?: GraphFlowStep[]
}

export interface AffectedFlowsResult {
  changedFiles: string[]
  matchedNodeIds: string[]
  unmatchedFiles: string[]
  affectedFlows: GraphFlow[]
}

export interface GraphServiceOptions {
  /** 项目根目录；默认 process.cwd() */
  projectRoot?: string
  /** 源码目录；默认自动探测 src/render/lib/app 等，未命中则 '.' */
  sourceDir?: string
  /** 自定义 graph.json 路径；默认 <projectRoot>/.graphify/graph.json */
  graphPath?: string
  /** 自定义 flows.json 路径；默认 <projectRoot>/.graphify/flows.json */
  flowsPath?: string
  /** 自定义 Graphify CLI JS 路径；默认从 @sentropic/graphify 包解析 */
  cliPath?: string
}

export interface GraphQueryOptions {
  budget?: number
  dfs?: boolean
}

/** code/graph 返回的轻量图谱摘要。 */
export interface GraphSummary {
  graphPath: string
  flowsPath: string
  nodeCount: number
  edgeCount: number
  communityCount: number
  builtFromCommit?: string
  hasFlows: boolean
}

const SOURCE_DIR_CANDIDATES = ['src', 'render', 'lib', 'app', 'packages', '.']

/** 自动选择项目源码目录：常见目录存在时优先，否则退回项目根。 */
export function autoSourceDir(projectRoot: string): string {
  for (const candidate of SOURCE_DIR_CANDIDATES) {
    if (candidate === '.') return '.'
    const path = join(projectRoot, candidate)
    if (existsSync(path)) return candidate
  }
  return '.'
}


export interface GraphProjectSummary {
  root: string
  sourceDir: string
  hasGraph: boolean
  hasFlows: boolean
  current: boolean
}

export interface DirectoryListing {
  path: string
  parent?: string
  dirs: string[]
}

/** 扫描候选 Web 代码图项目：先当前 cwd，再扫描其父目录下常见项目。 */
export function listGraphProjects(cwd = process.cwd()): GraphProjectSummary[] {
  const roots = new Set<string>([resolve(cwd)])
  const parent = dirname(cwd)
  try {
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const root = resolve(parent, entry.name)
      if (existsSync(join(root, 'package.json')) || existsSync(join(root, 'src')) || existsSync(join(root, '.git'))) {
        roots.add(root)
      }
    }
  } catch {
    // parent 不可扫描时忽略
  }
  return [...roots].slice(0, 30).map((root) => {
    const sourceDir = autoSourceDir(root)
    const service = new GraphService({ projectRoot: root, sourceDir })
    return {
      root,
      sourceDir,
      hasGraph: service.hasGraph(),
      hasFlows: service.hasFlows(),
      current: root === resolve(cwd),
    }
  })
}

/** 目录选择：返回给定路径下的子目录。 */
export function listDirectories(inputPath?: string, cwd = process.cwd()): DirectoryListing {
  const base = inputPath?.trim() || resolve(cwd)
  const path = resolve(base)
  let dirs: string[] = []
  try {
    dirs = readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => resolve(path, entry.name))
      .sort()
  } catch {
    return { path, dirs: [] }
  }
  const parent = dirname(path) === path ? undefined : dirname(path)
  return { path, ...(parent ? { parent } : {}), dirs }
}

/**
 * Graphify 独立代码图谱服务。
 *
 * 封装 Graphify CLI 的:
 * - build (extract + flows build)
 * - query / path / explain
 * - affected-flows / flows list / flows get
 *
 * 项目图谱数据位于 <projectRoot>/.graphify/，与 Weave 团队子系统解耦。
 */
export class GraphService {
  readonly projectRoot: string
  readonly sourceDir: string
  readonly graphPath: string
  readonly flowsPath: string

  constructor(options: GraphServiceOptions = {}) {
    this.projectRoot = resolve(options.projectRoot ?? process.cwd())
    this.sourceDir = options.sourceDir ?? autoSourceDir(this.projectRoot)
    this.graphPath = options.graphPath ?? join(this.projectRoot, '.graphify', 'graph.json')
    this.flowsPath = options.flowsPath ?? join(this.projectRoot, '.graphify', 'flows.json')
    this.#cliPath = options.cliPath ?? resolveGraphifyCli()
  }

  #cliPath: string

  /** 构建/更新代码图谱与执行流文件。 */
  async build(): Promise<{ graphPath: string; flowsPath: string }> {
    await this.#run(['extract', this.sourceDir, '--out', this.projectRoot, '--no-description', '--no-label'])
    await this.#run(['flows', 'build', '--graph', this.graphPath])
    return { graphPath: this.graphPath, flowsPath: this.flowsPath }
  }

  /** BFS/DFS 图谱语义查询，返回 Graphify 文本结果。 */
  async query(question: string, options: GraphQueryOptions = {}): Promise<string> {
    const args = ['query', question, '--graph', this.graphPath]
    if (options.dfs === true) args.push('--dfs')
    if (options.budget !== undefined) args.push('--budget', String(options.budget))
    return (await this.#run(args)).trim()
  }

  /** 两个节点之间的最短路径。 */
  async path(source: string, target: string): Promise<string> {
    return (await this.#run(['path', source, target, '--graph', this.graphPath])).trim()
  }

  /** 单个节点及其邻居详情。 */
  async explain(node: string): Promise<string> {
    return (await this.#run(['explain', node, '--graph', this.graphPath])).trim()
  }

  /** 改动文件影响面（执行流）。 */
  async affectedFlows(files: string[]): Promise<AffectedFlowsResult> {
    if (files.length === 0) return { changedFiles: [], matchedNodeIds: [], unmatchedFiles: [], affectedFlows: [] }
    const out = await this.#run([
      'affected-flows',
      '--files',
      files.join(','),
      '--graph',
      this.graphPath,
      '--flows',
      this.flowsPath,
      '--json',
    ])
    return JSON.parse(out) as AffectedFlowsResult
  }

  /** 列出执行流摘要。 */
  async listFlows(limit = 50): Promise<GraphFlow[]> {
    const out = await this.#run(['flows', 'list', '--flows', this.flowsPath, '--limit', String(limit), '--json'])
    return JSON.parse(out) as GraphFlow[]
  }

  /** 获取单个执行流详情。 */
  async getFlow(flowId: string): Promise<GraphFlow> {
    const out = await this.#run(['flows', 'get', flowId, '--flows', this.flowsPath, '--graph', this.graphPath, '--json'])
    return JSON.parse(out) as GraphFlow
  }

  /** 图谱数据是否已构建。 */
  hasGraph(): boolean {
    return existsSync(this.graphPath)
  }

  /** 执行流文件是否已构建。 */
  hasFlows(): boolean {
    return existsSync(this.flowsPath)
  }

  /** 读取 graph.json 的轻量摘要（不调用 CLI，适合 RPC 快速展示）。 */
  async graphSummary(): Promise<GraphSummary> {
    if (!this.hasGraph()) {
      throw new WeaveError('configuration_error', `代码图谱尚未构建: ${this.graphPath}`, { graphPath: this.graphPath })
    }
    let parsed: {
      nodes?: Array<{ community?: unknown }>
      links?: unknown[]
      graph?: { community_labels?: Record<string, unknown>; built_from_commit?: string }
    }
    try {
      parsed = JSON.parse(await readFile(this.graphPath, 'utf8')) as typeof parsed
    } catch (error) {
      throw new WeaveError('internal', `code/graph 图谱解析失败: ${this.graphPath}`, {
        graphPath: this.graphPath,
        cause: error instanceof Error ? error.message : String(error),
      })
    }
    const nodes = Array.isArray(parsed.nodes) ? parsed.nodes : []
    const communityLabels = parsed.graph?.community_labels
    const communityCount = communityLabels && typeof communityLabels === 'object' && !Array.isArray(communityLabels)
      ? Object.keys(communityLabels).length
      : new Set(nodes.map((node) => String(node.community ?? ''))).size
    return {
      graphPath: this.graphPath,
      flowsPath: this.flowsPath,
      nodeCount: nodes.length,
      edgeCount: Array.isArray(parsed.links) ? parsed.links.length : 0,
      communityCount,
      ...(parsed.graph?.built_from_commit ? { builtFromCommit: parsed.graph.built_from_commit } : {}),
      hasFlows: this.hasFlows(),
    }
  }

  async #run(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync(process.execPath, [this.#cliPath, ...args], {
        cwd: this.projectRoot,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      })
      return stdout
    } catch (error) {
      const detail = error as { message?: string; stderr?: string; code?: string | number }
      throw new WeaveError('graph_execution_failed', detail.message ?? 'Graphify CLI 执行失败', {
        command: args.join(' '),
        ...(typeof detail.stderr === 'string' && detail.stderr !== '' ? { stderr: detail.stderr.slice(0, 2000) } : {}),
        ...(detail.code !== undefined ? { exitCode: String(detail.code) } : {}),
      })
    }
  }
}

function resolveGraphifyCli(): string {
  const require = createRequire(import.meta.url)
  // @sentropic/graphify 的 exports 未暴露 package.json 子路径（ERR_PACKAGE_PATH_NOT_EXPORTED），
  // 改从包入口解析到 dist 目录，再拼接 CLI 入口，保证 pnpm 布局同样成立。
  const entryPath = require.resolve('@sentropic/graphify')
  return join(dirname(entryPath), 'cli.js')
}
