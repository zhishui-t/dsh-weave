import { WeaveError } from '../state/weave-error.js'

/**
 * Prism 控制面 HTTP 客户端（知识库/图谱/转换的统一消费出口）。
 *
 * prism 是独立子项目（知识与协作控制面），weave 只依赖其对外契约：
 * - 统一信封 `{ ok: true, value } | { ok: false, error: { code, message } }`
 *   （prism packages/server/src/http/envelope.ts，16 个错误码）；
 * - 本机 HTTP（prism serve，默认 127.0.0.1:7777）；
 * - 冻结契约面：/api/kb/*（知识）、/api/graph/*（代码图谱）、/api/health。
 * P2 角色团队迁移前不使用 /api/kb/context-pack（该路由强依赖 prism 角色定义）。
 */

export const DEFAULT_PRISM_BASE_URL = 'http://127.0.0.1:7777'

/** prism 知识分层（与 @prism/knowledge Layer 一致）。 */
export type PrismLayer = 'global' | 'project' | 'role'

/** prism 条目类型（@prism/knowledge EntryType）。 */
export type PrismEntryType = 'rule' | 'doc' | 'guide' | 'pitfall' | 'pattern' | 'diagram' | 'summary' | 'other'

/** prism 统一信封（envelope.ts）。 */
export interface PrismEnvelopeError {
  code: string
  message: string
}

/** /api/kb/search 命中项（@prism/knowledge SearchResult 子集）。 */
export interface PrismSearchResult {
  id: string
  version: number
  title: string
  type: PrismEntryType
  layer: PrismLayer
  owner?: string
  book: string
  module: string
  excerpt: string
  score: number
  /** 来源地址：`层[/owner]/书/模块/ID@v版次` */
  source: string
  freshness?: number
}

/** POST /api/kb/deposit 入参（@prism/knowledge DepositInput 子集）。 */
export interface PrismDepositInput {
  id?: string
  title: string
  type: PrismEntryType
  layer: PrismLayer
  /** project/role 层必填（project-id / role-id） */
  owner?: string
  book: string
  module?: string
  content: string
  tags?: string[]
  risk?: 'low' | 'medium' | 'high'
  confidence?: number
  source?: { kind: 'import' | 'agent' | 'manual' | 'task'; ref?: string }
  deposited_by?: { subject: string; team?: string; task_id?: string }
  origin_task?: { task_id: string; dag_id?: string; stage?: string; role?: string }
}

/** POST /api/kb/deposit 返回（@prism/knowledge DepositResult）。 */
export interface PrismDepositResult {
  id: string
  version: number
  path: string
  action: 'created' | 'updated' | 'unchanged'
}

/** POST /api/graph/build 返回的异步任务句柄。 */
export interface PrismGraphJobHandle {
  job_id: string
}

/** GET /api/graph/build/:job_id 任务状态。 */
export interface PrismGraphJob {
  job_id: string
  project: string
  status: string
  log?: string[]
  error?: string
  started_at?: number
  finished_at?: number
}

export interface PrismSearchParams {
  q: string
  layers?: PrismLayer[]
  owner?: string
  book?: string
  module?: string
  limit?: number
  /** 长任务描述必须用 any（OR 语义），否则全词元 AND 会零命中 */
  match_mode?: 'all' | 'any'
}

export interface PrismGraphQueryParams {
  project: string
  q: string
}

export interface PrismGraphPathParams {
  project: string
  from: string
  to: string
}

export interface PrismGraphExplainParams {
  project: string
  node: string
}

export interface PrismGraphAffectedParams {
  project: string
  node: string
  depth?: number
}

export interface PrismClientOptions {
  baseUrl?: string
  timeoutMs?: number
}

/** 统一把 prism 错误/网络故障映射为 WeaveError（调用方按 code 降级）。 */
function toWeaveError(error: unknown, baseUrl: string): WeaveError {
  if (error instanceof WeaveError) return error
  return new WeaveError('prism_unavailable', `Prism 控制面不可用（${baseUrl}）: ${error instanceof Error ? error.message : String(error)}`)
}

export class PrismClient {
  readonly baseUrl: string
  readonly timeoutMs: number

