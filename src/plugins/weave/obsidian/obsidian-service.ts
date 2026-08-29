import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import type { KnowledgeMeta, KnowledgeStore } from '../knowledge-model.js'
import { serializeKnowledgeFile } from '../knowledge-model.js'
import { WeaveError } from '../state/weave-error.js'

/**
 * Obsidian 真实 Vault 集成服务（doc/09 §2.3 / §2.6，T3）。
 *
 * 能力：
 * - generate：把 Weave active/candidate 知识同步到 Vault Markdown，并执行冲突保护；
 * - open：返回 `obsidian://open?path=<vault>` 协议 URI；
 * - reindex：扫描 Vault 内 Markdown，重新建立用户侧指纹；
 * - status：Vault 存在性、最近生成时间、冲突计数等摘要；
 * - conflicts：当前冲突/墓碑/别名清单。
 *
 * 冲突矩阵（doc/09 §2.6）：
 * | Weave 更新，用户未改        | 覆盖                                   |
 * | Weave 更新，用户已改        | 保留用户修改，记录 conflict            |
 * | 双方都改                    | 保留用户修改，Weave 侧备份，记录 conflict |
 * | 用户删除                    | 不重新生成该文件，记录 tombstone        |
 * | 首次生成                    | 全量生成；已有文件不覆盖                |
 * | 用户重命名                  | 保留用户命名，生成新条目，记录 alias    |
 * | 二进制附件                  | 仅同步 frontmatter 与链接，不覆盖二进制 |
 * | 增量刷新                    | 只重算变更条目，未变更文件不重写        |
 *
 * 说明：本服务只同步知识 Markdown（active/candidate），不会覆盖二进制附件；
 * 增量刷新通过 `.weave-fingerprint.json` 里的源/目标 hash 比较实现。
 */

const STATE_FILE = '.weave-fingerprint.json'
const BACKUP_DIR = '.weave-backups'
const STATE_VERSION = 1

export interface ObsidianGenerateInput {
  vaultPath?: string
  /** true 时强制覆盖未变更文件；遇用户修改将抛 conflict_detected（保护用户编辑）。 */
  force?: boolean
}

export interface ObsidianConflict {
  path: string
  kind: 'user_modified' | 'both_modified'
  detectedAt: string
  externalHash: string
  weaveHash: string
  backupPath?: string
}

export interface ObsidianTombstone {
  path: string
  detectedAt: string
}

export interface ObsidianAlias {
  from: string
  to: string
  detectedAt: string
}

export interface ObsidianGenerateResult {
  generated: number
  updated: number
  vaultPath: string
  conflictCount: number
  existingSkipped?: number
  conflicts?: ObsidianConflict[]
  tombstones?: ObsidianTombstone[]
  aliases?: ObsidianAlias[]
}

export interface ObsidianOpenInput {
  vaultPath?: string
}

export interface ObsidianOpenResult {
  opened: true
  vaultPath: string
  uri: string
}

export interface ObsidianReindexInput {
  vaultPath?: string
}

export interface ObsidianReindexResult {
  reindexed: true
  entries: number
  vaultPath: string
  conflictCount: number
}

export interface ObsidianStatusInput {
  vaultPath?: string
}

export interface ObsidianStatusResult {
  exists: boolean
  vaultPath: string
  lastGeneratedAt: string | null
  conflictCount: number
  fileCount?: number
  knowledgeCount?: number
  conflicts?: ObsidianConflict[]
}

interface FingerprintFile {
  sourceHash: string
  destHash: string
  mtimeMs: number
  syncedAt: string
}

interface ObsidianState {
  version: number
  generatedAt: string | null
  files: Record<string, FingerprintFile>
  conflicts: ObsidianConflict[]
  tombstones: ObsidianTombstone[]
  aliases: ObsidianAlias[]
}

export interface ObsidianServiceOptions {
  /** Vault 默认路径；缺省 ~/.dsh/obsidian。 */
  defaultVaultPath?: string
  /** 知识仓库；缺省时 generate 只创建/管理空 Vault（不产生知识镜像）。 */
  knowledgeStore?: KnowledgeStore
}

export class ObsidianService {
  readonly defaultVaultPath: string
  readonly #knowledgeStore?: KnowledgeStore

