import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
team_id: alpha-team
name: 阿尔法团队
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
    expect(team.team_id).toBe('alpha-team')
    expect(team.roles).toHaveLength(3)
    expect(team.task_decomposition.default_difficulty).toBe('hard')
    expect(team.roles[0]?.stages).toEqual(['prepare', 'design'])
    manager(['codex', 'zcode']).validateTeam(team)
  })

  it('parseTeam 保留可选 description（团队简介）', () => {
    const withDesc = GOOD_TEAM.replace('name: 阿尔法团队\n', 'name: 阿尔法团队\ndescription: 负责端到端协作交付\n')
    const team = manager(['codex', 'zcode']).parseTeam(withDesc, 'fixture')
    expect(team.description).toBe('负责端到端协作交付')
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

  it('角色 provider/model 可选配置解析并校验通过', () => {
    const teamYaml = GOOD_TEAM.replace(
      '    personality: 你追求代码质量。',
      '    personality: 你追求代码质量。\n    provider: deepseek-official\n    model: deepseek-v4-flash-vision-exp\n    thought_level: max',
    )
    const team = manager(['codex', 'zcode']).parseTeam(teamYaml, 'fixture')
    expect(team.roles[1]).toMatchObject({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash-vision-exp',
      thought_level: 'max',
    })
    manager(['codex', 'zcode']).validateTeam(team)
  })

  it('executor 未注册不在 validateTeam 硬失败（委托期由 DelegationService 兜底）', () => {
    const mgr = manager(['codex'])
    const team = mgr.validateTeam(mgr.parseTeam(GOOD_TEAM, 'f'))
    expect(team.team_id).toBe('alpha-team')
  })

  it('stages 缺失 → invalid_team（HI-4）', () => {
    const mgr = manager(['codex', 'zcode'])
    const bad = GOOD_TEAM.replace('    stages: [prepare, design]\n', '')
    expectCode(() => mgr.validateTeam(mgr.parseTeam(bad, 'f')), 'invalid_team')
  })

  it('模板阶段未被角色标签绑定 → 允许：任务按需兜底匹配', () => {
    const mgr = manager(['codex', 'zcode'])
    const bad = GOOD_TEAM.replace('    stages: [implement, test, integrate, execute, deploy]', '    stages: [implement, test, execute, deploy]')
    expect(() => mgr.validateTeam(mgr.parseTeam(bad, 'f'))).not.toThrow()
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

})

/* ------------------------------- loadTeam / listTeams ------------------------------- */

describe('TeamManager 备用模型同执行器校验（用户裁定）', () => {
  function managerWithAcp(executors: string[], acpNames: string[]): TeamManager {
    return new TeamManager(makeLookup(executors), {
      teamsDir: dir,
      acpProviders: { list: () => acpNames.map((name) => ({ name })) },
    })
  }

  /** 给 coder（executor=zcode）角色追加 fallback 配置。 */
  const withCoderFallback = (fallback: string): string =>
    GOOD_TEAM.replace(
      '    personality: 你追求代码质量。',
      `    personality: 你追求代码质量。\n    fallback_provider: ${fallback}\n    fallback_model: fb-model`,
    )

  it('同执行器通过：zcode 角色的 fallback_provider 在本机 ACP 清单内', () => {
    const mgr = managerWithAcp(['codex', 'zcode'], ['zcode'])
    const team = mgr.validateTeam(mgr.parseTeam(withCoderFallback('zcode'), 'f'))
    expect(team.roles[1]).toMatchObject({ fallback_provider: 'zcode', fallback_model: 'fb-model' })
  })

  it('跨执行器拒绝：zcode 角色 fallback_provider 指向 DSH LLM provider → invalid_team 并提示可用清单', () => {
    const mgr = managerWithAcp(['codex', 'zcode'], ['zcode'])
    const error = expectCode(() => mgr.validateTeam(mgr.parseTeam(withCoderFallback('deepseek-official'), 'f')), 'invalid_team')
    expect(error.message).toContain('跨执行器')
    expect(error.message).toContain("实际为 'deepseek-official'")
    expect(error.message).toContain('可用: zcode')
  })

  it('反向跨执行器拒绝：DSH 系角色（codex）fallback_provider 指向 ACP provider → invalid_team', () => {
    // lookup 故意不含 codex → kind 走 classifyProvider 兜底（codex ≠ acp）
    const mgr = managerWithAcp(['zcode'], ['zcode'])
    const teamYaml = GOOD_TEAM.replace(
      '    personality: 你是方案设计师。',
      '    personality: 你是方案设计师。\n    fallback_provider: zcode\n    fallback_model: fb-model',
    )
    const error = expectCode(() => mgr.validateTeam(mgr.parseTeam(teamYaml, 'f')), 'invalid_team')
    expect(error.message).toContain('不能指向 ACP provider')
    expect(error.message).toContain('应为 DSH LLM provider')
  })

  it('ACP 清单为空 → 跳过校验（降级不误杀，与执行器注册检查同一哲学）', () => {
    const mgr = managerWithAcp(['codex', 'zcode'], [])
    const team = mgr.validateTeam(mgr.parseTeam(withCoderFallback('deepseek-official'), 'f'))
    expect(team.roles[1]?.fallback_provider).toBe('deepseek-official')
  })

  it('未配置 fallback 的团队不受影响（GOOD_TEAM 基线）', () => {
    const mgr = managerWithAcp(['codex', 'zcode'], ['zcode'])
    expect(() => mgr.validateTeam(mgr.parseTeam(GOOD_TEAM, 'f'))).not.toThrow()
  })
})

describe('TeamManager loadTeam/listTeams', () => {
  it('loadTeam 成功（含仓库内 examples/team.yaml 样例）', () => {
    // 样例文件的 team_id(alpha-squad) 与本夹具文件名对齐后再加载，保持对样例结构的真实覆盖
    writeTeam('alpha-team', readFileSync(EXAMPLES_TEAM_YAML, 'utf8').replace('team_id: alpha-squad', 'team_id: alpha-team'))
    const team = manager(['codex', 'zcode']).loadTeam('alpha-team')
    expect(team.roles.map((r: TeamConfig['roles'][number]) => r.id)).toEqual(['designer', 'coder', 'reviewer'])
  })

  it('团队不存在 → invalid_team', () => {
    expectCode(() => manager(['codex']).loadTeam('ghost'), 'invalid_team')
  })

  it('文件 team_id 与文件名不一致 → invalid_team', () => {
    writeTeam('alpha-team', GOOD_TEAM.replace('team_id: alpha-team', 'team_id: other-team'))
    expectCode(() => manager(['codex', 'zcode']).loadTeam('alpha-team'), 'invalid_team')
  })

  it('listTeams 仅返回校验通过的团队（非法团队不进入调度）', () => {
    writeTeam('team-a', GOOD_TEAM.replace('team_id: alpha-team', 'team_id: team-a'))
    writeTeam('team-b', GOOD_TEAM.replace('team_id: alpha-team', 'team_id: team-b').replace('executor: zcode', 'executor: ghost'))
    writeTeam('team-c', GOOD_TEAM.replace('team_id: alpha-team', 'team_id: team-c'))
    const ids = manager(['codex', 'zcode']).listTeams().map((t) => t.team_id)
    // iso-1/v4 hotfix：执行器注册检查降级到委派期，listTeams 不再因 registry 波动清空团队。
    expect(ids).toEqual(['team-a', 'team-b', 'team-c'])
  })
})

/* ------------------------------- selectTeam / bindTeam（ME-4） ------------------------------- */

describe('TeamManager selectTeam 优先级链 + team_bindings（ME-4）', () => {
  const openPersistence = (): WeavePersistence => new WeavePersistence({ inMemory: true })

  it('显式指定 > 会话绑定', async () => {
    const persistence = openPersistence()
    const mgr = manager(['codex', 'zcode'], persistence)
    writeTeam('team-a', GOOD_TEAM.replace('team_id: alpha-team', 'team_id: team-a'))
    writeTeam('team-b', GOOD_TEAM.replace('team_id: alpha-team', 'team_id: team-b'))
    await mgr.bindTeam('s1', 'team-a')
    const chosen = await mgr.selectTeam('s1', 'team-b')
    expect(chosen?.team_id).toBe('team-b')
  })

  it('会话绑定生效且写入 core.db.team_bindings', async () => {
    const persistence = openPersistence()
    const mgr = manager(['codex', 'zcode'], persistence)
    writeTeam('team-a', GOOD_TEAM.replace('team_id: alpha-team', 'team_id: team-a'))
    await mgr.bindTeam('s1', 'team-a')
    expect(await mgr.getBoundTeam('s1')).toBe('team-a')
    expect((await mgr.selectTeam('s1'))?.team_id).toBe('team-a')
    expect(persistence.core.tables()).toContain('team_bindings')
  })

  it('重复绑定为 upsert（切换团队）', async () => {
    const persistence = openPersistence()
    const mgr = manager(['codex', 'zcode'], persistence)
    writeTeam('team-a', GOOD_TEAM.replace('team_id: alpha-team', 'team_id: team-a'))
    writeTeam('team-b', GOOD_TEAM.replace('team_id: alpha-team', 'team_id: team-b'))
    await mgr.bindTeam('s1', 'team-a')
    await mgr.bindTeam('s1', 'team-b')
    expect(await mgr.getBoundTeam('s1')).toBe('team-b')
  })

  it('default 团队优先于普通团队', async () => {
    const mgr = manager(['codex', 'zcode'])
    writeTeam('team-n', GOOD_TEAM.replace('team_id: alpha-team', 'team_id: team-n').replace('default: true', 'default: false'))
    writeTeam('team-d', GOOD_TEAM.replace('team_id: alpha-team', 'team_id: team-d'))
    expect((await mgr.selectTeam('s-x'))?.team_id).toBe('team-d')
  })

  it('仅一个团队时自动选择（无需 default）', async () => {
    const mgr = manager(['codex', 'zcode'])
    writeTeam('team-a', GOOD_TEAM.replace('team_id: alpha-team', 'team_id: team-a').replace('default: true', 'default: false'))
    expect((await mgr.selectTeam('s-x'))?.team_id).toBe('team-a')
  })

  it('多团队且无绑定无默认 → 返回 null（提示选择）', async () => {
    const mgr = manager(['codex', 'zcode'])
    writeTeam('team-a', GOOD_TEAM.replace('team_id: alpha-team', 'team_id: team-a').replace('default: true', 'default: false'))
    writeTeam('team-b', GOOD_TEAM.replace('team_id: alpha-team', 'team_id: team-b').replace('default: true', 'default: false'))
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

describe('TeamManager importTeam（Web 创建团队）', () => {
  it('校验通过后写入 YAML，并可重新加载', () => {
    const mgr = manager(['codex', 'zcode'])
    const team = mgr.importTeam(GOOD_TEAM.replace('team_id: alpha-team', 'team_id: imported'))
    expect(team.team_id).toBe('imported')
    expect(mgr.loadTeam('imported').team_id).toBe('imported')
  })

  it('已存在默认拒绝，overwrite=true 允许更新', () => {
    const mgr = manager(['codex', 'zcode'])
    const yaml = GOOD_TEAM.replace('team_id: alpha-team', 'team_id: imported')
    mgr.importTeam(yaml)
    expectCode(() => mgr.importTeam(yaml), 'conflict')
    expect(mgr.importTeam(yaml, { overwrite: true }).team_id).toBe('imported')
  })

  it('校验失败不落盘；路径非法直接拒绝', () => {
    const mgr = manager(['codex'])
    const imported = mgr.importTeam(GOOD_TEAM.replace('team_id: alpha-team', 'team_id: bad'))
    expect(imported.team_id).toBe('bad')
    expect(existsSync(join(dir, 'bad.yaml'))).toBe(true)
    expectCode(
      () => manager(['codex', 'zcode']).importTeam(GOOD_TEAM.replace('team_id: alpha-team', 'team_id: ../bad')),
      'invalid_team',
    )
  })
})

/* ------------------------------- Web RPC 支撑：deleteTeam / unbindTeam / listBindings ------------------------------- */

describe('TeamManager deleteTeam / unbindTeam / listBindings（Web team/delete・unbind・bindings）', () => {
  const openPersistence = (): WeavePersistence => new WeavePersistence({ inMemory: true })

  it('deleteTeam 删除 YAML 并清理该团队遗留绑定', async () => {
    const persistence = openPersistence()
    const mgr = manager(['codex', 'zcode'], persistence)
    mgr.importTeam(GOOD_TEAM.replace('team_id: alpha-team', 'team_id: gone'))
    await mgr.bindTeam('s9', 'gone')
    expect(existsSync(join(dir, 'gone.yaml'))).toBe(true)

    const result = await mgr.deleteTeam('gone')
    expect(result.team_id).toBe('gone')
    expect(existsSync(join(dir, 'gone.yaml'))).toBe(false)
    // 指向已删团队的绑定被同步清理，不残留悬空行
    expect(await mgr.listBindings()).toEqual([])
  })

  it('deleteTeam 团队不存在 → invalid_team；非法 team_id → invalid_argument', async () => {
    const mgr = manager(['codex', 'zcode'])
    await expect(mgr.deleteTeam('ghost')).rejects.toMatchObject({ code: 'invalid_team' })
    for (const evil of ['../escape', '..' + String.fromCharCode(92) + 'escape', '.dot']) {
      await expect(mgr.deleteTeam(evil)).rejects.toMatchObject({ code: 'invalid_argument' })
    }
    expect(existsSync(join(dir, 'escape.yaml'))).toBe(false)
  })

  it('listBindings 返回全部绑定并按 session_id 排序', async () => {
    const persistence = openPersistence()
    const mgr = manager(['codex', 'zcode'], persistence)
    await mgr.bindTeam('s2', 'team-a')
    await mgr.bindTeam('s1', 'team-b')
    const bindings = await mgr.listBindings()
    expect(bindings.map((b) => b.session_id)).toEqual(['s1', 's2'])
    for (const binding of bindings) {
      expect(typeof binding.team_id).toBe('string')
      expect(typeof binding.updated_at).toBe('string')
    }
  })

  it('unbindTeam 返回是否存在绑定；重复解绑返回 false', async () => {
    const persistence = openPersistence()
    const mgr = manager(['codex', 'zcode'], persistence)
    await mgr.bindTeam('s1', 'team-a')
    expect(await mgr.unbindTeam('s1')).toBe(true)
    expect(await mgr.unbindTeam('s1')).toBe(false)
    expect(await mgr.getBoundTeam('s1')).toBeNull()
  })
})

describe('TeamManager 团队消息（Phase 3 双向通信）', () => {
  const openPersistence = (): WeavePersistence => new WeavePersistence({ inMemory: true })

  it('发送、列表、未读、已读闭环', async () => {
    const persistence = openPersistence()
    const mgr = manager(['codex', 'zcode'], persistence)
    const sent = await mgr.sendTeamMessage({
      team_id: 'team-a',
      session_id: 's1',
      from_role: 'captain',
      to_role: 'coder',
      content: '请先实现登录',
    })
    expect(typeof sent.id).toBe('number')
    await mgr.sendTeamMessage({
      team_id: 'team-a',
      session_id: 's1',
      from_role: 'captain',
      to_role: 'coder',
      content: '再做测试',
    })

    const unread = await mgr.unreadTeamMessages({ team_id: 'team-a', to_role: 'coder' })
    expect(unread.unread).toBe(2)

    const messages = await mgr.listTeamMessages({ team_id: 'team-a', to_role: 'coder' })
    expect(messages).toHaveLength(2)
    expect(messages[0]?.content).toBe('再做测试')

    const read = await mgr.markTeamMessagesRead({ team_id: 'team-a', to_role: 'coder' })
    expect(read.updated).toBe(2)
    expect((await mgr.unreadTeamMessages({ team_id: 'team-a', to_role: 'coder' })).unread).toBe(0)
  })
})
