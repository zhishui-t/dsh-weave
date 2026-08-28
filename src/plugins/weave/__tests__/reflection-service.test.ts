import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AuditLog } from '../audit/index'
import { ReflectionService, type ReflectionDepositInput } from '../reflection-service'
import { KnowledgeStore } from '../knowledge-model'
import { openPersistence } from '../persistence/index'

interface TestEnv {
  store: KnowledgeStore
  audit: AuditLog
  close: () => void
}

const envs: TestEnv[] = []

afterAll(() => {
  for (const env of envs) env.close()
})

async function newEnv(): Promise<TestEnv> {
  const rootDir = mkdtempSync(join(tmpdir(), 'weave-reflect-'))
  const auditDir = mkdtempSync(join(tmpdir(), 'weave-reflect-audit-'))
  const db = openPersistence({ inMemory: true })
  const store = new KnowledgeStore({ rootDir, metaDb: db.knowledgeMeta })
  const audit = new AuditLog({ dir: auditDir })
  const env: TestEnv = {
    store,
    audit,
    close: () => {
      db.close()
      rmSync(rootDir, { recursive: true, force: true })
      rmSync(auditDir, { recursive: true, force: true })
    },
  }
  envs.push(env)
  return env
}

function withBlock(raw: string, extra = ''): string {
  return `${extra}\n### WEAVE_KNOWLEDGE_START\n${raw}\n### WEAVE_KNOWLEDGE_END\n`
}

const BASE_INPUT: ReflectionDepositInput = {
  taskId: 'task-1',
  executor: 'codex',
  roleId: 'coder',
  projectId: 'proj-a',
  version: 'v1',
  outputText: '',
}

