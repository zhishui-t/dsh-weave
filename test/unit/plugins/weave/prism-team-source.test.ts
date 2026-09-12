import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

import { PrismClient } from '../../../../src/plugins/weave/prism/prism-client'
import { PrismGateway } from '../../../../src/plugins/weave/prism/gateway'
import { PrismTeamSource, prismTeamToConfig } from '../../../../src/plugins/weave/prism/team-source'
import { TeamManager, type ExternalTeamSource, type TeamConfig } from '../../../../src/plugins/weave/team/team-manager.js'
import { ExecutorRegistry } from '../../../../src/plugins/weave/executors/executor-registry'
import { MockSubagentsContext } from './fixtures/mock-subagents'

const LOCAL_TEAM = `schema_version: "1"
team_id: local-team
name: 本地团队
default: true

roles:
  - id: coder
    bias: dev
    executor: zcode
    stages: [execute]
    max_concurrent_tasks: 2

task_decomposition:
  matchers: []
  default_difficulty: easy
  dag_templates:
    easy: ["coder"]

knowledge_injection:
  max_entries: 5
  max_chars_per_entry: 500
  max_total_chars: 2500
  priority: freshness_first
`

describe('prismTeamToConfig（prism 团队 → TeamConfig 映射）', () => {
  it('members → roles；count → max_concurrent；激活定义补人格；DSH 字段按缺省补齐', () => {
    const config = prismTeamToConfig(
      {
        team_id: 'core-dev',
        name: '核心研发团队',
        description: '设计、开发、测试',
        default: true,
        members: [
          { role: 'dev-1', count: 2 },
          { role: 'qa-checker' },
        ],
      },
      {
        defaultExecutor: 'zcode',
        activationMembers: [
          { role: 'dev-1', definition: { name: '开发一号', principle: '写代码先写测试', description: '开发' } },
        ],
      },
    )
    expect(config).toMatchObject({
      team_id: 'core-dev',
      name: '核心研发团队',
      description: '设计、开发、测试',
      default: true,
      source: 'prism',
    })
    expect(config.roles).toHaveLength(2)
    expect(config.roles[0]).toMatchObject({
      id: 'dev-1',
      name: '开发一号',
      executor: 'zcode',
      stages: ['implement'],
      max_concurrent_tasks: 2,
      personality: '写代码先写测试',
    })
    // 无 count → 1；无激活定义 → 兜底人格
    expect(config.roles[1]).toMatchObject({ id: 'qa-checker', max_concurrent_tasks: 1 })
    expect(config.roles[1]!.personality).toContain('qa-checker')
    // DSH 专属字段缺省：dag_template 指向首个角色，knowledge/feedback 用缺省值
    expect(config.task_decomposition).toMatchObject({ matchers: [], default_difficulty: 'hard', dag_templates: { hard: ['dev-1'] } })
    expect(config.knowledge_injection).toMatchObject({ max_entries: 5, priority: 'freshness_first' })
    expect(config.feedback).toMatchObject({ feedback_timeout_seconds: 60, max_revisions: 2 })
  })
})

describe('PrismTeamSource（prism HTTP 团队源）', () => {
  let server: Server
  let baseUrl: string

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      if (req.url === '/api/teams') {
        res.end(JSON.stringify({
          ok: true,
          value: {
            teams_dir: '/tmp/teams',
            teams: [
              { team_id: 'core-dev', name: '核心研发团队', default: true, members: [{ role: 'dev-1', count: 1 }] },
            ],
          },
        }))
        return
      }
      if (req.url === '/api/teams/core-dev/activate') {
        res.end(JSON.stringify({
          ok: true,
          value: {
            team_id: 'core-dev',
            team_name: '核心研发团队',
            members: [
              { role: 'dev-1', count: 1, installed: true, definition: { name: '开发一号', principle: '先想后写' } },
            ],
          },
        }))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: { code: 'not_found', message: req.url } }))
    })
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(() => {
    server.close()
  })

  function makeSource(): PrismTeamSource {
    return new PrismTeamSource({
      gateway: new PrismGateway({ client: new PrismClient({ baseUrl }) }),
      defaultExecutor: 'zcode',
    })
  }

  it('listTeams：prism 清单映射为 TeamConfig', async () => {
    const teams = await makeSource().listTeams()
    expect(teams).toHaveLength(1)
    expect(teams[0]).toMatchObject({ team_id: 'core-dev', name: '核心研发团队', source: 'prism', default: true })
    expect(teams[0]?.roles[0]).toMatchObject({ id: 'dev-1', executor: 'zcode' })
  })

  it('loadTeam：activate 返回携带角色定义（人格注入）', async () => {
    const team = await makeSource().loadTeam('core-dev')
    expect(team.roles[0]).toMatchObject({ id: 'dev-1', name: '开发一号', personality: '先想后写' })
  })

  it('prism 不可用 → listTeams 静默为空（调度不受影响）', async () => {
    const source = new PrismTeamSource({
      gateway: new PrismGateway({ client: new PrismClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 500 }) }),
    })
    expect(await source.listTeams()).toEqual([])
  })
})

