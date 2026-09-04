import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { KnowledgeFile, KnowledgeMeta, KnowledgeStore } from '../../../../src/plugins/weave/knowledge/knowledge-model.js'
import { WeaveCli, WeaveMcp } from '../../../../src/plugins/weave/host/cli-mcp.js'
import { ObsidianCli, parseObsidianCliArgs } from '../../../../src/plugins/weave/obsidian/cli.js'
import { ObsidianService } from '../../../../src/plugins/weave/obsidian/obsidian-service.js'
import { WeavePersistence } from '../../../../src/plugins/weave/persistence/persistence.js'
import { WeaveError } from '../../../../src/plugins/weave/state/weave-error.js'
import { WeaveQueryService } from '../../../../src/plugins/weave/web/query-service.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function makeVault(): string {
  const root = mkdtempSync(join(tmpdir(), 'weave-obsidian-'))
  roots.push(root)
  return root
}

interface MockEntry {
  path: string
  body: string
  title?: string
  status?: 'active' | 'candidate'
}

function makeStore(entries: MockEntry[]): KnowledgeStore {
  const metas: KnowledgeMeta[] = entries.map((entry, index) => ({
    id: `k${index}`,
    path: entry.path,
    layer: 'shared',
    status: entry.status ?? 'active',
    confidence: 0.9,
    freshness_score: 1,
    last_confirmed: null,
    model_version: null,
    created: '2025-01-01',
    updated: '2025-01-01',
  }))
  const files = new Map<string, KnowledgeFile>()
  entries.forEach((entry, index) => {
    const frontmatter = {
      schema_version: '1' as const,
      title: entry.title ?? `知识 ${index}`,
      type: 'doc' as const,
      status: entry.status ?? 'active',
      confidence: 0.9,
      created: '2025-01-01',
      freshness_score: 1,
      visibility: 'global' as const,
      tags: [],
    }
    files.set(`k${index}`, { path: entry.path, frontmatter, body: entry.body })
  })
  return {
    listMeta: async (filter: { status?: 'active' | 'candidate' } = {}): Promise<KnowledgeMeta[]> =>
      filter.status ? metas.filter((meta) => meta.status === filter.status) : metas,
    getKnowledgeFile: (id: string): KnowledgeFile | null => files.get(id) ?? null,
  } as unknown as KnowledgeStore
}

describe('ObsidianService', () => {
  it('generate 首次生成 + 增量刷新：不重写未变更文件，源变更后覆盖', async () => {
    const vault = makeVault()
    const store = makeStore([{ path: 'notes/a.md', body: 'hello' }])
    const service = new ObsidianService({ defaultVaultPath: vault, knowledgeStore: store })

    const first = await service.generate()
    expect(first).toMatchObject({ generated: 1, updated: 0, conflictCount: 0 })
    const dest = join(vault, 'notes/a.md')
    expect(readFileSync(dest, 'utf8')).toContain('title: 知识 0')
    expect(readFileSync(dest, 'utf8')).toContain('hello')

    const unchanged = await service.generate()
    expect(unchanged).toMatchObject({ generated: 0, updated: 0, conflictCount: 0 })

    const changed = new ObsidianService({ defaultVaultPath: vault, knowledgeStore: makeStore([{ path: 'notes/a.md', body: 'hello v2' }]) })
    const second = await changed.generate()
    expect(second).toMatchObject({ generated: 0, updated: 1, conflictCount: 0 })
    expect(readFileSync(dest, 'utf8')).toContain('hello v2')
  })

  it('用户仅修改：保留用户修改并记录 user_modified 冲突', async () => {
    const vault = makeVault()
    const service = new ObsidianService({ defaultVaultPath: vault, knowledgeStore: makeStore([{ path: 'notes/a.md', body: 'weave' }]) })
    await service.generate()
    const dest = join(vault, 'notes/a.md')
    writeFileSync(dest, 'user edit', 'utf8')

    const result = await service.generate()
    expect(result.conflictCount).toBe(1)
    expect(result.conflicts?.[0]).toMatchObject({ path: 'notes/a.md', kind: 'user_modified' })
    expect(readFileSync(dest, 'utf8')).toBe('user edit')
  })

  it('双方都修改：保留用户修改、生成 Weave 备份并记录 both_modified 冲突', async () => {
    const vault = makeVault()
    const service = new ObsidianService({ defaultVaultPath: vault, knowledgeStore: makeStore([{ path: 'notes/a.md', body: 'weave' }]) })
    await service.generate()
    const dest = join(vault, 'notes/a.md')
    writeFileSync(dest, 'user edit', 'utf8')

    const changed = new ObsidianService({ defaultVaultPath: vault, knowledgeStore: makeStore([{ path: 'notes/a.md', body: 'weave v2' }]) })
    const result = await changed.generate()
    expect(result.conflictCount).toBe(1)
    expect(result.conflicts?.[0]).toMatchObject({ kind: 'both_modified', path: 'notes/a.md' })
    expect(result.conflicts?.[0]?.backupPath).toBeTruthy()
    expect(existsSync(join(vault, result.conflicts![0]!.backupPath!))).toBe(true)
    expect(readFileSync(dest, 'utf8')).toBe('user edit')
  })

  it('force=true 遇用户修改/双方修改抛 conflict_detected 错误码', async () => {
    const vault = makeVault()
    const service = new ObsidianService({ defaultVaultPath: vault, knowledgeStore: makeStore([{ path: 'notes/a.md', body: 'weave' }]) })
    await service.generate()
    const dest = join(vault, 'notes/a.md')
    writeFileSync(dest, 'user edit', 'utf8')
    await expect(service.generate({ force: true })).rejects.toMatchObject({ code: 'conflict_detected' })

    const changed = new ObsidianService({ defaultVaultPath: vault, knowledgeStore: makeStore([{ path: 'notes/a.md', body: 'weave v2' }]) })
    await expect(changed.generate({ force: true })).rejects.toMatchObject({ code: 'conflict_detected' })
  })

  it('reindex 对不存在 Vault 抛 configuration_error', async () => {
    const vault = makeVault()
    const missing = join(vault, 'missing')
    const service = new ObsidianService({ defaultVaultPath: vault })
    await expect(service.reindex({ vaultPath: missing })).rejects.toMatchObject({ code: 'configuration_error' })
  })

  it('用户删除：不重建文件并记录 tombstone', async () => {
    const vault = makeVault()
    const store = makeStore([{ path: 'notes/a.md', body: 'weave' }])
    const service = new ObsidianService({ defaultVaultPath: vault, knowledgeStore: store })
    await service.generate()
    const dest = join(vault, 'notes/a.md')
    rmSync(dest)

    const result = await service.generate()
    expect(existsSync(dest)).toBe(false)
    expect(result).toMatchObject({ generated: 0, conflictCount: 0 })
    expect(result.tombstones).toHaveLength(1)
    expect(result.tombstones![0]?.path).toBe('notes/a.md')
  })

  it('用户重命名：保留用户命名，生成新条目并记录 alias', async () => {
    const vault = makeVault()
    const store = makeStore([{ path: 'notes/a.md', body: 'weave' }])
    const service = new ObsidianService({ defaultVaultPath: vault, knowledgeStore: store })
    await service.generate()
    const dest = join(vault, 'notes/a.md')
    const renamed = join(vault, 'notes/b.md')
    renameSync(dest, renamed)

    const result = await service.generate()
    expect(result.aliases).toHaveLength(1)
    expect(result.aliases![0]).toMatchObject({ from: 'notes/a.md', to: 'notes/b.md' })
    expect(existsSync(dest)).toBe(false)
    expect(existsSync(renamed)).toBe(true)
    expect(readFileSync(renamed, 'utf8')).toContain('weave')
  })

  it('reindex 不把未跟踪 Markdown 纳入指纹，后续 generate 仍不覆盖用户文件', async () => {
    const vault = makeVault()
    const manual = join(vault, 'manual.md')
    writeFileSync(manual, 'user manual', 'utf8')
    const store = makeStore([{ path: 'manual.md', body: 'weave content' }])
    const service = new ObsidianService({ defaultVaultPath: vault, knowledgeStore: store })

    await service.reindex()
    await service.generate()
    expect(readFileSync(manual, 'utf8')).toBe('user manual')
    expect(existsSync(join(vault, '.weave-fingerprint.json'))).toBe(true)
  })

  it('open/status：不存在 vault 报 configuration_error，存在后返回 URI 与状态', async () => {
    const vault = makeVault()
    const missing = join(vault, 'missing')
    const service = new ObsidianService({ defaultVaultPath: vault, knowledgeStore: makeStore([{ path: 'a.md', body: 'x' }]) })
    await expect(service.open({ vaultPath: missing })).rejects.toMatchObject({ code: 'configuration_error' })
    await service.generate()
    const opened = await service.open()
    expect(opened.uri).toContain('obsidian://open?path=')
    const status = await service.status()
    expect(status).toMatchObject({ exists: true, conflictCount: 0, fileCount: 1, knowledgeCount: 1 })
  })
})

