import type { WeavePersistence } from './persistence/persistence.js'
import type { TeamConfig, TeamManager } from './team-manager.js'
import type { TaskStatus } from './state/types.js'
import { WeaveError } from './state/weave-error.js'

/**
 * 队长规划器（会话即团队·队长调度模式）：
 * 当前 DSH 会话是队长——模型把用户目标拆解为「任务列表 + 角色 + 依赖」后调用
 * weave_plan_tasks，本模块校验并落库（dags/tasks/edges 三表，session_id=当前会话），
 * 随后由 WeaveScheduler 按依赖自动调度成员执行。
 *
 * 下发只有对话一条路：MCP submit_task / CLI task submit / Web task-create 均已移除，
 * 本文件是唯一的任务落库入口（ADR 红线不变：执行唯一出口仍是 DelegationService）。
 */

export interface PlannedTaskSpec {
  /** 计划内引用别名；缺省按顺序编号 T1..TN（持久化后为 `${dagId}-${id}`）。 */
  id?: string
  /** 任务短标题；缺省取 description 首行。 */
  subject?: string
  /** 交给成员的完整任务说明（必填）。 */
  description: string
  /** 成员角色 id（或与角色名完全一致）；必填。 */
  assignee: string
  /** 计划内上游任务别名列表。 */
  depends_on?: string[]
}

export interface PlanTasksInput {
  /** 本次规划的整体目标（仅用于摘要展示）。 */
  goal?: string
  /** 调用方会话 id；工具路径由 exec.agent.id 注入，缺省时拒绝。 */
  session_id: string
  project_id?: string
  version?: string
  /**
   * 追加模式（doc/05 §6.1 P1-A）：目标 dag_id——把 tasks 追加进该在途/终态 DAG，
   * 编号在该 DAG 域内跨批次递增；缺省（不传）保持新建 DAG 的历史行为。
   */
  append_to?: string
  tasks: PlannedTaskSpec[]
}

export interface PlannedTaskSummary {
  id: string
  subject: string
  assignee_role: string
  assignee_name: string
  executor: string
  depends_on: string[]
  status: TaskStatus
}

export interface PlanTasksOutput {
  dag_id: string
  session_id: string
  team_id: string
  team_name: string
  goal: string | null
  /** true = 本次为向既有 DAG 追加（tasks 仅含新增任务）；false = 新建 DAG。 */
  appended: boolean
  tasks: PlannedTaskSummary[]
}

export const CAPTAIN_PROJECT_ID = 'session'
export const CAPTAIN_VERSION = 'adhoc'

/** 规划所需最小 deps（CliMcpDeps 子集；测试注入内存库）。 */
export interface TeamPlannerDeps {
  persistence: WeavePersistence
  teamManager: TeamManager
}

interface NormalizedSpec {
  refId: string
  taskId: string
  subject: string
  description: string
  roleIndex: number
  dependsOn: string[]
}

function subjectOf(spec: PlannedTaskSpec): string {
  if (typeof spec.subject === 'string' && spec.subject.trim() !== '') return spec.subject.trim()
  const firstLine = String(spec.description ?? '').split('\n')[0]?.trim() ?? ''
  return firstLine === '' ? '（未命名任务）' : firstLine.slice(0, 60)
}

/** Kahn 拓扑判环：有环抛 invalid_argument（队长模型应在下一轮修正计划）。 */
export function assertAcyclic(nodes: Array<{ refId: string; dependsOn: string[] }>): void {
  const indegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const node of nodes) {
    indegree.set(node.refId, node.dependsOn.length)
    for (const dep of node.dependsOn) {
      dependents.set(dep, [...(dependents.get(dep) ?? []), node.refId])
    }
  }
  let queue = nodes.filter((n) => (indegree.get(n.refId) ?? 0) === 0).map((n) => n.refId)
  let visited = 0
  while (queue.length > 0) {
    const next: string[] = []
    for (const id of queue) {
      visited += 1
      for (const child of dependents.get(id) ?? []) {
        const left = (indegree.get(child) ?? 0) - 1
        indegree.set(child, left)
        if (left === 0) next.push(child)
      }
    }
    queue = next
  }
    if (visited !== nodes.length) {
      const cycleNodes = nodes.filter((n) => (indegree.get(n.refId) ?? 0) > 0).map((n) => n.refId)
      throw new WeaveError('invalid_argument', `任务依赖成环: ${cycleNodes.join(' -> ')}`, { cycle: cycleNodes })
    }
}

