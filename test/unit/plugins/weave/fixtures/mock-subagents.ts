/**
 * Weave 内部使用的 `ctx.subagents` API 快照 + Mock 夹具。
 *
 * 本文件以 **真实 DSH 0.1.1-rc.2 的 @deepseek-ai/dsh-subagent 为准**（而非文档假设）：
 * - `list(): string[]` 是**同步**方法（文档中的 `await ctx.subagents.list()` 是误导，见架构评审 E1/LO-3）；
 * - `start(name, request)` 的 `request.prompt` 是 `ContentBlock[]`（不是 string），`parent`/`signal` 必填；
 * - `start()` 返回 `SubagentRun { id, localAgent, result: Promise<SubagentResult>, dispose() }`；
 * - `SubagentResult` 为 `{ output: ContentBlock[], structured?, diagnostic?, stopReason }`，
 *   没有 `stdout`/`stderr`/`summary`/`duration_ms`（评审 E2/E3）；
 * - `stopReason` 枚举仅 `completed | aborted | error | max-tokens | refusal`（评审 E4）；
 * - 错误形态：`SubagentError`，携带 `code`（`NO_PROVIDER` / `UNSUPPORTED_CAPABILITY` / …）。
 *
 * MockSubagentsContext 实现本合约的稳定替身（文档 5.3）：
 * `list()` 返回 `['spawn','fork','codex','claude-code','zcode']`；`start()` 支持 signal abort 模拟。
 * CI / 无 DSH 环境用它保证测试稳定；真实验证见 `env-subagents-spike.test.ts` 的 RealRuntime 套件。
 */

/** DSH 0.1.1-rc.2 基线中 `ctx.subagents` 的 provider 注册名（spawn/fork 为默认启用，见 preset）。 */
export const DSH_PROVIDER_NAMES = {
  spawn: 'spawn',
  fork: 'fork',
  codex: 'codex',
  claudeCode: 'claude-code',
  acp: 'zcode',
} as const;

/** MockSubagentsContext 默认返回的 provider 清单（文档 5.3 约定）。 */
export const MOCK_PROVIDER_LIST: readonly string[] = [
  DSH_PROVIDER_NAMES.spawn,
  DSH_PROVIDER_NAMES.fork,
  DSH_PROVIDER_NAMES.codex,
  DSH_PROVIDER_NAMES.claudeCode,
  DSH_PROVIDER_NAMES.acp,
] as const;

/* ------------------------------------------------------------------ */
/* API 快照：以真实 @deepseek-ai/dsh-subagent 0.1.1-rc.2 为准           */
/* ------------------------------------------------------------------ */

export interface ContentBlockLike {
  type: 'text';
  text: string;
}

export type SubagentStopReasonLike =
  | 'completed'
  | 'aborted'
  | 'error'
  | 'max-tokens'
  | 'refusal';

export interface SubagentResultLike {
  output: ContentBlockLike[];
  structured?: unknown;
  diagnostic?: string;
  stopReason: SubagentStopReasonLike;
}

export interface SubagentAgentOptionsLike {
  provider?: string;
  model?: string;
}

export interface SubagentStartRequestLike {
  label?: string;
  prompt: ContentBlockLike[];
  /** 委托父 Agent（真实环境必填；mock 仅记录不解析）。 */
  parent: unknown;
  signal: AbortSignal;
  /** DSH 官方模型路由覆盖（provider/model）。 */
  agentOptions?: SubagentAgentOptionsLike;
  /** ACP 会话隔离主键（DSH 原样透传给 provider）。 */
  sessionKey?: string;
  /** Weave 注入的 ACP 运行时扩展（兼容旧路径把 sessionKey 内嵌于此）。 */
  weave?: { sessionKey?: string; [key: string]: unknown };
  outputSchema?: unknown;
  maxDepth?: number;
  toolFilter?: unknown;
  persona?: string;
}

export interface SubagentRunLike {
  id: string;
  /** 真实环境中为子 Agent 实例；mock 中恒为 undefined（模拟远端/未加载）。 */
  localAgent: unknown;
  result: Promise<SubagentResultLike>;
  dispose(): Promise<void>;
}

