import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'

import {
  EXECUTOR_KIND_RULES,
  ExecutorKind,
  ExecutorRegistry,
  classifyProvider,
} from '../../../../src/plugins/weave/executors/executor-registry'
import {
  MOCK_PROVIDER_LIST,
  MockSubagentsContext,
  type SubagentCapabilitiesLike,
  type SubagentProviderLike,
  type SubagentsLike,
} from './fixtures/mock-subagents'

/** 把 mock 当作最小 Context 使用（load 仅依赖 ctx.subagents）。 */
function asContext(subagents: SubagentsLike): Context {
  return { subagents } as unknown as Context
}

/** 手工 stub：可精确控制 list/getProvider（含缺失场景）。 */
function stubSubagents(
  names: string[],
  caps?: Record<string, Partial<SubagentCapabilitiesLike>>,
): SubagentsLike {
  return {
    list: () => [...names],
    start: async () => {
      throw new Error('stub registry context: start() 不应被调用')
    },
    getProvider: (name: string): SubagentProviderLike | undefined => {
      const partial = caps?.[name]
      if (!partial) return undefined
      return {
        name,
        capabilities: {
          outputSchema: false,
          depthLimit: false,
          toolFilter: false,
          persona: false,
          ...partial,
        },
        inheritsParentContext: false,
        start: async () => ({
          id: `stub-${name}`,
          localAgent: undefined,
          result: Promise.resolve({ output: [], stopReason: 'completed' }),
          dispose: async () => {},
        }),
      }
    },
  }
}

const FULL_CAPS: SubagentCapabilitiesLike = {
  outputSchema: true,
  depthLimit: true,
  toolFilter: true,
  persona: true,
}

describe('ExecutorRegistry（P0-REG-002）', () => {
  it('未 load 时：get/list/kindOf 均为空', () => {
    const registry = new ExecutorRegistry()
    expect(registry.list()).toEqual([])
    expect(registry.get('spawn')).toBeUndefined()
    expect(registry.kindOf('spawn')).toBeUndefined()
    expect(registry.size).toBe(0)
  })

  it('classifyProvider 四类规则：spawn/fork→dsh_subagent, codex→codex, claude-code→claude_code, 其它→acp', () => {
    expect(classifyProvider('spawn')).toBe('dsh_subagent')
    expect(classifyProvider('fork')).toBe('dsh_subagent')
    expect(classifyProvider('codex')).toBe('codex')
    expect(classifyProvider('claude-code')).toBe('claude_code')
    expect(classifyProvider('zcode')).toBe('acp')
    expect(classifyProvider('any-acp-tool')).toBe('acp')
    expect(classifyProvider('')).toBe('acp')
  })

  it('分类规则表覆盖 spawn/fork/codex/claude-code；acp 为未命中兜底（四类全可达）', () => {
    const kinds = new Set<ExecutorKind>(Object.values(EXECUTOR_KIND_RULES))
    expect([...kinds].sort()).toEqual(['claude_code', 'codex', 'dsh_subagent'].sort())
    expect(EXECUTOR_KIND_RULES['spawn']).toBe('dsh_subagent')
    expect(EXECUTOR_KIND_RULES['fork']).toBe('dsh_subagent')
    expect(classifyProvider('unlisted-tool')).toBe('acp')
  })

  it('load() 基于 ctx.subagents.list() 发现全部 provider 并正确分类（mock 全量）', () => {
    const registry = new ExecutorRegistry()
    registry.load(asContext(new MockSubagentsContext()))

    expect(registry.size).toBe(MOCK_PROVIDER_LIST.length)
    expect(registry.list()).toHaveLength(MOCK_PROVIDER_LIST.length)

    const byId = new Map(registry.list().map((info) => [info.id, info]))
    expect(byId.get('spawn')?.kind).toBe('dsh_subagent')
    expect(byId.get('fork')?.kind).toBe('dsh_subagent')
    expect(byId.get('codex')?.kind).toBe('codex')
    expect(byId.get('claude-code')?.kind).toBe('claude_code')
    expect(byId.get('zcode')?.kind).toBe('acp')
  })

  it('list() 保持 provider 注册顺序，且 id/name 一致', () => {
    const registry = new ExecutorRegistry()
    registry.load(asContext(new MockSubagentsContext()))
    expect(registry.list().map((info) => info.id)).toEqual([...MOCK_PROVIDER_LIST])
    for (const info of registry.list()) expect(info.name).toBe(info.id)
  })

  it('get()/kindOf()：已注册可查，未注册返回 undefined', () => {
    const registry = new ExecutorRegistry()
    registry.load(asContext(new MockSubagentsContext()))

    const spawn = registry.get('spawn')
    expect(spawn).toBeDefined()
    expect(spawn!.id).toBe('spawn')
    expect(registry.kindOf('spawn')).toBe('dsh_subagent')
    expect(registry.kindOf('codex')).toBe('codex')

    expect(registry.get('ghost-executor')).toBeUndefined()
    expect(registry.kindOf('ghost-executor')).toBeUndefined()
  })

  it('capabilities 来源于 getProvider(name).capabilities（真实 SubagentCapabilities）', () => {
    const registry = new ExecutorRegistry()
    registry.load(
      asContext(
        stubSubagents(['spawn'], {
          spawn: { outputSchema: true, depthLimit: true, toolFilter: false, persona: false },
        }),
      ),
    )
    expect(registry.get('spawn')?.capabilities).toEqual({
      outputSchema: true,
      depthLimit: true,
      toolFilter: false,
      persona: false,
    })
  })

  it('getProvider 缺失（provider 已下线/不可解析）时 capabilities 默认全 false，不抛错', () => {
    const registry = new ExecutorRegistry()
    registry.load(asContext(stubSubagents(['codex'])))
    expect(registry.get('codex')?.capabilities).toEqual({
      outputSchema: false,
      depthLimit: false,
      toolFilter: false,
      persona: false,
    })
    expect(registry.kindOf('codex')).toBe('codex')
  })

  it('重复 load() 整体重建：空列表清空、新列表替换旧列表', () => {
    const registry = new ExecutorRegistry()
    registry.load(asContext(new MockSubagentsContext()))
    expect(registry.size).toBe(5)

    registry.load(asContext(stubSubagents([])))
    expect(registry.size).toBe(0)
    expect(registry.get('spawn')).toBeUndefined()

    registry.load(asContext(stubSubagents(['fork'])))
    expect(registry.size).toBe(1)
    expect(registry.get('fork')?.kind).toBe('dsh_subagent')
  })

  it('Mock 全量下四类能力均为真（spawn/fork 全能力，P0 委托链需要）', () => {
    const registry = new ExecutorRegistry()
    registry.load(asContext(new MockSubagentsContext()))
    for (const info of registry.list()) expect(info.capabilities).toEqual(FULL_CAPS)
  })
})
