import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { TeamManager, type ExecutorLookup } from '../team-manager'
import { createWeaveRpcHandler, WEAVE_RPC_CHANNEL } from '../rpc'

const lookup: ExecutorLookup = {
  get(id) {
    return id === 'zcode' ? { id, name: id, kind: 'acp', capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false } } : undefined
  },
}

const config = {
  schema_version: '1',
  team_id: 'rpc-squad',
  name: 'RPC Squad',
  default: false,
  roles: [{
    id: 'member',
    name: '成员',
    bias: 'dev',
    executor: 'zcode',
    stages: ['prepare', 'implement', 'review'],
    max_concurrent_tasks: 1,
    personality: 'test',
    provider: 'provider-id',
    model: 'deepseek-v4-flash',
    thought_level: 'max',
    mode: 'yolo',
  }],
  task_decomposition: {
    matchers: [],
    default_difficulty: 'hard',
    dag_templates: {
      easy: ['prepare', 'implement', 'review'],
      medium: ['prepare', 'implement', 'review'],
      hard: ['prepare', 'implement', 'review'],
      critical: ['prepare', 'implement', 'review'],
    },
  },
  knowledge_injection: { max_entries: 1, max_chars_per_entry: 100, max_total_chars: 300, priority: 'freshness_first' },
  feedback: { feedback_timeout_seconds: 60, max_revisions: 1, reopen_window_seconds: 60 },
}

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'weave-rpc-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function handler(catalog?: Parameters<typeof createWeaveRpcHandler>[1]) {
  return createWeaveRpcHandler({
    teamManager: new TeamManager(lookup, { teamsDir: dir }),
    executorRegistry: { list: () => [{ id: 'zcode', name: 'zcode', kind: 'acp', capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false } }] },
  } as never, catalog)
}

const MODEL_VALUE = ['p', 'm'].join(String.fromCharCode(92))

describe('Weave Connection RPC', () => {
  it('snapshot 返回团队与执行器', async () => {
    const result = await handler()('snapshot', {})
    expect(result).toMatchObject({ ok: true, value: { executors: [{ id: 'zcode' }] } })
  })

  it('snapshot 透出 ZCode session/new 能力目录', async () => {
    const catalog = async () => ({
      modes: { currentModeId: 'yolo', availableModes: [{ id: 'yolo' }] },
      configOptions: [
        { id: 'model', currentValue: MODEL_VALUE, options: [{ value: MODEL_VALUE, name: 'deepseek › m' }] },
        { id: 'thought', currentValue: 'max', options: [{ value: 'off' }, { value: 'max' }] },
      ],
    })
    const result = await handler(catalog)('snapshot', {}, new AbortController().signal)
    expect(result).toMatchObject({
      ok: true,
      value: {
        zcodeCapabilities: {
          currentModel: MODEL_VALUE,
          models: [{ value: MODEL_VALUE, name: 'deepseek › m' }],
          currentMode: 'yolo',
          thoughtLevels: [{ value: 'off' }, { value: 'max' }],
        },
      },
    })
  })

  it('team/import 接收结构化 config 并持久化', async () => {
    const result = await handler()('team/import', { overwrite: true, config })
    expect(result).toMatchObject({ ok: true, value: { team_id: 'rpc-squad', roles: 1 } })
    expect(new TeamManager(lookup, { teamsDir: dir }).loadTeam('rpc-squad')).toMatchObject({
      roles: [{ provider: 'provider-id', model: 'deepseek-v4-flash' }],
    })
  })

  it('未知 endpoint 返回闭合错误', async () => {
    const result = await handler()('nope', {})
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
  })

  it('channel 常量使用独立命名空间', () => {
    expect(WEAVE_RPC_CHANNEL).toBe('/dsh-weave')
  })
})
