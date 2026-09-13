import { basename, join } from 'node:path'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { WeaveError } from '../state/weave-error.js'
import type { KnowledgeInjectionLimits } from '../scheduling/delegation-service.js'
import {
  PrismClient,
  type PrismDepositInput,
  type PrismDepositResult,
  type PrismGraphJob,
  type PrismSearchResult,
} from './prism-client.js'
import {
  KnowledgeStaging,
  type StagedKnowledge,
  type StagedKnowledgeInput,
} from './knowledge-staging.js'
import type { PrismSupervisor } from './prism-supervisor.js'

/**
 * PrismGateway —— weave 各模块消费 Prism 能力的唯一门面（防腐层）。
 *
 * 职责：
 * - 派发注入：把 prism 检索结果适配为 delegation 的 KnowledgeInjectionEntryLike
 *   （P2 角色迁移后可切 /api/kb/context-pack 走角色知识绑定）；
 * - 知识审核闭环：暂存区 review/approve/reject，approve → prism deposit（即生效）；
 * - 图谱：project 归一（basename）+ 异步 build 任务轮询等待；
 * - 转换/导出：prism 无 HTTP 路由的能力（kb convert / kb export）走 CLI 子进程。
 *
 * prism 故障一律抛 WeaveError（code=prism_*），由调用方决定降级——
 * 调度主链路（注入/图谱刷新）已在调用点 catch 降级，不阻断任务。
 */

/** WEAVE_KNOWLEDGE type → prism EntryType。 */
function mapEntryType(type: StagedKnowledge['type']): PrismDepositInput['type'] {
  switch (type) {
    case 'pitfall':
      return 'pitfall'
    case 'pattern':
      return 'pattern'
    case 'skill':
      return 'guide'
    case 'doc':
      return 'doc'
  }
}

/** 注入条目（delegation-service KnowledgeInjectionEntryLike 同构）。 */
export interface PrismInjectionEntry {
  id: string
  title: string
  content: string
  layer: string
  freshness_score: number
}

export interface PrismGatewayOptions {
  client: PrismClient
  staging?: KnowledgeStaging
  supervisor?: PrismSupervisor
  /** 代码图谱默认项目根（env WEAVE_GRAPH_PROJECT_ROOT > 插件仓根）。 */
  defaultProjectRoot?: string
  audit?: {
    record(event: {
      type: 'knowledge.deposited'
      knowledge_id: string
      task_id: string
      executor: string
      layer: string
    }): Promise<unknown>
  }
  log?: Pick<Console, 'log' | 'warn'>
}

export interface PrismGraphBuildResult {
  project: string
  status: string
  job: PrismGraphJob
  ok: boolean
}

export interface PrismConvertResult {
  job_id: string
  status: string
  title: string
  markdown: string
  warnings: string[]
}

/** reflection 反思沉淀入参（与旧 ReflectionService.depositFromOutput 的块字段对齐）。 */
export type PrismStagedDepositInput = StagedKnowledgeInput

const LAYER_PRIORITY: Record<string, number> = { role: 3, project: 2, global: 1 }

export class PrismGateway {
  readonly client: PrismClient
  readonly staging: KnowledgeStaging
  readonly #supervisor?: PrismSupervisor
  readonly #defaultProjectRoot: string
  readonly #audit?: PrismGatewayOptions['audit']
  readonly #log: Pick<Console, 'log' | 'warn'>

  constructor(options: PrismGatewayOptions) {
    this.client = options.client
    this.staging = options.staging ?? new KnowledgeStaging()
    this.#supervisor = options.supervisor
    this.#defaultProjectRoot = options.defaultProjectRoot ?? process.env.WEAVE_GRAPH_PROJECT_ROOT ?? ''
    this.#audit = options.audit
    this.#log = options.log ?? console
  }

  /* ============================ 派发注入 ============================ */

