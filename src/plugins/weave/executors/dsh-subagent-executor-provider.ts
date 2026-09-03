import { foldConsumedWork, installModelSelection } from '@deepseek-ai/dsh-agent'
import { finalAssistantOutput } from '@deepseek-ai/dsh-subagent'
import type { ExecutorCapabilities, ExecutorProvider, ExecutorStartRequest, ExecutorRun, ExecutorRuntimeOptions } from './executor-provider.js'

import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 执行器复用调试日志：WEAVE_EXEC_DEBUG=1 时追加到 ~/.dsh/weave/exec-debug.log（排障用，失败静默）。 */
function debugLog(event: string, detail: Record<string, unknown>): void {
  if (process.env.WEAVE_EXEC_DEBUG !== '1') return
  try {
    const dir = join(homedir(), '.dsh', 'weave')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'exec-debug.log'), `${new Date().toISOString()} ${event} ${JSON.stringify(detail)}
`, 'utf-8')
  } catch {
    /* 调试日志失败不影响主链路 */
  }
}

interface DshSubagentsContext {
  list(): string[]
  start(
    name: string,
    request: {
      prompt: Array<{ type: 'text'; text: string }>
      parent?: unknown
      signal: AbortSignal
      agentOptions?: { provider?: string; model?: string }
    },
  ): Promise<{
    id: string
    localAgent?: unknown
    result: Promise<{ output: Array<{ type: string; text?: string }>; stopReason: string }>
    dispose(): Promise<void>
  }>
  startContinuable?(spec: {
    provider: string
    label?: string
    request: {
      prompt: Array<{ type: 'text'; text: string }>
      parent?: unknown
      signal: AbortSignal
      agentOptions?: { provider?: string; model?: string }
    }
    signal: AbortSignal
  }): Promise<{ childId: string }>
  followup?(
    parent: unknown,
    childId: string,
    content: Array<{ type: 'text'; text: string }>,
    options: { source: Record<string, unknown>; signal: AbortSignal },
  ): Promise<unknown>
  listChildren?(
    parentSessionId: string,
    signal?: AbortSignal,
  ): Promise<Array<{ kind: 'child'; id: string; mode: 'one-shot' | 'continuable'; label?: string }>>
  agents?: {
    get(id: string): unknown
  }
}

interface ChildAgentLike {
  id?: string
  whenIdle?(): Promise<void>
  session?: { events?: Array<{ type: string; data?: { reason?: { kind?: string } } }> }
  ctx?: { on?: (event: string, listener: unknown) => unknown }
  options?: { provider?: string; model?: string }
}

export interface DshSubagentExecutorProviderOptions {
  /** 可支持的 DSH provider 名；缺省使用构造时的 list() 快照。 */
  executors?: string[]
  /** 可选的活 Agent 注册表，用于 continuable 子代理复用；缺失时自动退化为 one-shot。 */
  agents?: { get(id: string): unknown }
}

function toStopReason(reason: { kind?: string } | undefined): string {
  switch (reason?.kind) {
    case 'completed': return 'completed'
    case 'max-tokens': return 'max-tokens'
    case 'aborted': return 'aborted'
    case 'blocked': return 'refusal'
    default: return 'error'
  }
}

function parentIdOf(parent: unknown): string {
  if (typeof parent === 'object' && parent !== null && 'id' in parent) {
    const id = (parent as { id?: unknown }).id
    if (typeof id === 'string') return id
  }
  return ''
}

function buildAgentOptions(request: ExecutorStartRequest): { provider?: string; model?: string; maxTokens: number } | undefined {
  const model = request.runtime?.model
  if (!model && !request.runtime?.thoughtLevel) return { maxTokens: NO_MAX_TOKEN_LIMIT }
  return {
    ...(model?.provider !== undefined ? { provider: model.provider } : {}),
    ...(model?.id !== undefined ? { model: model.id } : {}),
    maxTokens: NO_MAX_TOKEN_LIMIT,
  }
}

/** 用户裁定：DSH 子代理不设 max token 限制。 */
const NO_MAX_TOKEN_LIMIT = 1_000_000

function readChildResult(child: ChildAgentLike, boundary: number, cancelled: boolean): {
  output: Array<{ type: string; text?: string }>
  stopReason: string
} {
  const own = (child.session?.events?.slice(boundary) ?? []) as unknown as Parameters<typeof foldConsumedWork>[0]
  const lastEnd = foldConsumedWork(own).end
  const output = (finalAssistantOutput(own) ?? []) as Array<{ type: string; text?: string }>
  const recorded = toStopReason((lastEnd?.data as { reason?: { kind?: string } } | undefined)?.reason)
  const stopReason = cancelled && recorded !== 'completed' ? 'aborted' : recorded
  return { output, stopReason }
}

