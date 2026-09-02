/**
 * t7 —— ACP Provider 扩展框架 / providers.json / 会话命令 测试。
 * 覆盖：扩展协商（声明∧探测）、意图应用与可观测降级、方法白名单、
 * 配置校验与两种输入形态、动态注册命令、update 变换钩子。
 */
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AcpSessionProvider,
  type AcpSessionFactoryConnection,
  defaultRuntimeHooks,
} from '../../../../src/plugins/weave/acp/acp-session-provider'
import {
  BUILTIN_ACP_EXTENSIONS,
  applyRuntimeIntents,
  callExtensionMethod,
  createZcodeExtension,
  negotiateExtensions,
} from '../../../../src/plugins/weave/acp/provider-extension'
import type { AcpProviderExtension } from '../../../../src/plugins/weave/acp/provider-extension'
import { ProviderStore, parseProviderInput, parseProviderInputs } from '../../../../src/plugins/weave/acp/provider-store'
import { createWeaveProviderCommandDefinitions, registerStoredAcpProviders } from '../../../../src/plugins/weave/acp/dynamic-provider'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const tmpRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'weave-ext-'))
  roots.push(root)
  return root
}

/** 构造工厂连接：extMethod 全记录；initialize._meta 可注入探测标记。 */
function makeConnection(options: { meta?: unknown; agentName?: string } = {}) {
  const extCalls: Array<{ method: string; params: Record<string, unknown> }> = []
  let sessionSeq = 0
  const connection = {
    key: 'k',
    cwd: '/tmp',
    sessions: new Set<string>(),
    initialize: vi.fn().mockResolvedValue({
      protocolVersion: 1,
      agentInfo: { name: options.agentName ?? 'some-agent' },
      agentCapabilities: { loadSession: false },
      ...(options.meta !== undefined ? { _meta: options.meta } : {}),
    }),
    newSession: vi.fn().mockImplementation(async () => {
      sessionSeq += 1
      const sessionId = `sess-${sessionSeq}`
      connection.sessions.add(sessionId)
      return { sessionId }
    }),
    prompt: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
    cancel: vi.fn().mockResolvedValue(undefined),
    extMethod: vi.fn().mockImplementation(async (method: string, params: Record<string, unknown>) => {
      extCalls.push({ method, params })
      return {}
    }),
    signal: new AbortController().signal,
  } as unknown as AcpSessionFactoryConnection
  return { connection: connection as AcpSessionFactoryConnection, extCalls }
}

function makeProvider(connection: AcpSessionFactoryConnection, declaredExtensions?: string[]) {
  return new AcpSessionProvider(
    { name: 'agent-x', command: 'node', args: ['x.js'], permission: 'reject', ...(declaredExtensions !== undefined ? { declaredExtensions } : {}) },
    (() => { throw new Error('should not spawn') }) as never,
    async () => connection,
  )
}

const START_BASE: {
  sessionKey: string
  parent: { session: { header: { cwd: string } } }
  signal: AbortSignal
  prompt: Array<{ type: 'text'; text: string }>
} = {
  sessionKey: 'k1',
  parent: { session: { header: { cwd: '/tmp' } } },
  signal: new AbortController().signal,
  prompt: [{ type: 'text', text: 'hi' }],
} as const

