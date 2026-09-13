import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

import { PrismClient } from '../../../../src/plugins/weave/prism/prism-client'
import { KnowledgeStaging } from '../../../../src/plugins/weave/prism/knowledge-staging'
import { PrismGateway } from '../../../../src/plugins/weave/prism/gateway'

const LIMITS = { max_entries: 5, max_chars_per_entry: 200, max_total_chars: 1200, priority: 'freshness_first' as const }

/** 最小 prism stub：health/search/deposit/graph build+job/query。 */
async function createPrismStub(options: {
  searchByScope?: (query: URLSearchParams) => unknown[]
  jobStatuses?: string[]
  deposit?: (body: unknown) => unknown
}): Promise<{ server: Server; url: string; requests: Array<{ method: string; path: string; body: unknown }> }> {
  const requests: Array<{ method: string; path: string; body: unknown }> = []
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      let body: unknown
      if (req.method === 'POST') {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      }
      requests.push({ method: req.method ?? '', path: url.pathname, body })
      const json = (value: unknown, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, value }))
      }
      if (url.pathname === '/api/health') return json({ status: 'up' })
      if (url.pathname === '/api/kb/search') {
        return json(options.searchByScope?.(url.searchParams) ?? [])
      }
      if (url.pathname === '/api/kb/deposit') {
        return json(options.deposit?.(body) ?? { id: 'KB-1', version: 1, path: '/x', action: 'created' })
      }
      if (url.pathname === '/api/graph/build') return json({ job_id: 'j1' })
      if (url.pathname === '/api/graph/build/j1') {
        const statuses = options.jobStatuses ?? ['done']
        const next = statuses.shift() ?? 'done'
        return json({ job_id: 'j1', project: 'weave', status: next })
      }
      if (url.pathname === '/api/graph/query') {
        return json({ project: url.searchParams.get('project'), output: 'graph-output' })
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: { code: 'not_found', message: url.pathname } }))
    })().catch(() => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: { code: 'internal', message: 'stub' } }))
    })
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address() as AddressInfo
  return { server, url: `http://127.0.0.1:${address.port}`, requests }
}

describe('PrismClient（prism HTTP 信封契约）', () => {
  it('health 探活解信封', async () => {
    const stub = await createPrismStub({})
    const client = new PrismClient({ baseUrl: stub.url })
    try {
      expect(await client.health()).toMatchObject({ status: 'up' })
    } finally {
      stub.server.close()
    }
  })

  it('prism 错误信封映射为 WeaveError（保留 prism code）', async () => {
    const server = createServer((req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: { code: 'not_found', message: '角色不存在' } }))
    })
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
    const address = server.address() as AddressInfo
    const client = new PrismClient({ baseUrl: `http://127.0.0.1:${address.port}` })
    try {
      await expect(client.search({ q: 'x' })).rejects.toMatchObject({
        code: 'not_found',
        message: expect.stringContaining('角色不存在'),
      })
    } finally {
      server.close()
    }
  })

  it('连接失败映射为 prism_unavailable', async () => {
    // 端口 1 保留端口，几乎必然拒绝连接
    const client = new PrismClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 1000 })
    await expect(client.health()).rejects.toMatchObject({ code: 'prism_unavailable' })
  })
})

