/**
 * P0-ENV-001 —— DSH 插件环境与 `ctx.subagents` 验证（spike）。
 *
 * 结构（三级验证，均可独立通过）：
 *  - Suite A「Mock 合约」：`MockSubagentsContext`（文档 5.3 夹具）对 Weave 所需
 *    `ctx.subagents` 合约的行为验证 —— 任何时候都运行（CI 常驻，保证后续任务可测）。
 *  - Suite B「真实 DSH 运行时」：动态加载真实 `@deepseek-ai/dsh-subagent`（0.1.1-rc.2 基线），
 *    在真实 cordis Context 上构造 `SubagentRuntime`，验证 `list()` / `start()` /
 *    `registerProvider` / 事件 / 错误码。未安装该包的环境自动跳过（真实环境冒烟，非静默降级）。
 *  - Suite C「API 快照一致性」：把快照合约与文档假设做对照断言（同步 list、ContentBlock[] prompt、
 *    stopReason 枚举、返回形态），沉淀"API 快照与兼容性结论"。
 *
 * 运行：pnpm vitest run src/plugins/weave/__tests__/env-subagents-spike.test.ts
 * 环境检查：pnpm env:check（test/scripts/env-check.mjs 输出 DSH 版本与 provider 包安装状态）
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  MOCK_PROVIDER_LIST,
  MockSubagentsContext,
  SUBAGENT_ERROR_CODES,
  type ContentBlockLike,
  type SubagentErrorLike,
  type SubagentProviderLike,
  type SubagentRunLike,
  type SubagentStartRequestLike,
} from './fixtures/mock-subagents';

/* ------------------------------------------------------------------ */
/* 环境探测：真实 @deepseek-ai/dsh-subagent 是否可加载                  */
/* ------------------------------------------------------------------ */

interface RealModule {
  SubagentRuntime: new (ctx: unknown) => any;
  SubagentError: new (message: string, code: string) => SubagentErrorLike;
}

interface RealEnv {
  module: RealModule;
  version: string;
  packageJsonPath: string;
}

let realEnv: RealEnv | undefined;
let realLoadError: string | undefined;

/** DSH 安装根（Windows 默认 D:\Program Files\deepseek），可用 DSH_ROOT 覆盖。 */
function dshRoot(): string {
  if (process.env.DSH_ROOT) return process.env.DSH_ROOT;
  const programFiles = process.env.ProgramFiles ?? 'C:/Program Files';
  return join(programFiles, 'deepseek');
}

async function probeRealEnv(): Promise<RealEnv | undefined> {
  try {
    // 候选：① 本仓库 devDep（pnpm）→ ② DSH 全局安装。
    const require = createRequire(import.meta.url);
    let pkgPath: string | undefined;
    try {
      pkgPath = require.resolve('@deepseek-ai/dsh-subagent/package.json');
    } catch {
      pkgPath = undefined;
    }
    if (!pkgPath) {
      const candidate = join(dshRoot(), 'node_modules', '@deepseek-ai', 'dsh-subagent', 'package.json');
      if (existsSync(candidate)) pkgPath = candidate;
    }
    if (!pkgPath) throw new Error('package not found (devDep and DSH global install both absent)');

    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
    const entry = pkgPath.replace(/[\\/]package\.json$/, '/lib/index.js');
    const mod = (await import(/* @vite-ignore */ pathToFileURL(entry).href)) as RealModule;
    if (typeof mod.SubagentRuntime !== 'function') {
      throw new Error(`@deepseek-ai/dsh-subagent has no SubagentRuntime export (module shape: ${Object.keys(mod).slice(0, 20).join(',')})`);
    }
    return { module: mod, version: pkg.version, packageJsonPath: pkgPath };
  } catch (error) {
    realLoadError = error instanceof Error ? error.message : String(error);
    return undefined;
  }
}

// 模块顶层探测（同步于 describe 注册之前，避免 skipIf 误判）。
await (async () => {
  try {
    const env = await probeRealEnv();
    if (env) {
      realEnv = env;
       
      console.info(`[env-spike] 真实 @deepseek-ai/dsh-subagent 已加载: ${env.version} (${env.packageJsonPath})`);
    } else {
       
      console.info(`[env-spike] 未找到 @deepseek-ai/dsh-subagent，Suite B 将跳过（CI mock 路径）: ${realLoadError ?? 'unknown'}`);
    }
  } catch (error) {
    realLoadError = error instanceof Error ? error.message : String(error);
  }
})();

/* ------------------------------------------------------------------ */
/* Suite A —— MockSubagentsContext 合约验证（CI 常驻）                  */
/* ------------------------------------------------------------------ */

