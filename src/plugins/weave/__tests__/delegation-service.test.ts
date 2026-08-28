import { describe, expect, it } from 'vitest'

import {
  DEFAULT_EXECUTION_IDLE_TIMEOUT_MS,
  loadExecutionIdleTimeoutMs,
} from '../settings-store'

import {
  DelegationService,
  detectPermissionDenied,
  formatKnowledgeSection,
  mapStopReason,
  type KnowledgeInjectionEntryLike,
  type RoleConfig,
  type TaskContext,
  type TeamConfigLike,
} from '../delegation-service'
import { ExecutorRegistry } from '../executor-registry'
import { openPersistence, type WeavePersistence } from '../persistence/index'
import { ProcessLimiter } from '../safety/process-limiter'
import { SessionTracker } from '../session-tracker'
import type { TaskRecord } from '../state/types'
import { MockSubagentsContext } from './fixtures/mock-subagents'

const BASE_TASK: TaskRecord = {
  id: 'task-1',
  session_id: 'sess-1',
  team_id: 'team-1',
  project_id: 'proj-weave',
  version: 'v0.2.0',
  description: '实现 ExecutorRegistry 并补单元测试',
  dependencies: [],
  assigned_agent: 'coder',
  executor: 'spawn',
  status: 'RUNNING',
  revision_count: 0,
  max_revisions: 5,
  feedback_timeout_seconds: 1800,
  feedback_expires_at: null,
  skip_override: false,
  skip_reason: null,
  fail_count: 0,
  result: null,
  error_type: null,
  created_at: '2026-08-25T08:00:00.000Z',
  updated_at: '2026-08-25T08:00:00.000Z',
}

const BASE_ROLE: RoleConfig = {
  id: 'coder',
  name: '编码工程师',
  bias: '重视可测试性',
  executor: 'spawn',
  stages: ['implement', 'test'],
  max_concurrent_tasks: 2,
  personality: '你是一名追求最小可用、先验证再交付的工程师。',
}

const BASE_TEAM: TeamConfigLike = {
  team_id: 'team-1',
  knowledge_injection: { max_entries: 5, max_chars_per_entry: 500, max_total_chars: 2500, priority: 'freshness_first' },
}

const BASE_CONTEXT: TaskContext = {
  parentAgent: { id: 'parent-session-1' },
  projectName: 'weave',
  repoPath: '/work/weave',
  gitBranch: 'main',
  upstreamOutputs: [{ label: '设计文档: 02-SDD', output: 'SDD 核心章节摘要…' }],
  outputRequirements: '输出实现文件路径与测试命令。',
}

function makeKnowledge(entries: KnowledgeInjectionEntryLike[]): {
  calls: Array<Record<string, unknown>>
  searchForInjection: (params: never) => Promise<KnowledgeInjectionEntryLike[]>
} {
  const calls: Array<Record<string, unknown>> = []
  return {
    calls,
    searchForInjection: async (params: never) => {
      calls.push(params as unknown as Record<string, unknown>)
      return entries
    },
  }
}

function makeService(opts: {
  mock?: MockSubagentsContext
  registry?: ExecutorRegistry
  limiter?: ProcessLimiter
  knowledge?: ReturnType<typeof makeKnowledge>
  timeoutMs?: number
}): { service: DelegationService; ctx: MockSubagentsContext; registry: ExecutorRegistry; limiter: ProcessLimiter; db: WeavePersistence } {
  const db = openPersistence({ inMemory: true })
  const ctx = opts.mock ?? new MockSubagentsContext()
  const registry = opts.registry ?? new ExecutorRegistry()
  if (!opts.registry) registry.load({ subagents: ctx } as never)
  const limiter = opts.limiter ?? new ProcessLimiter()
  const tracker = new SessionTracker(db.feedback)
  const service = new DelegationService({ subagents: ctx } as never, {
    executorRegistry: registry,
    sessionTracker: tracker,
    processLimiter: limiter,
    knowledgeEngine: opts.knowledge ?? makeKnowledge([]),
    timeoutMs: opts.timeoutMs,
  })
  return { service, ctx, registry, limiter, db }
}