export class TeamPlanner {
  readonly #persistence: WeavePersistence
  readonly #teamManager: TeamManager

  constructor(deps: TeamPlannerDeps) {
    this.#persistence = deps.persistence
    this.#teamManager = deps.teamManager
  }

  /**
   * 会话绑定的团队（绑定=启用语义）：不回退默认团队——
   * 未启用时应先发「启用<团队名>」或在会话面板中选择团队。
   */
  async resolveSessionTeam(sessionId: string): Promise<TeamConfig> {
    // 零仪式解析：会话绑定 > 默认团队 > 唯一团队。配置好了小队即可直接对话派发；
    // 仅当「多团队且无默认」时才要求一次显式指定。
    const resolved = await this.#teamManager.resolveSessionTeam(sessionId)
    if (resolved.team) return resolved.team
    const count = this.#teamManager.listTeams().length
    throw new WeaveError(
      'invalid_team',
      count === 0
        ? '尚未配置任何团队：请先在 ~/.dsh/teams/ 放置团队 YAML（或用 /weave 团队页创建），配置后无需启用、直接描述目标即可'
        : `存在 ${count} 个团队且未设置默认：请发送「启用<团队名>」或在会话面板下拉中选择一次，之后长期生效`,
      { session_id: sessionId, team_count: count },
    )
  }