describe('KnowledgeStaging（先审后发暂存区）', () => {
  it('append/list/get/remove 往返', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weave-staging-'))
    try {
      const staging = new KnowledgeStaging({ dir })
      const first = await staging.append({
        title: '坑：foo 需先 bar',
        type: 'pitfall',
        content: '内容',
        tags: ['t1'],
        task_id: 'T1',
        role_id: 'coder',
        project_id: 'proj-a',
        version: 'v1',
      })
      expect(first.id).toMatch(/^stag_/)
      await staging.append({
        title: '第二条',
        type: 'pattern',
        content: 'c2',
        task_id: 'T2',
        role_id: 'coder',
        project_id: 'proj-a',
        version: 'v1',
      })
      const list = await staging.list()
      expect(list).toHaveLength(2)
      expect(list[0]?.title).toBe('坑：foo 需先 bar')
      expect(await staging.count()).toBe(2)
      expect((await staging.get(first.id))?.task_id).toBe('T1')
      expect(await staging.remove(first.id)).toBe(true)
      expect(await staging.get(first.id)).toBeNull()
      expect(await staging.count()).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('PrismGateway（注入检索 + 审核闭环 + 图谱）', () => {
  let stagingDir = ''
  let stubServer: Server
  let baseUrl = ''

  beforeAll(async () => {
    stagingDir = await mkdtemp(join(tmpdir(), 'weave-gw-'))
  })
  afterAll(async () => {
    await rm(stagingDir, { recursive: true, force: true })
  })

  const makeGateway = async (options?: {
    deposit?: (body: unknown) => unknown
    jobStatuses?: string[]
  }) => {
    const stub = await createPrismStub({
      searchByScope: (params) => {
        const layer = params.get('layers')
        if (layer === 'project') {
          return [
            {
              id: 'KB-P1',
              version: 2,
              title: '项目知识',
              type: 'pitfall',
              layer: 'project',
              owner: 'proj-a',
              book: 'weave-execution',
              module: 'pitfall',
              excerpt: 'x'.repeat(300),
              score: 3,
              source: 'project/proj-a/weave-execution/pitfall/KB-P1@v2',
              freshness: 0.9,
            },
          ]
        }
        if (layer === 'global') {
          return [
            {
              id: 'KB-G1',
              version: 1,
              title: '全局知识',
              type: 'rule',
              layer: 'global',
              book: 'redline',
              module: 'root',
              excerpt: 'global content',
              score: 5,
              source: 'global/redline/root/KB-G1@v1',
            },
          ]
        }
        return []
      },
      ...(options?.deposit ? { deposit: options.deposit } : {}),
      ...(options?.jobStatuses ? { jobStatuses: options.jobStatuses } : {}),
    })
    stubServer = stub.server
    baseUrl = stub.url
    return stub
  }

  it('searchForInjection：多路合并去重 + 层优先 + 限额截断', async () => {
    await makeGateway()
    const client = new PrismClient({ baseUrl })
    const gateway = new PrismGateway({ client })
    try {
      const entries = await gateway.searchForInjection({
        taskId: 'T1',
        projectId: 'proj-a',
        version: 'v1',
        roleId: 'coder',
        keywords: 'foo bar',
        limit: LIMITS,
      })
      // global 分数高但层优先级低 → project 层 KB-P1 排前；content 截到 max_chars_per_entry+…
      expect(entries[0]?.id).toBe('KB-P1')
      expect(entries[0]?.content.length).toBeLessThanOrEqual(LIMITS.max_chars_per_entry + 1)
      expect(entries.map((entry) => entry.id)).toContain('KB-G1')
    } finally {
      stubServer.close()
    }
  })

  it('approveStaged：映射 deposit 入参 → 清暂存 → 审计', async () => {
    const deposits: unknown[] = []
    await makeGateway({ deposit: (body) => {
      deposits.push(body)
      return { id: 'KB-NEW', version: 1, path: '/p', action: 'created' }
    } })
    const client = new PrismClient({ baseUrl })
    const auditEvents: unknown[] = []
    const gateway = new PrismGateway({
      client,
      staging: new KnowledgeStaging({ dir: stagingDir }),
      audit: { record: async (event) => auditEvents.push(event) },
    })
    try {
      const staged = await gateway.stageReflection({
        title: '技能：部署顺序',
        type: 'skill',
        content: '先 a 后 b',
        tags: ['deploy'],
        task_id: 'T9',
        role_id: 'ops',
        project_id: 'proj-a',
        version: 'v1',
        executor: 'zcode',
      })
      const result = await gateway.approveStaged(staged.id)
      expect(result.deposit.id).toBe('KB-NEW')
      expect(deposits[0]).toMatchObject({
        title: '技能：部署顺序',
        type: 'guide',
        layer: 'project',
        owner: 'proj-a',
        book: 'weave-execution',
        module: 'skill',
        origin_task: { task_id: 'T9', role: 'ops' },
      })
      expect((deposits[0] as { tags: string[] }).tags).toContain('source:weave-reflection')
      expect(auditEvents).toMatchObject([{ type: 'knowledge.deposited', knowledge_id: 'KB-NEW', task_id: 'T9' }])
      expect(await gateway.countStaged()).toBe(0)
    } finally {
      stubServer.close()
    }
  })

  it('rejectStaged：删除暂存且不落库', async () => {
    await makeGateway()
    const client = new PrismClient({ baseUrl })
    const gateway = new PrismGateway({ client, staging: new KnowledgeStaging({ dir: stagingDir }) })
    try {
      const staged = await gateway.stageReflection({
        title: '无用',
        type: 'doc',
        content: 'c',
        task_id: 'T10',
        role_id: 'coder',
        project_id: 'proj-a',
        version: 'v1',
      })
      await gateway.rejectStaged(staged.id)
      expect(await gateway.countStaged()).toBe(0)
    } finally {
      stubServer.close()
    }
  })

  it('graphBuild：轮询 job 到终态', async () => {
    await makeGateway({ jobStatuses: ['running', 'running', 'done'] })
    const client = new PrismClient({ baseUrl })
    const gateway = new PrismGateway({ client, defaultProjectRoot: '/tmp/proj-a' })
    try {
      const result = await gateway.graphBuild({ timeoutMs: 10_000, pollIntervalMs: 10 })
      expect(result).toMatchObject({ project: 'proj-a', ok: true })
    } finally {
      stubServer.close()
    }
  })

  it('graphQuery：project 取根目录 basename', async () => {
    const stub = await makeGateway()
    const client = new PrismClient({ baseUrl })
    const gateway = new PrismGateway({ client, defaultProjectRoot: '/home/x/proj-a' })
    try {
      const result = await gateway.graphQuery({ question: '谁调用 foo' })
      expect(result.project).toBe('proj-a')
      expect(result.output).toBe('graph-output')
      expect(stub.requests.at(-1)?.path).toBe('/api/graph/query')
    } finally {
      stubServer.close()
    }
  })
})

describe('PrismSupervisor（脚本解析）', () => {
  it('resolveScript：不要求环境存在 prism，返回 string|undefined', async () => {
    const { PrismSupervisor } = await import('../../../../src/plugins/weave/prism/prism-supervisor')
    const client = new PrismClient({ baseUrl: 'http://127.0.0.1:1' })
    const supervisor = new PrismSupervisor({ client, autoStart: false })
    const script = supervisor.resolveScript()
    expect(script === undefined || typeof script === 'string').toBe(true)
    // autoStart=false 且无实例 → ensureRunning 不抛错并给出 reason
    const status = await supervisor.ensureRunning()
    expect(status.running).toBe(false)
    expect(status.spawned).toBe(false)
    expect(typeof status.reason).toBe('string')
  })
})

describe('暂存文件格式', () => {
  it('JSON 可读且含溯源字段', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weave-staging-fmt-'))
    try {
      const staging = new KnowledgeStaging({ dir })
      const staged = await staging.append({
        title: 't',
        type: 'doc',
        content: 'c',
        task_id: 'T1',
        role_id: 'r',
        project_id: 'p',
        version: 'v',
      })
      const raw = JSON.parse(await readFile(join(dir, `${staged.id}.json`), 'utf8')) as Record<string, unknown>
      expect(raw).toMatchObject({ title: 't', type: 'doc', task_id: 'T1', role_id: 'r', project_id: 'p', version: 'v' })
      expect(typeof raw.deposited_at).toBe('string')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
