import { Readable, Writable } from 'node:stream'

import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from '@agentclientprotocol/sdk'

export type AcpExecutorEventType =
  | 'status'
  | 'output'
  | 'reasoning'
  | 'tool_call'
  | 'tool_result'

export interface AcpExecutorEvent {
  taskId?: string
  executor?: string
  runId?: string
  sessionId?: string
  type: AcpExecutorEventType
  text?: string
  name?: string
  data?: unknown
  at: number
}

export interface AcpSessionProviderConfig {
  name: string
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  permission?: 'allow' | 'reject'
}

interface SpawnedProcess {
  pid?: number
  stdin?: unknown
  stdout?: unknown
  done: Promise<unknown>
  waitForExit(signal?: AbortSignal): Promise<void>
  terminate(): Promise<void> | void
}

interface AcpConnectionLike {
  initialize(params: unknown): Promise<unknown>
  newSession(params: { cwd: string; mcpServers: unknown[] }): Promise<{ sessionId: string }>
  loadSession?(params: { sessionId: string; cwd: string; mcpServers: unknown[] }): Promise<unknown>
  prompt(params: { sessionId: string; prompt: Array<{ type: 'text'; text: string }> }): Promise<{ stopReason: string }>
  cancel(params: { sessionId: string }): Promise<void>
  extMethod(method: string, params: Record<string, unknown>): Promise<unknown>
  signal: AbortSignal
}

export interface AcpSessionConnection {
  key: string
  conn: AcpConnectionLike
  process: SpawnedProcess
  dead: boolean
  sessions: Set<string>
  handleSessionUpdate?(update: AcpSessionUpdate): void
  /** 测试夹具可额外记录调用。 */
  cwd?: string
  newSession?: AcpConnectionLike['newSession']
}

interface AcpSessionUpdate {
  sessionId?: string
  sessionUpdate?: string
  content?: { type?: string; text?: string }
  title?: string
  status?: string
  toolCallId?: string
}

/** 依赖注入连接的最小形态，便于测试与替换真实 SDK 连接。 */
export interface AcpSessionFactoryConnection {
  key: string
  cwd?: string
  sessions: Set<string>
  initialize(params: unknown): Promise<unknown>
  newSession(params: { cwd: string; mcpServers: unknown[] }): Promise<{ sessionId: string }>
  loadSession?(params: { sessionId: string; cwd: string; mcpServers: unknown[] }): Promise<unknown>
  prompt(params: { sessionId: string; prompt: Array<{ type: 'text'; text: string }> }): Promise<{ stopReason: string }>
  cancel(params: { sessionId: string }): Promise<void>
  extMethod(method: string, params: Record<string, unknown>): Promise<unknown>
  signal: AbortSignal
  handleSessionUpdate?(update: AcpSessionUpdate): void
}

interface SessionRecord {
  sessionId: string
  connectionKey: string
}

interface StartOptions {
  sessionKey?: string
  resumeSessionId?: string
  modelProvider?: string
  model?: string
  thoughtLevel?: string
  mode?: string
}

interface RunController {
  events: AcpExecutorEvent[]
  listeners: Set<(event: AcpExecutorEvent) => void>
  output: Array<{ type: 'text'; text: string }>
}

