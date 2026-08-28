import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const ACP_MODEL_SEPARATOR = String.fromCharCode(92)

import {
  AcpSessionProvider,
  type AcpSessionProviderConfig,
  type AcpSessionFactoryConnection,
  type AcpConfigOption,
} from '../acp/acp-session-provider'

function makeFixtures(
  overrides?: Partial<AcpSessionProviderConfig>,
  options?: { loadSessionError?: Error },
) {
  const connections: AcpSessionFactoryConnection[] = []
  const spawned: unknown[] = []
  const never = new Promise(() => {})
  const spawn = vi.fn().mockImplementation(() => {
    const child = {
      pid: spawned.length + 100,
      stdin: { end: vi.fn() },
      stdout: {},
      done: never,
      waitForExit: vi.fn().mockResolvedValue(undefined),
      terminate: vi.fn().mockResolvedValue(undefined),
    }
    spawned.push(child)
    return child
  })
  const config: AcpSessionProviderConfig = {
    name: 'zcode',
    command: 'node',
    args: ['zcode-acp-server.js'],
    permission: 'reject',
    ...overrides,
  }

  let sessionSequence = 0
  const createConnection = (cwd: string, key: string) => {
    const controller = new AbortController()
    const connection: AcpSessionFactoryConnection = {
      key,
      cwd,
      initialize: vi.fn().mockResolvedValue({
        protocolVersion: 1,
        agentInfo: { name: 'zcode-acp-server', title: 'ZCode', version: '0.11.9' },
        agentCapabilities: { loadSession: true },
        authMethods: [{ id: 'zcode-credentials', name: 'ZCode built-in credentials' }],
      }),
      newSession: vi.fn().mockImplementation(async () => {
        sessionSequence += 1
        const sessionId = `acp-session-${sessionSequence}`
        connection.sessions.add(sessionId)
        return {
          sessionId,
          modes: {
            currentModeId: 'yolo',
            availableModes: [
              { id: 'plan', name: 'Plan' },
              { id: 'build', name: 'Build' },
              { id: 'yolo', name: 'Yolo' },
            ],
          },
          configOptions: [
            {
              id: 'model',
              category: 'model',
              currentValue: 'provider-id' + ACP_MODEL_SEPARATOR + 'deepseek-v4-flash',
              options: [
                { value: 'provider-id' + ACP_MODEL_SEPARATOR + 'deepseek-v4-flash', name: 'deepseek › deepseek-v4-flash' },
                { value: 'provider-id' + ACP_MODEL_SEPARATOR + 'DeepSeek-V4-Pro', name: 'deepseek › DeepSeek-V4-Pro' },
              ],
            },
            {
              id: 'mode',
              category: 'mode',
              currentValue: 'yolo',
              options: [{ value: 'plan' }, { value: 'build' }, { value: 'yolo' }],
            },
            {
              id: 'thought',
              category: 'thought_level',
              currentValue: 'max',
              options: [{ value: 'off' }, { value: 'high' }, { value: 'max' }],
            },
          ],
        }
      }),
      loadSession: options?.loadSessionError
        ? vi.fn().mockRejectedValue(options.loadSessionError)
        : vi.fn(),
      prompt: vi.fn().mockImplementation(async (params: { sessionId: string }) => {
        connection.handleSessionUpdate?.({
          sessionId: params.sessionId,
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'live ' },
        })
        connection.handleSessionUpdate?.({
          sessionId: params.sessionId,
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'output' },
        })
        return { stopReason: 'end_turn' }
      }),
      cancel: vi.fn().mockResolvedValue(undefined),
      extMethod: vi.fn().mockResolvedValue({}),
      signal: controller.signal,
      sessions: new Set<string>(),
    }
    connections.push(connection)
    return connection
  }

  const provider = new AcpSessionProvider(
    config,
    spawn,
    async (cwd: string, key: string) => createConnection(cwd, key),
  )
  return { provider, spawn, connections, config }
}

