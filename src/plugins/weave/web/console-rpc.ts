/**
 * Lightweight Web console RPC backend.
 *
 * The old task/team RPC engine was intentionally removed. This module re-exposes
 * only the console features that are still backed by current capabilities:
 * teams, knowledge, code graph, document convert, obsidian, audit, settings,
 * executors/providers. Legacy task/session endpoints return empty/zero views so
 * the client no longer sees HTTP 405 from an unregistered RPC channel.
 */

import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'
import { stringify as stringifyYaml } from 'yaml'

import { ProviderStore } from '../acp/provider-store.js'
import { AuditLog } from '../audit/audit-log.js'
import { DocumentConverter } from '../convert/document-converter.js'
import { ExecutorProviderRegistry } from '../executors/executor-provider.js'
import { GraphService } from '../graph/graph-service.js'
import { KnowledgeGraphService } from '../graph/knowledge-graph.js'
import { ImportPipeline } from '../import-pipeline.js'
import { KnowledgeReviewService } from '../knowledge-review.js'
import { KnowledgeStore } from '../knowledge-model.js'
import { ObsidianService } from '../obsidian/obsidian-service.js'
import { saveWeaveSettingsOverrides, loadWeaveSettingsOverrides, type WeaveSettingsOverrides } from '../settings-store.js'
import { WeaveError } from '../state/weave-error.js'
import type { WeavePersistence } from '../persistence/persistence.js'
import type { TeamManager } from '../team-manager.js'
import type { ExecutorRegistry } from '../executor-registry.js'

export const WEAVE_RPC_CHANNEL = '/dsh-weave'

/** The weave plugin repository root: the console's default code graph project. */
export const DEFAULT_GRAPH_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', '..',
)

type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }

export interface ConsoleRpcDeps {
  teamManager: TeamManager
  executorRegistry: ExecutorRegistry
  executorProviders?: ExecutorProviderRegistry
  knowledgeStore: KnowledgeStore
  audit: AuditLog
  persistence?: WeavePersistence
  settingsFile?: string
  providersFile?: string
  version?: string
  auditDir?: string
  teamsDir?: string
  stateDir?: string
  knowledgeDir?: string
  obsidianDir?: string
}

function success<T>(value: T): RpcResult<T> {
  return { ok: true, value }
}

function failure(error: unknown): RpcResult<never> {
  if (error instanceof WeaveError) {
    // DSH host RPC validates both error.code and error.details against a strict
    // schema. For bad-request, details.issues must be an array. Preserve the
    // original weave code inside the issue entry for diagnostics.
    if (error.code === 'internal') {
      return {
        ok: false,
        error: {
          code: 'internal',
          message: error.message,
          details: {},
        },
      }
    }
    const issues: unknown[] = [
      {
        message: error.message,
        code: error.code,
        ...(error.details ?? {}),
      },
    ]
    return {
      ok: false,
      error: {
        code: 'bad-request',
        message: error.message,
        details: { issues },
      },
    }
  }
  return {
    ok: false,
    error: {
      code: 'internal',
      message: error instanceof Error ? error.message : String(error),
      details: {},
    },
  }
}

function objectPayload(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new WeaveError('invalid_argument', 'RPC payload 必须是对象')
  }
  return input as Record<string, unknown>
}

function requireString(input: Record<string, unknown>, field: string): string {
  const value = input[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WeaveError('invalid_argument', `${field} 必须为非空字符串`)
  }
  return value
}

function serializeTeam(team: import('../team-manager.js').TeamConfig): Record<string, unknown> {
  return {
    team_id: team.team_id,
    name: team.name,
    ...(team.description !== undefined ? { description: team.description } : {}),
    default: team.default,
    roles: team.roles.map((role) => ({
      id: role.id,
      name: role.name,
      bias: role.bias,
      executor: role.executor,
      stages: [...role.stages],
      max_concurrent_tasks: role.max_concurrent_tasks,
      personality: role.personality,
      ...(role.provider !== undefined ? { provider: role.provider } : {}),
      ...(role.model !== undefined ? { model: role.model } : {}),
      ...(role.thought_level !== undefined ? { thought_level: role.thought_level } : {}),
      ...(role.mode !== undefined ? { mode: role.mode } : {}),
      ...(role.fallback_provider !== undefined ? { fallback_provider: role.fallback_provider } : {}),
      ...(role.fallback_model !== undefined ? { fallback_model: role.fallback_model } : {}),
      ...(role.priority !== undefined ? { priority: role.priority } : {}),
      ...(role.strengths !== undefined ? { strengths: [...role.strengths] } : {}),
    })),
  }
}

