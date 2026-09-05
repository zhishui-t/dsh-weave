import type { ExecutorChildPersistence } from '../executors/executor-child-store.js'
import { DEFAULT_ACP_SESSION_INDEX_FILE, type SessionKeyIndexRecord } from '../acp/acp-session-provider.js'
import { existsSync, readFileSync } from 'node:fs'

/**
 * 恢复对账探活（对照官方 agent-team roster.reconcileProvisioning 的三分支裁定）：
 * - alive：continuable 子代理在本进程内活着（agents 注册表可查）——产出回收链完好；
 * - artifacts：会话有持久产物但不在本进程（executor_children 记录且会话树可查到、
 *   或 ACP 会话索引有 acpSid）——可续/可读回，不判死；
 * - dead：两处均无痕迹 → 真死，FAILED(crash_recovery)。
 * 探针自身异常由调用方（RecoveryService）收敛为保守旧行为（FAILED）并审计原因。
 */

export interface RunningTaskProbeInput {
  taskId: string
  executor: string | null
  /** 父 DSH 会话 id（tasks.session_id），listChildren 的会话树根 */
  sessionId: string
  /** 委托会话键：`${team_id}:${assigned_agent}:${project_id}:${version}`（delegation-service 同构） */
  sessionKey: string
}

export type TaskLivenessVerdict =
  | { verdict: 'alive'; childId?: string; detail: string }
  | { verdict: 'artifacts'; childId?: string; detail: string }
  | { verdict: 'dead'; detail: string }

export interface TaskLivenessProbe {
  probeTask(input: RunningTaskProbeInput): Promise<TaskLivenessVerdict>
}

export interface DefaultTaskLivenessProbeOptions {
  /** executor_children 持久映射（core.db v3）；缺省视为无记录（全部走 dead 分支） */
  children?: ExecutorChildPersistence
  /** 宿主 subagents 视面：agents.get 查活子代理；listChildren 查持久会话树（均可选） */
  subagents?: {
    agents?: { get(id: string): unknown }
    listChildren?(parentSessionId: string): Promise<Array<{ id: string; kind: string; mode: string; label?: string }>>
  }
  /** ACP 会话索引文件路径；缺省生产路径 ~/.dsh/weave/acp-session-index.json */
  acpIndexFile?: string
  /** 注入文件读取（测试用）；缺省真实 fs */
  readIndex?: (file: string) => Record<string, SessionKeyIndexRecord> | undefined
}

function readAcpIndex(file: string): Record<string, SessionKeyIndexRecord> {
  try {
    if (!existsSync(file)) return {}
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { keys?: Record<string, SessionKeyIndexRecord> }
    return raw?.keys && typeof raw.keys === 'object' ? raw.keys : {}
  } catch {
    return {}
  }
}

/**
 * 默认探针：executor_children（子代理句柄）+ ACP 会话索引（acpSid）双源探活。
 * 判定顺序：进程内活 → 持久会话树（continuable 记录）→ ACP 索引 → dead。
 */
export class DefaultTaskLivenessProbe implements TaskLivenessProbe {
  readonly #children?: ExecutorChildPersistence
  readonly #subagents?: DefaultTaskLivenessProbeOptions['subagents']
  readonly #acpIndexFile: string
  readonly #readIndex: (file: string) => Record<string, SessionKeyIndexRecord> | undefined

  constructor(options: DefaultTaskLivenessProbeOptions = {}) {
    this.#children = options.children
    this.#subagents = options.subagents
    this.#acpIndexFile = options.acpIndexFile ?? DEFAULT_ACP_SESSION_INDEX_FILE
    this.#readIndex = options.readIndex ?? readAcpIndex
  }

  async probeTask(input: RunningTaskProbeInput): Promise<TaskLivenessVerdict> {
    // 1) executor_children 命中：有 continuable 句柄记录。
    let childId: string | undefined
    try {
      const rows = await this.#children?.load()
      childId = rows?.find((row) => row.sessionKey === input.sessionKey)?.childId
    } catch {
      childId = undefined
    }

    // 2) 子代理在本进程内活着 → alive（产出回收链完好）。
    if (childId !== undefined) {
      const live = this.#subagents?.agents?.get(childId)
      if (live !== undefined && live !== null) {
        return { verdict: 'alive', childId, detail: `child ${childId} live in-process` }
      }
      // 3) 不在进程但持久会话树可查到 → artifacts（durable continuable session，可续）。
      try {
        const tree = await this.#subagents?.listChildren?.(input.sessionId)
        const found = tree?.some((c) => c.id === childId || (c.label === input.sessionKey && c.mode === 'continuable'))
        if (found) {
          return { verdict: 'artifacts', childId, detail: `child ${childId} resumable via durable session tree` }
        }
      } catch {
        // 会话树不可用：继续走 ACP 索引/dead 判定。
      }
    }

    // 4) ACP 会话索引有 acpSid → artifacts（会话已物化，有持久产物，可按 iso-1 链续接）。
    const index = this.#readIndex(this.#acpIndexFile) ?? {}
    const entry = index[input.sessionKey]
    if (entry && typeof entry.acpSid === 'string' && entry.acpSid !== '') {
      return { verdict: 'artifacts', detail: `acp session ${entry.acpSid} materialized in session index` }
    }

    return {
      verdict: 'dead',
      detail: childId !== undefined
        ? `child ${childId} neither live nor resumable`
        : `no executor_children record and no acp session for ${input.sessionKey}`,
    }
  }
}