async function disposeProcess(process: SpawnedProcess, eofGraceMs: number): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), eofGraceMs)
  try {
    ;(process.stdin as { end?: () => void } | undefined)?.end?.()
    await process.waitForExit(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

function normalizeAcpStopReason(reason: string): 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal' {
  if (reason === 'end_turn') return 'completed'
  if (reason === 'cancelled') return 'aborted'
  if (reason === 'max_tokens') return 'max-tokens'
  if (reason === 'refusal') return 'refusal'
  return 'error'
}

/**
 * 长连接 ACP 执行器 Provider。
 * 与 stock dsh-subagent-acp 不同：按 sessionKey 复用会话，支持模型/思考深度
 * 扩展，并暴露实时 session/update 事件；run.dispose 只取消当前 prompt。
 */
export class AcpSessionProvider {
  readonly name: string
  readonly capabilities = { outputSchema: false, depthLimit: false, toolFilter: false, persona: false }
  readonly inheritsParentContext = false

  readonly #command: string
  readonly #args: string[]
  readonly #configuredCwd?: string
  readonly #env: Record<string, string>
  readonly #permission: 'allow' | 'reject'
  readonly #spawn: AcpSpawn['spawn']
  readonly #connect?: (cwd: string, key: string) => Promise<AcpSessionFactoryConnection>
  readonly #connections = new Map<string, AcpSessionConnection>()
  readonly #sessions = new Map<string, SessionRecord>()
  readonly #prompts = new Map<string, Promise<unknown>>()
  readonly #runs = new Map<string, RunController>()

  constructor(
    config: AcpSessionProviderConfig,
    spawn: AcpSpawn['spawn'],
    connect?: (cwd: string, key: string) => Promise<AcpSessionFactoryConnection>,
  ) {
    this.name = config.name
    this.#command = config.command
    this.#args = config.args ?? []
    this.#configuredCwd = config.cwd
    this.#env = config.env ?? {}
    this.#permission = config.permission ?? 'reject'
    this.#spawn = spawn
    this.#connect = connect
  }

  async start(request: {
    parent?: unknown
    signal: AbortSignal
    prompt: Array<{ type: string; text?: string }>
    weave?: StartOptions
  }): Promise<{
    id: string
    localAgent: undefined
    result: Promise<{ output: Array<{ type: string; text?: string }>; stopReason: string }>
    dispose(): Promise<void>
    readOutput(): AcpExecutorEvent[]
    onEvent(listener: (event: AcpExecutorEvent) => void): () => void
  }> {
    if (request.signal.aborted) throw new Error(`${this.name}: aborted before ACP session started`)

    const weave = request.weave ?? {}
    const parent = request.parent as { session?: { header?: { cwd?: string } } } | undefined
    const cwd = this.#configuredCwd ?? parent?.session?.header?.cwd
    if (!cwd) throw new Error(`${this.name}: cwd is required`)

    const sessionKey = weave.sessionKey ?? `${cwd}`
    const connection = await this.#acquireConnection(cwd)
    let sessionId = weave.resumeSessionId ?? this.#sessions.get(sessionKey)?.sessionId
    const knownInConnection = sessionId !== undefined && connection.sessions.has(sessionId)

    if (sessionId === undefined || !knownInConnection) {
      if (sessionId !== undefined && connection.conn.loadSession) {
        await connection.conn.loadSession({ sessionId, cwd, mcpServers: [] })
      } else {
        const created = await connection.conn.newSession({ cwd, mcpServers: [] })
        sessionId = created.sessionId
      }
      this.#sessions.set(sessionKey, { sessionId, connectionKey: connection.key })
    }

    const runId = `acp-${sessionId}`
    const controller = this.#startRunController(runId)

    if (weave.model) {
      const modelValue = weave.modelProvider
        ? weave.modelProvider + String.fromCharCode(92) + weave.model
        : weave.model
      await connection.conn.extMethod('session/setModel', { sessionId, modelId: modelValue })
      this.#emit(controller, { type: 'status', text: `model=${modelValue}` })
    }

    if (weave.thoughtLevel) {
      await connection.conn.extMethod('session/setThoughtLevel', {
        sessionId,
        thoughtLevel: weave.thoughtLevel,
      })
      this.#emit(controller, { type: 'status', text: `thought=${weave.thoughtLevel}` })
    }

    if (weave.mode) {
      await connection.conn.extMethod('session/setMode', { sessionId, mode: weave.mode })
      this.#emit(controller, { type: 'status', text: `mode=${weave.mode}` })
    }

    const previous = this.#prompts.get(sessionKey) ?? Promise.resolve()
    const queuedPrompt = previous.catch(() => undefined).then(async () => {
      const result = await connection.conn.prompt({
        sessionId,
        prompt: request.prompt.filter((block): block is { type: 'text'; text: string } => block.type === 'text'),
      })
      return {
        output: [...controller.output],
        stopReason: normalizeAcpStopReason(result.stopReason),
      }
    })

    this.#prompts.set(sessionKey, queuedPrompt)
    const cancel = (): void => {
      connection.conn.cancel({ sessionId }).catch(() => undefined)
    }
    if (request.signal.aborted) cancel()
    else request.signal.addEventListener('abort', cancel, { once: true })

    const result = queuedPrompt.finally(() => {
      if (this.#prompts.get(sessionKey) === queuedPrompt) this.#prompts.delete(sessionKey)
      request.signal.removeEventListener('abort', cancel)
    })

    return {
      id: runId,
      localAgent: undefined,
      result,
      dispose: async () => {
        cancel()
        await result.catch(() => undefined)
      },
      readOutput: () => [...controller.events],
      onEvent: (listener) => {
        controller.listeners.add(listener)
        return () => controller.listeners.delete(listener)
      },
    }
  }

  async dispose(): Promise<void> {
    const processes = [...this.#connections.values()].map((item) => item.process)
    this.#connections.clear()
    this.#sessions.clear()
    this.#prompts.clear()
    this.#runs.clear()
    await Promise.allSettled(processes.map((item) => disposeProcess(item, 3000)))
  }

  #handleSessionUpdate(connection: AcpSessionConnection, update: AcpSessionUpdate): void {
    if (update.sessionId) connection.sessions.add(update.sessionId)
    const controller = this.#runs.get(`acp-${update.sessionId}`)
    if (!controller) return

    const push = (event: Omit<AcpExecutorEvent, 'at'>) => {
      const full: AcpExecutorEvent = { ...event, at: Date.now() }
      controller.events.push(full)
      for (const listener of controller.listeners) listener(full)
    }
    const outputText = update.sessionUpdate === 'agent_message_chunk'
      ? update.content?.type === 'text' ? update.content.text : undefined
      : undefined
    if (typeof outputText === 'string') {
      controller.output.push({ type: 'text', text: outputText })
      push({ type: 'output', text: outputText })
    } else if (update.sessionUpdate === 'agent_thought_chunk' && update.content?.type === 'text') {
      push({ type: 'reasoning', text: update.content.text })
    } else if (update.sessionUpdate === 'tool_call') {
      push({ type: 'tool_call', name: update.title, data: update })
    } else if (update.sessionUpdate === 'tool_call_update') {
      push({ type: 'tool_result', name: update.toolCallId, data: update })
    }
  }

  async #acquireConnection(cwd: string): Promise<AcpSessionConnection> {
    const key = `${this.#command}:${this.#args.join(' ')}:${cwd}`
    const existing = this.#connections.get(key)
    if (existing && !existing.dead) return existing
    if (this.#connect) {
      const factoryConnection = await this.#connect(cwd, key)
      const connection: AcpSessionConnection = {
        ...factoryConnection,
        conn: factoryConnection,
        process: {
          done: new Promise(() => undefined),
          waitForExit: async () => undefined,
          terminate: async () => undefined,
        },
        dead: false,
        handleSessionUpdate: (update) => this.#handleSessionUpdate(connection, update),
      }
      this.#connections.set(key, connection)
      // 让测试/工厂持有的同一连接对象也能触发 Provider 事件路由。
      factoryConnection.handleSessionUpdate = connection.handleSessionUpdate
      return connection
    }

    const child = this.#spawn({
      argv: [this.#command, ...this.#args],
      cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
      graceMs: 3000,
      env: this.#env,
    })
    if (!child.stdin || !child.stdout) throw new Error(`${this.name}: ACP stdin/stdout streams are required`)

    const permission = this.#permission
    const connection: AcpSessionConnection = { key, conn: undefined as unknown as AcpConnectionLike, process: child, dead: false, sessions: new Set(), handleSessionUpdate: (update) => this.#handleSessionUpdate(connection, update) }

    const client = {
      requestPermission(params: { options: Array<{ kind?: string; optionId?: string | number }> }) {
        if (permission !== 'allow') return { outcome: { outcome: 'cancelled' } }
        const option =
          params.options.find((item) => item.kind === 'allow_once') ??
          params.options.find((item) => item.kind === 'allow_always') ??
          params.options[0]
        return option
          ? { outcome: { outcome: 'selected', optionId: option.optionId } }
          : { outcome: { outcome: 'cancelled' } }
      },
      sessionUpdate(params: { update: AcpSessionUpdate }) {
        connection.handleSessionUpdate?.(params.update)
      },
    }

    const conn = new ClientSideConnection(
      () => client as any,
      ndJsonStream(
        Writable.toWeb(child.stdin as Parameters<typeof Writable.toWeb>[0]) as never,
        Readable.toWeb(child.stdout as Parameters<typeof Readable.toWeb>[0]) as never,
    ),
    )
    connection.conn = conn
    this.#connections.set(key, connection)
    conn.signal.addEventListener('abort', () => { connection.dead = true }, { once: true })

    await conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: false } },
    })
    return connection
  }

  #startRunController(runId: string): RunController {
    const existing = this.#runs.get(runId)
    if (existing) return existing
    const created: RunController = { events: [], listeners: new Set(), output: [] }
    this.#runs.set(runId, created)
    return created
  }

  #emit(controller: RunController, event: Omit<AcpExecutorEvent, 'at'>): void {
    const full: AcpExecutorEvent = { ...event, at: Date.now() }
    controller.events.push(full)
    for (const listener of controller.listeners) {
      try {
        listener(full)
      } catch {
        // UI / 观察者异常不影响 executor 主链路。
      }
    }
  }
}

