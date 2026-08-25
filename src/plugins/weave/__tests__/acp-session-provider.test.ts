import { describe, expect, it, vi } from 'vitest'

import {
  AcpSessionProvider,
  type AcpSessionProviderConfig,
  type AcpSessionFactoryConnection,
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
      initialize: vi.fn().mockResolvedValue({}),
      newSession: vi.fn().mockImplementation(async () => {
        sessionSequence += 1
        const sessionId = `acp-session-${sessionSequence}`
        connection.sessions.add(sessionId)
        return { sessionId }
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
      prompt: [{ type: 'text', text: 'hello' }],
      weave: {
        sessionKey: 'team:coder:weave:v1',
        modelProvider: 'provider-id',
        model: 'deepseek-v4-flash-vision-exp',
        thoughtLevel: 'max',
      },
    })

    const output = await run.result
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

    const first = await provider.start({ ...request, weave: { sessionKey: 'role-project-version' } })
    await first.result
    const second = await provider.start({ ...request, weave: { sessionKey: 'role-project-version' } })
    await second.result
    const third = await provider.start({ ...request, weave: { sessionKey: 'isolated' } })
    await third.result

    expect(connections).toHaveLength(1)
    expect(connections[0]!.newSession).toHaveBeenCalledTimes(2)
    expect(first.id).toBe(second.id)
    expect(third.id).not.toBe(first.id)
  })
})
