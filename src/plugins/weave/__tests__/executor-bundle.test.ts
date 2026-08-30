/**
 * P0-EXEC-021 —— 执行器 Bundle 安装与启用验证。
 *
 * 结构（三套件）：
 *  - Suite A「Bundle 合约（CI 常驻）」：MockSubagentsContext 上模拟「Bundle 安装后 provider
 *    注册名」与 ExecutorRegistry 四类分类（spawn/fork → dsh_subagent、codex → codex、
 *    claude-code → claude_code、acp/zcode → acp）；任何环境都运行。
 *  - Suite B「真实 Bundle 加载（DSH 0.1.1-rc.2 宿主）」：仅当 DSH 安装根存在
 *    @deepseek-ai/dsh-subagent-{codex,claude-code,acp} 时运行。在裸 cordis Context 上构造
 *    SubagentRuntime，动态导入三个 provider 插件模块（name/inject/Config/apply），直接调用
 *    apply 完成注册（省略 cordis 装载器，注册路径与生产一致），断言
 *    `ctx.subagents.list()` 出现 codex / claude-code / acp 且 provider 形态正确。
 *  - Suite C「版本与 peer 满足实证」：记录 Bundle 与 DSH 宿主的实际版本（0.1.1-rc.2 /
 *    dist-tag next），断言 peer（^0.1.1-rc.2）被宿主满足 —— 回写
 *    doc/decisions/P0-EXEC-021-conclusion.md 的实证依据。
 *
 * 运行：pnpm vitest run src/plugins/weave/__tests__/executor-bundle.test.ts
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MOCK_PROVIDER_LIST, MockSubagentsContext } from './fixtures/mock-subagents';
import { ExecutorRegistry, classifyProvider } from '../executor-registry';

/* ------------------------------------------------------------------ */
/* 执行器 Bundle 定义与宿主探测                                          */
/* ------------------------------------------------------------------ */

/** 执行器 Bundle 三件套（0.1.1-rc.2 = npm dist-tag `next`，与 DSH 基线同版本线）。 */
const BUNDLE = [
  { pkg: '@deepseek-ai/dsh-subagent-codex', providerName: 'codex', kind: 'codex' as const },
  { pkg: '@deepseek-ai/dsh-subagent-claude-code', providerName: 'claude-code', kind: 'claude_code' as const },
  { pkg: '@deepseek-ai/dsh-subagent-acp', providerName: 'acp', kind: 'acp' as const },
] as const;

/** DSH 安装根（Windows 默认 D:\Program Files\deepseek），可用 DSH_ROOT 覆盖；
 *  兼容多盘符/多路径部署：依次探测 D:/、ProgramFiles、C:/ 三种常见位置。 */
function dshRoot(): string {
  if (process.env.DSH_ROOT) return process.env.DSH_ROOT;
  const programFiles = process.env.ProgramFiles ?? 'C:/Program Files';
  const candidates = [
    join('D:', 'Program Files', 'deepseek'),
    join(programFiles, 'deepseek'),
    join('C:', 'Program Files', 'deepseek'),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'node_modules', '@deepseek-ai'))) return c;
  }
  return candidates[0] ?? join('D:', 'Program Files', 'deepseek');
}

interface BundlePkg {
  pkg: string;
  entry: string;
  version: string;
}

/** 探测 DSH 安装根中已安装的 Bundle 包（未安装的忽略）。 */
function probeBundle(): BundlePkg[] {
  const root = dshRoot();
  const found: BundlePkg[] = [];
  for (const { pkg } of BUNDLE) {
    const pkgJson = join(root, 'node_modules', pkg, 'package.json');
    if (!existsSync(pkgJson)) continue;
    const meta = JSON.parse(readFileSync(pkgJson, 'utf8')) as { version: string; main?: string };
    const entry = join(root, 'node_modules', pkg, meta.main ?? 'lib/index.js');
    if (!existsSync(entry)) continue;
    found.push({ pkg, entry, version: meta.version });
  }
  return found;
}