function serializeKnowledge(meta: import('../knowledge-model.js').KnowledgeMeta): Record<string, unknown> {
  return {
    id: meta.id,
    path: meta.path,
    layer: meta.layer,
    status: meta.status,
    confidence: meta.confidence,
    freshness_score: meta.freshness_score,
    last_confirmed: meta.last_confirmed,
    created: meta.created,
    updated: meta.updated,
    ...(meta.superseded_by !== undefined ? { superseded_by: meta.superseded_by } : {}),
  }
}

interface ConsoleServices {
  graph: GraphService
  knowledgeGraph: KnowledgeGraphService
  documentConverter: DocumentConverter
  obsidian: ObsidianService
  importPipeline?: ImportPipeline
  providerStore: ProviderStore
  review: KnowledgeReviewService
  settingsFile: string
  importsDir: string
}

function buildServices(deps: ConsoleRpcDeps): ConsoleServices {
  const importsDir = join(homedir(), '.dsh', 'weave', 'imports')
  const outputDir = join(homedir(), '.dsh', 'weave', 'documents')
  const obsidianDir = deps.obsidianDir ?? join(homedir(), '.dsh', 'obsidian')
  const importPipeline = deps.persistence
    ? new ImportPipeline({
        importsDb: deps.persistence.imports,
        importsDir,
        knowledgeStore: deps.knowledgeStore,
      })
    : undefined
  return {
    graph: new GraphService({ projectRoot: DEFAULT_GRAPH_ROOT }),
    knowledgeGraph: new KnowledgeGraphService({ store: deps.knowledgeStore }),
    documentConverter: new DocumentConverter({ outputDir }),
    obsidian: new ObsidianService({ defaultVaultPath: obsidianDir, knowledgeStore: deps.knowledgeStore }),
    ...(importPipeline ? { importPipeline } : {}),
    providerStore: new ProviderStore({ file: deps.providersFile }),
    review: new KnowledgeReviewService({ knowledge: deps.knowledgeStore, audit: deps.audit }),
    settingsFile: deps.settingsFile ?? join(homedir(), '.dsh', 'weave', 'settings.json'),
    importsDir,
  }
}