describe('扩展协商 negotiateExtensions（声明 ∧ 探测）', () => {
  const probe = { meta: { zcode: { bridge: true } } }

  it('声明且探测命中 → active；未探测命中 → inactive:not-detected', () => {
    const hit = negotiateExtensions(['zcode'], BUILTIN_ACP_EXTENSIONS, probe)
    expect(hit.active.map((e) => e.name)).toEqual(['zcode'])
    expect(hit.report).toEqual([{ name: 'zcode', status: 'active' }])

    const miss = negotiateExtensions(['zcode'], BUILTIN_ACP_EXTENSIONS, {})
    expect(hit.active.length).toBe(1)
    expect(miss.active).toEqual([])
    expect(miss.report[0]).toEqual({ name: 'zcode', status: 'inactive', reason: 'not-detected' })
  })

  it('未知名 → inactive:unknown-extension；detect 抛异常 → inactive:detect-error', () => {
    const boom: AcpProviderExtension = {
      ...createZcodeExtension(),
      name: 'boom',
      detect() {
        throw new Error('probe blew up')
      },
    }
    const registry = { ...BUILTIN_ACP_EXTENSIONS, boom }
    const out = negotiateExtensions(['ghost', 'boom'], registry, probe)
    expect(out.active).toEqual([])
    expect(out.report).toContainEqual({ name: 'ghost', status: 'inactive', reason: 'unknown-extension' })
    expect(out.report.find((r) => r.name === 'boom')?.reason).toContain('detect-error')
  })

  it('探测到但未声明 → 保守不放行并报告 detected-but-not-declared', () => {
    const out = negotiateExtensions([], BUILTIN_ACP_EXTENSIONS, { agentInfo: { name: 'zcode-thing' } })
    expect(out.active).toEqual([])
    expect(out.report).toContainEqual({ name: 'zcode', status: 'inactive', reason: 'detected-but-not-declared' })
  })

  it('zcode.detect 三源识别：_meta 命中 / agentInfo.name 命中 / 无标记不命中', () => {
    const ext = createZcodeExtension()
    expect(ext.detect({ meta: { anything: 1, zc: undefined } })).toBe(false)
    expect(ext.detect({ agentInfo: { name: 'ZCode ACP Server' } })).toBe(true)
    expect(ext.detect({ agentCapabilities: { _meta: { 'x-zcode': true } } })).toBe(true)
    expect(ext.detect({})).toBe(false)
  })
})