export interface AcpSpawn {
  spawn(spec: {
    argv: string[]
    cwd?: string
    env?: Record<string, string>
    stdio: { stdin: 'pipe'; stdout: 'pipe'; stderr: 'inherit' | 'ignore' | 'pipe' }
    graceMs?: number
  }): SpawnedProcess
}

export interface AcpProviderRegistryContext {
  subagents?: {
    registerProvider(provider: unknown): () => void
  }
  subprocess?: {
    spawn(spec: Parameters<AcpSpawn['spawn']>[0]): SpawnedProcess
  }
}

/**
 * 从环境变量构造 ZCode ACP Provider 配置：
 * - WEAVE_ZCODE_ACP_SERVER：zcode-acp-server 的 dist/index.js 绝对路径
 * - WEAVE_ZCODE_BIN：ZCode CLI / zcode.cjs 路径
 * - WEAVE_ZCODE_NODE：可选，运行 ZCode 的 Node 可执行文件
 * - WEAVE_ZCODE_ACP_DEBUG：可选，设为 1 开启桥接诊断
 */
export function zcodeAcpProviderConfigFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): AcpSessionProviderConfig | undefined {
  const serverPath = env.WEAVE_ZCODE_ACP_SERVER
  if (!serverPath) return undefined
  const zcodeBin = env.WEAVE_ZCODE_BIN
  if (!zcodeBin) return undefined

  const zcodeNode = env.WEAVE_ZCODE_NODE
  const debug = env.WEAVE_ZCODE_ACP_DEBUG === '1'
  return {
    name: 'zcode',
    command: process.execPath,
    args: [serverPath],
    env: {
      ...Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      ),
      ...(zcodeBin ? { ZCODE_BIN: zcodeBin } : {}),
      ...(zcodeNode ? { ZCODE_NODE: zcodeNode } : {}),
      ...(debug ? { ZCODE_ACP_DEBUG: '1' } : {}),
    },
    permission: 'reject',
  }
}

