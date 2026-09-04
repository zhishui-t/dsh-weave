import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DelegationService } from '../../../../src/plugins/weave/scheduling/delegation-service'
import { ExecutorRegistry } from '../../../../src/plugins/weave/executors/executor-registry'
import {
  KnowledgeEngine,
  scoreKnowledge,
  type InjectionSearchParams,
} from '../../../../src/plugins/weave/knowledge/knowledge-engine'
import { KnowledgeStore, type KnowledgeLayer, type KnowledgeScope } from '../../../../src/plugins/weave/knowledge/knowledge-model'
import { openPersistence } from '../../../../src/plugins/weave/persistence/index'
import { SessionTracker } from '../../../../src/plugins/weave/scheduling/session-tracker'
import type { TaskRecord } from '../../../../src/plugins/weave/state/types'
import { MockSubagentsContext } from './fixtures/mock-subagents'

const LIMITS = { max_entries: 5, max_chars_per_entry: 500, max_total_chars: 2500, priority: 'freshness_first' as const }

describe('scoreKnowledge（TDD 2.2.6 权重表）', () => {
  const params = { projectId: 'proj-a', version: 'v2', roleId: 'coder' }
  const meta = (layer: KnowledgeLayer, path: string, freshness = 1.0) => ({ layer, path, freshness_score: freshness })

  it('当前版本项目知识 = 1.0 × freshness', () => {
    expect(scoreKnowledge(meta('project', '_agent/projects/proj-a/v2/note.md'), params)).toBeCloseTo(1.0)
    expect(scoreKnowledge(meta('project', '_agent/projects/proj-a/v2/note.md', 0.5), params)).toBeCloseTo(0.5)
  })

  it('跨版本共享项目知识 = 0.9 × freshness（同项目其它版本）', () => {
    expect(scoreKnowledge(meta('project', '_agent/projects/proj-a/v1/same.md'), params)).toBeCloseTo(0.9)
  })

  it('其它版本项目知识（其它项目）默认不参与 → null', () => {
    expect(scoreKnowledge(meta('project', '_agent/projects/proj-b/v2/other.md'), params)).toBeNull()
  })

  it('实例 = 0.85；共享 = 0.6', () => {
    expect(scoreKnowledge(meta('instance', '_agent/instances/inst-01/x.md'), params)).toBeCloseTo(0.85)
    expect(scoreKnowledge(meta('shared', '_agent/shared/g.md'), params)).toBeCloseTo(0.6)
  })

  it('角色：roleId 匹配 0.8，其它 0.4', () => {
    expect(scoreKnowledge(meta('role', '_agent/roles/coder/r.md'), params)).toBeCloseTo(0.8)
    expect(scoreKnowledge(meta('role', '_agent/roles/designer/r.md'), params)).toBeCloseTo(0.4)
  })

  it('freshness 裁剪到 [0,1]；无法解析路径 → null', () => {
    expect(scoreKnowledge(meta('project', '_agent/projects/proj-a/v2/a.md', 5), params)).toBeCloseTo(1.0)
    expect(scoreKnowledge(meta('project', '_agent/projects/proj-a/v2/a.md', -3), params)).toBeCloseTo(0.0)
    expect(scoreKnowledge(meta('project', '_agent/projectsbroken/p.md'), params)).toBeNull()
    expect(scoreKnowledge(meta('role', '_agent/misc/r.md'), params)).toBeNull()
  })
})

/** 每个测试独立环境（隔离避免相互污染；afterAll 统一清理）。 */
interface TestEnv {
  engine: KnowledgeEngine
  store: KnowledgeStore
  seed: (input: Parameters<KnowledgeStore['createCandidate']>[0]) => Promise<string>
  setFreshness: (id: string, value: number) => Promise<void>
  close: () => void
}

const envs: TestEnv[] = []

afterAll(() => {
  for (const env of envs) env.close()
})

async function newEnv(): Promise<TestEnv> {
  const rootDir = mkdtempSync(join(tmpdir(), 'weave-knowledge-'))
  const db = openPersistence({ inMemory: true })
  const store = new KnowledgeStore({ rootDir, metaDb: db.knowledgeMeta })
  const engine = new KnowledgeEngine(store)
  const env: TestEnv = {
    engine,
    store,
    seed: async (input) => {
      const meta = await store.createCandidate(input)
      await store.activate(meta.id, { confirmed: true })
      return meta.id
    },
    setFreshness: async (id, value) => {
      await db.knowledgeMeta.run((raw) => {
        raw.prepare('UPDATE knowledge_meta SET freshness_score = ? WHERE id = ?').run(value, id)
      })
    },
    close: () => {
      db.close()
      rmSync(rootDir, { recursive: true, force: true })
    },
  }
  envs.push(env)
  return env
}


