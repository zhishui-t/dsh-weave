import type { ExecutorCapabilities, ExecutorProvider, ExecutorStartRequest, ExecutorRun } from './executor-provider.js'

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
}

export interface DshSubagentExecutorProviderOptions {
  /** 可支持的 DSH provider 名；缺省使用构造时的 list() 快照。 */
  executors?: string[]
}

export class DshSubagentExecutorProvider implements ExecutorProvider {
  readonly id = 'dsh-subagent'
  readonly name = 'DSH Subagent'
  readonly kind = 'dsh_subagent'

  readonly capabilities: ExecutorCapabilities = {
    liveOutput: true,
    sessionReuse: false,
    sessionResume: false,
    modelSelection: true,
    providerSelection: true,
    thoughtControl: false,
    thoughtLevels: [],
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

  constructor(subagents: DshSubagentsContext, options: DshSubagentExecutorProviderOptions = {}) {
    this.#subagents = subagents
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
    if (request.runtime?.thoughtLevel && this.capabilities.thoughtControl === false) {
      throw new Error(`dsh-subagent: executor "${request.executor}" does not support thoughtLevel`)
    }
    if (request.runtime?.mode && this.capabilities.modeControl === false) {
      throw new Error(`dsh-subagent: executor "${request.executor}" does not support mode`)
    }

    const run = await this.#subagents.start(request.executor, {
      prompt: [{ type: 'text', text: request.prompt.map((block) => block.text).join('\n\n') }],
      parent: request.parent,
      signal: request.signal,
      ...(request.runtime?.model ? {
        agentOptions: {
          ...(request.runtime.model.provider !== undefined ? { provider: request.runtime.model.provider } : {}),
          ...(request.runtime.model.id !== undefined ? { model: request.runtime.model.id } : {}),
        },
      } : {}),
    })

    return {
      ...run,
      providerId: this.id,
      sessionId: typeof run.id === 'string' ? run.id : undefined,
      applied: {
        model: {
          requested: request.runtime?.model,
          effective: request.runtime?.model,
          supported: true,
        },
        thinking: {
          requested: request.runtime?.thoughtLevel,
          effective: null,
          supported: false,
          fallback: true,
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
      },
    }
  }
}