  constructor(options: ObsidianServiceOptions = {}) {
    this.defaultVaultPath = expandHome(options.defaultVaultPath ?? join(homedir(), '.dsh', 'obsidian'))
    this.#knowledgeStore = options.knowledgeStore
  }

  /** 解析并规范化 Vault 路径（支持 ~/.dsh/obsidian 简写）。 */
  resolveVaultPath(vaultPath?: string): string {
    const raw = vaultPath?.trim() ?? this.defaultVaultPath
    return expandHome(raw)
  }

  /** 生成/刷新 Vault：Weave 知识 → Obsidian Markdown（增量、冲突保护）。 */
  async generate(input: ObsidianGenerateInput = {}): Promise<ObsidianGenerateResult> {
    const vault = this.resolveVaultPath(input.vaultPath)
    this.#ensureVault(vault)

    const now = new Date().toISOString()
    const state = this.#readState(vault)
    const entries = await this.#listKnowledge()
    let generated = 0
    let updated = 0
    let existingSkipped = 0

    for (const meta of entries) {
      const rel = normalizeSlashes(meta.path)
      if (!this.#isSafeRelative(rel)) {
        continue
      }
      // 只镜像 Markdown 知识文件；二进制/其它附件不覆盖。
      if (!rel.toLowerCase().endsWith('.md')) {
        continue
      }
      const dest = join(vault, rel)
      const old = state.files[rel]
      const sourceText = this.#sourceText(meta)
      if (sourceText === null) continue
      const sourceHash = sha256(sourceText)
      const destExists = existsSync(dest)

      if (!destExists) {
        // 用户重命名：保留用户命名，把最新 Weave 内容写到新路径，并记录 alias。
        if (old) {
          const renamed = this.#findRenameTarget(vault, rel, old.destHash, state)
          if (renamed !== undefined && renamed !== rel) {
            this.#applyRename(vault, rel, renamed, sourceText, sourceHash, state, now)
            updated += 1
            this.#removeConflict(state.conflicts, rel)
            continue
          }
        }
        // 用户删除：不重新生成该文件，记录 tombstone。
        if (old || this.#hasTombstone(state.tombstones, rel)) {
          this.#upsertTombstone(state.tombstones, { path: rel, detectedAt: now })
          this.#removeConflict(state.conflicts, rel)
          continue
        }
        this.#writeTextFile(dest, sourceText)
        generated += 1
        state.files[rel] = fingerprintFor(sourceHash, sourceHash, now)
        this.#removeConflict(state.conflicts, rel)
        continue
      }

      // 首次生成时已有文件不覆盖（保留用户 / 既有 Vault 内容）。
      if (!old) {
        existingSkipped += 1
        continue
      }

      const destHash = hashFile(dest)
      const userModified = destHash !== old.destHash
      const sourceModified = sourceHash !== old.sourceHash
      if (!userModified && !sourceModified) {
        continue
      }

      if (userModified && sourceModified) {
        if (input.force === true) {
          throw new WeaveError('conflict_detected', 'Obsidian 文件已被用户修改且无法安全覆盖（双方都改）', {
            vaultPath: vault,
            path: rel,
            externalHash: destHash,
            weaveHash: sourceHash,
          })
        }
        const backupPath = this.#backupSource(vault, rel, sourceText)
        this.#upsertConflict(state.conflicts, {
          path: rel,
          kind: 'both_modified',
          detectedAt: now,
          externalHash: destHash,
          weaveHash: sourceHash,
          backupPath,
        })
        continue
      }