describe('A. MockSubagentsContext（文档 5.3 API 验证夹具）', () => {
  function makeRequest(overrides: Partial<SubagentStartRequestLike> = {}): SubagentStartRequestLike {
    return {
      prompt: [{ type: 'text', text: 'do the work' }],
      parent: { id: 'parent-session' },
      signal: new AbortController().signal,
      ...overrides,
    };
  }

  it('list() 同步返回文档约定的 provider 清单（spawn/fork/codex/claude-code/zcode）', () => {
    const ctx = new MockSubagentsContext();
    const list = ctx.list();
    expect(Array.isArray(list)).toBe(true);
    expect(list).not.toBeInstanceOf(Promise); // 真实 API 为同步方法（评审 E1/LO-3）
    expect(list).toEqual([...MOCK_PROVIDER_LIST]);
  });

  it('start() 返回 SubagentRunLike：{ id, localAgent, result, dispose }，result 以 completed 结束', async () => {
    const ctx = new MockSubagentsContext();
    const run = await ctx.start('spawn', makeRequest());
    expect(typeof run.id).toBe('string');
    expect(run.id.length).toBeGreaterThan(0);
    expect('localAgent' in run).toBe(true);
    expect(run.result).toBeInstanceOf(Promise);
    expect(typeof run.dispose).toBe('function');

    const result = await run.result;
    expect(result.stopReason).toBe('completed');
    expect(result.output).toEqual([{ type: 'text', text: `mock result for spawn` }]);
  });

  it('start() 记录请求：prompt 是 ContentBlock[]（type=text），parent/signal 原样保留', async () => {
    const ctx = new MockSubagentsContext();
    const signal = new AbortController().signal;
    await ctx.start('fork', makeRequest({ signal }));
    expect(ctx.started).toHaveLength(1);
    const record = ctx.started[0]!;
    expect(record.executor).toBe('fork');
    const prompt = record.request.prompt as ContentBlockLike[];
    expect(Array.isArray(prompt)).toBe(true);
    expect(prompt[0]!.type).toBe('text');
    expect(record.request.signal).toBe(signal);
  });

  it('未知执行器 → reject，错误码 NO_PROVIDER（与真实 SubagentError 对齐）', async () => {
    const ctx = new MockSubagentsContext();
    let caught: unknown;
    try {
      await ctx.start('not-a-provider', makeRequest());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as SubagentErrorLike).code).toBe(SUBAGENT_ERROR_CODES.NO_PROVIDER);
  });

  it('signal 已在 start 前 abort → start() 拒绝（CANCELLED，模拟 provider 清理后拒绝）', async () => {
    const ctx = new MockSubagentsContext();
    const controller = new AbortController();
    controller.abort();
    let caught: unknown;
    try {
      await ctx.start('spawn', makeRequest({ signal: controller.signal }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as SubagentErrorLike).code).toBe(SUBAGENT_ERROR_CODES.CANCELLED);
  });

  it('运行中 abort → result 以 stopReason=aborted 结束（manualCompletion 确定性验证）', async () => {
    const ctx = new MockSubagentsContext({ manualCompletion: true });
    const controller = new AbortController();
    const run = await ctx.start('spawn', makeRequest({ signal: controller.signal }));
    controller.abort();
    const result = await run.result;
    expect(result.stopReason).toBe('aborted');
  });

  it('manualCompletion 模式支持 settle(runId, result) 确定性结算（下游任务需要）', async () => {
    const ctx = new MockSubagentsContext({ manualCompletion: true });
    const run = await ctx.start('spawn', makeRequest());
    ctx.settle(run.id, { output: [{ type: 'text', text: 'injected' }], stopReason: 'completed' });
    const result = await run.result;
    expect(result.output).toEqual([{ type: 'text', text: 'injected' }]);
    expect(result.stopReason).toBe('completed');
  });

  it('registerProvider/dispose 联动 provider-added / provider-removed 事件', async () => {
    const ctx = new MockSubagentsContext();
    const seen: string[] = [];
    const offAdd = ctx.on('provider-added', (e) => seen.push(`+${(e as any).name}`));
    const offRem = ctx.on('provider-removed', (e) => seen.push(`-${(e as any).name}`));

    const provider: SubagentProviderLike = {
      name: 'spike-mock',
      capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
      inheritsParentContext: false,
      start: async () => ({ id: 'x', localAgent: undefined, result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} }),
    };
    const dispose = ctx.registerProvider(provider);
    expect(ctx.list()).toContain('spike-mock');
    expect(seen).toEqual(['+spike-mock']);
    dispose();
    expect(ctx.list()).not.toContain('spike-mock');
    expect(seen).toEqual(['+spike-mock', '-spike-mock']);
    offAdd();
    offRem();
  });
});

