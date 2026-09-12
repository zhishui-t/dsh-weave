#!/usr/bin/env node
/**
 * migrate-knowledge-to-prism —— 一次性迁移：旧 weave 知识库（~/.dsh/knowledge
 * Markdown 卡片）→ Prism 知识库（POST /api/kb/deposit）。
 *
 *   node scripts/migrate-knowledge-to-prism.mjs [--knowledge-dir <dir>] [--url <prism>]
 *        [--include-candidate] [--dry-run]
 *
 * 映射（与 PrismGateway.approveStaged 同构）：
 * - 目录 → 层：_agent/projects/<pid>/<ver> → project(owner=pid)；roles/<rid> → role(owner=rid)；
 *   instances/* → project（instance 维度已废弃）；shared / _human → global
 * - type：pitfall/pattern/doc/guide 直映；skill→guide；other→doc
 * - book='weave-imported'，module=type；tags 原样 + `source:weave-migration`
 * - frontmatter.id 存在则沿用（同 id 重复执行 → prism 版次 +1，安全幂等）
 * - 默认只迁移 active；--include-candidate 连 candidate 一起迁
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, basename, relative } from 'node:path'
import { homedir } from 'node:os'
import process from 'node:process'

function parseArgs(argv) {
  const out = {
    knowledgeDir: join(homedir(), '.dsh', 'knowledge'),
    url: process.env.WEAVE_PRISM_URL ?? 'http://127.0.0.1:7777',
    includeCandidate: false,
    dryRun: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--knowledge-dir') out.knowledgeDir = argv[++i]
    else if (argv[i] === '--url') out.url = argv[++i]
    else if (argv[i] === '--include-candidate') out.includeCandidate = true
    else if (argv[i] === '--dry-run') out.dryRun = true
  }
  return out
}

/** 简易 frontmatter 解析（--- 包围的 key: value；tags 支持 [a, b] 或多行 - 项）。 */
function parseFrontmatter(text) {
  if (!text.startsWith('---')) return { meta: {}, body: text }
  const end = text.indexOf('\n---', 3)
  if (end < 0) return { meta: {}, body: text }
  const head = text.slice(4, end)
  const body = text.slice(end + 4).replace(/^\n+/, '')
  const meta = {}
  for (const line of head.split('\n')) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (!m) continue
    const key = m[1]
    let value = m[2].trim()
    if (value === '') continue
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
    } else {
      value = value.replace(/^['"]|['"]$/g, '')
    }
    meta[key] = value
  }
  return { meta, body }
}

/** 目录路径 → prism 层/owner。 */
function layerOf(relativePath) {
  const normalized = relativePath.split('\\').join('/')
  if (normalized.includes('_agent/projects/')) {
    const rest = normalized.slice(normalized.indexOf('_agent/projects/') + '_agent/projects/'.length)
    return { layer: 'project', owner: rest.split('/')[0] ?? '' }
  }
  if (normalized.includes('_agent/roles/')) {
    const rest = normalized.slice(normalized.indexOf('_agent/roles/') + '_agent/roles/'.length)
    return { layer: 'role', owner: rest.split('/')[0] ?? '' }
  }
  // instances 维度已废弃：归并 project 层（owner 缺失 → 全局兜底）
  if (normalized.includes('_agent/instances/')) {
    const rest = normalized.slice(normalized.indexOf('_agent/instances/') + '_agent/instances/'.length)
    return { layer: 'project', owner: rest.split('/')[0] ?? '' }
  }
  return { layer: 'global' }
}

function mapType(type) {
  if (type === 'pitfall' || type === 'pattern' || type === 'doc' || type === 'guide' || type === 'rule' || type === 'diagram' || type === 'summary') return type
  if (type === 'skill') return 'guide'
  return 'doc'
}

async function collectMarkdown(dir, out = []) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '.graphify' || entry.name === '_views') continue
      await collectMarkdown(full, out)
    } else if (entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('_')) {
      out.push(full)
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const files = await collectMarkdown(args.knowledgeDir)
let migrated = 0
let skipped = 0
let failed = 0

for (const file of files) {
  const rel = relative(args.knowledgeDir, file)
  const raw = await readFile(file, 'utf8')
  const { meta, body } = parseFrontmatter(raw)
  const status = String(meta.status ?? 'candidate')
  if (!args.includeCandidate && status !== 'active') {
    skipped += 1
    continue
  }
  const title = String(meta.title ?? basename(file, '.md'))
  const type = mapType(String(meta.type ?? 'doc'))
  const { layer, owner } = layerOf(rel)
  const tags = Array.isArray(meta.tags) ? meta.tags : (typeof meta.tags === 'string' && meta.tags !== '' ? [meta.tags] : [])
  const payload = {
    ...(meta.id ? { id: String(meta.id) } : {}),
    title,
    type,
    layer,
    ...(owner ? { owner } : {}),
    book: 'weave-imported',
    module: type,
    content: body.trim(),
    tags: [...tags, 'source:weave-migration'],
    source: { kind: 'import', ref: rel },
  }
  if (args.dryRun) {
    process.stdout.write(`[dry] ${rel} → ${layer}${owner ? `/${owner}` : ''} ${type} «${title}»\n`)
    migrated += 1
    continue
  }
  try {
    const response = await fetch(new URL('/api/kb/deposit', args.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    })
    const result = await response.json()
    if (!response.ok || result.ok !== true) {
      failed += 1
      process.stderr.write(`[fail] ${rel}: ${JSON.stringify(result.error ?? { status: response.status })}\n`)
      continue
    }
    migrated += 1
    process.stdout.write(`[ok] ${rel} → ${result.value.id}@v${result.value.version}（${result.value.action}）\n`)
  } catch (error) {
    failed += 1
    process.stderr.write(`[fail] ${rel}: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

const sourceDirExists = await stat(args.knowledgeDir).then(() => true).catch(() => false)
process.stdout.write(`\n迁移完成：${migrated} 迁移 / ${skipped} 跳过（非 active） / ${failed} 失败（源目录: ${sourceDirExists ? args.knowledgeDir : '不存在'}）\n`)
if (failed > 0) process.exitCode = 1