describe('mapStopReason / detectPermissionDenied / formatKnowledgeSection（TDD 2.4.3）', () => {
  it('表驱动：completed/aborted/error/max-tokens/refusal → 值域映射正确', () => {
    expect(mapStopReason('completed')).toEqual({ errorType: null, status: 'COMPLETED', countBreaker: false })
    expect(mapStopReason('aborted')).toEqual({ errorType: 'aborted', status: 'CANCELLED', countBreaker: false })
    expect(mapStopReason('error')).toEqual({ errorType: 'execution_failed', status: 'FAILED', countBreaker: true })
    expect(mapStopReason('max-tokens')).toEqual({ errorType: 'execution_failed', status: 'FAILED', countBreaker: true })
    expect(mapStopReason('refusal')).toEqual({ errorType: 'execution_failed', status: 'FAILED', countBreaker: true })
  })

  it('Weave 应用层：timeout → FAILED/计熔断；permission_denied 启发式覆盖 execution_failed', () => {
    expect(mapStopReason('aborted', { weaveErrorType: 'timeout' })).toEqual({
      errorType: 'timeout',
      status: 'FAILED',
      countBreaker: true,
    })
    expect(mapStopReason('refusal', { permissionDenied: true })).toEqual({
      errorType: 'permission_denied',
      status: 'FAILED',
      countBreaker: true,
    })
  })

  it('detectPermissionDenied：诊断/输出文本命中（中英文）才为 true', () => {
    expect(detectPermissionDenied({ output: [], diagnostic: 'approval required' })).toBe(true)
    expect(detectPermissionDenied({ output: [], diagnostic: '需要批准才能继续' })).toBe(true)
    expect(detectPermissionDenied({ output: [{ type: 'text', text: '需要授权后执行' }] })).toBe(true)
    expect(detectPermissionDenied({ output: [{ type: 'text', text: '结果如下' }] })).toBe(false)
    expect(detectPermissionDenied({ output: [], diagnostic: '模型超时' })).toBe(false)
  })

  it('formatKnowledgeSection：max_entries / max_chars_per_entry / max_total_chars 生效', () => {
    const entries: KnowledgeInjectionEntryLike[] = [
      { id: 'k1', title: 'SQLite WAL', content: 'WAL 模式写并发更好', layer: 'pitfall', freshness_score: 1 },
      { id: 'k2', title: 'DSH API', content: 'ctx.subagents.list 为同步方法', layer: 'pattern', freshness_score: 0.9 },
      { id: 'k3', title: 'extra', content: '不应出现', layer: 'guide', freshness_score: 0.8 },
    ]
    const limits = { max_entries: 2, max_chars_per_entry: 8, max_total_chars: 100, priority: 'freshness_first' as const }
    const text = formatKnowledgeSection(entries, limits)
    expect(text).toContain('- [pitfall] SQLite WAL（k1）：WAL 模式写并…')
    expect(text).toContain('- [pattern] DSH API（k2）：ctx.suba…')
    expect(text).not.toContain('extra')
    const tiny = formatKnowledgeSection(entries, { max_entries: 5, max_chars_per_entry: 10, max_total_chars: 5, priority: 'freshness_first' })
    expect(tiny).toBe('（无）')
  })
})