  /**
   * 派发注入检索：project/global/role 三路 prism 检索合并去重，
   * 层优先（role>project>global）+ 新鲜度排序，按限额截断。
   * 语义对齐旧 KnowledgeEngine.searchForInjection（失败由调用方降级为空）。
   */
  async searchForInjection(params: {
    taskId: string
    projectId: string
    version: string
    roleId: string
    keywords?: string
    limit: KnowledgeInjectionLimits
    slim?: boolean
  }): Promise<PrismInjectionEntry[]> {
    const q = (params.keywords ?? '').trim()
    if (q === '') return []
    const scopeLimit = Math.max(params.limit.max_entries * 2, 10)
    const scopes: Array<{ layers: PrismSearchResult['layer'][]; owner?: string }> = [
      { layers: ['project'], owner: params.projectId },
      { layers: ['global'] },
      { layers: ['role'], owner: params.roleId },
    ]
    const results = await Promise.allSettled(
      scopes.map((scope) =>
        this.client.search({
          q,
          layers: scope.layers,
          ...(scope.owner !== undefined ? { owner: scope.owner } : {}),
          limit: scopeLimit,
          match_mode: 'any',
        }),
      ),
    )
    const byId = new Map<string, PrismSearchResult>()
    for (const result of results) {
      if (result.status !== 'fulfilled') {
        this.#log.warn('[dsh-weave] prism injection scope search failed:', result.reason)
        continue
      }
      for (const hit of result.value) {
        const existing = byId.get(hit.id)
        if (!existing || hit.score > existing.score) byId.set(hit.id, hit)
      }
    }
    const ranked = [...byId.values()].sort((a, b) => {
      const layerDiff = (LAYER_PRIORITY[b.layer] ?? 0) - (LAYER_PRIORITY[a.layer] ?? 0)
      if (layerDiff !== 0) return layerDiff
      return b.score - a.score
    })
    const entries: PrismInjectionEntry[] = []
    let totalChars = 0
    for (const hit of ranked) {
      if (entries.length >= params.limit.max_entries) break
      const content =
        hit.excerpt.length > params.limit.max_chars_per_entry
          ? `${hit.excerpt.slice(0, params.limit.max_chars_per_entry)}…`
          : hit.excerpt
      const lineLength = hit.title.length + content.length
      if (totalChars + lineLength > params.limit.max_total_chars) break
      entries.push({
        id: hit.id,
        title: hit.title,
        content,
        layer: hit.layer,
        freshness_score: hit.freshness ?? 1,
      })
      totalChars += lineLength
    }
    return entries
  }

  /** 工具面检索（weave_knowledge_search 代理 prism 检索）。 */
  async search(input: {
    query: string
    project_id?: string
    role_id?: string
    layer?: string
    limit?: number
  }): Promise<PrismSearchResult[]> {
    const layers = input.layer
      ? [input.layer as PrismSearchResult['layer']]
      : undefined
    const owner = layers?.[0] === 'role' ? input.role_id : input.project_id
    return await this.client.search({
      q: input.query,
      ...(layers ? { layers } : {}),
      ...(owner !== undefined ? { owner } : {}),
      limit: input.limit ?? 10,
      match_mode: 'any',
    })
  }

  /* ============================ 反思沉淀与审核 ============================ */

  /** 反思产物入暂存（先审后发：主会话 approve 后才落 prism）。 */
  async stageReflection(input: PrismStagedDepositInput): Promise<StagedKnowledge> {
    return await this.staging.append(input)
  }

  /** 审核队列（暂存区，先审先出）。 */
  async reviewQueue(limit?: number): Promise<StagedKnowledge[]> {
    const entries = await this.staging.list()
    return typeof limit === 'number' && limit >= 0 ? entries.slice(0, limit) : entries
  }

  async countStaged(): Promise<number> {
    return await this.staging.count()
  }