/** DSH SubagentCapabilities 的 Weave 侧快照（outputSchema/depthLimit/toolFilter/persona）。 */
export interface SubagentCapabilitiesLike {
  outputSchema: boolean;
  depthLimit: boolean;
  toolFilter: boolean;
  persona: boolean;
}

export interface SubagentProviderLike {
  name: string;
  capabilities: SubagentCapabilitiesLike;
  inheritsParentContext: boolean;
  start(request: SubagentStartRequestLike): Promise<SubagentRunLike>;
}

export interface SubagentErrorLike extends Error {
  code: string;
}

/** Weave 消费的 `ctx.subagents` 最小合约（真实运行时结构满足之）。 */
export interface SubagentsLike {
  /** 同步返回已注册 provider 名（有序）。 */
  list(): string[];
  start(
    name: string,
    request: SubagentStartRequestLike,
  ): Promise<SubagentRunLike>;
  getProvider?(name: string): SubagentProviderLike | undefined;
  registerProvider?(provider: SubagentProviderLike): () => void;
}

/** 错误码（与真实 SubagentError 对齐）。 */
export const SUBAGENT_ERROR_CODES = {
  NO_PROVIDER: 'NO_PROVIDER',
  UNSUPPORTED_CAPABILITY: 'UNSUPPORTED_CAPABILITY',
  CANCELLED: 'CANCELLED',
  UNKNOWN_EXECUTOR: 'UNKNOWN_EXECUTOR',
} as const;

export interface MockSubagentsOptions {
  /** 初始 provider 清单，默认 MOCK_PROVIDER_LIST。 */
  providers?: readonly string[];
  /** 如果为 true，`start()` 在 signal 已 abort 时 reject（模拟 provider 清理后拒绝）。 */
  abortRejectsOnStart?: boolean;
  /**
   * 手动完成模式：`start()` 返回的 result 不自动 settle，
   * 由 `settle(runId, result)`（下游测试注入确定性结果）或 abort 结束。
   */
  manualCompletion?: boolean;
}

interface StartRecord {
  executor: string;
  request: SubagentStartRequestLike;
  runId: string;
  startedAt: number;
}

type SubagentEvent =
  | { type: 'provider-added'; name: string }
  | { type: 'provider-removed'; name: string }
  | { type: 'run-start'; executor: string; runId: string }
  | { type: 'run-end'; executor: string; runId: string; stopReason: SubagentStopReasonLike };

/**
 * `ctx.subagents` 的稳定 mock（文档 5.3）：
 * - `list()` 同步返回 provider 名称数组；
 * - `start(executorId, request)` 返回 SubagentRunLike，永不触发真实子代理；
 * - signal abort 模拟：start 前已 abort → reject(CANCELLED)；运行中 abort → result 以
 *   `{ stopReason: 'aborted' }` 结束；
 * - 记录每次请求（`started`），供下游任务断言 prompt 构建 / 上下文注入等。
 */
export class MockSubagentsContext implements SubagentsLike {
  readonly options: MockSubagentsOptions;

  private readonly names: string[];
  private readonly startRecords: StartRecord[] = [];
  private readonly listeners = new Map<SubagentEvent['type'], Set<(e: any) => void>>();
  private readonly finishers = new Map<string, { executor: string; finish: (result: SubagentResultLike) => void }>();
  private nextRunId = 1;

  constructor(options: MockSubagentsOptions = {}) {
    this.options = options;
    this.names = [...(options.providers ?? MOCK_PROVIDER_LIST)];
  }

  list(): string[] {
    // 注意：真实 API 为同步返回数组（不是 Promise），此处刻意保持同步语义。
    return [...this.names];
  }

  getProvider(name: string): SubagentProviderLike | undefined {
    if (!this.names.includes(name)) return undefined;
    return {
      name,
      capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
      inheritsParentContext: true,
      start: () => this.start(name, this.lastRequest()!),
    };
  }

  registerProvider(provider: SubagentProviderLike): () => void {
    if (!this.names.includes(provider.name)) {
      this.names.push(provider.name);
      this.emit({ type: 'provider-added', name: provider.name });
    }
    return () => {
      const idx = this.names.indexOf(provider.name);
      if (idx >= 0) {
        this.names.splice(idx, 1);
        this.emit({ type: 'provider-removed', name: provider.name });
      }
    };
  }