export function createConsoleRpcHandler(deps: ConsoleRpcDeps | (() => ConsoleRpcDeps)) {
  const services = buildServices(typeof deps === 'function' ? deps() : deps)
  const resolvedDeps = typeof deps === 'function' ? () => deps() : () => deps

  return async (endpoint: string, rawPayload: unknown): Promise<RpcResult<unknown>> => {
    const payload = rawPayload ?? {}
    try {
      const d = resolvedDeps()
      const graphFor = (input: Record<string, unknown>): GraphService => {
        const root = typeof input.projectRoot === 'string' && input.projectRoot.trim() !== '' ? input.projectRoot : undefined
        return root ? new GraphService({ projectRoot: root }) : new GraphService({ projectRoot: DEFAULT_GRAPH_ROOT })
      }
      if (endpoint === 'snapshot') {
        const teams = d.teamManager.listTeams()
        const executors = d.executorRegistry.list()
        const knowledgeCount = (await d.knowledgeStore.listMeta({ status: 'candidate' })).length
        const audit = await d.audit.query({ limit: 5 })
        return success({
          teams: teams.map(serializeTeam),
          executors: executors.map((executor) => ({ id: executor.id, kind: executor.kind, capabilities: executor.capabilities })),
          overview: {
            teams: teams.length,
            roles: teams.reduce((sum, team) => sum + team.roles.length, 0),
            executors: executors.length,
            knowledge: knowledgeCount,
            audit: audit.length,
            tasks: 0,
            banned: 0,
          },
          zcodeCapabilities: {},
        })
      }
      if (endpoint === 'team/list') {
        objectPayload(payload)
        return success({ teams: d.teamManager.listTeams().map(serializeTeam) })
      }
      if (endpoint === 'team/get') {
        const input = objectPayload(payload)
        return success(serializeTeam(d.teamManager.loadTeam(requireString(input, 'teamId'))))
      }
      if (endpoint === 'team/import') {
        const input = objectPayload(payload)
        let yaml = typeof input.yaml === 'string' && input.yaml.trim() !== '' ? input.yaml : ''
        if (yaml === '' && typeof input.config === 'object' && input.config !== null) {
          yaml = stringifyYaml(input.config)
        }
        if (yaml.trim() === '') throw new WeaveError('invalid_argument', 'team/import 需要 yaml 文本或 config 对象')
        const team = d.teamManager.importTeam(yaml, { overwrite: input.overwrite === true })
        return success({ team_id: team.team_id, name: team.name, roles: team.roles.length })
      }
      if (endpoint === 'team/delete') {
        const input = objectPayload(payload)
        const result = await d.teamManager.deleteTeam(requireString(input, 'teamId'))
        return success({ deleted: true, ...result })
      }
      if (endpoint === 'team/set-default') {
        const input = objectPayload(payload)
        return success(d.teamManager.setDefaultTeam(requireString(input, 'teamId')))
      }
      if (endpoint === 'task/list') {
        objectPayload(payload)
        return success({ total: 0, tasks: [] })
      }
      if (endpoint === 'session/revisions') {
        objectPayload(payload)
        return success({ revisions: [] })
      }
      if (endpoint === 'knowledge/list') {
        const input = objectPayload(payload)
        const metas = await d.knowledgeStore.listMeta({
          ...(typeof input.status === 'string' ? { status: input.status as never } : {}),
          ...(typeof input.layer === 'string' ? { layer: input.layer as never } : {}),
        })
        return success({ candidates: metas.map(serializeKnowledge) })
      }
      if (endpoint === 'knowledge/graph') {
        const input = objectPayload(payload)
        return success(await services.knowledgeGraph.graph({
          ...(typeof input.project === 'string' ? { project: input.project } : {}),
          ...(typeof input.status === 'string' ? { status: input.status as never } : {}),
          ...(typeof input.layer === 'string' ? { layer: input.layer as never } : {}),
          ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
        }))
      }
      if (endpoint === 'knowledge/approve') {
        const input = objectPayload(payload)
        const meta = await services.review.approve(requireString(input, 'id'))
        return success({ id: meta.id, status: meta.status })
      }
      if (endpoint === 'knowledge/reject') {
        const input = objectPayload(payload)
        const meta = await services.review.reject(requireString(input, 'id'))
        return success({ id: meta.id, status: meta.status })
      }
      if (endpoint === 'knowledge/import/upload' && services.importPipeline) {
        const input = objectPayload(payload)
        const filename = requireString(input, 'filename')
        const data = typeof input.data === 'string' ? input.data : ''
        if (data === '') throw new WeaveError('invalid_argument', 'knowledge/import/upload 需要 data(base64)')
        const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_')
        const filePath = join(services.importsDir, `upload-${Date.now()}-${safeName}`)
        writeFileSync(filePath, Buffer.from(data, 'base64'))
        const job = await services.importPipeline.upload(
          { original_filename: filename, local_path: filePath },
          (input.meta ?? {}) as never,
        )
        return success({ jobId: job.id, id: job.id, status: job.status })
      }
      if (endpoint === 'knowledge/import/convert' && services.importPipeline) {
        const input = objectPayload(payload)
        const result = await services.importPipeline.convert(requireString(input, 'jobId'))
        return success({ jobId: result.job_id, markdown: result.markdown, title: result.title, status: result.status })
      }
      if (endpoint === 'knowledge/import/confirm' && services.importPipeline) {
        const input = objectPayload(payload)
        const candidate = (input.candidate ?? input) as Record<string, unknown>
        const result = await services.importPipeline.confirm(requireString(input, 'jobId'), candidate as never)
        return success({ id: result, candidate_id: result })
      }
      if (endpoint === 'code/status') {
        const input = objectPayload(payload)
        const root = typeof input.projectRoot === 'string' && input.projectRoot.trim() !== '' ? input.projectRoot : DEFAULT_GRAPH_ROOT
        const graph = new GraphService({ projectRoot: root })
        return success({
          projectRoot: graph.projectRoot,
          graphPath: graph.graphPath,
          flowsPath: graph.flowsPath,
          hasGraph: graph.hasGraph(),
          hasFlows: graph.hasFlows(),
        })
      }
      if (endpoint === 'code/graph') {
        const input = objectPayload(payload)
        return success(await graphFor(input).graphSummary())
      }
      if (endpoint === 'code/build') {
        const input = objectPayload(payload)
        return success(await graphFor(input).build())
      }
      if (endpoint === 'code/query') {
        const input = objectPayload(payload)
        return success({ text: await graphFor(input).query(requireString(input, 'question'), {
          ...(typeof input.budget === 'number' ? { budget: input.budget } : {}),
          ...(input.dfs === true ? { dfs: true } : {}),
        }) })
      }
      if (endpoint === 'code/path') {
        const input = objectPayload(payload)
        return success({ path: await graphFor(input).path(requireString(input, 'source'), requireString(input, 'target')) })
      }
      if (endpoint === 'code/explain') {
        const input = objectPayload(payload)
        return success({ explain: await graphFor(input).explain(requireString(input, 'node')) })
      }
      if (endpoint === 'code/affected') {
        const input = objectPayload(payload)
        const files = Array.isArray(input.files) ? input.files.filter((item): item is string => typeof item === 'string') : []
        return success(await graphFor(input).affectedFlows(files))
      }
      if (endpoint === 'code/flows') {
        const input = objectPayload(payload)
        return success({ flows: await graphFor(input).listFlows(typeof input.limit === 'number' ? input.limit : 50) })
      }
      if (endpoint === 'document/history') {
        const input = objectPayload(payload)
        return success({ jobs: await services.documentConverter.history(typeof input.limit === 'number' ? input.limit : 20) })
      }
      if (endpoint === 'document/convert') {
        const input = objectPayload(payload)
        return success(await services.documentConverter.convert({
          filename: requireString(input, 'filename'),
          data: typeof input.data === 'string' ? input.data : '',
        }))
      }
      if (endpoint === 'document/status') {
        const input = objectPayload(payload)
        return success(await services.documentConverter.status(requireString(input, 'jobId')))
      }
      if (endpoint === 'document/preview') {
        const input = objectPayload(payload)
        return success(await services.documentConverter.preview(requireString(input, 'jobId')))
      }
      if (endpoint === 'obsidian/status') {
        objectPayload(payload)
        return success(await services.obsidian.status())
      }
      if (endpoint === 'obsidian/generate') {
        const input = objectPayload(payload)
        return success(await services.obsidian.generate({ force: input.force === true }))
      }
      if (endpoint === 'obsidian/reindex') {
        objectPayload(payload)
        return success(await services.obsidian.reindex())
      }
      if (endpoint === 'audit/list') {
        const input = objectPayload(payload)
        const events = await d.audit.query({
          ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
          ...(Array.isArray(input.types) ? { types: input.types.filter((item): item is string => typeof item === 'string') as never } : {}),
          ...(typeof input.sessionId === 'string' ? { sessionId: input.sessionId } : {}),
        })
        return success({ events })
      }
      if (endpoint === 'settings/describe') {
        objectPayload(payload)
        const overrides = loadWeaveSettingsOverrides(services.settingsFile)
        return success({
          version: d.version ?? null,
          node_version: process.version,
          state_dir: d.stateDir ?? d.persistence?.stateDir ?? join(homedir(), '.dsh', 'state'),
          teams_dir: d.teamsDir ?? d.teamManager.teamsDir,
          audit_dir: d.auditDir ?? join(homedir(), '.dsh', 'audit'),
          providers_file: d.providersFile,
          zcode: { configured: Boolean(d.executorProviders?.get('zcode')), registered: d.executorProviders?.get('zcode') !== undefined },
          ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
        })
      }
      if (endpoint === 'settings/update') {
        const input = objectPayload(payload)
        const patch: WeaveSettingsOverrides = {}
        for (const key of ['state_dir', 'teams_dir', 'audit_dir', 'knowledge_dir', 'providers_file', 'obsidian_dir']) {
          if (typeof input[key] === 'string' && input[key] !== '') patch[key as keyof WeaveSettingsOverrides] = input[key] as string
        }
        saveWeaveSettingsOverrides(services.settingsFile, patch)
        return success({ saved: true, ...patch })
      }
      if (endpoint === 'provider/list') {
        objectPayload(payload)
        const rows = services.providerStore.list().map((row) => ({
          name: row.name,
          transport: row.transport,
          command: row.command,
          ...(row.args ? { args: row.args } : {}),
          ...(row.cwd ? { cwd: row.cwd } : {}),
          protocol: row.protocol,
          ...(row.declaredExtensions ? { declaredExtensions: row.declaredExtensions } : {}),
          enabled: d.executorProviders?.get(row.name) !== undefined,
        }))
        return success({ providers: rows })
      }
      throw new WeaveError('invalid_argument', `未知 RPC endpoint: ${endpoint}`)
    } catch (error) {
      return failure(error)
    }
  }
}