describe('AcpSessionProvider', () => {
  it('启动会话、应用模型/思考深度，并透出实时输出', async () => {
    const { provider } = makeFixtures()
    const run = await provider.start({
      parent: { session: { header: { cwd: 'K:/work/project/weave' } } },
      signal: new AbortController().signal,
      sessionKey: 'team:coder:weave:v1',
      prompt: [{ type: 'text', text: 'hello' }],
      weave: {
        modelProvider: 'provider-id',
        model: 'deepseek-v4-flash-vision-exp',
        thoughtLevel: 'max',
      },
    })

    const output = await run.result
    expect(run.providerMetadata?.agentInfo).toEqual({
      name: 'zcode-acp-server',
      title: 'ZCode',
      version: '0.11.9',
    })
    expect(run.providerMetadata?.agentCapabilities).toEqual({ loadSession: true })
    expect(run.sessionConfig?.modes?.currentModeId).toBe('yolo')
    const configOptions: AcpConfigOption[] = run.sessionConfig?.configOptions ?? []
    expect(configOptions.map((option) => option.id)).toEqual(['model', 'mode', 'thought'])
    expect(configOptions[0]?.options?.map((option) => option.value)).toEqual([
      'provider-id' + ACP_MODEL_SEPARATOR + 'deepseek-v4-flash',
      'provider-id' + ACP_MODEL_SEPARATOR + 'DeepSeek-V4-Pro',
    ])
    expect(configOptions[2]?.currentValue).toBe('max')
    expect(output.stopReason).toBe('completed')
    expect(run.id).toBe('acp-acp-session-1')
    expect(run.readOutput().map((event) => [event.type, event.text])).toEqual([
      // t7：扩展协商先产出 extensions 可观测事件，再逐意图 status。
      ['status', 'extensions=zcode'],
      ['status', 'model=' + 'provider-id' + String.fromCharCode(92) + 'deepseek-v4-flash-vision-exp'],
      ['status', 'thought=max'],
      ['output', 'live '],
      ['output', 'output'],
    ])
  })

  it('同一 sessionKey 复用同一 ACP 会话，不同 key 创建新会话', async () => {
    const { provider, connections } = makeFixtures()
    const request = {
      parent: { session: { header: { cwd: 'K:/work/project/weave' } } },
      signal: new AbortController().signal,
      prompt: [{ type: 'text', text: 'continue' }],
    }

    const first = await provider.start({ ...request, sessionKey: 'role-project-version' })
    await first.result
    const second = await provider.start({ ...request, sessionKey: 'role-project-version' })
    await second.result
    const third = await provider.start({ ...request, sessionKey: 'isolated' })
    await third.result

    expect(connections).toHaveLength(1)
    expect(connections[0]!.newSession).toHaveBeenCalledTimes(2)
    expect(first.id).toBe(second.id)
    expect(third.id).not.toBe(first.id)
  })

  /* ---- iso-1：sessionKey→acpSid 持久索引（跨实例隔离与续接） ---- */

  describe('sessionKey 持久索引（iso-1）', () => {
    let dir = ''
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'weave-acp-idx-'))
    })
    afterAll(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    it('验收1：两个不同 sessionKey 各自获得独立会话并落索引；同键复用同一 sid', async () => {
      const indexFile = join(dir, 'idx-isolation.json')
      const { provider, connections } = makeFixtures({ sessionIndexFile: indexFile })
      const request = {
        parent: { session: { header: { cwd: 'K:/work/project/weave' } } },
        signal: new AbortController().signal,
        prompt: [{ type: 'text', text: 'hello' }],
      }

      const dev1 = await provider.start({ ...request, sessionKey: 'changan:developer-1:session:v0' })
      await dev1.result
      const fe1 = await provider.start({ ...request, sessionKey: 'changan:frontend-1:session:v0' })
      await fe1.result

      expect(dev1.id).toBe('acp-acp-session-1')
      expect(fe1.id).toBe('acp-acp-session-2')
      expect(dev1.id).not.toBe(fe1.id)

      // 同键再次启动：复用（不新建占位符）。
      const again = await provider.start({ ...request, sessionKey: 'changan:developer-1:session:v0' })
      await again.result
      expect(again.id).toBe(dev1.id)

      expect(connections[0]!.newSession).toHaveBeenCalledTimes(2)
      const persisted = JSON.parse(readFileSync(indexFile, 'utf8')) as {
        version: number
        keys: Record<string, { acpSid: string; updatedAt: number }>
      }
      expect(persisted.version).toBe(1)
      expect(persisted.keys['changan:developer-1:session:v0']?.acpSid).toBe('acp-session-1')
      expect(persisted.keys['changan:frontend-1:session:v0']?.acpSid).toBe('acp-session-2')
    })

    it('验收2：跨实例（模拟插件重启）同键经 loadSession 续接原占位符，不新建', async () => {
      const indexFile = join(dir, 'idx-resume.json')
      const first = makeFixtures({ sessionIndexFile: indexFile })
      const boot = await first.provider.start({
        parent: { session: { header: { cwd: 'K:/work/project/weave' } } },
        signal: new AbortController().signal,
        sessionKey: 'changan:developer-2:session:v0',
        prompt: [{ type: 'text', text: 'bootstrap' }],
      })
      await boot.result
      expect(first.connections[0]!.newSession).toHaveBeenCalledTimes(1)

      // 新 provider 实例（内存表为空），共享同一持久索引 ⇒ 必须走 loadSession 续接。
      const second = makeFixtures({ sessionIndexFile: indexFile })
      const resumed = await second.provider.start({
        parent: { session: { header: { cwd: 'K:/work/project/weave' } } },
        signal: new AbortController().signal,
        sessionKey: 'changan:developer-2:session:v0',
        prompt: [{ type: 'text', text: 'continue across restart' }],
      })
      await resumed.result
      expect(resumed.id).toBe(boot.id)
      expect(second.connections[0]!.newSession).not.toHaveBeenCalled()
      expect(second.connections[0]!.loadSession).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'acp-session-1' }),
      )
    })

    it('边界：索引指向失效占位符时自愈新建并覆盖索引', async () => {
      const indexFile = join(dir, 'idx-stale.json')
      writeFileSync(
        indexFile,
        JSON.stringify({ version: 1, keys: { 'changan:tester-1:x': { acpSid: 'ghost-session', updatedAt: 1 } } }),
        'utf8',
      )
      const { provider, connections } = makeFixtures({ sessionIndexFile: indexFile }, {
        loadSessionError: new Error('placeholder evicted'),
      })

      const run = await provider.start({
        parent: { session: { header: { cwd: 'K:/work/project/weave' } } },
        signal: new AbortController().signal,
        sessionKey: 'changan:tester-1:x',
        prompt: [{ type: 'text', text: 'retry after stale alias' }],
      })
      await run.result

      expect(connections[0]!.loadSession).toHaveBeenCalledTimes(1)
      expect(connections[0]!.newSession).toHaveBeenCalledTimes(1)
      expect(run.id).toBe('acp-acp-session-1')
      const persisted = JSON.parse(readFileSync(indexFile, 'utf8')) as {
        keys: Record<string, { acpSid: string }>
      }
      expect(persisted.keys['changan:tester-1:x']?.acpSid).toBe('acp-session-1')
    })

    it('兼容：未配置索引文件时保持既有纯内存行为（零副作用）', async () => {
      const { provider, connections } = makeFixtures()
      const run = await provider.start({
        parent: { session: { header: { cwd: 'K:/work/project/weave' } } },
        signal: new AbortController().signal,
        sessionKey: 'legacy-key',
        prompt: [{ type: 'text', text: 'legacy path' }],
      })
      await run.result
      expect(run.id).toBe('acp-acp-session-1')
      expect(connections[0]!.newSession).toHaveBeenCalledTimes(1)
    })
  })
})

describe('P1-H：session/update 协议形态（顶层 {sessionId, update}）与实时事件链', () => {
  it('mergeSessionUpdateNotification：顶层 sessionId 合并进 update（修复前 update.sessionId 恒 undefined 致事件全静默）', async () => {
    const { mergeSessionUpdateNotification } = await import('../acp/acp-session-provider')
    // 协议真实形态：sessionId 在通知顶层，update 对象内没有
    const merged = mergeSessionUpdateNotification({
      sessionId: 'sess-real-1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } },
    })
    expect(merged.sessionId).toBe('sess-real-1')
    expect(merged.sessionUpdate).toBe('agent_message_chunk')
    // update 自带 sessionId 时优先保留
    const selfId = mergeSessionUpdateNotification({
      sessionId: 'sess-top',
      update: { sessionId: 'sess-inner', sessionUpdate: 'plan' } as never,
    })
    expect(selfId.sessionId).toBe('sess-inner')
    // 两者皆无 → undefined（历史行为）
    expect(mergeSessionUpdateNotification({ update: { sessionUpdate: 'plan' } as never }).sessionId).toBeUndefined()
  })

})
