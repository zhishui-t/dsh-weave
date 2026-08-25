import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ExecutorInfo } from '../executor-registry'
import { WeavePersistence } from '../persistence/persistence'
import { WeaveError } from '../state/weave-error'
import {
  TeamManager,
  type ExecutorLookup,
  type TeamConfig,
} from '../team-manager'

/* ------------------------------- 夹具（与 doc 样例同构） ------------------------------- */

const GOOD_TEAM = `schema_version: "1"
team_id: alpha-squad
name: 阿尔法小队
default: true

roles:
  - id: designer
    name: 方案设计师
    bias: design
    executor: codex
    stages: [prepare, design]
    max_concurrent_tasks: 1
    personality: 你是方案设计师。
  - id: coder
    name: 核心开发
    bias: dev
    executor: zcode
    stages: [implement, test, integrate, execute, deploy]
    max_concurrent_tasks: 2
    personality: 你追求代码质量。
  - id: reviewer
    name: 代码审核
    bias: review
    executor: codex
    stages: [review]
    max_concurrent_tasks: 2
    personality: 你是严格的审核员。

task_decomposition:
  matchers:
    - pattern: "重构|核心|关键|安全"
      difficulty: critical
    - pattern: "新增|实现|集成"
      difficulty: medium
    - pattern: "修复|调整"
      difficulty: easy
  default_difficulty: hard
  dag_templates:
    easy: ["execute"]
    medium: ["design", "implement", "test"]
    hard: ["design", "implement", "review", "test", "integrate"]
    critical: ["prepare", "design", "implement", "review", "test", "deploy"]

knowledge_injection:
  max_entries: 5
  max_chars_per_entry: 500
  max_total_chars: 2500
  priority: freshness_first

feedback:
  feedback_timeout_seconds: 1800
  max_revisions: 5
  reopen_window_seconds: 86400

executor_limits:
  codex:
    max_concurrent: 2
    max_per_hour: 20
  zcode:
    max_concurrent: 2
    max_per_hour: 20
`

const EXAMPLES_TEAM_YAML = fileURLToPath(
  new URL('../../../../examples/team.yaml', import.meta.url),
)

function makeLookup(executors: string[]): ExecutorLookup {
  const set = new Set(executors)
  return {
    get: (id: string): ExecutorInfo | undefined =>
      set.has(id)
        ? ({
            id,
            name: id,
            kind: 'acp',
            capabilities: {
              outputSchema: false,
              depthLimit: false,
              toolFilter: false,
              persona: false,
            },
          } as unknown as ExecutorInfo)
        : undefined,
  }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weave-teams-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeTeam(teamId: string, content: string): void {
  writeFileSync(join(dir, `${teamId}.yaml`), content)
}

function manager(executors: string[], persistence?: WeavePersistence): TeamManager {
  return new TeamManager(makeLookup(executors), { teamsDir: dir, persistence })
}

function expectCode(fn: () => unknown, code: string): WeaveError {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(WeaveError)
    expect((error as WeaveError).code).toBe(code)
    return error as WeaveError
  }
  throw new Error(`期望抛出 WeaveError(${code})，但未抛出`)
}

/* ------------------------------- parse/validate ------------------------------- */

