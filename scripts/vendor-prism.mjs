#!/usr/bin/env node
/**
 * vendor-prism —— 把子项目 prism 打包进 weave 插件（"一个插件整体"的交付形态）。
 *
 *   node scripts/vendor-prism.mjs [--prism <prism 仓库路径>] [--skip-build]
 *
 * 步骤：
 *  1. 在 prism 仓库跑 `node scripts/package.mjs --out <weave>/dist/vendor-tmp`
 *     （默认包含 pnpm build；--skip-build 复用 prism 现有 dist）；
 *  2. 把产物 `prism-<version>/` 归位为 `dist/vendor/prism/`（删除旧版）；
 *  3. 打印等效环境变量（WEAVE_PRISM_SCRIPT / WEAVE_PRISM_MCP_ENTRY）。
 *
 * 运行时无需设环境变量：PrismSupervisor 会自动探测 `dist/vendor/prism/`
 * 下的 bin/prism.js（serve/CLI）与 packages/server/dist/mcp/server.js（MCP）。
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const WEAVE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const out = { prism: process.env.WEAVE_PRISM_REPO ?? resolve(WEAVE_ROOT, '..', 'prism'), skipBuild: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--prism') out.prism = resolve(argv[++i])
    else if (argv[i] === '--skip-build') out.skipBuild = true
  }
  return out
}

function run(cmd, args, cwd) {
  // 不用 shell：cmd/args 都是数组且路径可能含空格（shell:true 时 Windows 裸重解析会炸）
  const result = spawnSync(cmd, args, { cwd, stdio: 'inherit' })
  if (result.status !== 0) {
    process.stderr.write(`[vendor-prism] 命令失败（exit=${result.status}）: ${cmd} ${args.join(' ')}（cwd=${cwd}）\n`)
    process.exit(result.status ?? 1)
  }
}

const args = parseArgs(process.argv.slice(2))
const packageScript = join(args.prism, 'scripts', 'package.mjs')
if (!existsSync(packageScript)) {
  process.stderr.write(`[vendor-prism] 未找到 prism 打包脚本: ${packageScript}（用 --prism 指定仓库路径）\n`)
  process.exit(1)
}

const tmpDir = join(WEAVE_ROOT, 'dist', 'vendor-tmp')
rmSync(tmpDir, { recursive: true, force: true })
mkdirSync(tmpDir, { recursive: true })

const buildArgs = [packageScript, '--out', tmpDir]
if (args.skipBuild) buildArgs.push('--skip-build')
run(process.execPath, buildArgs, args.prism)

const staged = readdirSync(tmpDir).filter((name) => {
  try {
    return statSync(join(tmpDir, name)).isDirectory() && name.startsWith('prism-')
  } catch {
    return false
  }
})
if (staged.length !== 1) {
  process.stderr.write(`[vendor-prism] 产物异常：期望 1 个 prism-<version> 目录，实际 ${JSON.stringify(staged)}\n`)
  process.exit(1)
}

const vendorDir = join(WEAVE_ROOT, 'dist', 'vendor')
const target = join(vendorDir, 'prism')
rmSync(target, { recursive: true, force: true })
mkdirSync(vendorDir, { recursive: true })
cpSync(join(tmpDir, staged[0]), target, { recursive: true })
rmSync(tmpDir, { recursive: true, force: true })

const serveEntry = join(target, 'bin', 'prism.js')
const mcpEntry = join(target, 'packages', 'server', 'dist', 'mcp', 'server.js')
for (const entry of [serveEntry, mcpEntry]) {
  if (!existsSync(entry)) {
    process.stderr.write(`[vendor-prism] 产物缺少入口: ${entry}\n`)
    process.exit(1)
  }
}

process.stdout.write(`[vendor-prism] 完成: ${target}\n`)
process.stdout.write(`  WEAVE_PRISM_SCRIPT=${serveEntry}\n`)
process.stdout.write(`  WEAVE_PRISM_MCP_ENTRY=${mcpEntry}\n`)
process.stdout.write('  （运行时可不设：PrismSupervisor 自动探测 dist/vendor/prism/）\n')