describe('ObsidianCli', () => {
  it('help/参数解析/基本命令/非法命令', async () => {
    const vault = makeVault()
    const service = new ObsidianService({ defaultVaultPath: vault, knowledgeStore: makeStore([{ path: 'a.md', body: 'x' }]) })
    const cli = new ObsidianCli(service)

    const help = await cli.run(['--help'])
    expect(help.text).toContain('/weave obsidian')

    const parsed = parseObsidianCliArgs(['--vault', vault, '--force'])
    expect(parsed.flags.get('vault')).toBe(vault)
    expect(parsed.flags.has('force')).toBe(true)

    const generated = await cli.run(['generate', '--vault', vault])
    expect(generated.text).toContain('新增: 1')
    expect((generated.data as { generated: number }).generated).toBe(1)

    await expect(cli.run(['unknown'])).rejects.toMatchObject({ code: 'invalid_argument' })

    const weaveVault = makeVault()
    const weaveCli = new WeaveCli(new WeaveMcp({} as never), undefined, cli)
    const viaWeave = await weaveCli.run(['obsidian', 'generate', '--vault', weaveVault])
    expect(viaWeave.text).toContain('新增: 1')
    expect(viaWeave.exitCode).toBe(0)
  })
})

describe('RPC 层 obsidian 端点', () => {
  it('WeaveQueryService 能分发 obsidian/* 并返回业务结果', async () => {
    const vault = makeVault()
    const service = new ObsidianService({ defaultVaultPath: vault, knowledgeStore: makeStore([{ path: 'a.md', body: 'x' }]) })
    const query = new WeaveQueryService({ persistence: new WeavePersistence({ inMemory: true }), obsidianService: service })

    await query.obsidianGenerate({ vaultPath: vault })
    const status = await query.dispatch('obsidian/status', { vaultPath: vault })
    expect(status).toMatchObject({ exists: true, vaultPath: vault, conflictCount: 0 })
  })

  it('未注入 ObsidianService 时返回 configuration_error', async () => {
    const query = new WeaveQueryService({ persistence: new WeavePersistence({ inMemory: true }) })
    await expect(query.dispatch('obsidian/status', {})).rejects.toBeInstanceOf(WeaveError)
    await expect(query.dispatch('obsidian/status', {})).rejects.toMatchObject({ code: 'configuration_error' })
  })
})