describe('TeamManager parseTeam/validateTeam（P0-TEAM-003 核心校验）', () => {
  it('合法配置（GOOD_TEAM）解析并校验通过', () => {
    const team = manager(['codex', 'zcode']).parseTeam(GOOD_TEAM, 'fixture')
    expect(team.team_id).toBe('alpha-squad')
    expect(team.roles).toHaveLength(3)
    expect(team.task_decomposition.default_difficulty).toBe('hard')
    expect(team.roles[0]?.stages).toEqual(['prepare', 'design'])
    expect(team.executor_limits?.codex).toEqual({ max_concurrent: 2, max_per_hour: 20 })
    manager(['codex', 'zcode']).validateTeam(team)
  })

  it('schema_version 非法 → invalid_team', () => {
    const mgr = manager(['codex', 'zcode'])
    expectCode(() => mgr.parseTeam(GOOD_TEAM.replace('schema_version: "1"', 'schema_version: "2"'), 'f'), 'invalid_team')
  })

  it('角色 id 重复 → invalid_team', () => {
    const mgr = manager(['codex', 'zcode'])
    const dup = GOOD_TEAM.replace('  - id: reviewer', '  - id: designer')
    expectCode(() => mgr.validateTeam(mgr.parseTeam(dup, 'f')), 'invalid_team')
  })

  it('max_concurrent_tasks <= 0 → invalid_team', () => {
    const mgr = manager(['codex', 'zcode'])
    const bad = GOOD_TEAM.replace('    max_concurrent_tasks: 1', '    max_concurrent_tasks: 0')
    expectCode(() => mgr.validateTeam(mgr.parseTeam(bad, 'f')), 'invalid_team')
  })

  it('角色 provider/model/max_tokens 可选配置解析并校验通过', () => {
    const teamYaml = GOOD_TEAM.replace(
      '    personality: 你追求代码质量。',
      '    personality: 你追求代码质量。\n    provider: deepseek-official\n    model: deepseek-v4-flash-vision-exp\n    max_tokens: 4096',
    )
    const team = manager(['codex', 'zcode']).parseTeam(teamYaml, 'fixture')
    expect(team.roles[1]).toMatchObject({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash-vision-exp',
      max_tokens: 4096,
    })
    manager(['codex', 'zcode']).validateTeam(team)
  })

  it('角色 max_tokens 非法 → invalid_team', () => {
    const team = manager(['codex', 'zcode']).parseTeam(GOOD_TEAM, 'fixture')
    team.roles[0]!.max_tokens = 0
    expectCode(() => manager(['codex', 'zcode']).validateTeam(team), 'invalid_team')
  })

  it('executor 未注册 → executor_unavailable（含 details）', () => {
    const mgr = manager(['codex'])
    const error = expectCode(() => mgr.validateTeam(mgr.parseTeam(GOOD_TEAM, 'f')), 'executor_unavailable')
    expect(error.details?.executor).toBe('zcode')
  })

  it('stages 缺失 → invalid_team（HI-4）', () => {
    const mgr = manager(['codex', 'zcode'])
    const bad = GOOD_TEAM.replace('    stages: [prepare, design]\n', '')
    expectCode(() => mgr.validateTeam(mgr.parseTeam(bad, 'f')), 'invalid_team')
  })

  it('模板阶段未被任何角色绑定 → invalid_team（HI-4）', () => {
    const mgr = manager(['codex', 'zcode'])
    const bad = GOOD_TEAM.replace('    stages: [implement, test, integrate, execute, deploy]', '    stages: [implement, test, execute, deploy]')
    expectCode(() => mgr.validateTeam(mgr.parseTeam(bad, 'f')), 'invalid_team')
  })

  it('default_difficulty 对应模板缺失 → invalid_team（HI-4）', () => {
    const mgr = manager(['codex', 'zcode'])
    const bad = GOOD_TEAM.replace('  default_difficulty: hard', '  default_difficulty: medium').replace(
      '    medium: ["design", "implement", "test"]\n',
      '',
    )
    expectCode(() => mgr.validateTeam(mgr.parseTeam(bad, 'f')), 'invalid_team')
  })

  it('matcher 正则非法 → invalid_team', () => {
    const mgr = manager(['codex', 'zcode'])
    const bad = GOOD_TEAM.replace('pattern: "修复|调整"', 'pattern: "("')
    expectCode(() => mgr.validateTeam(mgr.parseTeam(bad, 'f')), 'invalid_team')
  })

  it('executor_limits 非正数 → invalid_team（ME-6）', () => {
    const mgr = manager(['codex', 'zcode'])
    const bad = GOOD_TEAM.replace('    max_concurrent: 2\n    max_per_hour: 20', '    max_concurrent: 0\n    max_per_hour: 20')
    expectCode(() => mgr.validateTeam(mgr.parseTeam(bad, 'f')), 'invalid_team')
  })
})

/* ------------------------------- loadTeam / listTeams ------------------------------- */

describe('TeamManager loadTeam/listTeams', () => {
  it('loadTeam 成功（含仓库内 examples/team.yaml 样例）', () => {
    writeTeam('alpha-squad', readFileSync(EXAMPLES_TEAM_YAML, 'utf8'))
    const team = manager(['codex', 'zcode']).loadTeam('alpha-squad')
    expect(team.roles.map((r: TeamConfig['roles'][number]) => r.id)).toEqual(['designer', 'coder', 'reviewer'])
  })

  it('团队不存在 → invalid_team', () => {
    expectCode(() => manager(['codex']).loadTeam('ghost'), 'invalid_team')
  })

  it('文件 team_id 与文件名不一致 → invalid_team', () => {
    writeTeam('alpha-squad', GOOD_TEAM.replace('team_id: alpha-squad', 'team_id: other-squad'))
    expectCode(() => manager(['codex', 'zcode']).loadTeam('alpha-squad'), 'invalid_team')
  })

  it('listTeams 仅返回校验通过的团队（非法团队不进入调度）', () => {
    writeTeam('team-a', GOOD_TEAM.replace('team_id: alpha-squad', 'team_id: team-a'))
    writeTeam('team-b', GOOD_TEAM.replace('team_id: alpha-squad', 'team_id: team-b').replace('executor: zcode', 'executor: ghost'))
    writeTeam('team-c', GOOD_TEAM.replace('team_id: alpha-squad', 'team_id: team-c'))
    const ids = manager(['codex', 'zcode']).listTeams().map((t) => t.team_id)
    expect(ids).toEqual(['team-a', 'team-c'])
  })
})