describe('意图应用 applyRuntimeIntents / zcode.apply', () => {
  it('白名单：未声明方法直接拒绝；ZCode 协议中的统一配置方法放行', async () => {
    const ext = createZcodeExtension()
    await expect(callExtensionMethod(ext, { extMethod: async () => 1 }, 'session/hack', {})).rejects.toThrow(/allowlist/)
    await expect(
      callExtensionMethod(ext, { extMethod: async () => 1 }, 'session/set_config_option', { sessionId: 's1' }),
    ).resolves.toBe(1)
    await expect(
      callExtensionMethod(ext, { extMethod: async () => 1 }, 'session/updateRuntimeModelConfig', { sessionId: 's1' }),
    ).resolves.toBe(1)
  })

  it('model+thought+mode 全部经 extMethod 应用；provider/model 反斜杠拼接', async () => {
    const ext = createZcodeExtension()
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const out = await ext.apply(
      { sessionId: 's1', modelProvider: 'pid', model: 'glm-5', thoughtLevel: 'max', mode: 'yolo' },
      { extMethod: async (method, params) => { calls.push({ method, params }); return {} } },
    )
    expect(out.model).toMatchObject({ supported: true, effective: 'pid' + String.fromCharCode(92) + 'glm-5' })
    expect(out.thought).toMatchObject({ supported: true, effective: 'max' })
    expect(out.mode).toMatchObject({ supported: true, effective: 'yolo' })
    expect(calls.map((c) => c.method)).toEqual(['session/setModel', 'session/setThoughtLevel', 'session/setMode'])
  })

  it('extMethod 失败 → supported:false + fallback:true + detail（不外抛）', async () => {
    const ext = createZcodeExtension()
    const out = await ext.apply(
      { sessionId: 's1', thoughtLevel: 'max' },
      { extMethod: async () => { throw new Error('bridge offline') } },
    )
    expect(out.thought).toMatchObject({ requested: 'max', supported: false, fallback: true })
    expect(String(out.thought?.detail)).toContain('bridge offline')
  })

  it('无激活扩展：全部请求意图降级且 detail 可观测；tools 恒 unsupported', async () => {
    const out = await applyRuntimeIntents([], {
      sessionId: 's1',
      model: 'm',
      thoughtLevel: 'max',
      mode: 'plan',
      tools: { management: 'deny' },
    }, { extMethod: async () => ({}) })
    for (const key of ['model', 'thought', 'mode', 'tools'] as const) {
      expect(out.applied[key]).toMatchObject({ supported: false, fallback: true })
      expect(String(out.applied[key]?.detail)).not.toBe('')
    }
    const withActive = await applyRuntimeIntents([createZcodeExtension()], {
      sessionId: 's1',
      tools: { management: 'allow', allowedTools: ['read'] },
    }, { extMethod: async () => ({}) })
    expect(withActive.applied.tools).toMatchObject({ supported: false, fallback: true })
    expect(String(withActive.applied.tools?.detail)).toContain('tool filtering')
  })

  it('缺 model id 的降级 detail；未请求的意图键不出现在报告中', async () => {
    const out = await applyRuntimeIntents([createZcodeExtension()], {
      sessionId: 's1',
      modelProvider: 'pid',
    }, { extMethod: async () => ({}) })
    expect(out.applied.model?.supported).toBe(false)
    expect(String(out.applied.model?.detail)).toContain('model id')
    expect(out.applied.thought).toBeUndefined()
    expect(out.applied.mode).toBeUndefined()
  })

  it('端到端：声明 zcode 且 _meta 命中 → 会话启动走扩展；未声明扩展 → 意图降级事件', async () => {
    const hit = makeConnection({ meta: { zcode: {} } })
    const provider = makeProvider(hit.connection)
    const run = await provider.start({ ...START_BASE, weave: { model: 'glm-5', thoughtLevel: 'low' } })
    const texts = run.readOutput().map((e) => e.text ?? '')
    expect(texts[0]).toBe('extensions=zcode')
    expect(hit.extCalls.map((c) => c.method)).toContain('session/setModel')
    expect(run.intentApplied?.model).toMatchObject({ supported: true })

    const miss = makeConnection({})
    const provider2 = makeProvider(miss.connection, [])
    const run2 = await provider2.start({ ...START_BASE, weave: { model: 'm' } as never })
    // 空声明 = 纯标准 ACP：无协商项，故无降级原因可报。
    expect((run2.readOutput()[0]!.text ?? '')).toBe('extensions=none')
    expect(run2.intentApplied?.model).toMatchObject({ supported: false, fallback: true, detail: 'no active extension (negotiation produced none)' })

    // 声明了 zcode 但探测未命中：明确报告 not-detected 降级原因。
    const missDeclared = makeConnection({})
    const provider3 = makeProvider(missDeclared.connection, ['zcode'])
    const run3 = await provider3.start({ ...START_BASE, weave: { thoughtLevel: 'max' } })
    expect((run3.readOutput()[0]!.text ?? '')).toBe('extensions=none (zcode:not-detected)')
    expect(run3.intentApplied?.thought).toMatchObject({ supported: false, fallback: true })
  })

  it('transformUpdate 钩子优先于内核默认 update 映射', async () => {
    const fixture = makeConnection({ meta: { zcode: {} } })
    const provider = new AcpSessionProvider(
      { name: 'agent-x', command: 'node', permission: 'reject', declaredExtensions: ['zcode'] },
      (() => { throw new Error('no spawn') }) as never,
      async () => fixture.connection,
      {
        resolveExtensions: defaultRuntimeHooks(['zcode']).resolveExtensions,
        transformUpdate: (update) =>
          update.sessionUpdate === 'tool_call' ? [{ type: 'status', text: `custom:${String(update.title)}` }] : undefined,
      },
    )
    const run = await provider.start(START_BASE)
    fixture.connection.handleSessionUpdate?.({ sessionId: 'sess-1', sessionUpdate: 'tool_call', title: 'Read' })
    const texts = run.readOutput().map((e) => `${e.type}:${e.text ?? ''}`)
    expect(texts).toContain('status:custom:Read')
  })
})