      if (userModified) {
        if (input.force === true) {
          throw new WeaveError('conflict_detected', 'Obsidian 文件已被用户修改且无法安全覆盖', {
            vaultPath: vault,
            path: rel,
            externalHash: destHash,
            weaveHash: sourceHash,
          })
        }
        this.#upsertConflict(state.conflicts, {
          path: rel,
          kind: 'user_modified',
          detectedAt: now,
          externalHash: destHash,
          weaveHash: sourceHash,
        })
        continue
      }

      // 用户未改、Weave 更新：覆盖。
      this.#writeTextFile(dest, sourceText)
      updated += 1
      state.files[rel] = fingerprintFor(sourceHash, sourceHash, now)
      this.#removeConflict(state.conflicts, rel)
    }

    state.generatedAt = now
    this.#writeState(vault, state)
    return {
      generated,
      updated,
      vaultPath: vault,
      conflictCount: state.conflicts.length,
      ...(existingSkipped > 0 ? { existingSkipped } : {}),
      ...(state.conflicts.length > 0 ? { conflicts: [...state.conflicts] } : {}),
      ...(state.tombstones.length > 0 ? { tombstones: [...state.tombstones] } : {}),
      ...(state.aliases.length > 0 ? { aliases: [...state.aliases] } : {}),
    }
  }

  /** 返回 Obsidian 打开协议 URI（CLI/宿主可另行 spawn）。 */
  async open(input: ObsidianOpenInput = {}): Promise<ObsidianOpenResult> {
    const vault = this.resolveVaultPath(input.vaultPath)
    if (!existsSync(vault) || !statSync(vault).isDirectory()) {
      throw new WeaveError('configuration_error', 'Obsidian Vault 不存在或不可用', { vaultPath: vault })
    }
    const uri = `obsidian://open?path=${encodeURIComponent(vault)}`
    return { opened: true, vaultPath: vault, uri }
  }

  /** 手动回索引：扫描 Vault 内 Markdown，把用户侧 hash 更新进指纹。 */
  async reindex(input: ObsidianReindexInput = {}): Promise<ObsidianReindexResult> {
    const vault = this.resolveVaultPath(input.vaultPath)
    if (!existsSync(vault) || !statSync(vault).isDirectory()) {
      throw new WeaveError('configuration_error', 'Obsidian Vault 不存在或不可用', { vaultPath: vault })
    }

    const now = new Date().toISOString()
    const state = this.#readState(vault)
    const files = collectMarkdown(vault)
    const seen = new Set<string>()
    for (const rel of files) {
      seen.add(rel)
      const old = state.files[rel]
      // 只重建 Weave 已跟踪文件的指纹。未跟踪的已有 Markdown 保持“首次生成不覆盖”语义，
      // 避免空 sourceHash 被下一次 generate 判定为 Weave 更新后覆盖用户文件。
      if (!old) continue
      const dest = join(vault, rel)
      state.files[rel] = {
        sourceHash: old.sourceHash,
        destHash: hashFile(dest),
        mtimeMs: mtimeOf(dest),
        syncedAt: now,
      }
      this.#removeConflict(state.conflicts, rel)
    }
    // 用户通过回索引同时删除了 Weave 曾跟踪的文件：记录 tombstone，防止后续 generate 复活。
    for (const rel of Object.keys(state.files)) {
      if (seen.has(rel)) continue
      const dest = join(vault, rel)
      if (!existsSync(dest)) {
        this.#upsertTombstone(state.tombstones, { path: rel, detectedAt: now })
      }
    }
    this.#writeState(vault, state)
    return {
      reindexed: true,
      entries: files.length,
      vaultPath: vault,
      conflictCount: state.conflicts.length,
    }
  }

  /** 状态摘要：Vault 存在性 / 最近生成时间 / 冲突计数。 */
  async status(input: ObsidianStatusInput = {}): Promise<ObsidianStatusResult> {
    const vault = this.resolveVaultPath(input.vaultPath)
    const exists = existsSync(vault) && statSync(vault).isDirectory()
    if (!exists) {
      return { exists, vaultPath: vault, lastGeneratedAt: null, conflictCount: 0 }
    }
    const state = this.#readState(vault)
    const files = collectMarkdown(vault)
    const knowledgeCount = (await this.#listKnowledge()).length
    return {
      exists: true,
      vaultPath: vault,
      lastGeneratedAt: state.generatedAt,
      conflictCount: state.conflicts.length,
      fileCount: files.length,
      ...(knowledgeCount > 0 ? { knowledgeCount } : {}),
      ...(state.conflicts.length > 0 ? { conflicts: [...state.conflicts] } : {}),
    }
  }

  /** 冲突/墓碑/别名清单。 */
  async conflicts(input: ObsidianStatusInput = {}): Promise<{
    vaultPath: string
    conflicts: ObsidianConflict[]
    tombstones?: ObsidianTombstone[]
    aliases?: ObsidianAlias[]
  }> {
    const vault = this.resolveVaultPath(input.vaultPath)
    if (!existsSync(vault) || !statSync(vault).isDirectory()) {
      throw new WeaveError('configuration_error', 'Obsidian Vault 不存在或不可用', { vaultPath: vault })
    }
    const state = this.#readState(vault)
    return {
      vaultPath: vault,
      conflicts: [...state.conflicts],
      ...(state.tombstones.length > 0 ? { tombstones: [...state.tombstones] } : {}),
      ...(state.aliases.length > 0 ? { aliases: [...state.aliases] } : {}),
    }
  }

  /* ------------------------------ 内部实现 ------------------------------ */

  #ensureVault(vault: string): void {
    try {
      mkdirSync(vault, { recursive: true })
      const meta = statSync(vault)
      if (!meta.isDirectory()) {
        throw new Error(`路径不是目录: ${vault}`)
      }
    } catch (error) {
      throw new WeaveError('configuration_error', `Obsidian Vault 不存在/不可写: ${vault}`, {
        vaultPath: vault,
        cause: error instanceof Error ? error.message : String(error),
      })
    }
  }

  #readState(vault: string): ObsidianState {
    const file = join(vault, STATE_FILE)
    if (!existsSync(file)) {
      return emptyState()
    }
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<ObsidianState>
      return normalizeState(raw)
    } catch (error) {
      throw new WeaveError('internal', `Obsidian 指纹读取失败: ${file}`, {
        vaultPath: vault,
        stateFile: file,
        cause: error instanceof Error ? error.message : String(error),
      })
    }
  }

  #writeState(vault: string, state: ObsidianState): void {
    const file = join(vault, STATE_FILE)
    try {
      writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    } catch (error) {
      throw new WeaveError('internal', `Obsidian 指纹写入失败: ${file}`, {
        vaultPath: vault,
        stateFile: file,
        cause: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async #listKnowledge(): Promise<KnowledgeMeta[]> {
    const store = this.#knowledgeStore
    if (!store) return []
    const [active, candidate] = await Promise.all([
      store.listMeta({ status: 'active' }),
      store.listMeta({ status: 'candidate' }),
    ])
    return [...active, ...candidate]
  }

  #sourceText(meta: KnowledgeMeta): string | null {
    const store = this.#knowledgeStore
    if (!store) return null
    const file = store.getKnowledgeFile(meta.id)
    if (!file) return null
    return serializeKnowledgeFile(file.frontmatter, file.body)
  }

  #isSafeRelative(rel: string): boolean {
    if (rel === '' || rel === STATE_FILE || rel.split('/').includes('..') || rel.startsWith('/') || rel.startsWith('\\') || isAbsolute(rel)) {
      return false
    }
    if (rel.split('/').some((segment) => segment.startsWith('.weave'))) {
      return false
    }
    return !rel.includes('\0')
  }

  #writeTextFile(dest: string, text: string): void {
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, text, 'utf8')
  }

  #backupSource(vault: string, rel: string, sourceText: string): string {
    const backupDir = join(vault, BACKUP_DIR, dirname(rel))
    mkdirSync(backupDir, { recursive: true })
    const name = `${basename(rel).replace(/\.md$/i, '')}-${Date.now()}.md`
    const backupPath = join(backupDir, name)
    writeFileSync(backupPath, sourceText, 'utf8')
    return normalizeSlashes(relative(vault, backupPath))
  }

  #upsertConflict(list: ObsidianConflict[], conflict: ObsidianConflict): void {
    const index = list.findIndex((item) => item.path === conflict.path)
    if (index >= 0) list[index] = conflict
    else list.push(conflict)
  }

  #removeConflict(list: ObsidianConflict[], path: string): void {
    const index = list.findIndex((item) => item.path === path)
    if (index >= 0) list.splice(index, 1)
  }

  #upsertTombstone(list: ObsidianTombstone[], tombstone: ObsidianTombstone): void {
    if (list.some((item) => item.path === tombstone.path)) return
    list.push(tombstone)
  }

  #removeTombstone(list: ObsidianTombstone[], path: string): void {
    const index = list.findIndex((item) => item.path === path)
    if (index >= 0) list.splice(index, 1)
  }

  #hasTombstone(list: ObsidianTombstone[], path: string): boolean {
    return list.some((item) => item.path === path)
  }

  #upsertAlias(list: ObsidianAlias[], alias: ObsidianAlias): void {
    const index = list.findIndex((item) => item.from === alias.from)
    if (index >= 0) list[index] = alias
    else list.push(alias)
  }

  /**
   * 用户重命名启发：旧路径缺失时，在 Vault 中寻找一个内容 hash 与上次同步目标一致的
   * 未跟踪 Markdown。命中即视为“纯改名”，保留用户命名并把最新 Weave 内容写到新路径。
   */
  #findRenameTarget(vault: string, fromRel: string, oldDestHash: string, state: ObsidianState): string | undefined {
    if (oldDestHash === '') return undefined
    const candidates = collectMarkdown(vault).filter((candidate) => {
      if (candidate === fromRel) return false
      if (state.files[candidate] !== undefined) return false
      if (this.#hasTombstone(state.tombstones, candidate)) return false
      const candidatePath = join(vault, candidate)
      if (!existsSync(candidatePath)) return false
      try {
        return hashFile(candidatePath) === oldDestHash
      } catch {
        return false
      }
    })
    return candidates[0]
  }

  #applyRename(
    vault: string,
    fromRel: string,
    toRel: string,
    sourceText: string,
    sourceHash: string,
    state: ObsidianState,
    now: string,
  ): void {
    this.#writeTextFile(join(vault, toRel), sourceText)
    delete state.files[fromRel]
    state.files[toRel] = fingerprintFor(sourceHash, sourceHash, now)
    this.#removeConflict(state.conflicts, fromRel)
    this.#removeConflict(state.conflicts, toRel)
    this.#removeTombstone(state.tombstones, fromRel)
    this.#removeTombstone(state.tombstones, toRel)
    this.#upsertAlias(state.aliases, { from: fromRel, to: toRel, detectedAt: now })
  }
}

