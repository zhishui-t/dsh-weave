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
  options?: {
    loadSessionError?: Error
    resumeSessionError?: Error
    /** 模拟旧桥/纯标准 ACP：连接上根本没有 resumeSession 方法。 */
    omitResumeSession?: boolean
    /** 预置连接已认识的会话（模拟同进程内已知 sid）。 */
    initialSessions?: string[]
  },
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
      ...(options?.omitResumeSession
        ? {}
        : {
            resumeSession: options?.resumeSessionError
              ? vi.fn().mockRejectedValue(options.resumeSessionError)
              : vi.fn().mockResolvedValue({ modes: { currentModeId: 'yolo', availableModes: [] } }),
          }),
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
      sessions: new Set<string>(options?.initialSessions ?? []),
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

  it('兼容旧调用：仅 weave.sessionKey 也按角色隔离；顶层 sessionKey 优先', async () => {
    const { provider, connections } = makeFixtures()
    const request = {
      parent: { session: { header: { cwd: 'K:/work/project/weave' } } },
      signal: new AbortController().signal,
      prompt: [{ type: 'text', text: 'hello' }],
    }

    const legacyDev = await provider.start({ ...request, weave: { sessionKey: 'legacy:developer-1' } })
    await legacyDev.result
    const legacyFe = await provider.start({ ...request, weave: { sessionKey: 'legacy:frontend-1' } })
    await legacyFe.result

    expect(legacyDev.id).not.toBe(legacyFe.id)
    expect(connections[0]!.newSession).toHaveBeenCalledTimes(2)

    const again = await provider.start({
      ...request,
      sessionKey: 'legacy:developer-1',
      weave: { sessionKey: 'legacy:frontend-1' },
    })
    await again.result
    expect(again.id).toBe(legacyDev.id)
  })

  it('缺 sessionKey fail fast：不新建会话、不写 undefined 脏键', async () => {
    const { provider, connections } = makeFixtures()
    const request = {
      parent: { session: { header: { cwd: 'K:/work/project/weave' } } },
      signal: new AbortController().signal,
      prompt: [{ type: 'text', text: 'hello' }],
    }

    await expect(provider.start({ ...request })).rejects.toThrow(/sessionKey is required/)
    // fail fast 发生在 acquireConnection 之前：不得创建连接，更不得新建会话。
    expect(connections).toHaveLength(0)
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

    it('治理：历史 "undefined" 脏键在下一次写入时被清除，合法键保留', async () => {
      const indexFile = join(dir, 'idx-legacy-cleanup.json')
      writeFileSync(
        indexFile,
        JSON.stringify({
          version: 1,
          keys: {
            undefined: { acpSid: 'legacy-shared-session', updatedAt: 1 },
            'changan:developer-3:session:v0': { acpSid: 'valid-existing-session', updatedAt: 2 },
          },
        }),
        'utf8',
      )
      const { provider } = makeFixtures({ sessionIndexFile: indexFile })
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const run = await provider.start({
          parent: { session: { header: { cwd: 'K:/work/project/weave' } } },
          signal: new AbortController().signal,
          sessionKey: 'changan:developer-3:session:v0',
          prompt: [{ type: 'text', text: 'clean legacy undefined key' }],
        })
        await run.result

        const persisted = JSON.parse(readFileSync(indexFile, 'utf8')) as {
          keys: Record<string, { acpSid: string }>
        }
        expect(persisted.keys.undefined).toBeUndefined()
        expect(persisted.keys['changan:developer-3:session:v0']?.acpSid).toBe('valid-existing-session')
        // 清理脏键时补一行日志（QA 微项②）：可观测、不静默。
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('[dsh-weave] acp-session-index: dropped 1 invalid key(s)'),
        )
      } finally {
        warnSpy.mockRestore()
      }
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

    it('边界：索引指向失效占位符，load+resume 全失败时自愈新建并覆盖索引', async () => {
      const indexFile = join(dir, 'idx-stale.json')
      writeFileSync(
        indexFile,
        JSON.stringify({
          version: 1,
          keys: {
            'changan:tester-1:x': { acpSid: 'ghost-session', updatedAt: 1, cwd: 'K:/old/workdir', zcodeSid: 'sess_ghost' },
          },
        }),
        'utf8',
      )
      const { provider, connections } = makeFixtures({ sessionIndexFile: indexFile }, {
        loadSessionError: new Error('placeholder evicted'),
        resumeSessionError: new Error('session not found'),
      })

      const run = await provider.start({
        parent: { session: { header: { cwd: 'K:/work/project/weave' } } },
        signal: new AbortController().signal,
        sessionKey: 'changan:tester-1:x',
        prompt: [{ type: 'text', text: 'retry after stale alias' }],
      })
      await run.result

      expect(connections[0]!.loadSession).toHaveBeenCalledTimes(1)
      expect(connections[0]!.resumeSession).toHaveBeenCalledTimes(1)
      expect(connections[0]!.newSession).toHaveBeenCalledTimes(1)
      expect(run.id).toBe('acp-acp-session-1')
      const persisted = JSON.parse(readFileSync(indexFile, 'utf8')) as {
        keys: Record<string, { acpSid: string; cwd?: string; zcodeSid?: string }>
      }
      const record = persisted.keys['changan:tester-1:x']
      expect(record?.acpSid).toBe('acp-session-1')
      // sid 变更：旧 resume 线索整体作废（cwd 覆写为本次声明值，zcodeSid 不迁移）。
      expect(record?.cwd).toBe('K:/work/project/weave')
      expect(record?.zcodeSid).toBeUndefined()
    })

    it('恢复链第二级：旧索引条目 + 新桥 load 失败 → session/resume 带旧线索沿用旧会话（不新建）', async () => {
      const indexFile = join(dir, 'idx-resume-chain.json')
      writeFileSync(
        indexFile,
        JSON.stringify({
          version: 1,
          keys: {
            'changan:developer-4:session:v0': { acpSid: 'legacy-acp-sid', updatedAt: 1, cwd: 'K:/old/workdir' },
          },
        }),
        'utf8',
      )
      // 桥重启后 session/load 环节失败（如历史回放异常），但占位符本身可恢复。
      const { provider, connections } = makeFixtures({ sessionIndexFile: indexFile }, {
        loadSessionError: new Error('history replay failed'),
      })

      const run = await provider.start({
        parent: { session: { header: { cwd: 'K:/work/project/weave' } } },
        signal: new AbortController().signal,
        sessionKey: 'changan:developer-4:session:v0',
        prompt: [{ type: 'text', text: 'continue after host restart' }],
      })
      const output = await run.result

      // load 异常被接住（不冒泡成 execution_failed），resume 成功沿用旧会话。
      expect(output.stopReason).toBe('completed')
      expect(connections[0]!.loadSession).toHaveBeenCalledTimes(1)
      expect(connections[0]!.resumeSession).toHaveBeenCalledTimes(1)
      // resume 携带索引里的旧线索：原 acpSid + 创建时的 cwd。
      expect(connections[0]!.resumeSession).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'legacy-acp-sid', cwd: 'K:/old/workdir' }),
      )
      expect(connections[0]!.newSession).not.toHaveBeenCalled()
      expect(run.id).toBe('acp-legacy-acp-sid')
      // 索引复写：同一 acpSid 沿用，旧线索保留。
      const persisted = JSON.parse(readFileSync(indexFile, 'utf8')) as {
        keys: Record<string, { acpSid: string; cwd?: string }>
      }
      expect(persisted.keys['changan:developer-4:session:v0']?.acpSid).toBe('legacy-acp-sid')
      expect(persisted.keys['changan:developer-4:session:v0']?.cwd).toBe('K:/old/workdir')
    })

    it('异常全接住：旧桥形态（连接无 resumeSession 方法）load 失败直接回落 newSession，不冒泡', async () => {
      const indexFile = join(dir, 'idx-no-resume-method.json')
      writeFileSync(
        indexFile,
        JSON.stringify({ version: 1, keys: { 'changan:qa-1:x': { acpSid: 'ghost-acp', updatedAt: 1 } } }),
        'utf8',
      )
      const { provider, connections } = makeFixtures({ sessionIndexFile: indexFile }, {
        loadSessionError: new Error('session not found'),
        omitResumeSession: true,
      })

      const run = await provider.start({
        parent: { session: { header: { cwd: 'K:/work/project/weave' } } },
        signal: new AbortController().signal,
        sessionKey: 'changan:qa-1:x',
        prompt: [{ type: 'text', text: 'old bridge without resume' }],
      })
      await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })
      expect(connections[0]!.loadSession).toHaveBeenCalledTimes(1)
      expect(connections[0]!.newSession).toHaveBeenCalledTimes(1)
      expect(run.id).toBe('acp-acp-session-1')
    })

    it('索引同 sid 复写保留前向兼容 resume 线索（zcodeSid），仅刷新时间戳', async () => {
      const indexFile = join(dir, 'idx-keep-clue.json')
      writeFileSync(
        indexFile,
        JSON.stringify({
          version: 1,
          keys: { 'changan:keeper-1:x': { acpSid: 'warm-sid', updatedAt: 1, cwd: 'K:/old/workdir', zcodeSid: 'sess_keep' } },
        }),
        'utf8',
      )
      // 连接已认识该 sid（同进程二次启动）：走 knownInConnection 分支的补写。
      const { provider } = makeFixtures({ sessionIndexFile: indexFile }, {
        initialSessions: ['warm-sid'],
      })

      const run = await provider.start({
        parent: { session: { header: { cwd: 'K:/work/project/weave' } } },
        signal: new AbortController().signal,
        sessionKey: 'changan:keeper-1:x',
        prompt: [{ type: 'text', text: 'warm reuse' }],
      })
      await run.result
      expect(run.id).toBe('acp-warm-sid')

      const persisted = JSON.parse(readFileSync(indexFile, 'utf8')) as {
        keys: Record<string, { acpSid: string; updatedAt: number; cwd?: string; zcodeSid?: string }>
      }
      const record = persisted.keys['changan:keeper-1:x']
      expect(record?.acpSid).toBe('warm-sid')
      expect(record?.updatedAt).toBeGreaterThan(1)
      expect(record?.zcodeSid).toBe('sess_keep')
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

    it('isSessionKnown：持久索引/当前连接已知为 true，未知 key 为 false', async () => {
      const indexFile = join(dir, 'idx-known.json')
      writeFileSync(
        indexFile,
        JSON.stringify({ version: 1, keys: { 'changan:known:x': { acpSid: 'sid-1', updatedAt: 1 } } }),
        'utf8',
      )
      const { provider } = makeFixtures({ sessionIndexFile: indexFile })
      expect(provider.isSessionKnown('changan:known:x')).toBe(true)
      expect(provider.isSessionKnown('changan:nope:x')).toBe(false)
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