describe('providers.json 存储与入参解析', () => {
  it('add/list/remove/upsert 真实落盘；损坏文件按空库降级', () => {
    const root = tmpRoot()
    const store = new ProviderStore({ file: join(root, 'weave', 'providers.json') })
    expect(store.list()).toEqual([])
    const cfg = parseProviderInput({ name: 'a1', transport: 'stdio', command: 'node', protocol: 'acp', args: ['x.js'], declaredExtensions: ['zcode'] })
    store.add(cfg)
    store.add(parseProviderInput('name=a2 command=node transport=stdio protocol=acp'))
    store.add(parseProviderInput({ name: 'a1', transport: 'stdio', command: 'node2', protocol: 'acp' }))
    expect(store.list().map((c) => `${c.name}:${c.command}`)).toEqual(['a2:node', 'a1:node2'])
    expect(existsSync(store.file)).toBe(true)
    expect(JSON.parse(readFileSync(store.file, 'utf8')).version).toBe(1)
    expect(store.remove('a2')).toBe(true)
    expect(store.remove('ghost')).toBe(false)
    expect(store.get('a1')?.command).toBe('node2')
  })

  it('校验矩阵：非法字段逐一 invalid_argument', () => {
    const bad = (input: unknown) => expect(() => parseProviderInput(input as never)).toThrowError(/invalid_argument|必须|未知|JSON|仅支持|不能为空|解析失败/)
    bad({ name: '9bad', transport: 'stdio', command: 'n', protocol: 'acp' })
    bad({ name: 'ok', transport: 'tcp', command: 'n', protocol: 'acp' })
    bad({ name: 'ok', transport: 'stdio', command: 'n', protocol: 'mcp' })
    bad({ name: 'ok', transport: 'stdio', command: '', protocol: 'acp' })
    bad({ name: 'ok', transport: 'stdio', command: 'n', protocol: 'acp', args: [''] })
    bad({ name: 'ok', transport: 'stdio', command: 'n', protocol: 'acp', env: { A: 1 } })
    bad({ name: 'ok', transport: 'stdio', command: 'n', protocol: 'acp', declaredExtensions: [42] })
    bad('{ broken json')
    bad('unknownKey=x')
    bad('novalue')
    expect(() => parseProviderInput('')).toThrowError(/不能为空/)
  })

  it('紧凑语法：args/env/declaredExtensions 解析正确；JSON 字符串优先路径', () => {
    const compact = parseProviderInput('name=c1 command=node args=--a,b cwd=/w env=A=1,B=x=y transport=stdio protocol=acp declaredExtensions=zcode,codex')
    expect(compact).toMatchObject({
      name: 'c1',
      command: 'node',
      args: ['--a', 'b'],
      cwd: '/w',
      env: { A: '1', B: 'x=y' },
      declaredExtensions: ['zcode', 'codex'],
      transport: 'stdio',
      protocol: 'acp',
    })
    const json = parseProviderInput('{"name":"j1","transport":"stdio","command":"py","protocol":"acp"}')
    expect(json.name).toBe('j1')
  })

  it('parseProviderInputs：支持数组、providers/servers/mcpServers、env 数组与缺省 transport/protocol', () => {
    const arr = parseProviderInputs([
      { name: 'm1', command: 'node', args: ['a.js'] },
      { name: 'm2', command: 'python', args: ['b.py'] },
    ])
    expect(arr.map((c) => c.name)).toEqual(['m1', 'm2'])
    expect(arr[0]?.transport).toBe('stdio')
    expect(arr[0]?.protocol).toBe('acp')

    const providers = parseProviderInputs('{"providers":[{"name":"p1","command":"node","args":["x.js"]}]}')
    expect(providers).toHaveLength(1)
    expect(providers[0]?.name).toBe('p1')

    const mcp = parseProviderInputs({
      mcpServers: [
        {
          name: 'acp-tool',
          type: 'stdio',
          command: '/usr/bin/acp-tool',
          args: ['--serve'],
          env: [{ name: 'TOKEN', value: 'secret' }, { name: 'MODE', value: 'x' }],
        },
      ],
    })
    expect(mcp[0]?.command).toBe('/usr/bin/acp-tool')
    expect(mcp[0]?.env).toEqual({ TOKEN: 'secret', MODE: 'x' })

    const idFallback = parseProviderInputs('{"servers":[{"id":"fallback-agent","command":"npx","args":["agent.js"]}]}')
    expect(idFallback[0]?.name).toBe('fallback-agent')

    const objectMap = parseProviderInputs({ servers: { 'map-agent': { command: 'node', args: ['m.js'] } } })
    expect(objectMap[0]?.name).toBe('map-agent')
    expect(objectMap[0]?.args).toEqual(['m.js'])

    const yaml = parseProviderInputs('name: yaml-agent\ncommand: node\nargs:\n  - y.js\nextensions:\n  - zcode')
    expect(yaml[0]?.name).toBe('yaml-agent')
    expect(yaml[0]?.args).toEqual(['y.js'])
    expect(yaml[0]?.declaredExtensions).toEqual(['zcode'])

    const fenced = parseProviderInputs('```yaml\nname: fenced-agent\ncommand: node\nargs: f.js\n```')
    expect(fenced[0]?.name).toBe('fenced-agent')
    expect(fenced[0]?.args).toEqual(['f.js'])

    const loose = parseProviderInputs('Some ACP protocol doc\nname = loose-agent\ncommand = npx\nargs = --serve,--port 8080\nextensions = zcode')
    expect(loose[0]?.name).toBe('loose-agent')
    expect(loose[0]?.args).toEqual(['--serve', '--port', '8080'])
    expect(loose[0]?.declaredExtensions).toEqual(['zcode'])

    const singleLine = parseProviderInputs('name: single-agent command: node args: s.js extensions: zcode')
    expect(singleLine[0]?.name).toBe('single-agent')
    expect(singleLine[0]?.args).toEqual(['s.js'])
    expect(singleLine[0]?.declaredExtensions).toEqual(['zcode'])

    const withAddPrefix = parseProviderInputs('provider add {"name":"prefix-agent","command":"node"}')
    expect(withAddPrefix[0]?.name).toBe('prefix-agent')
    const withBareAdd = parseProviderInputs('add {"name":"bare-add-agent","command":"node"}')
    expect(withBareAdd[0]?.name).toBe('bare-add-agent')

    expect(() => parseProviderInputs([])).toThrowError(/不能为空/)
    expect(() => parseProviderInputs({ providers: [] })).toThrowError(/不能为空/)
  })
})