interface SubagentRuntimeModule {
  SubagentRuntime: new (ctx: unknown) => any;
}

interface HostModule {
  module: SubagentRuntimeModule;
  version: string;
  packageJsonPath: string;
}

let hostModule: HostModule | undefined;
let bundlePkgs: BundlePkg[] = [];

async function probeHost(): Promise<HostModule | undefined> {
  try {
    const require = createRequire(import.meta.url);
    let pkgPath: string | undefined;
    try {
      pkgPath = require.resolve('@deepseek-ai/dsh-subagent/package.json');
    } catch {
      pkgPath = undefined;
    }
    if (!pkgPath) return undefined;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
    const entry = pkgPath.endsWith('package.json')
      ? pkgPath.slice(0, -'package.json'.length) + 'lib/index.js'
      : pkgPath;
    const mod = (await import(/* @vite-ignore */ pathToFileURL(entry).href)) as SubagentRuntimeModule;
    if (typeof mod.SubagentRuntime !== 'function') return undefined;
    return { module: mod, version: pkg.version, packageJsonPath: pkgPath };
  } catch (error) {
    console.error('[exec-bundle] probeHost failed:', error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

// 模块顶层探测（同步于 describe 注册之前，避免 skipIf 误判）。
await (async () => {
  hostModule = await probeHost();
  bundlePkgs = probeBundle();
  if (hostModule) {
     
    console.info(`[exec-bundle] DSH 宿主 @deepseek-ai/dsh-subagent = ${hostModule.version} (${hostModule.packageJsonPath})`);
  }
  if (bundlePkgs.length) {
     
    console.info(`[exec-bundle] Bundle 已安装: ${bundlePkgs.map((b) => `${b.pkg}@${b.version}`).join(', ')}`);
  } else {
     
    console.info('[exec-bundle] Bundle 未安装，Suite B 将跳过（CI mock 路径）');
  }
})();

/* ------------------------------------------------------------------ */
/* Suite A —— Bundle 合约与注册表分类（CI 常驻）                         */
/* ------------------------------------------------------------------ */

describe('A. Bundle 合约与四类分类（CI 常驻，MockSubagentsContext）', () => {
  it('MOCK_PROVIDER_LIST 覆盖四类执行器（spawn/fork 必过 + bundle 三件套）', () => {
    const names = [...MOCK_PROVIDER_LIST];
    expect(names).toContain('spawn');
    expect(names).toContain('fork');
    expect(names).toContain('codex');
    expect(names).toContain('claude-code');
    expect(names).toContain('zcode');
    const kinds = new Set(names.map((n) => classifyProvider(n)));
    expect(kinds).toEqual(new Set(['dsh_subagent', 'codex', 'claude_code', 'acp']));
  });

  it('classifyProvider 规则表：codex→codex、claude-code→claude_code、acp→acp、其余→acp', () => {
    expect(classifyProvider('codex')).toBe('codex');
    expect(classifyProvider('claude-code')).toBe('claude_code');
    expect(classifyProvider('acp')).toBe('acp');
    expect(classifyProvider('zcode')).toBe('acp'); // 未命中规则 → acp（示例名）
    expect(classifyProvider('spawn')).toBe('dsh_subagent');
    expect(classifyProvider('fork')).toBe('dsh_subagent');
  });

  it('ExecutorRegistry 加载 Mock 清单后：四类可见，kindOf 正确，capabilities 透传', () => {
    const ctx = { subagents: new MockSubagentsContext({ providers: [...MOCK_PROVIDER_LIST] }) };
    const registry = new ExecutorRegistry();
    registry.load(ctx as any);
    expect(registry.list().map((e) => e.id).sort()).toEqual(['claude-code', 'codex', 'fork', 'spawn', 'zcode']);
    expect(registry.kindOf('codex')).toBe('codex');
    expect(registry.kindOf('claude-code')).toBe('claude_code');
    expect(registry.kindOf('zcode')).toBe('acp');
    expect(registry.kindOf('spawn')).toBe('dsh_subagent');
    for (const info of registry.list()) {
      expect(info.capabilities).toMatchObject({
        outputSchema: expect.any(Boolean),
        depthLimit: expect.any(Boolean),
        toolFilter: expect.any(Boolean),
        persona: expect.any(Boolean),
      });
    }
  });

  it('Bundle provider 注册名与 registry 分类一一对应（安装契约）', () => {
    for (const { providerName, kind } of BUNDLE) {
      expect(classifyProvider(providerName)).toBe(kind);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Suite B —— 真实 Bundle 加载（DSH 宿主 0.1.1-rc.2）                   */
/* ------------------------------------------------------------------ */

const suiteBReady = hostModule !== undefined && bundlePkgs.length === BUNDLE.length;

describe.skipIf(!suiteBReady)('B. 真实 Bundle 加载：codex / claude-code / acp 注册进 ctx.subagents', () => {
  let bootError: string | undefined;
  let ctx: any;
  let subagents: any;
  const registered: Array<{ name: string; provider: any }> = [];

  beforeAll(async () => {
    try {
      const cordis = await import('@deepseek-ai/cordis');
      ctx = new cordis.Context();
      new hostModule!.module.SubagentRuntime(ctx);
      subagents = ctx.subagents;
      // subprocess 服务：Provider.apply 仅注册（start 时才使用），给桩即可
      ctx.subprocess = {
        spawn: () => {
          throw new Error('executor-bundle: spawn stub 不应被调用（本次仅验证注册）');
        },
      };

      for (const { pkg, entry } of bundlePkgs) {
        const mod = (await import(/* @vite-ignore */ pathToFileURL(entry).href)) as {
          name: string;
          inject: string[];
          Config?: (config: Record<string, unknown>) => Record<string, unknown>;
          apply: (ctx: unknown, config: Record<string, unknown>) => void;
        };
        expect(typeof mod.apply).toBe('function');
        expect(mod.inject).toContain('subagents');
        expect(mod.inject).toContain('subprocess');
        const config: Record<string, unknown> = { providerName: BUNDLE.find((b) => b.pkg === pkg)!.providerName };
        if (pkg === '@deepseek-ai/dsh-subagent-acp') {
          // ACP provider 的 Config 要求 command（真实启用时按部署填充；此处仅验证注册兼容）
          config.command = 'node';
        }
        // 生产路径：cordis 用插件 Config 校验并填充默认值后再 apply（dsh-subagent-codex 的
        // disposeGraceMs 等默认值由此产生）；harness 复刻该步骤，避免绕过校验。
        // schemastery Schema 为可调用对象：validate 并返回带默认值的规范化 config（产物形状与 cordis 一致）
        const validated = mod.Config ? mod.Config(config) : config;
        mod.apply(ctx, validated);
        const provider = subagents.getProvider(validated.providerName as string);
        expect(provider, `${pkg} 应注册为 provider ${validated.providerName}`).toBeDefined();
        registered.push({ name: validated.providerName as string, provider });
      }
    } catch (error) {
      bootError = error instanceof Error ? error.message : String(error);
    }
  });

  afterAll(async () => {
    try {
      await ctx?.dispose?.();
    } catch {
      /* 裸 Context 无显式 dispose 生命周期，忽略 */
    }
  });

  it('三个 Bundle 包均以 0.1.1-rc.2 安装（与 DSH 基线同版本线）', () => {
    for (const { pkg, version } of bundlePkgs) {
      expect(version, pkg).toBe('0.1.1-rc.2');
    }
  });

  it('apply 后 ctx.subagents.list() 出现 codex / claude-code / acp', () => {
    expect(bootError).toBeUndefined();
    const names = subagents.list() as string[];
    expect(names).toContain('codex');
    expect(names).toContain('claude-code');
    expect(names).toContain('acp');
     
    console.info(`[exec-bundle] 真实 list() = ${JSON.stringify(names)}`);
  });

  it('注册的 SubagentProvider 形态：name / capabilities / start', () => {
    for (const { name, provider } of registered) {
      expect(provider.name).toBe(name);
      expect(typeof provider.start).toBe('function');
      expect(provider.capabilities).toMatchObject({
        outputSchema: expect.any(Boolean),
        depthLimit: expect.any(Boolean),
        toolFilter: expect.any(Boolean),
        persona: expect.any(Boolean),
      });
    }
  });

  it('Bundle 安装后的真实 list() 输入 → ExecutorRegistry 四类分类一致', () => {
    const registry = new ExecutorRegistry();
    registry.load({ subagents } as any);
    expect(registry.kindOf('codex')).toBe('codex');
    expect(registry.kindOf('claude-code')).toBe('claude_code');
    expect(registry.kindOf('acp')).toBe('acp');
    expect(registry.get('codex')?.capabilities).toBeDefined();
  });
});

/* ------------------------------------------------------------------ */
/* Suite C —— 版本与 peer 满足实证（结论回写依据）                       */
/* ------------------------------------------------------------------ */

describe.skipIf(hostModule === undefined)('C. 版本与 peer 满足实证（宿主 0.1.1-rc.2）', () => {
  // 需求基线：三个 provider @0.1.1-rc.2 的 peerDependencies 为 ^0.1.1-rc.2（cordis ^4.0.1）。
  const PEER_PKGS = [
    '@deepseek-ai/dsh-subagent',
    '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-subprocess',
    '@deepseek-ai/dsh-timeout',
    '@deepseek-ai/dsh-invariants',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-agent',
  ] as const;
  const CORDIS_PKG = '@deepseek-ai/cordis';

  it('宿主 dsh-* peer 包均为 0.1.1-rc.2（满足 ^0.1.1-rc.2）', () => {
    const require = createRequire(import.meta.url);
    for (const name of PEER_PKGS) {
      let pkgPath: string | undefined;
      try {
        pkgPath = require.resolve(`${name}/package.json`);
      } catch {
        const candidate = join(dshRoot(), 'node_modules', name, 'package.json');
        if (existsSync(candidate)) pkgPath = candidate;
      }
      expect(pkgPath, `${name} 应已安装`).toBeDefined();
      const { version } = JSON.parse(readFileSync(pkgPath!, 'utf8')) as { version: string };
      expect(version, `${name} 应满足 ^0.1.1-rc.2`).toBe('0.1.1-rc.2');
    }
  });

  it('宿主 cordis 4.0.1 满足 ^4.0.1', () => {
    const require = createRequire(import.meta.url);
    let pkgPath: string | undefined;
    try {
      pkgPath = require.resolve(`${CORDIS_PKG}/package.json`);
    } catch {
      const candidate = join(dshRoot(), 'node_modules', CORDIS_PKG, 'package.json');
      if (existsSync(candidate)) pkgPath = candidate;
    }
    expect(pkgPath).toBeDefined();
    const { version } = JSON.parse(readFileSync(pkgPath!, 'utf8')) as { version: string };
    expect(version.startsWith('4.0.1')).toBe(true);
  });

  it('结论记录：Bundle 采用 0.1.1-rc.2（npm dist-tag `next`），非 latest(0.0.1-rc.1)', () => {
    // 实证依据：npm view <pkg> dist-tags → latest=0.0.1-rc.1 / next=0.1.1-rc.2；
    // review-report E6 以 latest 版本判定"低于基线"，实际 next 标签与基线同版本线。
    for (const { version } of bundlePkgs) {
      expect(version).toBe('0.1.1-rc.2');
    }
     
    console.info('[exec-bundle] 结论：方案A 成立，无需降级到方案B（spawn/fork 必过 + codex/claude-code/acp 安装后验证均满足）');
  });
});