function emptyState(): ObsidianState {
  return { version: STATE_VERSION, generatedAt: null, files: {}, conflicts: [], tombstones: [], aliases: [] }
}

function normalizeState(raw: Partial<ObsidianState>): ObsidianState {
  const files: Record<string, FingerprintFile> = {}
  if (raw.files && typeof raw.files === 'object') {
    for (const [path, value] of Object.entries(raw.files)) {
      if (!value || typeof value !== 'object') continue
      const sourceHash = typeof value.sourceHash === 'string' ? value.sourceHash : ''
      const destHash = typeof value.destHash === 'string' ? value.destHash : ''
      const mtimeMs = typeof value.mtimeMs === 'number' ? value.mtimeMs : 0
      const syncedAt = typeof value.syncedAt === 'string' ? value.syncedAt : ''
      files[path] = { sourceHash, destHash, mtimeMs, syncedAt }
    }
  }
  return {
    version: STATE_VERSION,
    generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : null,
    files,
    conflicts: Array.isArray(raw.conflicts) ? raw.conflicts.filter(isConflictLike) : [],
    tombstones: Array.isArray(raw.tombstones) ? raw.tombstones.filter(isTombstoneLike) : [],
    aliases: Array.isArray(raw.aliases) ? raw.aliases.filter(isAliasLike) : [],
  }
}