describe('registerStoredAcpProviders 生命周期', () => {
  function makeLifecycleEnv() {
    const root = tmpRoot()
    const store = new ProviderStore({ file: join(root, 'providers.json') })
    store.add({ name: 'p1', transport: 'stdio', command: 'node', protocol: 'acp' })
    store.add({ name: 'p2', transport: 'stdio', command: 'node', protocol: 'acp' })
    const lowLevelCalls: string[] = []
    const wrapperCalls: string[] = []
    return { root, store, lowLevelCalls, wrapperCalls }
  }

  it('按 provider 名隔离 disposers，remove 一个不影响另一个', () => {
    const env = makeLifecycleEnv()
    const result = registerStoredAcpProviders({
      providersFile: join(env.root, 'providers.json'),
      subagents: { registerProvider: (provider) => {
        const name = (provider as { name: string }).name
        env.lowLevelCalls.push(`register-${name}`)
        return () => { env.lowLevelCalls.push(`dispose-${name}`) }
      } },
      subprocess: { spawn: () => ({}) },
      registry: { register: (provider) => {
        const name = (provider as { id: string }).id
        env.wrapperCalls.push(`register-${name}`)
        return () => { env.wrapperCalls.push(`dispose-${name}`) }
      } },
    })

    expect(result.registered).toEqual(['p1', 'p2'])
    expect(Object.keys(result.disposersByName).sort()).toEqual(['p1', 'p2'])
    expect(result.disposersByName.p1).toHaveLength(2)
    expect(result.disposersByName.p2).toHaveLength(2)

    for (const dispose of [...(result.disposersByName.p1 ?? [])].reverse()) dispose()
    expect(env.wrapperCalls).toContain('dispose-p1')
    expect(env.lowLevelCalls).toContain('dispose-p1')
    expect(env.wrapperCalls).not.toContain('dispose-p2')
    expect(env.lowLevelCalls).not.toContain('dispose-p2')
  })

  it('registry 注册失败时回滚低层 provider，且不误报成功', () => {
    const env = makeLifecycleEnv()
    const result = registerStoredAcpProviders({
      providersFile: join(env.root, 'providers.json'),
      names: ['p1'],
      subagents: { registerProvider: (provider) => {
        const name = (provider as { name: string }).name
        env.lowLevelCalls.push(`register-${name}`)
        return () => { env.lowLevelCalls.push(`dispose-${name}`) }
      } },
      subprocess: { spawn: () => ({}) },
      registry: { register: () => { throw new Error('registry boom') } },
    })

    expect(result.registered).toEqual([])
    expect(result.failed[0]).toMatchObject({ name: 'p1' })
    expect(env.lowLevelCalls).toEqual(['register-p1', 'dispose-p1'])
  })
})