export function registerAcpSessionProvider(
  context: AcpProviderRegistryContext,
  config: AcpSessionProviderConfig,
): boolean {
  const subagents = context.subagents
  const subprocess = context.subprocess
  if (!subagents || !subprocess) return false

  const provider = new AcpSessionProvider(config, (spec) => subprocess.spawn(spec))
  subagents.registerProvider(provider)
  return true
}

export interface ZcodeAcpExecutorProviderOptions {
  /** 可被角色引用的 executor id；默认 `zcode`。 */
  executorIds?: string[]
}

/**
 * 把长连接 ACP Session Provider 适配成 Weave 统一 ExecutorProvider。
 * ZCode 通过 ACP 扩展支持模型、思考深度、模式和实时输出。
 */
export class ZcodeAcpExecutorProvider {
  readonly #provider: AcpSessionProvider
  readonly #executorIds: Set<string>

  readonly id: string
  readonly name = 'ZCode ACP'
  readonly kind = 'acp'

  readonly capabilities = {
    liveOutput: true,
    sessionReuse: true,
    sessionResume: true,
    modelSelection: true,
    providerSelection: true,
    thoughtControl: true,
    thoughtLevels: ['off', 'low', 'medium', 'high', 'max'],
    modeControl: true,
    modes: ['build', 'plan', 'edit', 'ask', 'yolo'],
    tools: {
      externalRuntime: true,
      filtering: 'none',
      permission: 'reject',
    },
  } as const

