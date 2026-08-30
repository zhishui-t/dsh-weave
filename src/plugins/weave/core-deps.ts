import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { AuditLog, DEFAULT_AUDIT_DIR } from './audit/audit-log.js'
import { AcpSessionProvider, DEFAULT_ACP_SESSION_INDEX_FILE, ZcodeAcpExecutorProvider, zcodeAcpProviderConfigFromEnvironment, type AcpSessionProviderConfig } from './acp/acp-session-provider.js'
import { ExecutorRegistry } from './executor-registry.js'
import { ExecutorProviderRegistry } from './executors/executor-provider.js'
import { DshSubagentExecutorProvider } from './executors/dsh-subagent-executor-provider.js'
import { KnowledgeStore } from './knowledge-model.js'
import { openPersistence } from './persistence/persistence.js'
import { TeamManager } from './team-manager.js'

export interface CoreDepsOptions {
  stateDir?: string
  teamsDir?: string
  auditDir?: string
  knowledgeDir?: string
}

export interface CoreDeps {
  persistence: ReturnType<typeof openPersistence>
  teamManager: TeamManager
  executorRegistry: ExecutorRegistry
  knowledgeStore: KnowledgeStore
  audit: AuditLog
}

/** Minimal dependency set used by the fork integration path. */
export function createCoreDeps(ctx: Context, options: CoreDepsOptions = {}): CoreDeps {
  const persistence = openPersistence({ ...(options.stateDir ? { stateDir: options.stateDir } : {}) })
  const registry = new ExecutorRegistry()
  registry.load(ctx as never)
  const teamsDir = options.teamsDir ?? join(homedir(), '.dsh', 'teams')
  const knowledgeRoot = options.knowledgeDir ?? join(homedir(), '.dsh', 'knowledge')
  const auditDir = options.auditDir ?? DEFAULT_AUDIT_DIR
  return {
    persistence,
    teamManager: new TeamManager(registry, { teamsDir, persistence }),
    executorRegistry: registry,
    knowledgeStore: new KnowledgeStore({ rootDir: knowledgeRoot, metaDb: persistence.knowledgeMeta }),
    audit: new AuditLog({ dir: auditDir }),
  }
}

export interface CreateDefaultExecutorProviderRegistryOptions {
  zcode?: AcpSessionProviderConfig
  includeDsh?: boolean
}

/** Create the unified executor provider registry (ZCode ACP + DSH fallback). */
export function createDefaultExecutorProviderRegistry(
  ctx: Context,
  options: CreateDefaultExecutorProviderRegistryOptions = {},
): ExecutorProviderRegistry {
  const registry = new ExecutorProviderRegistry()
  const runtimeCtx = ctx as Context & {
    subprocess?: {
      spawn(spec: {
        argv: string[]
        cwd?: string
        env?: Record<string, string>
        stdio: { stdin: 'pipe'; stdout: 'pipe'; stderr: 'inherit' | 'ignore' | 'pipe' }
        graceMs?: number
      }): unknown
    }
  }
  const zcodeConfig = options.zcode ?? zcodeAcpProviderConfigFromEnvironment(process.env)
  const subagents = ctx.reflect.get('subagents', false) as
    | { registerProvider?(provider: unknown): () => void }
    | undefined
  const subprocess = runtimeCtx.subprocess

  if (zcodeConfig && subprocess) {
    const acp = new AcpSessionProvider(
      {
        ...zcodeConfig,
        sessionIndexFile: DEFAULT_ACP_SESSION_INDEX_FILE,
      },
      (spec) => subprocess.spawn(spec) as never,
    )
    subagents?.registerProvider?.(acp)
    registry.register(new ZcodeAcpExecutorProvider(acp))
  }
  if (options.includeDsh !== false && subagents) {
    const agents = (ctx as Context & { reflect?: { get(name: string, fallback?: boolean): unknown } }).reflect?.get?.('agents', false) as
      | { get(id: string): unknown }
      | undefined
    registry.register(new DshSubagentExecutorProvider(subagents as never, { agents }))
  }
  return registry
}