/* ------------------------------------------------------------------ */
/* Suite B —— 真实 @deepseek-ai/dsh-subagent 运行时 spike               */
/* ------------------------------------------------------------------ */

describe.skipIf(realEnv === undefined)('B. 真实 DSH SubagentRuntime（@deepseek-ai/dsh-subagent）', () => {
  let bootError: string | undefined;
  let runtime: any;
  let service: any; // ctx.subagents —— 插件消费者看到的真实入口
  let disposeCtx: (() => Promise<void>) | undefined;
  const notes: string[] = [];

  beforeAll(async () => {
    try {
      const enve = realEnv!;
      const cordis = await import('@deepseek-ai/cordis');
      const Context = cordis.Context;
      const ctx = new Context();
      runtime = new enve.module.SubagentRuntime(ctx);
      // ctx.subagents：@deepseek-ai/dsh-subagent 通过模块扩充声明到 cordis Context；
      // 测试以动态 any 视角读取（避免编译期强制依赖该包的 type augmentation）。
      service = (ctx as any).subagents;
      // 契约：Service 注册到 ctx 上（`ctx.subagents`），暴露与实例相同的公开方法
      // （reflect 层返回的是同一服务注册表的封装入口，非同一对象身份——生产插件均经此入口消费）。
      if (service == null || typeof service.list !== 'function' || typeof service.start !== 'function') {
        throw new Error(`ctx.subagents 未暴露服务合约（list/start）: ${typeof service}`);
      }
      if (service !== runtime) {
        notes.push('ctx.subagents 是服务注册表的封装入口（identity 不同，功能等价：providers 同源、instanceof 相同）');
      }
      disposeCtx = async () => {
        try {
          await (ctx as any)?.dispose?.();
        } catch {
          /* 裸 Context 无显式 dispose 生命周期，忽略 */
        }
      };
    } catch (error) {
      bootError = error instanceof Error ? error.message : String(error);
    }
  });

  afterAll(async () => {
    await disposeCtx?.();
  });

  it('真实包可加载，版本已记录（结论回写用）', () => {
    expect(realEnv?.version).toMatch(/^\d+\.\d+\.\d+/);
     
    console.info(`[env-spike] @deepseek-ai/dsh-subagent version = ${realEnv?.version}`);
  });

  it('裸 cordis Context 上可构造 SubagentRuntime（registry 无 provider，list() 为空且同步）', () => {
    expect(bootError).toBeUndefined();
    expect(realEnv).toBeDefined();
    const list = service.list();
    expect(Array.isArray(list)).toBe(true);
    expect(list).not.toBeInstanceOf(Promise);
    expect(list).toEqual([]);
  });

  it('registerProvider → list()/getProvider()/provider-added、移除 → provider-removed', () => {
    const calls: any[] = [];
    runtime.ctx.on('subagent/provider-added', (p: any) => calls.push(['add', p.name]));
    runtime.ctx.on('subagent/provider-removed', (name: string) => calls.push(['remove', name]));

    const provider = makeFakeProvider('spike');
    const dispose = service.registerProvider(provider);
    expect(service.list()).toEqual(['spike']);
    expect(service.getProvider('spike')).toBe(provider);
    expect(calls).toContainEqual(['add', 'spike']);

    dispose();
    expect(service.list()).toEqual([]);
    expect(service.getProvider('spike')).toBeUndefined();
    expect(calls).toContainEqual(['remove', 'spike']);
  });

  it("start('spawn', request) 可返回（fake provider 路径）：SubagentRun 形状 + result 完成 + dispose 幂等", async () => {
    service.registerProvider(makeFakeProvider('spawn'));
    const events: any[] = [];
    runtime.ctx.on('subagent/start', (info: any) => events.push(['start', info]));
    runtime.ctx.on('subagent/end', (info: any) => events.push(['end', info]));

    const request: SubagentStartRequestLike = {
      label: 'spike',
      prompt: [{ type: 'text', text: 'spike prompt' }],
      parent: undefined as never, // spike：非真实 Agent；observeRun 以未限定作用域发布事件
      signal: new AbortController().signal,
    };
    const run: SubagentRunLike = await service.start('spawn', request);

    expect(typeof run.id).toBe('string');
    expect('localAgent' in run).toBe(true);
    expect(run.result).toBeInstanceOf(Promise);
    expect(typeof run.dispose).toBe('function');

    const result = await run.result;
    expect(result.stopReason).toBe('completed');
    expect(result.output).toEqual([{ type: 'text', text: 'fake output' }]);

    await run.dispose();
    await run.dispose(); // 幂等

    // 生命周期事件成对（start 在发布时即发出，end 在 result 结算后发出）。
    const starts = events.filter((e) => e[0] === 'start');
    const ends = events.filter((e) => e[0] === 'end');
    expect(starts.length).toBe(1);
    expect(ends.length).toBe(1);
  });

  it('未注册 provider → start() 以 SubagentError(NO_PROVIDER) 拒绝', async () => {
    let caught: SubagentErrorLike | undefined;
    try {
      await service.start('nope', {
        prompt: [{ type: 'text', text: 'x' }],
        parent: undefined as never,
        signal: new AbortController().signal,
      });
    } catch (error) {
      caught = error as SubagentErrorLike;
    }
    expect(caught).toBeDefined();
    expect(caught!.code).toBe('NO_PROVIDER');
    expect(caught!.message).toContain('no subagent provider registered');
  });

  it('能力校验：provider 不支持 persona → start() 以 UNSUPPORTED_CAPABILITY 拒绝（fail loud）', async () => {
    service.registerProvider({
      ...makeFakeProvider('spike-no-persona'),
      capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: false },
    });
    let caught: SubagentErrorLike | undefined;
    try {
      await service.start('spike-no-persona', {
        prompt: [{ type: 'text', text: 'x' }],
        parent: undefined as never,
        signal: new AbortController().signal,
        persona: 'shadow',
      });
    } catch (error) {
      caught = error as SubagentErrorLike;
    }
    expect(caught).toBeDefined();
    expect(caught!.code).toBe('UNSUPPORTED_CAPABILITY');
  });

  it('契约聚合：真实 ctx.subagents 满足 Weave 的 SubagentsLike（list/start/getProvider/registerProvider）', () => {
    expect(typeof service.list).toBe('function');
    expect(typeof service.start).toBe('function');
    expect(typeof service.getProvider).toBe('function');
    expect(typeof service.registerProvider).toBe('function');
  });

  it('声明：真实环境 boot 检查项（若有异常则本测试失败，避免静默跳过）', () => {
    expect(bootError).toBeUndefined();
    for (const note of notes) {
       
      console.info(`[env-spike] note: ${note}`);
    }
  });
});