function params(overrides: Partial<InjectionSearchParams> = {}): InjectionSearchParams {
  return {
    taskId: 'task-1',
    projectId: 'proj-a',
    version: 'v2',
    roleId: 'coder',
    limit: LIMITS,
    ...overrides,
  }
}

function seedInput(layer: KnowledgeLayer, scope: KnowledgeScope, filename: string, title: string, body: string, visibility: string) {
  return {
    layer,
    scope,
    filename,
    frontmatter: { title, type: 'pitfall' as const, visibility: visibility as never, tags: [] },
    body,
  }
}

describe('KnowledgeEngine.searchForInjection', () => {
  it('仅 active 参与注入（candidate 不出现）', async () => {
    const { engine, store } = await newEnv()
    const cand = await store.createCandidate(seedInput('project', { projectId: 'proj-a', version: 'v2' }, 'c.md', '候选知识', '候选正文', 'project_only'))
    const entries = await engine.searchForInjection(params())
    expect(entries.map((e) => e.id)).not.toContain(cand.id)
  })

  it('排序：当前版本 > 跨版本 > 实例 > 同角色 > 全局 > 跨角色（freshness_first）', async () => {
    const { engine, seed } = await newEnv()
    const cur = await seed(seedInput('project', { projectId: 'proj-a', version: 'v2' }, 'cur.md', '当前版本', '当前正文', 'project_only'))
    const cross = await seed(seedInput('project', { projectId: 'proj-a', version: 'v1' }, 'cross.md', '跨版本', '跨版本正文', 'project_only'))
    const inst = await seed(seedInput('instance', { instanceId: 'inst-1' }, 'i.md', '实例知识', '实例正文', 'instance_only'))
    const role = await seed(seedInput('role', { roleId: 'coder' }, 'r.md', '同角色', '角色正文', 'role_only'))
    const glob = await seed(seedInput('shared', {}, 'g.md', '全局知识', '全局正文', 'global'))
    const role2 = await seed(seedInput('role', { roleId: 'designer' }, 'r2.md', '跨角色', '跨角色正文', 'role_only'))

    const entries = await engine.searchForInjection(params({ limit: { ...LIMITS, max_entries: 10 } }))
    expect(entries.map((e) => e.id)).toEqual([cur, cross, inst, role, glob, role2])
  })

  it('同来源按 freshness 降序（freshness_first）', async () => {
    const { engine, seed, setFreshness } = await newEnv()
    const fresh1 = await seed(seedInput('project', { projectId: 'proj-a', version: 'v2' }, 'f1.md', '新近知识', '新近正文', 'project_only'))
    const fresh2 = await seed(seedInput('project', { projectId: 'proj-a', version: 'v2' }, 'f2.md', '陈旧知识', '陈旧正文', 'project_only'))
    await setFreshness(fresh1, 0.95)
    await setFreshness(fresh2, 0.2)
    const ids = (await engine.searchForInjection(params())).map((e) => e.id)
    expect(ids.indexOf(fresh1)).toBeGreaterThanOrEqual(0)
    expect(ids.indexOf(fresh2)).toBeGreaterThanOrEqual(0)
    expect(ids.indexOf(fresh1)).toBeLessThan(ids.indexOf(fresh2))
  })

  it('max_entries 强制：只返回前 N 条', async () => {
    const { engine, seed, setFreshness } = await newEnv()
    const ids: string[] = []
    for (let i = 0; i < 4; i += 1) {
      ids.push(await seed(seedInput('project', { projectId: 'proj-a', version: 'v2' }, `m${i}.md`, `知识${i}`, `正文${i}`, 'project_only')))
    }
    // 制造确定性排序（freshness 优先：0.9 > 0.8 > 0.7 > 0.6）
    for (let i = 0; i < ids.length; i += 1) await setFreshness(ids[i]!, 0.9 - i * 0.1)
    const entries = await engine.searchForInjection(params({ limit: { ...LIMITS, max_entries: 2 } }))
    expect(entries.map((e) => e.id)).toEqual([ids[0], ids[1]])
  })

  it('max_chars_per_entry 截断（…）；max_total_chars 累计超限停止追加', async () => {
    const { engine, seed, setFreshness } = await newEnv()
    const longBody = 'A'.repeat(200)
    const a = await seed(seedInput('project', { projectId: 'proj-a', version: 'v2' }, 'l1.md', '长知识A', longBody, 'project_only'))
    const b = await seed(seedInput('project', { projectId: 'proj-a', version: 'v2' }, 'l2.md', '长知识B', longBody, 'project_only'))
    await setFreshness(a, 0.9)
    await setFreshness(b, 0.8)
    const entries = await engine.searchForInjection(params({ limit: { ...LIMITS, max_entries: 5, max_chars_per_entry: 50, max_total_chars: 60 } }))
    expect(entries.length).toBe(1) // 50+…=51 的第一条后，累计 51 + 51 > 60 → 第二条不再追加
    expect(entries[0]!.id).toBe(a)
    expect(entries[0]!.content.length).toBe(51) // 50 + '…'
    void b
  })

  it('优雅降级：无匹配来源返回 []；文件缺失条目被跳过不抛错', async () => {
    const { engine, store, seed } = await newEnv()
    // 无匹配：项目不匹配（其它版本项目知识默认不参与）
    const entries = await engine.searchForInjection(params({ projectId: 'no-such', version: 'v9', roleId: 'nobody' }))
    expect(entries).toEqual([])
    // 文件被删除（元数据残留）→ 跳过该条
    const orphan = await seed(seedInput('shared', {}, 'orphan.md', '孤儿', '内容', 'global'))
    rmSync(join(store.rootDir, '_agent', 'shared', 'orphan.md'))
    const after = await engine.searchForInjection(params())
    expect(after.map((e) => e.id)).not.toContain(orphan)
  })

  it('priority 非 freshness_first → configuration_error', async () => {
    const { engine } = await newEnv()
    await expect(
      engine.searchForInjection(params({ limit: { ...LIMITS, priority: 'recency_first' as never } })),
    ).rejects.toMatchObject({ code: 'configuration_error' })
  })

  it('reviewQueue / approve / reject 薄壳（candidate 生命周期）', async () => {
    const { engine, store, seed } = await newEnv()
    const rv1 = await store.createCandidate(seedInput('shared', {}, 'rv.md', '待审核', '内容', 'global'))
    const rv2 = await store.createCandidate(seedInput('shared', {}, 'rv2.md', '待驳回', '内容', 'global'))
    const queue = await engine.reviewQueue()
    const queueIds = queue.map((m) => m.id)
    expect(queueIds).toContain(rv1.id)
    expect(queueIds).toContain(rv2.id)
    const approved = await engine.approve(rv1.id)
    expect(approved.status).toBe('active')
    await engine.reject(rv2.id, '与现有知识重复')
    expect((await store.getMeta(rv2.id))?.status).toBe('deprecated')
    void seed
  })

  it('与 DelegationService 集成：executeTask prompt 注入相关知识（t9↔t15 契约）', async () => {
    const { engine, seed } = await newEnv()
    await seed(seedInput('project', { projectId: 'proj-a', version: 'v2' }, 'k.md', 'WAL 开启', 'SQLite WAL 模式知识正文', 'project_only'))
    const ctx = new MockSubagentsContext()
    const registry = new ExecutorRegistry()
    registry.load({ subagents: ctx } as never)
    const db = openPersistence({ inMemory: true })
    const service = new DelegationService({ subagents: ctx } as never, {
      executorRegistry: registry,
      sessionTracker: new SessionTracker(db.feedback),
      knowledgeEngine: engine,
    })
    const task: TaskRecord = {
      id: 'task-inj', session_id: 's-1', team_id: 'team-1', project_id: 'proj-a', version: 'v2',
      description: '实现检索排序', dependencies: [], assigned_agent: 'coder', executor: 'spawn',
      status: 'RUNNING', revision_count: 0, max_revisions: 5, feedback_timeout_seconds: 1800,
      feedback_expires_at: null, skip_override: false, skip_reason: null, fail_count: 0,
      result: null, error_type: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }
    await service.executeTask(
      task,
      { id: 'coder', name: '编码工程师', bias: '', executor: 'spawn', stages: ['implement'], max_concurrent_tasks: 2, personality: '先验证再交付' },
      { team_id: 'team-1', knowledge_injection: LIMITS },
      { parentAgent: { id: 's-1' } },
      new AbortController().signal,
    )
    const prompt = (ctx.started[0]!.request.prompt as { text: string }[])[0]!.text
    expect(prompt).toContain('## 相关知识（来自知识库）')
    expect(prompt).toContain('WAL 开启')
  })
})