describe('/weave provider add/list/remove 命令', () => {
  function makeCommandEnv() {
    const root = tmpRoot()
    const hotCalls: string[] = []
    const removed: string[] = []
    const defs = createWeaveProviderCommandDefinitions({
      providersFile: join(root, 'providers.json'),
      hotRegister: (cfg) => { hotCalls.push(cfg.name); return null },
      onRemove: (name) => removed.push(name),
    })
    return { add: defs.add, manage: defs.manage, hotCalls, removed, store: new ProviderStore({ file: join(root, 'providers.json') }), root }
  }

  it('add-provider：JSON 成功持久化并热注册；坏 JSON 报 error 信封', async () => {
    const env = makeCommandEnv()
    const add = env.add!
    const ok = await add.handler('{"name":"agent7","transport":"stdio","command":"node","args":["a.js"],"protocol":"acp","declaredExtensions":["zcode"]}')
    expect(ok.kind).toBe('success')
    expect(ok.text).toContain('已注册执行器 agent7')
    expect(env.store.get('agent7')?.declaredExtensions).toEqual(['zcode'])
    expect(env.hotCalls).toContain('agent7')

    const bad = await add.handler('{ broken')
    expect(bad.kind).toBe('error')
    expect(env.store.get('agent8')).toBeUndefined()
  })

  it('add-provider：JSON 数组与 mcpServers 协议可一次注册多个', async () => {
    const env = makeCommandEnv()
    const add = env.add!
    const ok = await add.handler(
      '{"mcpServers":[{"name":"alpha","command":"node","args":["a.js"]},{"name":"beta","command":"python","args":["b.py"],"env":[{"name":"K","value":"v"}]}]}',
    )
    expect(ok.kind).toBe('success')
    expect(ok.text).toContain('已注册执行器 alpha')
    expect(ok.text).toContain('已注册执行器 beta')
    expect(env.store.get('alpha')?.command).toBe('node')
    expect(env.store.get('beta')?.env).toEqual({ K: 'v' })
    expect(env.hotCalls).toEqual(['alpha', 'beta'])

    const arr = await add.handler('[{"name":"gamma","command":"deno","args":["g.ts"]}]')
    expect(arr.kind).toBe('success')
    expect(env.store.get('gamma')?.args).toEqual(['g.ts'])
  })

  it('add-provider：真实 ZCode JSON 命令可保存，且容忍 add/provider add 前缀', async () => {
    const env = makeCommandEnv()
    const add = env.add!
    const raw = '{"name":"zcode","transport":"stdio","command":"node","args":["C:/work/project/weave/node_modules/zcode-acp-server/dist/index.js"],"env":{"ZCODE_BIN":"D:/Program Files/ZCode/resources/glm/zcode.cjs","ZCODE_NODE":"C:/Program Files/nodejs/node.exe"},"protocol":"acp","declaredExtensions":["zcode"]}'
    const ok = await add.handler(raw)
    expect(ok.kind).toBe('success')
    expect(env.store.get('zcode')?.declaredExtensions).toEqual(['zcode'])
    expect(env.store.get('zcode')?.args).toEqual(['C:/work/project/weave/node_modules/zcode-acp-server/dist/index.js'])

    const prefixed = await add.handler(`provider add ${raw}`)
    expect(prefixed.kind).toBe('success')
    expect(env.store.get('zcode')?.command).toBe('node')
  })

  it('list/remove 子命令；remove 未知名报错', async () => {
    const env = makeCommandEnv()
    const manage = env.manage!
    const emptyList = await manage.handler('list')
    expect(emptyList.text).toBe('（无动态 provider）')

    const add = env.add!
    await add.handler('name=p9 command=deno transport=stdio protocol=acp')

    const listed = await manage.handler('list')
    expect(listed.kind).toBe('success')
    expect(listed.text).toContain('- p9 command=deno')

    const ghost = await manage.handler('remove ghost')
    expect(ghost.kind).toBe('error')

    const removed = await manage.handler('remove p9')
    expect(removed.kind).toBe('success')
    expect(env.store.list()).toHaveLength(0)
  })
})
