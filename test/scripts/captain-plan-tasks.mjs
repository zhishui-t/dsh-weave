import { openPersistence } from '../../dist/plugins/weave/persistence/persistence.js'
import { TeamManager, DEFAULT_TEAMS_DIR } from '../../dist/plugins/weave/team-manager.js'
import { TeamPlanner, createPlanTasksHandler } from '../../dist/plugins/weave/planner.js'

const sessionId = process.env.WEAVE_SESSION_ID ?? 'session-ffc1e711-bdef-4aef-8e47-9c7d5193cb19'
const teamId = 'changan'

const persistence = openPersistence()
const teamManager = new TeamManager({}, { teamsDir: DEFAULT_TEAMS_DIR, persistence })
await teamManager.bindTeam(sessionId, teamId)

const planner = new TeamPlanner({ persistence, teamManager })
const handler = createPlanTasksHandler({
  planner,
  schedulerStart: async (input) => {
    console.log(`[scheduler] DAG ${input.dagId} 已启动后台调度（当前环境为本地落库模拟，真实执行需 DSH 宿主调度器运行）`)
  },
  log: console,
})

const output = await handler({
  goal: '审视 Weave 插件工程的知识沉淀/注入/反思链路，并实现执行器输出知识沉淀解析、任务完成反思沉淀、skill 知识注入，以及全量质量审核。',
  session_id: sessionId,
  project_id: 'weave-knowledge',
  version: 'phase0.5',
  tasks: [
    {
      id: 'T1',
      subject: '架构审视与优化设计',
      assignee: 'architect',
      description: '审视插件工程，重点检查知识图谱注入/沉淀、任务完成后反思、不同执行器/知识/图谱/技能如何沉淀与使用，输出优化方案和设计文档。',
    },
    {
      id: 'T2',
      subject: '知识沉淀解析（WEAVE_KNOWLEDGE 块）',
      assignee: 'developer-1',
      depends_on: ['T1'],
      description: '实现知识沉淀解析：解析执行器输出中的 WEAVE_KNOWLEDGE_START/END JSON 块，写入候选知识库。',
    },
    {
      id: 'T3',
      subject: '任务完成后反思生成并沉淀',
      assignee: 'developer-2',
      depends_on: ['T1'],
      description: '实现任务完成后反思生成并沉淀为候选知识。',
    },
    {
      id: 'T4',
      subject: 'type=skill 知识注入执行器 prompt',
      assignee: 'developer-3',
      depends_on: ['T1'],
      description: '实现 type=skill 类型知识可以被注入执行器 prompt，作为技能使用。',
    },
    {
      id: 'T5',
      subject: '全量测试/typecheck/build 与 QA 报告',
      assignee: 'qa',
      depends_on: ['T2', 'T3', 'T4'],
      description: '全量测试、typecheck、build，输出 QA 审查报告，完成后由队长汇总。',
    },
  ],
}, undefined)

console.log('\n=== weave_plan_tasks 返回 ===')
console.log(JSON.stringify(output, null, 2))
persistence.close()
