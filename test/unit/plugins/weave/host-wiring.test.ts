import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Plugin } from '@deepseek-ai/cordis'

import { AuditLog } from '../../../../src/plugins/weave/audit/audit-log'
import { CircuitBreaker } from '../../../../src/plugins/weave/safety/circuit-breaker'
import { DagRepository } from '../../../../src/plugins/weave/dag/repository'
import { ExecutorRegistry } from '../../../../src/plugins/weave/executors/executor-registry'
import { FeedbackRouter } from '../../../../src/plugins/weave/scheduling/feedback-router'
import { KnowledgeReviewService } from '../../../../src/plugins/weave/knowledge/knowledge-review'
import { KnowledgeStore } from '../../../../src/plugins/weave/knowledge/knowledge-model'
import {
  buildWeaveToolDefinitions,
  registerWeaveHost,
  registerWeaveCommand,
  toJsonPropertySpec,
  tokenizeCommandLine,
  type HostCommandRuntime,
  type HostCommandDefinition,
  type HostCommandInvocation,
  type HostCommandResult,
  type HostToolRuntime,
} from '../../../../src/plugins/weave/host/host-wiring'
import { WeaveMcp } from '../../../../src/plugins/weave/host/cli-mcp'
import type { CliMcpDeps } from '../../../../src/plugins/weave/host/cli-mcp'
import { openPersistence, type WeavePersistence } from '../../../../src/plugins/weave/persistence/index'
import { SessionTracker } from '../../../../src/plugins/weave/scheduling/session-tracker'
import { TeamManager } from '../../../../src/plugins/weave/team/team-manager.js'
import * as weavePlugin from '../../../../src/plugins/weave/index'

/**
 * P0-PLUGIN-WIRE（t37）集成测试：插件入口接线契约。
 * - apply 后 registerWeaveHost(ctx, deps) 可构建 WeaveMcp/WeaveCli 并挂载到 ctx.weave；
 * - 宿主 ctx.tools 存在时，weave_* 工具注册成功且可执行核心命令；无 ctx.tools 时走服务导出契约；
 * - dispose 幂等、不与既有 WeaveService 兼容性冲突。
 */

const GOOD_TEAM = `schema_version: "1"
team_id: alpha-squad
name: 阿尔法团队
default: true

roles:
  - id: coder
    bias: dev
    executor: zcode
    stages: [execute]
    max_concurrent_tasks: 2

task_decomposition:
  matchers:
    - pattern: "修复|调整"
      difficulty: easy
  default_difficulty: easy
  dag_templates:
    easy: ["execute"]

knowledge_injection:
  max_entries: 5
  max_chars_per_entry: 500
  max_total_chars: 2500
  priority: freshness_first
`

interface Env {
  ctx: Context
  p: WeavePersistence
  rootDir: string
  deps: CliMcpDeps
  kstore: KnowledgeStore
  close: () => void
}

/** 队长模式下 MCP 层不再创建任务；种子一条单任务 WAITING 行供治理命令使用。 */
async function seedHostTask(
  persistence: import('../../../../src/plugins/weave/persistence/index').WeavePersistence,
  projectId: string,
): Promise<{ dagId: string; taskId: string }> {
  const now = new Date().toISOString()
  const dagId = `dag-${projectId}-v1-hostseed`
  const taskId = `${dagId}-t1`
  await persistence.tasks.run((db) => {
    db.prepare(
      `INSERT INTO dags (dag_id, team_id, project_id, version, difficulty, status, created_at, updated_at)
       VALUES (?, 'alpha-squad', ?, 'v1', 'hard', 'created', ?, ?)`,
    ).run(dagId, projectId, now, now)
    db.prepare(
      `INSERT INTO tasks (id, dag_id, session_id, team_id, project_id, version, description, stage,
       dependencies, assigned_agent, executor, status, revision_count, max_revisions,
       feedback_timeout_seconds, feedback_expires_at, skip_override, skip_reason, fail_count,
       result, error_type, created_at, updated_at)
       VALUES (?, ?, 'host-session', 'alpha-squad', ?, 'v1', '修复登录超时', '', '[]', 'coder', 'zcode', 'WAITING',
       0, 5, 1800, NULL, 0, NULL, 0, NULL, NULL, ?, ?)`,
    ).run(taskId, dagId, projectId, now, now)
  })
  return { dagId, taskId }
}