  /**
   * 审核通过：暂存 → prism deposit（映射 type/book/module/tags 溯源）→ 清暂存。
   * deposit 失败时暂存条目保留（可重试）。
   */
  async approveStaged(stagingId: string): Promise<{ staged: StagedKnowledge; deposit: PrismDepositResult }> {
    const staged = await this.staging.get(stagingId)
    if (!staged) throw new WeaveError('knowledge_not_found', `暂存知识不存在: ${stagingId}`)
    const deposit = await this.client.deposit({
      title: staged.title,
      type: mapEntryType(staged.type),
      layer: 'project',
      owner: staged.project_id,
      book: 'weave-execution',
      module: staged.type,
      content: staged.content,
      tags: [...staged.tags, `executor:${staged.executor ?? staged.role_id}`, `role:${staged.role_id}`, 'source:weave-reflection'],
      source: { kind: 'agent' },
      deposited_by: { subject: 'weave', task_id: staged.task_id },
      origin_task: { task_id: staged.task_id, role: staged.role_id },
    })
    await this.#audit?.record({
      type: 'knowledge.deposited',
      knowledge_id: deposit.id,
      task_id: staged.task_id,
      executor: staged.executor ?? staged.role_id,
      layer: 'project',
    })
    await this.staging.remove(stagingId)
    return { staged, deposit }
  }

  /** 审核拒绝：删除暂存条目（不落 prism）。 */
  async rejectStaged(stagingId: string): Promise<StagedKnowledge> {
    const staged = await this.staging.get(stagingId)
    if (!staged) throw new WeaveError('knowledge_not_found', `暂存知识不存在: ${stagingId}`)
    await this.#audit?.record({
      type: 'knowledge.deposited',
      knowledge_id: stagingId,
      task_id: staged.task_id,
      executor: staged.executor ?? staged.role_id,
      layer: 'rejected',
    })
    await this.staging.remove(stagingId)
    return staged
  }

  /* ============================ 图谱 ============================ */

  /** 图谱项目名 = 项目根 basename（prism ProjectRegistry 以名字定位项目）。 */
  #projectName(projectRoot?: string): { project: string; root: string } {
    const root = (projectRoot ?? this.#defaultProjectRoot ?? '').trim()
    if (root === '') {
      throw new WeaveError('configuration_error', '代码图谱项目根未配置（WEAVE_GRAPH_PROJECT_ROOT 或 gateway.defaultProjectRoot）')
    }
    return { project: basename(root), root }
  }

  /**
   * 构建代码图谱（prism 异步 job，轮询到终态）。
   * 默认全量构建；incremental=true 走增量。
   */
  async graphBuild(options: { projectRoot?: string; incremental?: boolean; timeoutMs?: number; pollIntervalMs?: number } = {}): Promise<PrismGraphBuildResult> {
    const { project, root } = this.#projectName(options.projectRoot)
    const handle = await this.client.graphBuild({ project, root, ...(options.incremental ? { incremental: true } : {}) })
    const timeoutMs = options.timeoutMs ?? 15 * 60_000
    const pollIntervalMs = options.pollIntervalMs ?? 2_000
    const deadline = Date.now() + timeoutMs
    let job = await this.client.graphJob(handle.job_id)
    while (!/(done|success|complete|failed|error|cancell?ed)/i.test(job.status)) {
      if (Date.now() > deadline) {
        throw new WeaveError('prism_graph_timeout', `prism 图谱构建超时（${timeoutMs}ms）: ${project}`)
      }
      await new Promise((resolveSleep) => setTimeout(resolveSleep, pollIntervalMs))
      job = await this.client.graphJob(handle.job_id)
    }
    const ok = /(done|success|complete)/i.test(job.status)
    if (!ok) {
      throw new WeaveError('prism_graph_failed', `prism 图谱构建失败: ${project}（${job.status}）`, {
        error: job.error,
        log: job.log?.slice(-5),
      })
    }
    return { project, status: job.status, job, ok: true }
  }

  async graphQuery(input: { question: string; projectRoot?: string }): Promise<{ project: string; output: string }> {
    const { project } = this.#projectName(input.projectRoot)
    return await this.client.graphQuery({ project, q: input.question })
  }

  async graphPath(input: { source: string; target: string; projectRoot?: string }): Promise<Record<string, unknown>> {
    const { project } = this.#projectName(input.projectRoot)
    return await this.client.graphPath({ project, from: input.source, to: input.target })
  }

  async graphExplain(input: { node: string; projectRoot?: string }): Promise<Record<string, unknown>> {
    const { project } = this.#projectName(input.projectRoot)
    return await this.client.graphExplain({ project, node: input.node })
  }

  async graphAffected(input: { files: string[]; projectRoot?: string }): Promise<{ project: string; affected: string[] }> {
    const { project } = this.#projectName(input.projectRoot)
    // prism /api/graph/affected 以单节点为入参：多文件逐个查询后合并受影响集合。
    const results = await Promise.allSettled(
      input.files.map((file) => this.client.graphAffected({ project, node: file })),
    )
    const affected = new Set<string>()
    let project_ = project
    for (const result of results) {
      if (result.status === 'rejected') continue
      project_ = result.value.project
      const value = result.value as { affected?: unknown }
      const nodes = Array.isArray(value.affected) ? value.affected : []
      for (const node of nodes) {
        if (typeof node === 'string') affected.add(node)
        else if (node && typeof node === 'object' && typeof (node as { id?: unknown }).id === 'string') {
          affected.add((node as { id: string }).id)
        }
      }
    }
    return { project: project_, affected: [...affected] }
  }

  /* ============================ 转换 / 导出（CLI 能力） ============================ */

  /**
   * 文档转换（prism kb convert）：file 为服务端路径，或 filename+data（base64）。
   * prism 该能力无 HTTP 路由，走 CLI 子进程，产物 Markdown 直接返回。
   */
  async convertDocument(input: { file?: string; filename?: string; data?: string; format?: string }): Promise<PrismConvertResult> {
    if (!this.#supervisor) {
      throw new WeaveError('configuration_error', 'PrismGateway 未配置 supervisor（document convert 需要 CLI）')
    }
    let source = input.file ?? ''
    let cleanup: (() => Promise<void>) | undefined
    if (source === '' && typeof input.data === 'string' && input.data !== '') {
      const name = (input.filename ?? `upload-${Date.now()}.bin`).replace(/[/\\]/g, '_')
      const dir = await mkdtemp(join(tmpdir(), 'weave-convert-'))
      source = join(dir, name)
      await writeFile(source, Buffer.from(input.data, 'base64'))
      cleanup = async () => {
        await rm(dir, { recursive: true, force: true })
      }
    }
    if (source === '') {
      throw new WeaveError('invalid_argument', 'document convert 需要 file 或 filename+data')
    }
    const dir = await mkdtemp(join(tmpdir(), 'weave-convert-'))
    const outPath = join(dir, 'converted.md')
    try {
      const result = await this.#supervisor.runCli(['kb', 'convert', source, '--out', outPath], {
        timeoutMs: 180_000,
      })
      if (result.code !== 0) {
        throw new WeaveError('convert_failed', `prism kb convert 失败: ${result.stderr.trim() || result.stdout.trim() || `exit=${result.code}`}`)
      }
      const markdown = await readFile(outPath, 'utf8')
      // stdout 形如「已转换 X → Y（ok，N 字）」，解析状态；解析不出按 ok 处理
      const statusMatch = result.stdout.match(/（([a-z_]+)，/)
      return {
        job_id: `prism-${Date.now()}`,
        status: statusMatch?.[1] ?? 'ok',
        title: basename(source),
        markdown,
        warnings: [],
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
      await cleanup?.()
    }
  }

  /**
   * 知识图谱导出 Obsidian Vault（prism kb export --format obsidian）。
   * 旧 ObsidianService 的指纹/冲突矩阵随模块下线（接受的功能收缩）。
   */
  async exportKnowledgeObsidian(): Promise<{ output: string }> {
    if (!this.#supervisor) {
      throw new WeaveError('configuration_error', 'PrismGateway 未配置 supervisor（obsidian export 需要 CLI）')
    }
    const result = await this.#supervisor.runCli(['kb', 'export', '--format', 'obsidian'], { timeoutMs: 300_000 })
    if (result.code !== 0) {
      throw new WeaveError('export_failed', `prism kb export 失败: ${result.stderr.trim() || result.stdout.trim() || `exit=${result.code}`}`)
    }
    return { output: result.stdout.trim() }
  }

  /* ============================ 团队/角色（P2：定义面由 prism 承接） ============================ */

  /** GET /api/teams（prism 团队清单；角色/团队定义 P2 起由 prism 承接）。 */
  async listTeams(): Promise<{ teams?: Array<unknown>; teams_dir?: string }> {
    return await this.client.request('GET', '/api/teams')
  }

  /** GET /api/teams/:id/activate（TeamActivation：成员 + 角色定义 + 工作流）。 */
  async teamActivate(teamId: string): Promise<unknown> {
    return await this.client.request('GET', `/api/teams/${encodeURIComponent(teamId)}/activate`)
  }

  /** GET /api/roles（prism 角色清单）。 */
  async listRoles(): Promise<{ roles?: Array<unknown>; roles_dir?: string }> {
    return await this.client.request('GET', '/api/roles')
  }

  /** POST /api/tasks/register（P3 台账镜像：批量登记 DAG，不触发 prism 执行）。 */
  async taskRegister(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return await this.client.request('POST', '/api/tasks/register', { body: payload })
  }

  /** POST /api/tasks/report（P3 台账镜像：状态回报，prism 侧状态机校验）。 */
  async taskReport(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return await this.client.request('POST', '/api/tasks/report', { body: payload })
  }
}