  constructor(provider: AcpSessionProvider, options: ZcodeAcpExecutorProviderOptions = {}) {
    this.#provider = provider
    this.#executorIds = new Set(options.executorIds ?? [provider.name])
    this.id = provider.name
  }

  supports(executor: string): boolean {
    return this.#executorIds.has(executor)
  }

  async start(request: import('../executors/executor-provider.js').ExecutorStartRequest): Promise<
    import('../executors/executor-provider.js').ExecutorRun
  > {
    const run = await this.#provider.start({
      parent: request.parent,
      signal: request.signal,
      prompt: request.prompt.map((block) => ({
        type: 'text' as const,
        ...(typeof block.text === 'string' ? { text: block.text } : {}),
      })) as Array<{ type: 'text'; text: string }>,
      weave: {
        sessionKey: request.sessionKey,
        ...(request.resumeSessionId !== undefined ? { resumeSessionId: request.resumeSessionId } : {}),
        ...(request.runtime?.model?.provider !== undefined
          ? { modelProvider: request.runtime.model.provider }
          : {}),
        ...(request.runtime?.model?.id !== undefined ? { model: request.runtime.model.id } : {}),
        ...(request.runtime?.thoughtLevel !== undefined ? { thoughtLevel: request.runtime.thoughtLevel } : {}),
        ...(request.runtime?.mode !== undefined ? { mode: request.runtime.mode } : {}),
      },
    })

    const sessionId = run.id.startsWith('acp-') ? run.id.slice(4) : run.id
    const decorate = (event: import('../acp/acp-session-provider.js').AcpExecutorEvent) => ({
      ...event,
      taskId: request.executor,
      executor: request.executor,
      runId: run.id,
      sessionId: event.sessionId ?? sessionId,
    })

    const applied = {
      model: {
        requested: request.runtime?.model,
        effective: request.runtime?.model,
        supported: true,
      },
      thinking: {
        requested: request.runtime?.thoughtLevel,
        effective: request.runtime?.thoughtLevel,
        supported: true,
      },
      mode: {
        requested: request.runtime?.mode,
        effective: request.runtime?.mode,
        supported: true,
      },
      tools: {
        requested: request.runtime?.tools,
        effective: { management: 'external', permission: 'reject' },
        supported: false,
        fallback: true,
      },
    }

    return {
      ...run,
      providerId: this.id,
      sessionId,
      result: run.result.then((result) => ({ ...result, applied })),
      applied,
      readOutput: () => run.readOutput?.().map(decorate) ?? [],
      onEvent: (listener) => run.onEvent
        ? run.onEvent((event) => listener(decorate(event)))
        : () => undefined,
    }
  }
}