export class DshSubagentExecutorProvider implements ExecutorProvider {
  readonly id = 'dsh-subagent'
  readonly name = 'DSH Subagent'
  readonly kind = 'dsh_subagent'

  readonly capabilities: ExecutorCapabilities = {
    liveOutput: true,
    sessionReuse: true,
    sessionResume: true,
    modelSelection: true,
    providerSelection: true,
    thoughtControl: true,
    thoughtLevels: ['off', 'low', 'high', 'max'],
    modeControl: false,
    modes: [],
    tools: {
      externalRuntime: false,
      filtering: 'full',
      permission: 'ask',
    },
  }

  readonly #subagents: DshSubagentsContext
  readonly #explicitExecutors?: Set<string>
  readonly #children = new Map<string, string>()
  readonly #boundaries = new Map<string, number>()

  constructor(subagents: DshSubagentsContext, options: DshSubagentExecutorProviderOptions = {}) {
    this.#subagents = options.agents
      ? { ...subagents, agents: options.agents }
      : subagents
    this.#explicitExecutors = options.executors ? new Set(options.executors) : undefined
  }

  supports(executor: string): boolean {
    if (this.#explicitExecutors) return this.#explicitExecutors.has(executor)
    try {
      return this.#subagents.list().includes(executor)
    } catch {
      return false
    }
  }

  async start(request: ExecutorStartRequest): Promise<ExecutorRun> {
    if (!this.supports(request.executor)) {
      throw new Error(`dsh-subagent: unsupported executor "${request.executor}"`)
    }
    if (request.runtime?.mode && this.capabilities.modeControl === false) {
      throw new Error(`dsh-subagent: executor "${request.executor}" does not support mode`)
    }

    const sessionKey = request.sessionKey
    const continuableReady = Boolean(sessionKey && this.#subagents.startContinuable && this.#subagents.followup && this.#subagents.agents?.get)
    if (sessionKey && !continuableReady) {
      debugLog('continuable API incomplete', {
        executor: request.executor, sessionKey,
        hasStartContinuable: Boolean(this.#subagents.startContinuable),
        hasFollowup: Boolean(this.#subagents.followup),
        hasAgentsGet: Boolean(this.#subagents.agents?.get),
      })
    }
    if (continuableReady) {
      try {
        return await this.#startContinuable(request, sessionKey)
      } catch (error) {
        // fork 的会话连续性是业务约束：复用失败时不能静默再 fork 一个新子代理。
        if (request.executor === 'fork') throw error
        debugLog('continuable reuse failed -> one-shot fallback', {
          executor: request.executor, sessionKey, error: String(error).slice(0, 300),
        })
        console.warn('[dsh-weave] dsh-subagent continuable reuse failed, falling back to one-shot:', error)
      }
    }
    if (request.executor === 'fork') {
      throw new Error('dsh-subagent: fork executor requires continuable session APIs')
    }
    return this.#startOneShot(request)
  }

  async #startOneShot(request: ExecutorStartRequest): Promise<ExecutorRun> {
    const run = await this.#subagents.start(request.executor, {
      prompt: [{ type: 'text', text: request.prompt.map((block) => block.text).join('\n\n') }],
      parent: request.parent,
      signal: request.signal,
      agentOptions: buildAgentOptions(request),
    })

    this.#applyThoughtLevel(run.localAgent as ChildAgentLike | undefined, request.runtime)

    return {
      ...run,
      providerId: this.id,
      sessionId: typeof run.id === 'string' ? run.id : undefined,
      applied: this.#applied(request),
    }
  }

  async #startContinuable(request: ExecutorStartRequest, sessionKey: string): Promise<ExecutorRun> {
    const prompt = [{ type: 'text' as const, text: request.prompt.map((block) => block.text).join('\n\n') }]

    const agentOptions = buildAgentOptions(request)

    let childId = this.#children.get(sessionKey)
    if (childId === undefined && this.#subagents.listChildren) {
      try {
        const parentId = parentIdOf(request.parent)
        if (parentId) {
          const children = await this.#subagents.listChildren(parentId, request.signal)
          const existing = children.find((c) => c.kind === 'child' && c.mode === 'continuable' && c.label === sessionKey) as
            | { kind: 'child'; id: string; mode: 'continuable'; label?: string }
            | undefined
          if (existing?.id) {
            childId = existing.id
            this.#children.set(sessionKey, childId)
          }
        }
      } catch {
        // 会话树不可用时退回内存/新建路径；不阻断。
      }
    }

    let boundary = 0
    if (childId === undefined) {
      const started = await this.#subagents.startContinuable!({
        provider: request.executor,
        label: sessionKey,
        request: {
          prompt,
          parent: request.parent,
          signal: request.signal,
          ...(agentOptions ? { agentOptions } : {}),
        },
        signal: request.signal,
      })
      childId = started.childId
      this.#children.set(sessionKey, childId)
      const initialChild = this.#subagents.agents!.get(childId) as ChildAgentLike | undefined
      if (!initialChild || typeof initialChild.whenIdle !== 'function') {
        throw new Error(`dsh-subagent: continuable child "${childId}" is not live`)
      }
      boundary = initialChild.session?.events?.length ?? 0
    } else {
      const existingChild = this.#subagents.agents!.get(childId) as ChildAgentLike | undefined
      if (!existingChild || typeof existingChild.whenIdle !== 'function') {
        throw new Error(`dsh-subagent: continuable child "${childId}" is not live`)
      }
      // followup 可能同步触发事件；先记录边界，避免把本轮输出误算进上一轮/漏掉本轮。
      boundary = existingChild.session?.events?.length ?? 0
      await this.#subagents.followup!(request.parent, childId, prompt, {
        source: {
          kind: 'coordinator',
          form: 'relay',
          senderSessionId: parentIdOf(request.parent) || sessionKey,
        },
        signal: request.signal,
      })
    }

    const child = this.#subagents.agents!.get(childId) as ChildAgentLike | undefined
    if (!child || typeof child.whenIdle !== 'function') {
      throw new Error(`dsh-subagent: continuable child "${childId}" is not live`)
    }

    this.#applyThoughtLevel(child, request.runtime)
    this.#boundaries.set(childId, boundary)

    let cancelled = false
    const onAbort = (): void => {
      cancelled = true
      const agent = child as unknown as { cancel?: (cause: unknown, options?: unknown) => void }
      agent.cancel?.({ kind: 'parent' })
    }
    request.signal.addEventListener('abort', onAbort, { once: true })

    const result = (async () => {
      try {
        await child.whenIdle?.()
        return readChildResult(child, boundary, cancelled)
      } finally {
        request.signal.removeEventListener('abort', onAbort)
      }
    })()

    return {
      id: childId,
      sessionId: childId,
      localAgent: child,
      result,
      dispose: async () => {
        // Continuable children are intentionally kept for later reuse; no-op dispose.
      },
      providerId: this.id,
      applied: this.#applied(request),
    }
  }

  #applyThoughtLevel(child: ChildAgentLike | undefined, runtime: ExecutorRuntimeOptions | undefined): void {
    if (!runtime?.thoughtLevel) return
    if (!child) {
      throw new Error(`dsh-subagent: executor cannot apply thoughtLevel without an in-process localAgent`)
    }
    if (!child.ctx?.on || typeof child.ctx.on !== 'function') {
      throw new Error(`dsh-subagent: executor cannot apply thoughtLevel without an in-process localAgent`)
    }
    const provider = runtime.model?.provider ?? child.options?.provider
    const model = runtime.model?.id ?? child.options?.model
    if (!provider || !model) {
      throw new Error(`dsh-subagent: executor needs provider/model when applying thoughtLevel`)
    }
    installModelSelection(child.ctx as Parameters<typeof installModelSelection>[0], {
      current: {
        provider,
        model,
        reasoningEffort: runtime.thoughtLevel as never,
      },
      assembled: undefined,
    })
  }

  #applied(request: ExecutorStartRequest): ExecutorRun['applied'] {
    return {
      model: {
        requested: request.runtime?.model,
        effective: request.runtime?.model,
        supported: true,
      },
      thinking: {
        requested: request.runtime?.thoughtLevel,
        effective: request.runtime?.thoughtLevel ?? null,
        supported: request.runtime?.thoughtLevel ? true : false,
      },
      mode: {
        requested: request.runtime?.mode,
        effective: null,
        supported: false,
      },
      tools: {
        requested: request.runtime?.tools,
        effective: { management: 'dsh', filtering: 'full' },
        supported: true,
      },
    }
  }
}