interface HostConnectionRpc {
  handle(channel: string, handler: (endpoint: string, payload: unknown) => Promise<RpcResult<unknown>>, options?: { authority?: string }): () => unknown
}

interface WebServerLike {
  register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: unknown) => void | Promise<void> }): () => unknown
}

export function registerConsoleRpc(
  ctx: Context,
  deps: ConsoleRpcDeps | (() => ConsoleRpcDeps),
): boolean {
  const runtime = ctx as Context & {
    inject?: (services: readonly string[], callback: (scoped: Context & { connection?: { rpc?: HostConnectionRpc }; webServer?: WebServerLike }) => unknown) => unknown
    connection?: { rpc?: HostConnectionRpc }
  }
  runtime.inject?.(['connection'], (scoped) => {
    const handler = createConsoleRpcHandler(deps)
    scoped.connection?.rpc?.handle(WEAVE_RPC_CHANNEL, handler, { authority: 'trusted-host' })
  })
  // HTTP fallback for clients that do not have a WebSocket RPC transport.
  runtime.inject?.(['webServer'], (scoped) => {
    const ws = scoped.webServer
    if (!ws?.register) return
    const handler = createConsoleRpcHandler(deps)
    ws.register({
      kind: 'prefix',
      path: WEAVE_RPC_CHANNEL,
      handler: async (req, res) => {
        const url = new URL(String((req as { url?: unknown })?.url ?? '/'), 'http://localhost')
        const pathEndpoint = url.pathname.replace(`${WEAVE_RPC_CHANNEL}/`, '')
        let raw = ''
        await new Promise<void>((resolve) => {
          let done = false
          const finish = (): void => { if (!done) { done = true; resolve() } }
          ;(req as { on?(event: string, cb: (chunk: unknown) => void): unknown }).on?.('data', (chunk) => { raw += String(chunk) })
          ;(req as { on?(event: string, cb: () => void): unknown }).on?.('end', finish)
          setTimeout(finish, 5000)
        })
        let body: Record<string, unknown> = {}
        try { body = JSON.parse(raw) as Record<string, unknown> } catch { /* empty body is valid for zero-arg endpoints */ }
        const rpcId = typeof body.rpcId === 'string' ? body.rpcId : ''
        const endpoint = typeof body.method === 'string' ? body.method : pathEndpoint
        const payload = body.payload ?? {}
        const result = await handler(endpoint, payload)
        ;(res as { writeHead(status: number, headers?: Record<string, string>): unknown }).writeHead?.(200, { 'content-type': 'application/json' })
        ;(res as { end(body?: string): unknown }).end?.(JSON.stringify({ type: 'server-response', rpcId, result }))
      },
    })
  })
  return Boolean(runtime.inject)
}