  /** 校验 + 序号分配 + dags/tasks/edges 落库；返回给队长模型的规划摘要。 */
  async plan(input: PlanTasksInput): Promise<PlanTasksOutput> {
    if (!input || !Array.isArray(input.tasks) || input.tasks.length === 0) {
      throw new WeaveError('invalid_argument', 'tasks 不能为空（至少规划一个任务）')
    }
    const sessionId = String(input.session_id ?? '')
    if (sessionId === '') {
      throw new WeaveError('invalid_argument', '无法确定调用会话（session_id 缺失）')
    }
    const projectId = typeof input.project_id === 'string' && input.project_id.trim() !== ''
      ? input.project_id.trim()
      : CAPTAIN_PROJECT_ID
    const version = typeof input.version === 'string' && input.version.trim() !== ''
      ? input.version.trim()
      : CAPTAIN_VERSION
    const goal = typeof input.goal === 'string' && input.goal.trim() !== '' ? input.goal.trim() : null

    const team = await this.resolveSessionTeam(sessionId)

    // 追加模式解析（doc/05 §6.1 P1-A）：目标 DAG 必须存在且属于当前会话团队；
    // 语义域（project/version）继承目标 DAG——追加语义是"往这个计划里加任务"。
    const appendTo = typeof input.append_to === 'string' && input.append_to.trim() !== ''
      ? input.append_to.trim()
      : null
    let target: { dagId: string; status: string; projectId: string; version: string } | null = null
    const existingRefIds: string[] = []
    const existingEdges: Array<{ from: string; to: string }> = []
    if (appendTo !== null) {
      const row = await this.#persistence.tasks.run((db) =>
        db.prepare('SELECT dag_id, team_id, project_id, version, status FROM dags WHERE dag_id = ?')
          .get(appendTo) as { dag_id: string; team_id: string; project_id: string; version: string; status: string } | undefined,
      )
      if (!row) {
        throw new WeaveError('invalid_argument', `append_to 指向的 DAG 不存在: ${appendTo}`, { append_to: appendTo })
      }
      if (row.team_id !== team.team_id) {
        throw new WeaveError(
          'invalid_argument',
          `DAG ${appendTo} 属于团队 ${row.team_id}，与当前会话团队 ${team.team_id} 不一致，拒绝追加`,
          { append_to: appendTo, dag_team: row.team_id, session_team: team.team_id },
        )
      }
      target = { dagId: row.dag_id, status: row.status, projectId: row.project_id, version: row.version }
      const scraped = await this.#persistence.tasks.run((db) => ({
        taskIds: (db.prepare('SELECT id FROM tasks WHERE dag_id = ?').all(appendTo) as Array<{ id: string }>).map((r) => r.id),
        edges: db.prepare('SELECT from_task_id, to_task_id FROM edges WHERE dag_id = ?').all(appendTo) as Array<{ from_task_id: string; to_task_id: string }>,
      }))
      for (const id of scraped.taskIds) {
        existingRefIds.push(id.startsWith(`${target.dagId}-`) ? id.slice(target.dagId.length + 1) : id)
      }
      for (const edge of scraped.edges) existingEdges.push({ from: edge.from_task_id, to: edge.to_task_id })
    }
    const existingSet = new Set(existingRefIds)

    // 引用别名归一：显式 id 或 T{既有任务数+i}——追加模式下编号在 DAG 域内跨批次
    // 递增（任务池 taskSeq 语义），新建模式仍是每批 T1..TN；同一计划内必须唯一。
    const specs = input.tasks.map((spec, index) => ({ spec, index }))
    const refIds = specs.map(({ spec, index }) => {
      const explicit = typeof spec.id === 'string' && spec.id.trim() !== '' ? spec.id.trim() : `T${existingRefIds.length + index + 1}`
      return explicit
    })
    const duplicates = refIds.filter((id, i) => refIds.indexOf(id) !== i)
    if (duplicates.length > 0) {
      throw new WeaveError('invalid_argument', `任务 id 重复: ${[...new Set(duplicates)].join(', ')}`, { duplicates })
    }
    if (target !== null) {
      // 显式 id 与 DAG 域既有任务撞名 → 拒绝（缺省编号因取"既有数+序"也可能撞显式历史 id，一并拦）。
      const collisions = [...new Set(refIds.filter((id) => existingSet.has(id)))]
      if (collisions.length > 0) {
        throw new WeaveError(
          'invalid_argument',
          `任务 id 与 DAG ${target.dagId} 既有任务冲突: ${collisions.join(', ')}`,
          { task_id: collisions },
        )
      }
    }

    const rolesByRef = new Map<number, { id: string; name: string; executor: string }>()
    for (const { spec, index } of specs) {
      if (typeof spec.description !== 'string' || spec.description.trim() === '') {
        throw new WeaveError('invalid_argument', `任务 ${refIds[index]} 的 description 不能为空`, { task_ref: refIds[index] })
      }
      const assignee = typeof spec.assignee === 'string' ? spec.assignee.trim() : ''
      const role =
        team.roles.find((r) => r.id === assignee) ??
        team.roles.find((r) => r.name === assignee)
      if (!role) {
        throw new WeaveError(
          'invalid_argument',
          `任务 ${refIds[index]} 的 assignee「${assignee}」不是团队 ${team.team_id} 的角色（可用: ${team.roles.map((r) => r.id).join(', ')})`,
          { task_ref: refIds[index], assignee },
        )
      }
      rolesByRef.set(index, { id: role.id, name: role.name, executor: role.executor })
    }

    const nodes = specs.map(({ spec }, index) => ({
      refId: refIds[index] as string,
      dependsOn: Array.isArray(spec.depends_on)
        ? spec.depends_on.map((dep) => String(dep).trim()).filter((dep) => dep !== '')
        : [],
    }))
    // 依赖解析域：批内新 id ∪ 目标 DAG 既有任务 refId（追加模式允许新任务依赖既有任务）。
    const refDomain = new Set<string>([...refIds, ...existingRefIds])
    for (const node of nodes) {
      for (const dep of node.dependsOn) {
        if (!refDomain.has(dep)) {
          throw new WeaveError(
            'invalid_argument',
            `依赖引用不存在: ${dep}（必须在本次计划的 tasks[].id${target !== null ? ' 或目标 DAG 既有任务' : ''} 中）`,
            {
              task_ref: node.refId,
              dependency: dep,
            },
          )
        }
      }
    }
    // 判环：追加模式下批内节点与目标 DAG 既有节点/边联合校验（统一到持久化 taskId
    // 命名空间）。既有任务不可被追加依赖，跨批环结构上不可能；联合校验按规格兜底。
    if (target !== null) {
      const existingDeps = new Map<string, string[]>()
      for (const edge of existingEdges) {
        existingDeps.set(edge.to, [...(existingDeps.get(edge.to) ?? []), edge.from])
      }
      assertAcyclic([
        ...nodes.map((node) => ({
          refId: `${target.dagId}-${node.refId}`,
          dependsOn: node.dependsOn.map((dep) => `${target.dagId}-${dep}`),
        })),
        ...existingRefIds.map((refId) => ({
          refId: `${target.dagId}-${refId}`,
          dependsOn: existingDeps.get(`${target.dagId}-${refId}`) ?? [],
        })),
      ])
    } else {
      assertAcyclic(nodes)
    }

    // 全局序号沿用 task_sequences 分配器；dag 命名与既有行兼容。
    // 追加模式复用目标 dagId，不消耗新序号；语义域继承目标 DAG。
    let dagId: string
    let effectiveProjectId = projectId
    let effectiveVersion = version
    if (target !== null) {
      dagId = target.dagId
      effectiveProjectId = target.projectId
      effectiveVersion = target.version
    } else {
      const seq = await this.#nextSequence(projectId, version)
      dagId = `dag-${projectId}-${version}-${seq}`
    }

    const normalized: NormalizedSpec[] = specs.map(({ spec }, index) => ({
      refId: refIds[index] as string,
      taskId: `${dagId}-${refIds[index]}`,
      subject: subjectOf(spec),
      description: (spec as PlannedTaskSpec).description.trim(),
      roleIndex: index,
      dependsOn: nodes[index]!.dependsOn,
    }))

    const now = new Date().toISOString()
    await this.#persistence.tasks.run((db) => {
      if (target !== null) {
        // 终态 DAG 追加 → 复活：状态回 created，调度器 start 重建运行上下文后重泵。
        if (target.status !== 'created' && target.status !== 'running') {
          db.prepare('UPDATE dags SET status = ?, updated_at = ? WHERE dag_id = ?').run('created', now, target.dagId)
        }
      } else {
        db.prepare(
          `INSERT INTO dags (dag_id, team_id, project_id, version, difficulty, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'captain', 'created', ?, ?)`,
        ).run(dagId, team.team_id, projectId, version, now, now)
      }

      const insertTask = db.prepare(
        `INSERT INTO tasks (id, dag_id, session_id, team_id, project_id, version, description, stage,
         dependencies, assigned_agent, executor, status, revision_count, max_revisions,
         feedback_timeout_seconds, feedback_expires_at, skip_override, skip_reason, fail_count,
         result, error_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, 0, ?, ?, NULL, 0, NULL, 0, NULL, NULL, ?, ?)`,
      )
      const insertEdge = db.prepare(
        'INSERT OR IGNORE INTO edges (dag_id, from_task_id, to_task_id) VALUES (?, ?, ?)',
      )
      for (const item of normalized) {
        const role = rolesByRef.get(item.roleIndex)!
        const status: TaskStatus = item.dependsOn.length > 0 ? 'BLOCKED' : 'WAITING'
        insertTask.run(
          item.taskId,
          dagId,
          sessionId,
          team.team_id,
          effectiveProjectId,
          effectiveVersion,
          item.description,
          JSON.stringify(item.dependsOn.map((ref) => `${dagId}-${ref}`)),
          role.id,
          role.executor,
          status,
          team.feedback.max_revisions,
          team.feedback.feedback_timeout_seconds,
          now,
          now,
        )
        for (const dep of item.dependsOn) {
          insertEdge.run(dagId, `${dagId}-${dep}`, item.taskId)
        }
      }
    })

    const tasks: PlannedTaskSummary[] = normalized.map((item) => {
      const role = rolesByRef.get(item.roleIndex)!
      return {
        id: item.taskId,
        subject: item.subject,
        assignee_role: role.id,
        assignee_name: role.name,
        executor: role.executor,
        depends_on: item.dependsOn,
        status: item.dependsOn.length > 0 ? 'BLOCKED' : 'WAITING',
      }
    })

    return {
      dag_id: dagId,
      session_id: sessionId,
      team_id: team.team_id,
      team_name: team.name,
      goal,
      appended: target !== null,
      tasks,
    }
  }

  async #nextSequence(projectId: string, version: string): Promise<number> {
    return this.#persistence.core.run((db) => {
      db.prepare('INSERT OR IGNORE INTO task_sequences (project_id, version, next_n) VALUES (?, ?, 0)').run(projectId, version)
      const row = db
        .prepare('UPDATE task_sequences SET next_n = next_n + 1 WHERE project_id = ? AND version = ? RETURNING next_n')
        .get(projectId, version) as { next_n: number }
      return row.next_n
    })
  }
}

