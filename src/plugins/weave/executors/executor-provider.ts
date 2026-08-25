import type { ContentBlockLike } from '../delegation-service.js'
import type { DelegationRunLike } from '../delegation-service.js'

export type ExecutorStopReason =
  | 'completed'
  | 'aborted'
  | 'error'
  | 'max-tokens'
  | 'refusal'
  | string

export interface ExecutorContentBlock {
  type: 'text'
  text: string
}

export interface ExecutorModelSelection {
  /** 模型所属 provider；语义由目标执行器定义。 */
  provider?: string
  /** 模型 id；省略时表示仅覆盖 provider。 */
  id?: string
}

export interface ExecutorToolsPolicy {
  management: 'external' | 'disabled' | 'deny' | 'allow' | 'full'
  permission?: 'allow' | 'reject' | 'ask'
  allowedTools?: string[]
  deniedTools?: string[]
  onUnsupportedFilter?: 'error' | 'fallback'
}

export interface ExecutorRuntimeOptions {
  model?: ExecutorModelSelection
  thoughtLevel?: string
  mode?: string
  tools?: ExecutorToolsPolicy
}

export interface ExecutorStartRequest {
  executor: string
  /** 稳定会话键；同一 key 复用同一会话。 */
  sessionKey: string
  prompt: Array<ExecutorContentBlock | ContentBlockLike>
  parent?: unknown
  signal: AbortSignal
  runtime?: ExecutorRuntimeOptions
  /** 显式恢复指定 ACP/远端会话；优先于 sessionKey 的默认映射。 */
  resumeSessionId?: string
}

export interface ExecutorAppliedCapability {
  requested?: unknown
  effective?: unknown
  supported: boolean
  fallback?: boolean
}

export interface ExecutorResult {
  output: Array<{ type: string; text?: string }>
  structured?: unknown
  diagnostic?: string
  stopReason: ExecutorStopReason
  applied?: {
    model?: ExecutorAppliedCapability
    thinking?: ExecutorAppliedCapability
    mode?: ExecutorAppliedCapability
    tools?: ExecutorAppliedCapability
  }
}

export interface ExecutorEvent {
  taskId?: string
  executor?: string
  runId?: string
  sessionId?: string
  type: 'status' | 'output' | 'reasoning' | 'tool_call' | 'tool_result' | 'error'
  text?: string
  name?: string
  data?: unknown
  at: number
}

export interface ExecutorRun extends Omit<DelegationRunLike, 'result'> {
  providerId: string
  sessionId?: string
  result: Promise<ExecutorResult>
  applied?: ExecutorResult['applied']
  /** Provider 应至少支持事件缓冲快照；不支持实时流的实现可省略。 */
  readOutput?(): ExecutorEvent[]
  /** 实时订阅；不支持时可省略，由调用方轮询 readOutput。 */
  onEvent?(listener: (event: ExecutorEvent) => void): () => void
}

export interface ExecutorCapabilities {
  liveOutput: boolean
  sessionReuse: boolean
  sessionResume: boolean
  modelSelection: boolean
  providerSelection: boolean
  thoughtControl: boolean
  thoughtLevels: readonly string[]
  modeControl: boolean
  modes: readonly string[]
  tools: {
    externalRuntime: boolean
    filtering: 'none' | 'deny' | 'allow' | 'full'
    permission: 'none' | 'reject' | 'allow' | 'ask'
  }
}

export interface ExecutorProvider {
  id: string
  name: string
  kind: 'dsh_subagent' | 'acp' | 'codex' | 'claude' | 'custom' | string
  capabilities: ExecutorCapabilities
  supports(executor: string): boolean
  start(request: ExecutorStartRequest): Promise<ExecutorRun>
  dispose?(): Promise<void>
}

export class ExecutorProviderRegistry {
  readonly #providers = new Map<string, ExecutorProvider>()

  register(provider: ExecutorProvider, options: { override?: boolean } = {}): () => void {
    const id = provider.id
    if (!options.override && this.#providers.has(id)) {
      throw new Error(`executor provider already registered: ${id}`)
    }
    this.#providers.set(id, provider)
    return () => this.#providers.delete(id)
  }

  get(id: string): ExecutorProvider | undefined {
    return this.#providers.get(id)
  }

  require(id: string): ExecutorProvider {
    const provider = this.get(id)
    if (!provider) throw new Error(`executor provider not registered: ${id}`)
    return provider
  }

  resolve(executor: string): ExecutorProvider | undefined {
    for (const provider of this.#providers.values()) {
      if (provider.supports(executor)) return provider
    }
    return undefined
  }

  list(): ExecutorProvider[] {
    return [...this.#providers.values()]
  }
}
