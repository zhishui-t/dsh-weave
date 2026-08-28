import { installModelSelection } from '@deepseek-ai/dsh-agent'
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

    // DSH 子代理的 AgentOptions 本身不接收 reasoningEffort；
    // 但子代理以 localAgent 暴露时，可把 thought_level 安装到其 scope 的模型选择上。
    if (request.runtime?.thoughtLevel) {
      const child = run.localAgent as {
        ctx?: { on?: (event: string, listener: unknown) => unknown }
        options?: { provider?: string; model?: string }
      } | undefined
      if (!child?.ctx?.on || typeof child.ctx.on !== 'function') {
        throw new Error(`dsh-subagent: executor "${request.executor}" cannot apply thoughtLevel without an in-process localAgent`)
      }
      const provider = request.runtime.model?.provider ?? child.options?.provider
      const model = request.runtime.model?.id ?? child.options?.model
      if (!provider || !model) {
        throw new Error(`dsh-subagent: executor "${request.executor}" needs provider/model when applying thoughtLevel`)
      }
      installModelSelection(child.ctx as Parameters<typeof installModelSelection>[0], {
        current: {
          provider,
          model,
          reasoningEffort: request.runtime.thoughtLevel as never,
        },
        assembled: undefined,
      })
    }

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
      },
    }
  }
}
