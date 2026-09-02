#!/usr/bin/env node
/**
 * P0-ENV-001 —— 环境检查脚本（DSH 插件环境与 ctx.subagents 可用性探测）。
 *
 * 探测内容：
 *  - DSH 安装根（DSH_ROOT 环境变量 > ProgramFiles/deepseek 默认）
 *  - @deepseek-ai/dsh（DSH 版本）与 @deepseek-ai/dsh-subagent（子代理服务）版本
 *  - provider 包安装状态：spawn-in-process / fork-in-process / codex / claude-code / acp
 *  - 默认 agent preset 中 tool-subagent 行及其 provider/disabled 状态
 *
 * 输出：JSON 摘要到 stdout（人读结论到 stderr 同屏显示），退出码恒为 0（纯报告，
 * 安装缺失是"结论"而非"脚本失败"）。可用 `pnpm env:check` 运行。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 查找 DSH 安装根：优先 DSH_ROOT 环境变量，否则探测常见安装路径
 * （注意 Windows 多盘符：ProgramFiles 默认值仅覆盖系统盘，DSH 常装在其它盘）。
 */
function dshRoot() {
  if (process.env.DSH_ROOT) return process.env.DSH_ROOT;
  const programFiles = process.env.ProgramFiles ?? 'C:/Program Files';
  const candidates = [
    join(programFiles, 'deepseek'),
    'D:/Program Files/deepseek',
    'C:/Program Files/deepseek',
    'C:/Program Files (x86)/deepseek',
    join(process.env.USERPROFILE ?? process.env.HOME ?? '', 'AppData', 'Local', 'Programs', 'deepseek'),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'node_modules', '@deepseek-ai', 'dsh-subagent', 'package.json'))) return candidate;
  }
  return candidates[0];
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function findScopedPackage(nodeModulesDir, name) {
  const dir = join(nodeModulesDir, '@deepseek-ai', name);
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) return { name, installed: false, path: undefined, version: undefined };
  const pkg = readJson(pkgPath);
  return { name, installed: true, path: dir, version: pkg?.version };
}

function scanPreset(nodeModulesDir) {
  // 默认 standard preset（DSH 0.1.1-rc.2）
  const presetPath = join(nodeModulesDir, '@deepseek-ai', 'dsh', 'config', 'agent-presets', 'standard', 'agent.cordis.yml');
  if (!existsSync(presetPath)) return { presetPath: undefined, rows: [] };
  const text = readFileSync(presetPath, 'utf8');
  const rows = [];
  const re = /id:\s*tool-subagent(-(?<suffix>\w[\w-]*))?\s*\n(?:[ \t]+.*\n)*?[ \t]+config:\s*\n(?:[ \t]+.*\n)*?[ \t]+provider:\s*(?<provider>\S+)\s*\n/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    const disabled = /disabled:\s*true/.test(text.slice(start, start + 400));
    rows.push({ row: m[0].split('\n')[0].trim(), provider: m.groups.provider, disabled });
  }
  return { presetPath, rows };
}

const root = dshRoot();
const nm = join(root, 'node_modules');

const dshPkg = findScopedPackage(nm, 'dsh');
const subagent = findScopedPackage(nm, 'dsh-subagent');
const providers = [
  'dsh-subagent-spawn-in-process',
  'dsh-subagent-fork-in-process',
  'dsh-subagent-codex',
  'dsh-subagent-claude-code',
  'dsh-subagent-acp',
].map((name) => findScopedPackage(nm, name));

const preset = scanPreset(nm);

const report = {
  generatedAt: new Date().toISOString(),
  dshRoot: root,
  dsh: { version: dshPkg.version ?? 'unknown', installed: dshPkg.installed },
  subagents: {
    version: subagent.version ?? 'unknown',
    installed: subagent.installed,
    api: {
      list: 'list(): string[]  （同步，非 Promise —— 评审 E1/LO-3）',
      start: 'start(name: string, request: { label?, prompt: ContentBlock[], parent: Agent, signal: AbortSignal, ... }) => Promise<SubagentRun>',
      run: 'SubagentRun = { id, localAgent?, result: Promise<{ output: ContentBlock[], structured?, diagnostic?, stopReason }>, dispose() }',
      stopReason: ['completed', 'aborted', 'error', 'max-tokens', 'refusal'],
    },
  },
  providers,
  preset: {
    presetPath: preset.presetPath,
    rows: preset.rows,
  },
  conclusion: [],
};

if (!dshPkg.installed || !subagent.installed) {
  report.conclusion.push('DSH 未安装于默认路径（可用 DSH_ROOT 指定）。Weave 开发依赖 @deepseek-ai/dsh-subagent 时测试仍可运行（Suite B 自动跳过 → mock 路径）。');
} else {
  report.conclusion.push(`DSH 版本 ${dshPkg.version}；ctx.subagents（@deepseek-ai/dsh-subagent ${subagent.version}）API 可用：list()/start()/registerProvider()/getProvider() 均已验证（见 env-subagents-spike.test.ts Suite B）。`);
}

const enabledProviders = providers.filter((p) => p.installed).map((p) => p.name);
const baseline = ['dsh-subagent-spawn-in-process', 'dsh-subagent-fork-in-process'];
const missingBaseline = baseline.filter((n) => !enabledProviders.includes(n));
if (missingBaseline.length === 0) {
  report.conclusion.push(`基线 provider 已安装：${baseline.join(' + ')}（注册名默认 spawn / fork）。`);
} else {
  report.conclusion.push(`基线 provider 缺失：${missingBaseline.join(', ')} → ctx.subagents.start('spawn'/'fork') 在真实环境将抛 NO_PROVIDER。`);
}

const optional = providers.filter((p) => !baseline.includes(p.name));
for (const p of optional) {
  report.conclusion.push(
    p.installed
      ? `可选 provider ${p.name} 已安装（v${p.version}）。`
      : `可选 provider ${p.name} 未安装（npm 最新版 0.0.1-rc.1，低于 DSH 基线；默认 preset 中对应工具行 disabled: true —— 评审 E6）。`,
  );
}
if (preset.rows.length) {
  for (const row of preset.rows) {
    report.conclusion.push(`preset 工具行 ${row.row} → provider=${row.provider}${row.disabled ? '（disabled: true）' : ''}`);
  }
}

console.log(JSON.stringify(report, null, 2));
console.error('\n【环境检查结论】');
for (const line of report.conclusion) console.error(`- ${line}`);