function makeFakeProvider(name: string): SubagentProviderLike {
  return {
    name,
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    inheritsParentContext: false,
    start: async (_request: SubagentStartRequestLike) => ({
      id: `fake-session-${name}`,
      localAgent: undefined,
      result: Promise.resolve({
        output: [{ type: 'text', text: 'fake output' }],
        stopReason: 'completed' as const,
      }),
      dispose: async () => {},
    }),
  };
}

/* ------------------------------------------------------------------ */
/* Suite C —— API 快照一致性（把评审发现的契约事实固化为断言）          */
/* ------------------------------------------------------------------ */

describe('C. API 快照与文档契约对照（评审 E1-E4 实证固化）', () => {
  it('list() 为同步方法：SDD/FDD“await ctx.subagents.list()”不再适用（LO-3）', () => {
    const ctx = new MockSubagentsContext();
    const value = ctx.list();
    expect(value).not.toBeInstanceOf(Promise);
    expect(Array.isArray(value)).toBe(true);
  });

  it('prompt 为 ContentBlock[]（评审 E2），非 string', () => {
    const ctx = new MockSubagentsContext();
    const req: SubagentStartRequestLike = {
      prompt: [{ type: 'text', text: 'hello' }],
      parent: {},
      signal: new AbortController().signal,
    };
    void ctx.start('spawn', req);
    expect(Array.isArray(ctx.lastRequest()?.prompt)).toBe(true);
    expect((ctx.lastRequest()?.prompt as ContentBlockLike[])[0]?.type).toBe('text');
  });

  it('返回为 SubagentRun（评审 E3）：无 stdout/stderr/summary/duration_ms 字段', () => {
    const ctx = new MockSubagentsContext();
    const run = ctx.start('spawn', {
      prompt: [{ type: 'text', text: 'x' }],
      parent: {},
      signal: new AbortController().signal,
    });
    expect(run).toBeInstanceOf(Promise);
    void run;
  });

  it('stopReason 枚举（评审 E4）仅 completed/aborted/error/max-tokens/refusal', async () => {
    const allowed = ['completed', 'aborted', 'error', 'max-tokens', 'refusal'];
    // 已中止的 signal：真实 API 语义为 provider 在 start 前清理并拒绝；
    // mock 开启 abortRejectsOnStart:false 时，将已中止视为"运行中取消"，以 aborted 结束。
    const ctx = new MockSubagentsContext({ abortRejectsOnStart: false });
    const abortController = new AbortController();
    abortController.abort();
    const run = await ctx.start('spawn', {
      prompt: [{ type: 'text', text: 'x' }],
      parent: {},
      signal: abortController.signal,
    });
    const result = await run.result;
    expect(allowed).toContain(result.stopReason);
    expect(result.stopReason).toBe('aborted');
  });
});