describe('TeamManager 外部团队源合并（本地优先、prism 兜底）', () => {
  function makeManager(external: ExternalTeamSource): TeamManager {
    const rootDir = mkdtempSync(join(tmpdir(), 'weave-prism-teams-'))
    writeFileSync(join(rootDir, 'local-team.yaml'), LOCAL_TEAM)
    const registry = new ExecutorRegistry()
    registry.load({ subagents: new MockSubagentsContext() } as never)
    const manager = new TeamManager(registry, {
      teamsDir: rootDir,
      externalTeams: external,
    })
    ;(manager as unknown as { rootDirForCleanup?: string }).rootDirForCleanup = rootDir
    return manager
  }

  function cleanup(manager: TeamManager): void {
    const rootDir = (manager as unknown as { rootDirForCleanup?: string }).rootDirForCleanup
    if (rootDir) rmSync(rootDir, { recursive: true, force: true })
  }

  const prismTeam: TeamConfig = {
    team_id: 'prism-team',
    name: 'Prism 团队',
    default: false,
    source: 'prism',
    roles: [{ id: 'dev-1', name: '开发一号', bias: 'general', executor: 'zcode', stages: ['implement'], max_concurrent_tasks: 1, personality: 'p' }],
    task_decomposition: { matchers: [], default_difficulty: 'hard', dag_templates: { hard: ['dev-1'] } },
    knowledge_injection: { max_entries: 5, max_chars_per_entry: 500, max_total_chars: 2500, priority: 'freshness_first' },
    feedback: { feedback_timeout_seconds: 60, max_revisions: 2, reopen_window_seconds: 60 },
  }

  it('listTeams：本地 + prism 合并；外部源故障只降级为空', async () => {
    const manager = makeManager({
      listTeams: async () => [prismTeam],
      loadTeam: async () => prismTeam,
    })
    try {
      const teams = await manager.listTeams()
      expect(teams.map((team) => team.team_id)).toEqual(['local-team', 'prism-team'])
      expect(teams.find((team) => team.team_id === 'prism-team')?.source).toBe('prism')
    } finally {
      cleanup(manager)
    }

    const degraded = makeManager({
      listTeams: async () => {
        throw new Error('prism down')
      },
      loadTeam: async () => {
        throw new Error('prism down')
      },
    })
    try {
      // 实现方应自行容错为 []；这里直接传抛错的源，验证 TeamManager 不被拖垮
      const teams = await degraded.listTeams()
      expect(teams.map((team) => team.team_id)).toEqual(['local-team'])
    } finally {
      cleanup(degraded)
    }
  })

  it('本地 team_id 优先：同名团队不透 prism', async () => {
    const manager = makeManager({
      listTeams: async () => [{ ...prismTeam, team_id: 'local-team', name: '假本地' }],
      loadTeam: async () => ({ ...prismTeam, team_id: 'local-team' }),
    })
    try {
      const teams = await manager.listTeams()
      expect(teams.filter((team) => team.team_id === 'local-team')).toHaveLength(1)
      expect(teams.find((team) => team.team_id === 'local-team')?.source).toBeUndefined() // 本地无 source 标记
      const loaded = await manager.loadTeam('local-team')
      expect(loaded.name).toBe('本地团队') // 读的是本地 YAML，不是 prism
    } finally {
      cleanup(manager)
    }
  })

  it('loadTeam：本地缺失 → 回落 prism；双方都无 → invalid_team', async () => {
    const manager = makeManager({
      listTeams: async () => [prismTeam],
      loadTeam: async (teamId) => {
        if (teamId === 'prism-team') return prismTeam
        throw new Error('not in prism')
      },
    })
    try {
      const loaded = await manager.loadTeam('prism-team')
      expect(loaded.source).toBe('prism')
      await expect(manager.loadTeam('ghost')).rejects.toMatchObject({ code: 'invalid_team' })
    } finally {
      cleanup(manager)
    }
  })
})