/* ------------------------------ 工具 handler 组装 ------------------------------ */

/** 宿主 ToolRunContext 最小视面：exec.agent 即发起调用的 Agent（可能是子代理会话）。 */
export interface ToolExecLike {
  agent?: unknown
  signal?: AbortSignal
}

export interface CaptainWiring {
  planner: TeamPlanner
  /** start 仅负责启动后台调度循环；进度/汇总经 notify 回灌会话，不阻塞工具返回。 */
  schedulerStart: (input: { dagId: string; sessionId: string; parentAgent: unknown }) => Promise<void>
  log?: { warn?: (...args: unknown[]) => void }
  /**
   * 按会话 id 查找存活代理（宿主 cordis ctx.agents.get）；
   * 缺席或查不到时血统回溯止步于已知的最近父会话 id。禁止硬编码，真值取自 durable header。
   */
  getAgentById?: (sessionId: string) => unknown
}

/** 代理 durable 血统的最小视面（DSH SessionHeader：origin='subagent' 时 parentSession 为委派方）。 */
interface LineageAgentLike {
  id?: unknown
  session?: { header?: { origin?: unknown; parentSession?: unknown } }
}

/**
 * 从执行代理向宿主会话根回溯：
 * - dags/tasks 落库的 session_id 必须是对话面板所见的那一个——工具在子代理内执行时
 *   exec.agent.id 是子代理会话（实测偏离对话 id），直接落库会让 WeaveSessionPanel 按
 *   sessionId 查空（EmptyState 假象）；
 * - 真值链：`session.header.parentSession` + 存活代理注册表逐跳上溯，
 *   直到无 parentSession 的顶层会话；中途代理不可见则止步于最近可证父 id（仍是有效会话）；
 * - 无血缘信息（header 缺失/非子代理起源）→ 原样返回当前 agent.id，向后兼容直连部署。
 */
