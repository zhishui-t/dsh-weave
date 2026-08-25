import { describe, expect, it, vi } from 'vitest'

const ACP_MODEL_SEPARATOR = String.fromCharCode(92)

import {
  AcpSessionProvider,
  type AcpSessionProviderConfig,
  type AcpSessionFactoryConnection,
  type AcpConfigOption,
} from '../acp/acp-session-provider'

function makeFixtures() {
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
      loadSession: vi.fn(),
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
})