function isConflictLike(value: unknown): value is ObsidianConflict {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return typeof item.path === 'string' && typeof item.detectedAt === 'string'
}

function isTombstoneLike(value: unknown): value is ObsidianTombstone {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return typeof item.path === 'string' && typeof item.detectedAt === 'string'
}

function isAliasLike(value: unknown): value is ObsidianAlias {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return typeof item.from === 'string' && typeof item.to === 'string'
}

function fingerprintFor(sourceHash: string, destHash: string, syncedAt: string): FingerprintFile {
  return { sourceHash, destHash, mtimeMs: 0, syncedAt }
}

function expandHome(input: string): string {
  const value = input.trim()
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return resolve(join(homedir(), value.slice(2)))
  }
  return resolve(value)
}

function normalizeSlashes(value: string): string {
  return value.split('\\').join('/')
}

function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex')
}

function hashFile(file: string): string {
  return sha256(readFileSync(file))
}

function mtimeOf(file: string): number {
  return statSync(file).mtimeMs
}

function collectMarkdown(root: string): string[] {
  const out: string[] = []
  const walk = (current: string): void => {
    let children: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
    try {
      children = readdirSync(current, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
    } catch {
      return
    }
    for (const entry of children) {
      if (entry.name.startsWith('.weave')) continue
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        out.push(normalizeSlashes(relative(root, full)))
      }
    }
  }
  walk(root)
  return out.sort()
}