describe('ReflectionService.depositFromOutput', () => {
  it('role 层路由：写入 _agent/roles/{roleId}，meta.layer=role，tags 落地，status=candidate', async () => {
    const env = await newEnv()
    const service = new ReflectionService({ knowledge: env.store })
    const result = await service.depositFromOutput({
      ...BASE_INPUT,
      outputText: withBlock(
        JSON.stringify({
          type: 'pitfall',
          title: '角色经验',
          content: '角色专属内容',
          tags: ['tag1'],
          layer: 'role',
        }),
      ),
    })

    expect(result.deposited).toHaveLength(1)
    expect(result.deposited[0]).toMatchObject({ title: '角色经验', layer: 'role' })
    expect(result.invalid).toBe(0)
    expect(result.errors).toEqual([])

    const metas = await env.store.listMeta({ layer: 'role', status: 'candidate' })
    expect(metas).toHaveLength(1)
    const meta = metas[0]!
    const file = env.store.getKnowledgeFile(meta.id)
    expect(file?.frontmatter.status).toBe('candidate')
    expect(file?.frontmatter.visibility).toBe('role_only')
    expect(file?.frontmatter.tags).toEqual(expect.arrayContaining(['executor:codex', 'role:coder', 'source:weave-reflection']))
    expect(file?.body.trim()).toBe('角色专属内容')
    expect(existsSync(join(env.store.rootDir, '_agent', 'roles', 'coder', 'reflect-task-1-1.md'))).toBe(true)
  })

  it('project 层缺省路由：块未写 layer 时默认 project，并写入 project/version 目录', async () => {
    const env = await newEnv()
    const service = new ReflectionService({ knowledge: env.store })
    const result = await service.depositFromOutput({
      ...BASE_INPUT,
      outputText: withBlock(
        JSON.stringify({ type: 'pattern', title: '默认项目知识', content: '项目默认正文', tags: [] }),
      ),
    })

    expect(result.deposited).toHaveLength(1)
    expect(result.deposited[0]).toMatchObject({ layer: 'project' })
    expect(result.errors).toEqual([])
    const metas = await env.store.listMeta({ layer: 'project', status: 'candidate' })
    expect(metas).toHaveLength(1)
    expect(metas[0]!.path).toBe('_agent/projects/proj-a/v1/reflect-task-1-1.md')
  })

  it('shared 路由：写入 _agent/shared 且 visibility=global', async () => {
    const env = await newEnv()
    const service = new ReflectionService({ knowledge: env.store })
    const result = await service.depositFromOutput({
      ...BASE_INPUT,
      outputText: withBlock(
        JSON.stringify({ type: 'guide', title: '全局指南', content: '全局内容', tags: [], layer: 'shared' }),
      ),
    })

    expect(result.deposited[0]).toMatchObject({ layer: 'shared' })
    const metas = await env.store.listMeta({ layer: 'shared', status: 'candidate' })
    const file = env.store.getKnowledgeFile(metas[0]!.id)
    expect(file?.frontmatter.visibility).toBe('global')
    expect(existsSync(join(env.store.rootDir, '_agent', 'shared', 'reflect-task-1-1.md'))).toBe(true)
  })

  it('instance 降级：无 instanceId 时降级 project，errors 记录一条且仍沉淀', async () => {
    const env = await newEnv()
    const service = new ReflectionService({ knowledge: env.store })
    const result = await service.depositFromOutput({
      ...BASE_INPUT,
      outputText: withBlock(
        JSON.stringify({ type: 'pitfall', title: '实例经验', content: '实例降级正文', tags: [], layer: 'instance' }),
      ),
    })

    expect(result.deposited).toHaveLength(1)
    expect(result.deposited[0]!.layer).toBe('project')
    expect(result.errors).toEqual([
      expect.objectContaining({ index: 0, message: expect.stringContaining('instance 层需要 instanceId') }),
    ])
    const projectMetas = await env.store.listMeta({ layer: 'project', status: 'candidate' })
    expect(projectMetas).toHaveLength(1)
    const instanceMetas = await env.store.listMeta({ layer: 'instance' })
    expect(instanceMetas).toHaveLength(0)
  })

  it('invalid 计数透传：畸形块计入 invalid，有效块仍沉淀', async () => {
    const env = await newEnv()
    const service = new ReflectionService({ knowledge: env.store })
    const outputText = `${withBlock(JSON.stringify({ type: 'pattern', title: '有效', content: '正文', tags: [] }))}\n` +
      '### WEAVE_KNOWLEDGE_START\n{ not json\n### WEAVE_KNOWLEDGE_END\n'
    const result = await service.depositFromOutput({ ...BASE_INPUT, outputText })

    expect(result.invalid).toBe(1)
    expect(result.deposited).toHaveLength(1)
  })

  it('审计事件：成功沉淀写入 knowledge.deposited，字段完整', async () => {
    const env = await newEnv()
    const service = new ReflectionService({ knowledge: env.store, audit: env.audit })
    const result = await service.depositFromOutput({
      ...BASE_INPUT,
      outputText: withBlock(
        JSON.stringify({ type: 'skill', title: '审计知识', content: '审计正文', tags: [], layer: 'shared' }),
      ),
    })

    const events = await env.audit.query({ types: ['knowledge.deposited'] })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'knowledge.deposited',
      knowledge_id: result.deposited[0]!.id,
      task_id: 'task-1',
      executor: 'codex',
      layer: 'shared',
    })
  })

  it('单块失败不抛错：非法 roleId 导致 createCandidate 失败时 errors 带 index/message，且不阻断其它块', async () => {
    const env = await newEnv()
    const service = new ReflectionService({ knowledge: env.store })
    const outputText = `${withBlock(
      JSON.stringify({ type: 'pitfall', title: '坏角色', content: '内容', tags: [], layer: 'role' }),
      '',
    )}${withBlock(
      JSON.stringify({ type: 'pattern', title: '好项目', content: '正常', tags: [], layer: 'project' }),
      '',
    )}`
    const result = await service.depositFromOutput({
      ...BASE_INPUT,
      roleId: 'bad/role',
      outputText,
    })

    expect(result.deposited).toHaveLength(1)
    expect(result.deposited[0]!.title).toBe('好项目')
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatchObject({ index: 0, message: expect.any(String) })
  })
})