  /** 已记录的 start 请求（按发起顺序）。 */
  get started(): readonly StartRecord[] {
    return this.startRecords;
  }

  /** 最近一次 start 的原始请求。 */
  lastRequest(): SubagentStartRequestLike | undefined {
    const last = this.startRecords[this.startRecords.length - 1];
    return last?.request;
  }

  on(event: SubagentEvent['type'], listener: (event: SubagentEvent) => void): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener as any);
    this.listeners.set(event, set);
    return () => set.delete(listener as any);
  }

  async start(
    name: string,
    request: SubagentStartRequestLike,
  ): Promise<SubagentRunLike> {
    if (!this.names.includes(name)) {
      const err = new Error(
        `no subagent provider registered for "${name}"`,
      ) as SubagentErrorLike;
      err.code = SUBAGENT_ERROR_CODES.NO_PROVIDER;
      throw err;
    }

    // start 前已 abort：真实 provider 清理后 reject（评审 E4 语义）。
    if (request.signal.aborted) {
      if (this.options.abortRejectsOnStart !== false) {
        const err = new Error('subagent start aborted') as SubagentErrorLike;
        err.code = SUBAGENT_ERROR_CODES.CANCELLED;
        throw err;
      }
    }

    const runId = `mock-run-${this.nextRunId++}`;
    this.startRecords.push({ executor: name, request, runId, startedAt: Date.now() });
    this.emit({ type: 'run-start', executor: name, runId });

    let settled = false;
    let finish: (r: SubagentResultLike) => void = () => {};
    const result = new Promise<SubagentResultLike>((resolve) => {
      finish = resolve;
    });
    if (this.options.manualCompletion === true) {
      // 手动完成模式：不注册自动完成，挂到 finishers 供 settle() 结算。
      this.finishers.set(runId, {
        executor: name,
        finish: (r) => {
          if (settled) return;
          settled = true;
          finish(r);
        },
      });
    }

    // 运行中 abort 模拟：signal 触发后以 aborted 结束。
    const onAbort = () => {
      if (settled) return;
      settled = true;
      this.emit({ type: 'run-end', executor: name, runId, stopReason: 'aborted' });
      finish({
        output: [],
        stopReason: 'aborted',
        diagnostic: 'aborted by signal (mock)',
      });
    };
    if (request.signal.aborted) {
      onAbort();
    } else {
      request.signal.addEventListener('abort', onAbort, { once: true });
    }

    // 模拟正常的 async 完成（下一微任务）；手动完成模式下跳过。
    if (this.options.manualCompletion !== true) {
      void Promise.resolve().then(() => {
        if (settled) return;
        settled = true;
        const output: ContentBlockLike[] = [{ type: 'text', text: `mock result for ${name}` }];
        this.emit({ type: 'run-end', executor: name, runId, stopReason: 'completed' });
        finish({ output, stopReason: 'completed' });
      });
    }

    const run: SubagentRunLike = {
      id: runId,
      localAgent: undefined,
      result,
      dispose: async () => {
        if (settled) return;
        settled = true;
        this.finishers.delete(runId);
        onAbort();
      },
    };
    return run;
  }

  /**
   * 手动完成模式下，按 runId 注入确定性结果（下游任务测试用）。
   * @param result - 完成结果；未提供时使用默认 completed 输出。
   */
  settle(runId: string, result?: Partial<SubagentResultLike>): void {
    const entry = this.finishers.get(runId);
    if (!entry) throw new Error(`no pending run "${runId}" to settle`);
    this.finishers.delete(runId);
    const r: SubagentResultLike = {
      output: result?.output ?? [],
      stopReason: result?.stopReason ?? 'completed',
      ...(result?.diagnostic !== undefined ? { diagnostic: result.diagnostic } : {}),
      ...(result?.structured !== undefined ? { structured: result.structured } : {}),
    };
    this.emit({ type: 'run-end', executor: entry.executor, runId, stopReason: r.stopReason });
    entry.finish(r);
  }

  private emit(event: SubagentEvent): void {
    const set = this.listeners.get(event.type);
    if (!set) return;
    for (const l of set) {
      (l as (e: SubagentEvent) => void)(event);
    }
  }
}