export function resolveHostSessionId(agent: unknown, deps?: Pick<CaptainWiring, 'getAgentById'>): string {
  let current = agent as LineageAgentLike | undefined
  let resolved = String(current?.id ?? '')
  const visited = new Set<string>()
  // 上限防御：血缘环/异常数据下有界终止，不挂死工具调用。
  for (let hop = 0; hop < 16 && current; hop += 1) {
    const currentId = String(current?.id ?? '')
    if (currentId !== '') {
      if (visited.has(currentId)) break
      visited.add(currentId)
      resolved = currentId
    }
    const header = (current?.session as LineageAgentLike['session'] | undefined)?.header
    const parentId =
      typeof header?.parentSession === 'string' && header.parentSession !== '' ? header.parentSession : ''
    if (parentId === '') break
    const parentAgent = deps?.getAgentById?.(parentId) as LineageAgentLike | undefined
    if (!parentAgent) {
      // 父代理不在进程内（已析构/跨进程）：parentSession 本身即最深的可证宿主会话。
      resolved = parentId
      break
    }
    current = parentAgent
  }
  return resolved
}

/**
 * weave_plan_tasks 工具的 execute 实现：
 * - 会话 id：args.session_id 显式覆盖 > 宿主会话回溯（exec.agent 血统），后者保证
 *   落库 session_id 与对话面板一致；
 * - 规划成功即触发 DAG 后台调度（通知同样发往宿主会话）；
 * - 失败以异常上抛（dsh-tools 映射为工具错误反馈给队长模型修正计划）。
 */
export function createPlanTasksHandler(wiring: CaptainWiring) {
  return async function planTasks(args: unknown, exec?: unknown): Promise<PlanTasksOutput> {
    const payload = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
    const requested = typeof payload['session_id'] === 'string' && payload['session_id'] !== ''
      ? payload['session_id']
      : undefined
    const toolExec = exec as ToolExecLike | undefined
    const sessionId = requested !== undefined
      ? requested
      : resolveHostSessionId(toolExec?.agent, wiring)
    if (sessionId === '') {
      throw new WeaveError('invalid_argument', '无法确定当前会话：exec.agent 缺失且未显式传 session_id')
    }
    const output = await wiring.planner.plan({ ...(payload as unknown as PlanTasksInput), session_id: sessionId })
    try {
      await wiring.schedulerStart({
        dagId: output.dag_id,
        sessionId,
        parentAgent: toolExec?.agent,
      })
    } catch (error) {
      wiring.log?.warn?.('[dsh-weave] scheduler 启动失败:', error)
    }
    return output
  }
}