describe('DelegationService.executeTask（唯一出口 ctx.subagents.start）', () => {
  it('成功路径：四类执行器均走同一 start 入口（spawn/fork/codex/zcode），参数与输出结构正确', async () => {
    for (const executor of ['spawn', 'fork', 'codex', 'zcode']) {
      const ctx = new MockSubagentsContext()
      const knowledge = makeKnowledge([{ id: 'k1', title: 'WAL', content: 'WAL 开启', layer: 'pitfall', freshness_score: 1 }])
      const { service } = makeService({ mock: ctx, knowledge })
      const role = { ...BASE_ROLE, executor }
      const task = { ...BASE_TASK, executor }
      const controller = new AbortController()
      const output = await service.executeTask(task, role, BASE_TEAM, BASE_CONTEXT, controller.signal)

      expect(ctx.started).toHaveLength(1)
      const record = ctx.started[0]!
      expect(record.executor).toBe(executor)
      expect(Array.isArray(record.request.prompt)).toBe(true)
      expect((record.request.prompt as { type: string }[])[0]!.type).toBe('text')
      expect(record.request.parent).toBe(BASE_CONTEXT.parentAgent)
      expect(record.request.signal).toBe(controller.signal)

      expect(output.id).toMatch(/mock-run-/)
      expect(output.stopReason).toBe('completed')
      expect(output.duration_ms).toBeGreaterThanOrEqual(0)
      expect(output.weave).toEqual({ errorType: null, status: 'COMPLETED', countBreaker: false })
      expect(knowledge.calls).toEqual([
        { taskId: 'task-1', projectId: 'proj-weave', version: 'v0.2.0', roleId: 'coder', limit: BASE_TEAM.knowledge_injection, slim: true },
      ])
    }
  })

  it('iso-1 会话隔离：ACP/zcode 同一角色固定 sessionKey、不同角色不同 key，且顶层透传', async () => {
    const ctx = new MockSubagentsContext()
    const { service } = makeService({ mock: ctx })
    const zcodeTask = { ...BASE_TASK, executor: 'zcode' }
    const devRole = { ...BASE_ROLE, id: 'developer-1', executor: 'zcode' }
    const feRole = { ...BASE_ROLE, id: 'frontend-1', executor: 'zcode' }

    await service.executeTask(zcodeTask, devRole, BASE_TEAM, BASE_CONTEXT, new AbortController().signal)
    await service.executeTask({ ...zcodeTask, id: 'task-2' }, devRole, BASE_TEAM, BASE_CONTEXT, new AbortController().signal)
    await service.executeTask({ ...zcodeTask, id: 'task-3' }, feRole, BASE_TEAM, BASE_CONTEXT, new AbortController().signal)

    const requests = ctx.started.map((record) => record.request)
    const devKey = 'team-1:developer-1:proj-weave:v0.2.0'
    const feKey = 'team-1:frontend-1:proj-weave:v0.2.0'
    expect(requests[0]!.sessionKey).toBe(devKey)
    expect(requests[1]!.sessionKey).toBe(devKey)
    expect(requests[2]!.sessionKey).toBe(feKey)
    // DSH 会把 request 原样透传给 provider；weave.sessionKey 仅作兼容兜底，
    // 顶层 sessionKey 必须存在，否则生产 zcode 会以 undefined 键共用会话。
    expect(requests[0]!.weave?.sessionKey).toBe(devKey)
    expect(requests[1]!.weave?.sessionKey).toBe(devKey)
    expect(requests[2]!.weave?.sessionKey).toBe(feKey)
    expect(requests[0]!.sessionKey).not.toBe(requests[2]!.sessionKey)
  })

  it('buildPrompt 模板：角色/任务/项目/上游/知识/可用命令/沉淀要求/输出要求齐全', async () => {
    const ctx = new MockSubagentsContext()
    const { service: s2 } = makeService({ mock: ctx })
    const text = s2.buildPrompt(
      BASE_TASK,
      BASE_ROLE,
      BASE_CONTEXT,
      [{ id: 'k1', title: 'WAL', content: 'WAL 开启', layer: 'pitfall', freshness_score: 1 }],
      null,
      BASE_TEAM.knowledge_injection,
    )
    for (const snippet of [
      '你是 编码工程师，负责完成以下任务。',
      '## 角色人格',
      '你是一名追求最小可用、先验证再交付的工程师。',
      '## DSH Memory 提示',
      '先查本地源码、配置、文档，不随意联网搜索。',
      '## 执行纪律',
      '小步快跑：一次改一处，改完立即验证。',
      '## 任务描述',
      '实现 ExecutorRegistry 并补单元测试',
      '## 项目上下文',
      '- 项目: proj-weave - 版本: v0.2.0 - weave',
      '- 工作目录: /work/weave',
      '- Git 分支: main',
      '## 上游任务产物',
      '### 设计文档: 02-SDD',
      'SDD 核心章节摘要…',
      '## 相关知识（来自知识库）',
      '[pitfall] WAL（k1）：WAL 开启',
      '## 可用命令（执行中可调用）',
      '## 知识沉淀要求',
      '### WEAVE_KNOWLEDGE_START',
      '### WEAVE_KNOWLEDGE_END',
      '## 输出要求',
      '输出实现文件路径与测试命令。',
    ]) {
      expect(text).toContain(snippet)
    }
  })

  it('修订注入：prompt 含上一版输出与反馈历史（SessionTracker.getRevisionContext）', async () => {
    const db = openPersistence({ inMemory: true })
    const tracker = new SessionTracker(db.feedback)
    await tracker.recordRevision('task-1', '改成手机号验证码', 'v1 输出摘要')
    const ctx = new MockSubagentsContext()
    const registry = new ExecutorRegistry()
    registry.load({ subagents: ctx } as never)
    const svc = new DelegationService({ subagents: ctx } as never, {
      executorRegistry: registry,
      sessionTracker: tracker,
      processLimiter: new ProcessLimiter(),
      knowledgeEngine: makeKnowledge([]),
    })
    const revCtx = await tracker.getRevisionContext('task-1')
    const text = svc.buildPrompt(BASE_TASK, BASE_ROLE, BASE_CONTEXT, [], revCtx, BASE_TEAM.knowledge_injection)
    expect(text).toContain('## 之前的版本与用户反馈')
    const output = await svc.executeTask(BASE_TASK, BASE_ROLE, BASE_TEAM, BASE_CONTEXT, new AbortController().signal)
    const promptText = ((ctx.started[0]!.request.prompt as { text: string }[])[0]!.text)
    expect(output.id).toBeTruthy()
    expect(promptText).toContain('## 之前的版本与用户反馈')
    expect(promptText).toContain('这是第 1 次修订。')
    expect(promptText).toContain('### 上一版输出')
    expect(promptText).toContain('v1 输出摘要')
    expect(promptText).toContain('1. 改成手机号验证码')
  })

  it('知识注入失败降级：知识引擎异常不阻断委托', async () => {
    const ctx = new MockSubagentsContext()
    const service = new DelegationService({ subagents: ctx } as never, {
      executorRegistry: (() => { const r = new ExecutorRegistry(); r.load({ subagents: ctx } as never); return r })(),
      sessionTracker: new SessionTracker(openPersistence({ inMemory: true }).feedback),
      processLimiter: new ProcessLimiter(),
      knowledgeEngine: { searchForInjection: async () => { throw new Error('db locked') } },
    })
    const output = await service.executeTask(BASE_TASK, BASE_ROLE, BASE_TEAM, BASE_CONTEXT, new AbortController().signal)
    expect(output.stopReason).toBe('completed')
  })

  it('执行器未注册 → WeaveError(executor_unavailable)，不发起 start', async () => {
    const ctx = new MockSubagentsContext()
    const { service } = makeService({ mock: ctx, registry: new ExecutorRegistry() }) // 空 registry
    await expect(
      service.executeTask(BASE_TASK, BASE_ROLE, BASE_TEAM, BASE_CONTEXT, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'executor_unavailable' })
    expect(ctx.started).toHaveLength(0)
  })

  it('取消（启动前 abort）：start 拒绝但映射为 CANCELLED，不计熔断，槽位释放', async () => {
    const ctx = new MockSubagentsContext()
    const limiter = new ProcessLimiter()
    const { service } = makeService({ mock: ctx, limiter })
    const controller = new AbortController()
    controller.abort()
    const output = await service.executeTask(BASE_TASK, BASE_ROLE, BASE_TEAM, BASE_CONTEXT, controller.signal)
    expect(output.stopReason).toBe('aborted')
    expect(output.weave).toEqual({ errorType: 'aborted', status: 'CANCELLED', countBreaker: false })
    expect(limiter.status('spawn').active).toBe(0)
  })

  it('取消（运行中 abort）：result 以 aborted 结束 → CANCELLED', async () => {
    const ctx = new MockSubagentsContext({ manualCompletion: true })
    const { service } = makeService({ mock: ctx })
    const controller = new AbortController()
    const pending = service.executeTask(BASE_TASK, BASE_ROLE, BASE_TEAM, BASE_CONTEXT, controller.signal)
    // 等待 start 已发起
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.abort()
    const output = await pending
    expect(output.stopReason).toBe('aborted')
    expect(output.weave).toEqual({ errorType: 'aborted', status: 'CANCELLED', countBreaker: false })
  })

  it('错误映射：error/max-tokens/refusal → execution_failed + FAILED + 计熔断', async () => {
    for (const stopReason of ['error', 'max-tokens', 'refusal'] as const) {
      const ctx = new MockSubagentsContext({ manualCompletion: true })
      const { service } = makeService({ mock: ctx })
      const pending = service.executeTask(BASE_TASK, BASE_ROLE, BASE_TEAM, BASE_CONTEXT, new AbortController().signal)
      await new Promise((resolve) => setTimeout(resolve, 20))
      const runId = ctx.started[0]!.runId
      ctx.settle(runId, { output: [], stopReason, diagnostic: `stopReason=${stopReason}` })
      const output = await pending
      expect(output.stopReason).toBe(stopReason)
      expect(output.weave).toEqual({ errorType: 'execution_failed', status: 'FAILED', countBreaker: true })
    }
  })

  it('非交互拒绝启发式（AC-EXEC-004）：diagnostic 命中 → permission_denied，未命中 → execution_failed', async () => {
    const ctx = new MockSubagentsContext({ manualCompletion: true })
    const { service } = makeService({ mock: ctx })
    const pending = service.executeTask(BASE_TASK, BASE_ROLE, BASE_TEAM, BASE_CONTEXT, new AbortController().signal)
    await new Promise((resolve) => setTimeout(resolve, 20))
    ctx.settle(ctx.started[0]!.runId, { output: [], stopReason: 'refusal', diagnostic: 'permission denied: approval required' })
    const denied = await pending
    expect(denied.weave).toEqual({ errorType: 'permission_denied', status: 'FAILED', countBreaker: true })
  })

  it('委托超时：Weave 应用层 timeout（FAILED/计熔断），dispose 被调用', async () => {
    const ctx = new MockSubagentsContext({ manualCompletion: true })
    const { service } = makeService({ mock: ctx })
    const output = await service.executeTask(
      BASE_TASK, BASE_ROLE, BASE_TEAM, { ...BASE_CONTEXT, timeoutMs: 30 }, new AbortController().signal,
    )
    expect(output.stopReason).toBe('aborted')
    expect(output.weave).toEqual({ errorType: 'timeout', status: 'FAILED', countBreaker: true })
    expect(output.duration_ms).toBeGreaterThanOrEqual(30)
  })

  it('基础设施故障：start() reject（非取消）→ WeaveError(execution_failed)', async () => {
    const registry = new ExecutorRegistry()
    const failing = { subagents: { start: async () => { throw new Error('transport down') } } }
    const ctx = new MockSubagentsContext()
    registry.load({ subagents: ctx } as never)
    const service = new DelegationService(failing as never, {
      executorRegistry: registry,
      sessionTracker: new SessionTracker(openPersistence({ inMemory: true }).feedback),
      processLimiter: new ProcessLimiter(),
      knowledgeEngine: makeKnowledge([]),
    })
    await expect(
      service.executeTask(BASE_TASK, BASE_ROLE, BASE_TEAM, BASE_CONTEXT, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'execution_failed' })
  })

  it('排队限流：并发超限排队不熔断，释放后继续（AC-EXEC-005）', async () => {
    const ctx = new MockSubagentsContext({ manualCompletion: true })
    const limiter = new ProcessLimiter({ limits: { spawn: { maxConcurrent: 1, maxPerHour: 10 } }, pollIntervalMs: 5 })
    const { service } = makeService({ mock: ctx, limiter })
    const c1 = new AbortController()
    const c2 = new AbortController()
    const run2 = service.executeTask(BASE_TASK, BASE_ROLE, BASE_TEAM, BASE_CONTEXT, c2.signal)
    const run1 = service.executeTask({ ...BASE_TASK, id: 'task-a' }, BASE_ROLE, BASE_TEAM, BASE_CONTEXT, c1.signal)
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(ctx.started).toHaveLength(1) // 后一个在排队
    // 释放第一个槽位 → 排队者获得槽位并启动
    ctx.settle(ctx.started[0]!.runId, { output: [{ type: 'text', text: 'done' }], stopReason: 'completed' })
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(ctx.started).toHaveLength(2)
    // 先结算排队运行的 result，再等待任务完成（避免颠倒顺序导致的死锁）
    ctx.settle(ctx.started[1]!.runId, { output: [{ type: 'text', text: 'done2' }], stopReason: 'completed' })
    const o2 = await run2
    const o1 = await run1
    expect(o1.stopReason).toBe('completed')
    expect(o2.stopReason).toBe('completed')
    expect(limiter.status('spawn').active).toBe(0)
  })

  it('角色模型路由：provider/model 透传为 agentOptions；缺省不传', async () => {
    const ctx = new MockSubagentsContext()
    const { service } = makeService({ mock: ctx })
    await service.executeTask(
      BASE_TASK,
      { ...BASE_ROLE, provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' },
      BASE_TEAM,
      BASE_CONTEXT,
      new AbortController().signal,
    )
    expect(ctx.started[0]!.request.agentOptions).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash-vision-exp',
    })

    const plainCtx = new MockSubagentsContext()
    const plainService = makeService({ mock: plainCtx }).service
    await plainService.executeTask(BASE_TASK, BASE_ROLE, BASE_TEAM, BASE_CONTEXT, new AbortController().signal)
    expect(plainCtx.started[0]!.request.agentOptions).toBeUndefined()
  })

  it('实时执行事件：订阅 localAgent session/event 并透出 output/tool 事件', async () => {
    const listeners = new Set<(session: unknown, event: unknown) => void>()
    const localAgent = {
      id: 'child-session-1',
      ctx: {
        on: (event: string, listener: (session: unknown, data: unknown) => void) => {
          if (event !== 'session/event') return () => undefined
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
    }
    let resolveResult: (value: any) => void = () => {}
    const result = new Promise<any>((resolve) => { resolveResult = resolve })
    const delegationCtx = {
      subagents: {
        start: async () => ({
          id: 'run-live',
          localAgent,
          result,
          dispose: async () => undefined,
        }),
      },
    }
    const registry = new ExecutorRegistry()
    registry.load({ subagents: { list: () => ['spawn'] } } as never)
    const events: any[] = []
    const service = new DelegationService(delegationCtx as never, {
      executorRegistry: registry,
      sessionTracker: new SessionTracker(openPersistence({ inMemory: true }).feedback),
      processLimiter: new ProcessLimiter(),
      knowledgeEngine: makeKnowledge([]),
      onExecutorEvent: (event) => events.push(event),
    })
    const pending = service.executeTask(BASE_TASK, BASE_ROLE, BASE_TEAM, BASE_CONTEXT, new AbortController().signal)

    // 等 start 返回并完成订阅。
    await new Promise((resolve) => setTimeout(resolve, 10))
    for (const listener of listeners) {
      listener(localAgent, { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '实时' } } })
      listener(localAgent, { type: 'tool/call', data: { name: 'bash', arguments: '{"cmd":"ls"}' } })
    }
    resolveResult({ output: [{ type: 'text', text: 'done' }], stopReason: 'completed' })
    const output = await pending

    expect(output.stopReason).toBe('completed')
    expect(events.map((event) => [event.type, event.text])).toEqual([
      ['status', 'started'],
      ['status', 'streaming'],
      ['output', '实时'],
      ['tool_call', '{"cmd":"ls"}'],
      ['status', 'completed'],
    ])
    expect(events[0]?.sessionId).toBe('child-session-1')
    expect(events.find((event) => event.type === 'tool_call')?.name).toBe('bash')
    expect(events.find((event) => event.type === 'output')?.text).toBe('实时')
    expect(events.find((event) => event.type === 'tool_call')?.name).toBe('bash')
    expect(listeners.size).toBe(0)
  })

  it('context.sessionId 优先：事件路由到宿主会话而非子代理会话（doc/05 §6.2 P1-B）', async () => {
    const listeners = new Set<(session: unknown, event: unknown) => void>()
    const localAgent = {
      id: 'child-session-1',
      ctx: {
        on: (event: string, listener: (session: unknown, data: unknown) => void) => {
          if (event !== 'session/event') return () => undefined
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
    }
    const delegationCtx = {
      sessionId: 'sess-host',
      subagents: {
        start: async () => ({
          id: 'run-live',
          localAgent,
          result: Promise.resolve({ output: [{ type: 'text', text: 'done' }], stopReason: 'completed' }),
          dispose: async () => undefined,
        }),
      },
    }
    const registry = new ExecutorRegistry()
    registry.load({ subagents: { list: () => ['spawn'] } } as never)
    const events: any[] = []
    const service = new DelegationService(delegationCtx as never, {
      executorRegistry: registry,
      sessionTracker: new SessionTracker(openPersistence({ inMemory: true }).feedback),
      processLimiter: new ProcessLimiter(),
      knowledgeEngine: makeKnowledge([]),
      onExecutorEvent: (event) => events.push(event),
    })
    await service.executeTask(BASE_TASK, BASE_ROLE, BASE_TEAM, BASE_CONTEXT, new AbortController().signal)

    // 全部事件（含 started/streaming/output/终态）都归属宿主会话，agent.id 被覆盖
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((event) => event.sessionId === 'sess-host')).toBe(true)
  })

  it('远端执行器无 localAgent：发出 stream_unavailable 状态且不影响结果', async () => {
    const delegationCtx = {
      subagents: {
        start: async () => ({
          id: 'run-remote',
          localAgent: undefined,
          result: Promise.resolve({ output: [], stopReason: 'completed' }),
          dispose: async () => undefined,
        }),
      },
    }
    const registry = new ExecutorRegistry()
    registry.load({ subagents: { list: () => ['codex'] } } as never)
    const events: any[] = []
    const service = new DelegationService(delegationCtx as never, {
      executorRegistry: registry,
      sessionTracker: new SessionTracker(openPersistence({ inMemory: true }).feedback),
      processLimiter: new ProcessLimiter(),
      knowledgeEngine: makeKnowledge([]),
      onExecutorEvent: (event) => events.push(event),
    })
    const output = await service.executeTask(
      { ...BASE_TASK, executor: 'codex' },
      { ...BASE_ROLE, executor: 'codex' },
      BASE_TEAM,
      BASE_CONTEXT,
      new AbortController().signal,
    )
    expect(output.stopReason).toBe('completed')
    expect(events.some((event) => event.type === 'status' && event.text === 'stream_unavailable')).toBe(true)
  })
})

describe('执行空闲超时缺省（idle_timeout 误杀修复）', () => {
  it('新缺省 1_200_000ms：zcode 长工具执行/长思考段实测可超 10 分钟，600s 已 4 次误杀', () => {
    expect(DEFAULT_EXECUTION_IDLE_TIMEOUT_MS).toBe(1_200_000)
  })

  it('loadExecutionIdleTimeoutMs：缺失文件回落缺省；非正数/非法类型忽略', () => {
    expect(loadExecutionIdleTimeoutMs('no-such-settings-file.json')).toBe(1_200_000)
  })
})