const envs: Env[] = []
afterAll(() => {
  for (const env of envs) env.close()
})

async function newEnv(): Promise<Env> {
  const rootDir = mkdtempSync(join(tmpdir(), 'weave-host-'))
  writeFileSync(join(rootDir, 'alpha-squad.yaml'), GOOD_TEAM)
  const p = openPersistence({ inMemory: true })
  const registry = new ExecutorRegistry()
  // 最小执行器：注册一个假 provider（registry 只做分类/校验）
  registry.load(({ subagents: { list: () => ['zcode'] } }) as never)
  const tracker = new SessionTracker(p.feedback)
  const router = new FeedbackRouter({ tasks: p.tasks, feedback: p.feedback, sessionTracker: tracker })
  const kstore = new KnowledgeStore({ rootDir: join(rootDir, 'knowledge'), metaDb: p.knowledgeMeta })
  const kreview = new KnowledgeReviewService({ knowledge: kstore, audit: new AuditLog({ dir: join(rootDir, 'audit') }) })
  const ctx = new Context()
  const plugin = weavePlugin as unknown as Plugin
  const fiber = ctx.plugin(plugin)
  await fiber
  const deps = {
    persistence: p,
    teamManager: new TeamManager(registry, { teamsDir: rootDir, persistence: p }),
    executorRegistry: registry,
    feedbackRouter: router,
    dagRepository: new DagRepository(p),
    knowledgeReview: kreview,
    knowledgeStore: kstore,
    circuitBreaker: new CircuitBreaker(),
  }
  const env: Env = {
    ctx,
    p,
    rootDir,
    deps,
    kstore,
    close: () => {
      p.close()
      rmSync(rootDir, { recursive: true, force: true })
    },
  }
  envs.push(env)
  return env
}

