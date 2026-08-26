import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Plugin } from '@deepseek-ai/cordis'

import { AuditLog } from '../audit/audit-log'
import { CircuitBreaker } from '../safety/circuit-breaker'
import { DagRepository } from '../dag/repository'
import { ExecutorRegistry } from '../executor-registry'
import { FeedbackRouter } from '../feedback-router'
import { KnowledgeReviewService } from '../knowledge-review'
import { KnowledgeStore } from '../knowledge-model'
import {
  buildWeaveToolDefinitions,
  registerWeaveHost,
  registerWeaveCommand,
  tokenizeCommandLine,
  type HostCommandRuntime,
  type HostCommandDefinition,
  type HostCommandInvocation,
  type HostCommandResult,
  type HostToolRuntime,
} from '../host-wiring'
import type { CliMcpDeps } from '../cli-mcp'
import { openPersistence, type WeavePersistence } from '../persistence/index'
import { SessionTracker } from '../session-tracker'
import { TeamManager } from '../team-manager'
import * as weavePlugin from '../index'

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

  it('宿主 ctx.tools 存在时注册全部 15 个 weave_* 工具，核心命令可执行', async () => {
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
      'weave_submit_task',
      'weave_get_status',
      'weave_revise_task',
      'weave_accept_task',
      'weave_team_list',
      'weave_team_switch',
      'weave_executor_list',
      'weave_knowledge_review',
      'weave_knowledge_approve',
      'weave_knowledge_reject',
      'weave_task_retry',
      'weave_task_skip',
      'weave_task_cancel',
      'weave_task_reopen',
      'weave_ban_list',
    ])
    expect(registered).toHaveLength(15)

    // 核心命令：通过注册的 weave_submit_task 定义直接执行
    const submitDef = registered.find((r) => (r.def as { name: string }).name === 'weave_submit_task')!.def as {
      execute: (args: Record<string, unknown>) => Promise<{ dag_id: string; tasks: unknown[]; status: string }>
    }
    const output = await submitDef.execute({ description: '修复登录超时', project_id: 'p1', version: 'v1' })
    expect(output.status).toBe('submitted')
    expect(output.dag_id).toMatch(/^dag-/)
    expect(output.tasks.length).toBeGreaterThan(0)

    // 工具注销后注册表清空
    bundle.dispose()
    expect(registered).toHaveLength(0)
    expect(bundle.registration.unregister).toBeTypeOf('function')
  })

  it('核心 CLI 命令可调用：/weave task submit + status（--json）', async () => {
    const env = await newEnv()
    const bundle = registerWeaveHost(env.ctx, env.deps)
    const submitted = await bundle.cli.run(['task', 'submit', '修复登录超时', '--project', 'proj-x', '--version', 'v2'])
    expect(submitted.exitCode).toBe(0)
    expect(submitted.text).toContain('已提交 DAG')
    const dagId = (JSON.parse(submitted.json) as { data: { dag_id: string } }).data.dag_id
    expect(dagId).toContain('proj-x')
    const status = await bundle.cli.run(['task', 'status', '--dag', dagId])
    expect(status.exitCode).toBe(0)
    expect(status.text).toContain('WAITING')
  })

  it('buildWeaveToolDefinitions 15 个定义：名称齐全且每个具 execute/description/parameters', async () => {
    const env = await newEnv()
    const bundle = registerWeaveHost(env.ctx, env.deps)
    const defs = buildWeaveToolDefinitions(bundle.mcp)
    expect(defs).toHaveLength(15)
    for (const d of defs) {
      expect(d.name).toMatch(/^weave_/)
      expect(d.description.length).toBeGreaterThan(0)
      expect(d.parameters).toBeDefined()
      expect(typeof d.execute).toBe('function')
    }
    const names = defs.map((d) => d.name)
    for (const n of [
      'weave_knowledge_review', 'weave_knowledge_approve', 'weave_knowledge_reject',
      'weave_task_retry', 'weave_task_skip', 'weave_task_cancel', 'weave_task_reopen',
      'weave_ban_list',
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

    // 3) ban_list：无熔断 → 空清单
    const bans = (await def('weave_ban_list').execute({})) as { bans: unknown[] }
    expect(bans.bans).toEqual([])

    // 4) task_cancel / task_retry：提交任务 → 取消（RUNNING→不可；WAITING→CANCELLED）→ 重试回 WAITING
    const sub = await bundle.mcp.submitTask({ description: '修复登录超时', project_id: 'p2', version: 'v1' })
    const taskId = sub.tasks[0]!.id
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

    // 2) 先提交任务，再 task status --dag → success
    const sub = await bundle.mcp.submitTask({ description: '修复登录超时', project_id: 'p3', version: 'v1' })
    const status = await invoke(`task status --dag "${sub.dag_id}"`)
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
