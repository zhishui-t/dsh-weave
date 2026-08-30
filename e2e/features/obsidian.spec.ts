/**
 * T8 Obsidian e2e: O1-O4
 *
 * O1 Vault 不存在 → generate 自动创建（文档允许自动创建口径）
 * O2 用户已修改同文件 → 保留用户修改，记录 conflict
 * O3 用户删除 → 不重建，记录 tombstone
 * O4 二进制附件 → 只同步 frontmatter/链接，不覆盖二进制
 */
import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { KnowledgeStore } from '../../dist/plugins/weave/knowledge-model.js'
import { ObsidianService } from '../../dist/plugins/weave/obsidian/obsidian-service.js'
import { WeavePersistence } from '../../dist/plugins/weave/persistence/persistence.js'
import { WeaveQueryService } from '../../dist/plugins/weave/web/query-service.js'
import { WeaveError } from '../../dist/plugins/weave/state/weave-error.js'

test.describe('T8 obsidian e2e (real KnowledgeStore + real Vault)', () => {
  const roots: string[] = []
  const persists: WeavePersistence[] = []
  test.afterEach(() => {
    for (const p of persists.splice(0)) p.close()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function makeStore(base: string) {
    const persistence = new WeavePersistence({ inMemory: true })
    persists.push(persistence)
    const store = new KnowledgeStore({
      rootDir: join(base, 'knowledge'),
      metaDb: persistence.knowledgeMeta,
    })
    return store
  }

  async function createKnowledge(store: KnowledgeStore, title: string, body: string, filename: string) {
    return store.createCandidate({
      layer: 'project',
      scope: { projectId: 'demo', version: 'v1' },
      filename,
      frontmatter: { title, type: 'doc', visibility: 'project_only', tags: [] },
      body,
    })
  }

  test('O1: Vault 不存在 → generate 自动创建（不抛 configuration_error）', async () => {
    const base = mkdtempSync(join(tmpdir(), 'weave-e2e-obs-'))
    roots.push(base)
    const vault = join(base, 'vault')
    const store = makeStore(base)
    await createKnowledge(store, '知识 A', '正文', 'a.md')
    const service = new ObsidianService({ defaultVaultPath: vault, knowledgeStore: store })
    const query = new WeaveQueryService({
      persistence: new WeavePersistence({ inMemory: true }),
      obsidianService: service,
    })

    const result = (await query.dispatch('obsidian/generate', { vaultPath: vault })) as {
      generated: number
      vaultPath: string
      conflictCount: number
    }
    expect(existsSync(vault)).toBe(true)
    expect(result.vaultPath).toBe(vault)
    expect(result.generated).toBeGreaterThanOrEqual(1)
    expect(result.conflictCount).toBe(0)

    const status = (await query.dispatch('obsidian/status', { vaultPath: vault })) as {
      exists: boolean
      conflictCount: number
    }
    expect(status).toMatchObject({ exists: true, conflictCount: 0 })
  })

  test('O2: 用户已修改同文件 → 保留用户修改，记录 conflict', async () => {
    const base = mkdtempSync(join(tmpdir(), 'weave-e2e-obs-'))
    roots.push(base)
    const vault = join(base, 'vault')
    const store = makeStore(base)
    await createKnowledge(store, '冲突知识', 'weave original', 'a.md')
    const service = new ObsidianService({ defaultVaultPath: vault, knowledgeStore: store })
    const query = new WeaveQueryService({
      persistence: new WeavePersistence({ inMemory: true }),
      obsidianService: service,
    })

    await query.dispatch('obsidian/generate', { vaultPath: vault })
    const dest = join(vault, '_agent/projects/demo/v1/a.md')
    if (!existsSync(dest)) {
      throw new Error(`expected generated file at ${dest}`)
    }
    writeFileSync(dest, 'user edit', 'utf8')

    const result = (await query.dispatch('obsidian/generate', { vaultPath: vault })) as {
      conflictCount: number
      conflicts?: Array<{ path: string; kind: string }>
    }
    expect(result.conflictCount).toBe(1)
    expect(result.conflicts?.[0]).toMatchObject({ kind: 'user_modified' })
    expect(readFileSync(dest, 'utf8')).toBe('user edit')
  })

  test('O2/force: 双方都改 + force=true → conflict_detected，不覆盖用户修改', async () => {
    const base = mkdtempSync(join(tmpdir(), 'weave-e2e-obs-'))
    roots.push(base)
    const vault = join(base, 'vault')
    const store = makeStore(base)
    await createKnowledge(store, '强迫知识', 'weave v1', 'a.md')
    let service = new ObsidianService({ defaultVaultPath: vault, knowledgeStore: store })
    let query = new WeaveQueryService({ persistence: new WeavePersistence({ inMemory: true }), obsidianService: service })
    await query.dispatch('obsidian/generate', { vaultPath: vault })

    const dest = join(vault, '_agent/projects/demo/v1/a.md')
    writeFileSync(dest, 'user edit', 'utf8')

    // 源也变化：新 store 产生同一知识不同正文
    const store2 = makeStore(base)
    await createKnowledge(store2, '强迫知识', 'weave v2', 'a.md')
    service = new ObsidianService({ defaultVaultPath: vault, knowledgeStore: store2 })
    query = new WeaveQueryService({ persistence: new WeavePersistence({ inMemory: true }), obsidianService: service })

    try {
      await query.dispatch('obsidian/generate', { vaultPath: vault, force: true })
      expect.unreachable('expected conflict_detected')
    } catch (error) {
      expect(error).toBeInstanceOf(WeaveError)
      expect((error as WeaveError).code).toBe('conflict_detected')
    }
    expect(readFileSync(dest, 'utf8')).toBe('user edit')
  })

  test('O3: 用户删除文件 → 不重建，记录 tombstone', async () => {
    const base = mkdtempSync(join(tmpdir(), 'weave-e2e-obs-'))
    roots.push(base)
    const vault = join(base, 'vault')
    const store = makeStore(base)
    await createKnowledge(store, '删除知识', '正文', 'a.md')
    const service = new ObsidianService({ defaultVaultPath: vault, knowledgeStore: store })
    const query = new WeaveQueryService({
      persistence: new WeavePersistence({ inMemory: true }),
      obsidianService: service,
    })

    await query.dispatch('obsidian/generate', { vaultPath: vault })
    const dest = join(vault, '_agent/projects/demo/v1/a.md')
    expect(existsSync(dest)).toBe(true)
    rmSync(dest)

    const result = (await query.dispatch('obsidian/generate', { vaultPath: vault })) as {
      generated: number
      tombstones?: Array<{ path: string }>
    }
    expect(result.generated).toBe(0)
    expect(existsSync(dest)).toBe(false)
    expect(result.tombstones).toHaveLength(1)
  })

  test('O4: 二进制附件不覆盖', async () => {
    const base = mkdtempSync(join(tmpdir(), 'weave-e2e-obs-'))
    roots.push(base)
    const vault = join(base, 'vault')
    mkdirSync(vault, { recursive: true })
    const binary = join(vault, 'assets', 'logo.png')
    mkdirSync(join(vault, 'assets'), { recursive: true })
    const binaryContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
    writeFileSync(binary, binaryContent)

    const store = makeStore(base)
    await createKnowledge(store, '含附件知识', '正文 ![logo](assets/logo.png)', 'a.md')
    const service = new ObsidianService({ defaultVaultPath: vault, knowledgeStore: store })
    const query = new WeaveQueryService({
      persistence: new WeavePersistence({ inMemory: true }),
      obsidianService: service,
    })

    const result = (await query.dispatch('obsidian/generate', { vaultPath: vault })) as {
      generated: number
      conflictCount: number
    }
    expect(result.generated).toBe(1)
    expect(result.conflictCount).toBe(0)
    expect(readFileSync(binary).equals(binaryContent)).toBe(true)
  })
})