describe('P0-PLUGIN-WIRE｜插件入口接线', () => {
  it('apply 后 registerWeaveHost 构建 WeaveMcp/WeaveCli 并挂载 ctx.weave（服务导出契约）', async () => {
    const env = await newEnv()
    const ctx = env.ctx as Context & { weave?: { mcp?: unknown; cli?: unknown } }
    expect(ctx.weave).toBeDefined()
    const bundle = registerWeaveHost(ctx, env.deps)
    // 裸 Context 无 ctx.tools → 仅服务导出，不注册工具
    expect(bundle.registration.hasToolRuntime).toBe(false)
    expect(bundle.registration.registered).toEqual([])
    expect(bundle.mcp).toBeDefined()
    expect(bundle.cli).toBeDefined()
    expect(ctx.weave?.mcp).toBe(bundle.mcp)
    expect(ctx.weave?.cli).toBe(bundle.cli)
    bundle.dispose()
    expect(ctx.weave?.mcp).toBeUndefined() // dispose 幂等且清理挂载
    bundle.dispose() // 二次调用不抛
  })

  it('宿主 ctx.tools 存在时注册全部 22 个 weave_* 工具，核心命令可执行', async () => {
    const env = await newEnv()
    const ctx = env.ctx as Context & { weave?: { mcp?: unknown } }
    const registered: Array<{ def: unknown; unregister: () => void }> = []
    const toolRuntime: HostToolRuntime = {
      register: (def) => {
        const entry = { def, unregister: () => undefined }
        registered.push(entry)
        return () => {
          const idx = registered.indexOf(entry)
          if (idx >= 0) registered.splice(idx, 1)
        }
      },
    }
    ;(ctx as unknown as { tools: HostToolRuntime }).tools = toolRuntime

    const bundle = registerWeaveHost(ctx, env.deps)
    expect(bundle.registration.hasToolRuntime).toBe(true)
    const names = bundle.registration.registered
    expect(names).toEqual([
      'weave_plan_tasks',
      'weave_get_status',
      'weave_revise_task',
      'weave_accept_task',
      'weave_team_list',
      'weave_team_switch',
      'weave_executor_list',
      'weave_knowledge_search',
      'weave_knowledge_review',
      'weave_knowledge_approve',
      'weave_knowledge_reject',
      'weave_task_retry',
      'weave_task_skip',
      'weave_task_cancel',
      'weave_task_reopen',
      'weave_wait_dag_change',
      'weave_ban_list',
      'weave_graph_build',
      'weave_graph_query',
      'weave_graph_path',
      'weave_graph_explain',
      'weave_graph_affected',
      'weave_document_convert',
      'weave_obsidian_generate',
      'weave_obsidian_open',
      'weave_obsidian_reindex',
      'weave_obsidian_status',
      'weave_obsidian_conflicts',
    ])
    expect(registered).toHaveLength(28)

    // weave_plan_tasks 不注入回调时应明确报错（下发路径必须显式接线）
    const planDef = registered.find((r) => (r.def as { name: string }).name === 'weave_plan_tasks')!.def as {
      execute: (args: Record<string, unknown>, exec?: unknown) => Promise<unknown>
    }
    await expect(planDef.execute({ tasks: [] })).rejects.toMatchObject(/configuration_error/)

    // 工具注销后注册表清空
    bundle.dispose()
    expect(registered).toHaveLength(0)
    expect(bundle.registration.unregister).toBeTypeOf('function')
  })

  it('options.planTasks 注入后：planTasks 工具全链路可用（回调→返回摘要）', async () => {
    const env = await newEnv()
    const planCalls: Array<Record<string, unknown>> = []
    const planTasks = async (args: unknown) => {
      planCalls.push(args as Record<string, unknown>)
      return { dag_id: 'dag-stub-1', session_id: 's1', team_id: 't', team_name: 'n', goal: null, appended: false, tasks: [] }
    }
    const bundle = registerWeaveHost(env.ctx, env.deps, { planTasks })
    const def = buildWeaveToolDefinitions(bundle.mcp, { planTasks }).find((d) => d.name === 'weave_plan_tasks')!
    const out = (await def.execute({ tasks: [{ description: 'x', assignee: 'coder' }] }, { agent: { id: 'sess' } })) as { dag_id: string }
    expect(out.dag_id).toBe('dag-stub-1')
    expect(planCalls).toHaveLength(1)

    // 未注入 planTasks 时：明确 configuration_error，不静默假装可用
    const bare = registerWeaveHost(env.ctx, env.deps)
    const bareDef = buildWeaveToolDefinitions(bare.mcp).find((d) => d.name === 'weave_plan_tasks')!
    await expect(bareDef.execute({}, undefined)).rejects.toMatchObject(/configuration_error/)
  })

  it('队长执行纪律双通道提示：工具描述与返回汇总均含七条纪律；append_to 参数已暴露（doc/05 §7）', async () => {
    const defs = buildWeaveToolDefinitions({} as never, {})
    const def = defs.find((d) => d.name === 'weave_plan_tasks')!
    // 通道一：工具描述（精简版，关键词齐全）
    for (const keyword of ['不得结束', '通报进度', '长阻塞', '交付物', 'retry/cancel', 'append_to', '15 秒级', '质量分层']) {
      expect(def.description).toContain(keyword)
    }
    // 通道二：返回汇总 render 追加完整纪律块（单一来源 CAPTAIN_DISCIPLINE；JSON 主体保持完整）
    const rendered = def.output.render({}, { dag_id: 'd1', appended: false }) as Array<{ type: string; text: string }>
    const text = rendered[0]!.text
    expect(rendered[0]!.type).toBe('text')
    expect(text).toContain('"dag_id": "d1"')
    expect(text).toContain('## 队长执行纪律')
    for (let i = 1; i <= 7; i += 1) {
      expect(text).toContain(`${i}. `)
    }
    expect(text).toContain('append_to 增量追加到当前任务组')
    expect(text).toContain('非用户明确要求，禁止新建任务组')
    expect(text).toContain('先读团队人员配置')
    expect(text).toContain('禁止长期只用子集')
    // 第 1 条措辞强化（必须值守，不得擅自结束回合）
    expect(text).toContain('有在途任务时必须值守')
    expect(text).toContain('不得擅自结束会话回合')
    // 第 2 条措辞强化（15 秒级高频轮询 + 一变即通报 + 用户消息优先，禁止延迟汇报）
    expect(text).toContain('值守期间必须高频轮询（15 秒级）并及时响应')
    expect(text).toContain('任务状态一变即向用户通报')
    expect(text).toContain('用户消息优先处理')
    expect(text).toContain('禁止延迟汇报')
    // 第 7 条质量分层（常规任务 QA 不前置，重大任务块才提前介入）
    expect(text).toContain('质量分层：常规任务由开发自测与测试（tester）覆盖，QA 只做终审收口')
    expect(text).toContain('重大任务块（跨模块/架构级/高风险）可让 QA 提前介入评审')
    expect(text).toContain('禁止每个任务都派 QA 审核')
    // append_to 参数已进 schema（第⑤条可执行的前提）
    expect((def.parameters as Record<string, unknown>).append_to).toBeDefined()
  })

  it('weave_team_switch 缺省 session_id 经 options.resolveSessionId 从 exec 解析（显式 > exec > cli-session）', async () => {
    const calls: Array<{ team_id: string; session_id?: string }> = []
    const mcpStub = {
      teamSwitch: async (input: { team_id: string; session_id?: string }) => {
        calls.push(input)
        return { session_id: input.session_id ?? 'cli-session', team_id: input.team_id }
      },
    } as unknown as WeaveMcp
    const defs = buildWeaveToolDefinitions(mcpStub, {
      resolveSessionId: (exec) => (exec as { agent?: { id?: string } } | undefined)?.agent?.id,
    })
    const def = defs.find((d) => d.name === 'weave_team_switch')!

    // 缺省：从 exec.agent 解析宿主会话 id，不落假 id
    await def.execute({ team_id: 'alpha-squad' }, { agent: { id: 'sess-host-1' } })
    // 空串 session_id 视为缺省，同样走 exec 解析
    await def.execute({ team_id: 'alpha-squad', session_id: '' }, { agent: { id: 'sess-host-2' } })
    // 显式 session_id 永远优先
    await def.execute({ team_id: 'alpha-squad', session_id: 'explicit-1' }, { agent: { id: 'sess-host-3' } })
    // 无 exec（纯 CLI）：原样透传，由 mcp 层兜底 cli-session
    await def.execute({ team_id: 'alpha-squad' }, undefined)

    expect(calls[0]).toEqual({ team_id: 'alpha-squad', session_id: 'sess-host-1' })
    expect(calls[1]).toEqual({ team_id: 'alpha-squad', session_id: 'sess-host-2' })
    expect(calls[2]).toEqual({ team_id: 'alpha-squad', session_id: 'explicit-1' })
    expect(calls[3]).toEqual({ team_id: 'alpha-squad' })
  })

  it('buildWeaveToolDefinitions 28 个定义：名称齐全且每个具 execute/description/parameters', async () => {
    const env = await newEnv()
    const bundle = registerWeaveHost(env.ctx, env.deps)
    const defs = buildWeaveToolDefinitions(bundle.mcp)
    expect(defs).toHaveLength(28)
    for (const d of defs) {
      expect(d.name).toMatch(/^weave_/)
      expect(d.description.length).toBeGreaterThan(0)
      expect(d.parameters).toBeDefined()
      expect(typeof d.execute).toBe('function')
    }
    const names = defs.map((d) => d.name)
    for (const n of [
      'weave_knowledge_search', 'weave_knowledge_review', 'weave_knowledge_approve', 'weave_knowledge_reject',
      'weave_task_retry', 'weave_task_skip', 'weave_task_cancel', 'weave_task_reopen',
      'weave_wait_dag_change',
      'weave_ban_list', 'weave_graph_build', 'weave_graph_query', 'weave_graph_path',
      'weave_graph_explain', 'weave_graph_affected', 'weave_document_convert',
      'weave_obsidian_generate', 'weave_obsidian_open', 'weave_obsidian_reindex',
      'weave_obsidian_status', 'weave_obsidian_conflicts',
    ]) {
      expect(names).toContain(n)
    }
  })

  it('新增工具冒烟：knowledge_review/approve、ban_list、task_cancel/retry 可执行', async () => {
    const env = await newEnv()
    const bundle = registerWeaveHost(env.ctx, env.deps)
    const def = (n: string): { execute: (args: Record<string, unknown>, exec?: unknown) => Promise<unknown> } =>
      buildWeaveToolDefinitions(bundle.mcp).find((d) => d.name === n)!

    // 1) knowledge_review：空队列
    const rv = (await def('weave_knowledge_review').execute({})) as { candidates: unknown[] }
    expect(rv.candidates).toEqual([])

    // 2) knowledge_approve：创建 candidate → approve → active
    const cand = await env.kstore.createCandidate({
      layer: 'shared',
      scope: {},
      filename: 't39.md',
      frontmatter: { title: 't39知识', type: 'pitfall', visibility: 'global', tags: ['t39'] },
      body: '正文 t39',
    })
    const candId = cand.id
    const approved = (await def('weave_knowledge_approve').execute({ knowledge_id: candId })) as { status: string }
    expect(approved.status).toBe('active')

    // 2.5) knowledge_search：按需检索到刚转正的 active 知识
    const searched = (await def('weave_knowledge_search').execute({ query: 't39' })) as { total_hits: number; results: Array<{ id: string }> }
    expect(searched.total_hits).toBeGreaterThan(0)
    expect(searched.results.some((r) => r.id === candId)).toBe(true)

    // 3) ban_list：无熔断 → 空清单
    const bans = (await def('weave_ban_list').execute({})) as { bans: unknown[] }
    expect(bans.bans).toEqual([])

    // 4) task_cancel / task_retry：种子任务 → 取消（WAITING→CANCELLED）→ 重试回 WAITING
    const seededP2 = await seedHostTask(env.deps.persistence, 'p2')
    const taskId = seededP2.taskId
    const cancelled = (await def('weave_task_cancel').execute({ task_id: taskId })) as { status: string }
    expect(cancelled.status).toBe('CANCELLED')
    const retried = (await def('weave_task_retry').execute({ task_id: taskId })) as { status: string }
    expect(retried.status).toBe('WAITING')
  })

  it('tokenizeCommandLine：空格分隔 + 双引号包裹', () => {
    expect(tokenizeCommandLine('team list')).toEqual(['team', 'list'])
    expect(tokenizeCommandLine('  task   submit  "修复 登录超时"  --project p1  ')).toEqual([
      'task', 'submit', '修复 登录超时', '--project', 'p1',
    ])
    expect(tokenizeCommandLine('')).toEqual([])
    expect(tokenizeCommandLine('"quoted" value')).toEqual(['quoted', 'value'])
  })

  it('tokenizeCommandLine：原样保留 JSON 对象/数组，含空格与引号', () => {
    const rawJson = 'provider add {"name":"my agent","command":"node","args":["a.js","b.js"]}'
    expect(tokenizeCommandLine(rawJson)).toEqual([
      'provider',
      'add',
      '{"name":"my agent","command":"node","args":["a.js","b.js"]}',
    ])
    const rawArray = 'provider add [{"name":"a","command":"node"},{"name":"b","command":"deno"}]'
    expect(tokenizeCommandLine(rawArray)).toEqual([
      'provider',
      'add',
      '[{"name":"a","command":"node"},{"name":"b","command":"deno"}]',
    ])
  })

  it('provider add 保留原始多行协议内容传给 providerCommand', async () => {
    const env = await newEnv()
    const registered: Array<{ def: HostCommandDefinition }> = []
    const commandsRuntime = {
      register: (def: HostCommandDefinition) => {
        registered.push({ def })
        return () => undefined
      },
    }
    ;(env.ctx as unknown as { commands: HostCommandRuntime }).commands = commandsRuntime
    let capturedArgs: string[] | undefined
    const bundle = registerWeaveHost(env.ctx, env.deps, {
      providerCommand: async (args) => {
        capturedArgs = args
        return { kind: 'success', text: args.join('|') }
      },
    })
    expect(bundle.command.registered).toBe(true)
    const def = registered[0]!.def
    const rawInput = 'provider add name: raw-agent\ncommand: node\nargs:\n  - r.js'
    const result = await def.handler({
      commandId: 'cmd-1',
      agent: undefined,
      rawInput,
      attachments: [],
      signal: new AbortController().signal,
    } as unknown as HostCommandInvocation)
    expect(result.kind).toBe('success')
    expect(capturedArgs).toEqual(['add', 'name: raw-agent\ncommand: node\nargs:\n  - r.js'])
  })

  it('ctx.commands 存在时注册 /weave：team list 与 task status 可执行并返回 CommandResult', async () => {
    const env = await newEnv()
    const registered: Array<{ def: HostCommandDefinition }> = []
    const commandsRuntime = {
      register: (def: HostCommandDefinition) => {
        registered.push({ def })
        return () => undefined
      },
    }
    ;(env.ctx as unknown as { commands: HostCommandRuntime }).commands = commandsRuntime
    const bundle = registerWeaveHost(env.ctx, env.deps)
    expect(bundle.command.registered).toBe(true)
    expect(bundle.command.name).toBe('weave')
    expect(registered).toHaveLength(1)
    const def = registered[0]!.def
    expect(def.name).toBe('weave')
    expect(def.description).toContain('Weave')
    expect(def.input?.hint).toContain('weave <子命令>')

    const invoke = async (rawInput: string): Promise<HostCommandResult> => {
      const result = await def.handler({
        commandId: 'cmd-1',
        agent: undefined,
        rawInput,
        attachments: [],
        signal: new AbortController().signal,
      } as unknown as HostCommandInvocation)
      return result as HostCommandResult
    }

    // 1) team list → success
    const teamList = await invoke('team list')
    expect(teamList.kind).toBe('success')
    expect((teamList as { text?: string }).text).toContain('alpha-squad')

    // 2) 先种子任务，再 task status --dag → success
    const seededP3 = await seedHostTask(env.deps.persistence, 'p3')
    const status = await invoke(`task status --dag "${seededP3.dagId}"`)
    expect(status.kind).toBe('success')
    expect((status as { text?: string }).text).toContain('WAITING')

    // 3) 失败路径：task status（缺参数）→ error
    const bad = await invoke('task status')
    expect(bad.kind).toBe('error')
    expect((bad as { text: string }).text.length).toBeGreaterThan(0)
  })

  it('registerWeaveCommand：ctx.commands 缺席时返回 registered=false（服务导出降级），dispose 幂等', async () => {
    const env = await newEnv()
    const reg = registerWeaveCommand(env.ctx, env.deps)
    expect(reg.registered).toBe(false)
    expect(reg.name).toBe('weave')
    reg.unregister()
    reg.unregister()
  })

  it('与既有 WeaveService/plugin-loading 兼容：服务版本与元数据不破坏', async () => {
    const env = await newEnv()
    const weave = env.ctx.weave as { version(): string; describe(): string; mcp?: unknown; cli?: unknown }
    expect(weave.version()).toBe('0.2.0')
    expect(weave.describe()).toContain('weave')
    registerWeaveHost(env.ctx, env.deps)
    expect(weave.mcp).toBeDefined()
    expect(weave.cli).toBeDefined()
    const weaveMod = weavePlugin as { name: string; apply: unknown }
    expect(weaveMod.name).toBe('dsh-weave')
    expect(weaveMod.apply).toBeTypeOf('function')
  })
})

describe('P0-TOOLS-SCHEMA-FIX：属性规格表递归转 JSON Schema', () => {
  it('嵌套 tasks.items 的布尔 required 上提为该层数组；叶子层不再残留布尔标记', () => {
    const env = { persistence: { tasks: {}, core: {} } } as never
    const mcp = new WeaveMcp(env as never)
    const planDef = buildWeaveToolDefinitions(mcp).find((d) => d.name === 'weave_plan_tasks')!
    const schema = toJsonPropertySpec(planDef.parameters) as {
      properties: Record<string, any>
    }
    const items = schema.properties['tasks'] && (schema.properties['tasks'] as any)['items']
    expect(items?.type).toBe('object')
    expect(items?.required).toEqual(['description', 'assignee'])
    const leaf = items?.properties?.['description']
    expect(leaf && typeof leaf === 'object' && 'required' in leaf).toBe(false)

    // 顶层扁平表：revise_task 的两个必填字段上提
    const revise = buildWeaveToolDefinitions(mcp).find((d) => d.name === 'weave_revise_task')!
    const reviseSchema = toJsonPropertySpec(revise.parameters) as { required?: string[] }
    expect(reviseSchema.required).toEqual(['task_id', 'feedback'])
  })
})