/* ------------------------------- selectTeam / bindTeam（ME-4） ------------------------------- */

describe('TeamManager selectTeam 优先级链 + team_bindings（ME-4）', () => {
  const openPersistence = (): WeavePersistence => new WeavePersistence({ inMemory: true })

  it('显式指定 > 会话绑定', async () => {
    const persistence = openPersistence()
    const mgr = manager(['codex', 'zcode'], persistence)
    writeTeam('team-a', GOOD_TEAM.replace('team_id: alpha-squad', 'team_id: team-a'))
    writeTeam('team-b', GOOD_TEAM.replace('team_id: alpha-squad', 'team_id: team-b'))
    await mgr.bindTeam('s1', 'team-a')
    const chosen = await mgr.selectTeam('s1', 'team-b')
    expect(chosen?.team_id).toBe('team-b')
  })

  it('会话绑定生效且写入 core.db.team_bindings', async () => {
    const persistence = openPersistence()
    const mgr = manager(['codex', 'zcode'], persistence)
    writeTeam('team-a', GOOD_TEAM.replace('team_id: alpha-squad', 'team_id: team-a'))
    await mgr.bindTeam('s1', 'team-a')
    expect(await mgr.getBoundTeam('s1')).toBe('team-a')
    expect((await mgr.selectTeam('s1'))?.team_id).toBe('team-a')
    expect(persistence.core.tables()).toContain('team_bindings')
  })

  it('重复绑定为 upsert（切换团队）', async () => {
    const persistence = openPersistence()
    const mgr = manager(['codex', 'zcode'], persistence)
    writeTeam('team-a', GOOD_TEAM.replace('team_id: alpha-squad', 'team_id: team-a'))
    writeTeam('team-b', GOOD_TEAM.replace('team_id: alpha-squad', 'team_id: team-b'))
    await mgr.bindTeam('s1', 'team-a')
    await mgr.bindTeam('s1', 'team-b')
    expect(await mgr.getBoundTeam('s1')).toBe('team-b')
  })

  it('default 团队优先于普通团队', async () => {
    const mgr = manager(['codex', 'zcode'])
    writeTeam('team-n', GOOD_TEAM.replace('team_id: alpha-squad', 'team_id: team-n').replace('default: true', 'default: false'))
    writeTeam('team-d', GOOD_TEAM.replace('team_id: alpha-squad', 'team_id: team-d'))
    expect((await mgr.selectTeam('s-x'))?.team_id).toBe('team-d')
  })

  it('仅一个团队时自动选择（无需 default）', async () => {
    const mgr = manager(['codex', 'zcode'])
    writeTeam('team-a', GOOD_TEAM.replace('team_id: alpha-squad', 'team_id: team-a').replace('default: true', 'default: false'))
    expect((await mgr.selectTeam('s-x'))?.team_id).toBe('team-a')
  })

  it('多团队且无绑定无默认 → 返回 null（提示选择）', async () => {
    const mgr = manager(['codex', 'zcode'])
    writeTeam('team-a', GOOD_TEAM.replace('team_id: alpha-squad', 'team_id: team-a').replace('default: true', 'default: false'))
    writeTeam('team-b', GOOD_TEAM.replace('team_id: alpha-squad', 'team_id: team-b').replace('default: true', 'default: false'))
    expect(await mgr.selectTeam('s-x')).toBeNull()
  })

  it('会话绑定指向已删除团队 → invalid_team', async () => {
    const persistence = openPersistence()
    const mgr = manager(['codex', 'zcode'], persistence)
    await mgr.bindTeam('s1', 'ghost')
    const error = await mgr.selectTeam('s1').catch((e) => e)
    expect(error).toBeInstanceOf(WeaveError)
    expect((error as WeaveError).code).toBe('invalid_team')
  })
})