  constructor(options: PrismClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_PRISM_BASE_URL).replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs ?? 30_000
  }

  /** 发起请求并解信封；非 2xx/网络故障/ok=false 一律抛 WeaveError。 */
  async request<T>(
    method: 'GET' | 'POST',
    path: string,
    init: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(path, this.baseUrl)
    if (init.query) {
      for (const [key, value] of Object.entries(init.query)) {
        if (value === undefined || value === '') continue
        url.searchParams.set(key, String(value))
      }
    }
    let response: Response
    try {
      response = await fetch(url, {
        method,
        ...(init.body !== undefined
          ? { body: JSON.stringify(init.body), headers: { 'content-type': 'application/json' } }
          : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      throw toWeaveError(error, this.baseUrl)
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new WeaveError('prism_bad_response', `Prism 返回非 JSON（HTTP ${response.status} ${path}）`)
    }
    const envelope = payload as { ok?: boolean; value?: unknown; error?: PrismEnvelopeError }
    if (!response.ok || envelope.ok !== true) {
      const detail = envelope.error
      throw new WeaveError(
        detail?.code ?? 'prism_bad_response',
        detail ? `Prism ${detail.code}: ${detail.message}` : `Prism 请求失败（HTTP ${response.status} ${path}）`,
      )
    }
    return envelope.value as T
  }

  /** GET /api/health。 */
  async health(): Promise<{ status?: string; version?: string; home?: string }> {
    return await this.request('GET', '/api/health')
  }

  /** GET /api/kb/search。 */
  async search(params: PrismSearchParams): Promise<PrismSearchResult[]> {
    return await this.request('GET', '/api/kb/search', {
      query: {
        q: params.q,
        ...(params.layers?.length ? { layers: params.layers.join(',') } : {}),
        ...(params.owner !== undefined ? { owner: params.owner } : {}),
        ...(params.book !== undefined ? { book: params.book } : {}),
        ...(params.module !== undefined ? { module: params.module } : {}),
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
        ...(params.match_mode !== undefined ? { match_mode: params.match_mode } : {}),
      },
    })
  }

  /** POST /api/kb/deposit。 */
  async deposit(input: PrismDepositInput): Promise<PrismDepositResult> {
    return await this.request('POST', '/api/kb/deposit', { body: input })
  }

  /** POST /api/graph/build（异步任务，返回句柄）。 */
  async graphBuild(body: { project: string; root?: string; incremental?: boolean }): Promise<PrismGraphJobHandle> {
    return await this.request('POST', '/api/graph/build', { body })
  }

  /** GET /api/graph/build/:job_id。 */
  async graphJob(jobId: string): Promise<PrismGraphJob> {
    return await this.request('GET', `/api/graph/build/${encodeURIComponent(jobId)}`)
  }

  /** GET /api/graph/query。 */
  async graphQuery(params: PrismGraphQueryParams): Promise<{ project: string; output: string }> {
    return await this.request('GET', '/api/graph/query', { query: { project: params.project, q: params.q } })
  }

  /** GET /api/graph/path。 */
  async graphPath(params: PrismGraphPathParams): Promise<{ project: string } & Record<string, unknown>> {
    return await this.request('GET', '/api/graph/path', {
      query: { project: params.project, from: params.from, to: params.to },
    })
  }

  /** GET /api/graph/explain。 */
  async graphExplain(params: PrismGraphExplainParams): Promise<{ project: string } & Record<string, unknown>> {
    return await this.request('GET', '/api/graph/explain', { query: { project: params.project, node: params.node } })
  }

  /** GET /api/graph/affected。 */
  async graphAffected(params: PrismGraphAffectedParams): Promise<{ project: string } & Record<string, unknown>> {
    return await this.request('GET', '/api/graph/affected', {
      query: {
        project: params.project,
        node: params.node,
        ...(params.depth !== undefined ? { depth: params.depth } : {}),
      },
    })
  }

  /** GET /api/graph/summary。 */
  async graphSummary(project: string): Promise<Record<string, unknown>> {
    return await this.request('GET', '/api/graph/summary', { query: { project } })
  }
}
