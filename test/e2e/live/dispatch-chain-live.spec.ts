// 派单全链路真实 E2E（live 层）：一条命令端到端验证——
//   会话启动（目标工作区新会话）→ 短句绑定团队 → 队长 weave_plan_tasks 分任务 →
//   执行器产出落盘 → 知识沉淀（WEAVE_KNOWLEDGE/自动反思 → knowledge_meta）→ 代码图谱（Graphify）。
// 覆盖三个历史事故点：
//   1) 派单必须落在目标工作区（test）的新会话，而不是 weave 默认工作区；
//   2) 「启动团队 <id>」短句必须经 pre-step hook 写入绑定（含团队感知注入能力存在性）；
//   3) 队长必须在正确团队（deepseek-zcode-test）上调 weave_plan_tasks，
//      任务进入 tasks.db 并推进到终态，产物落在 K:/work/test/zcode-squad/snake。
//
// 门控：WEAVE_E2E_LIVE=1（与 console-live 相同）；宿主必须已重启加载新 weave dist。
// 运行（Git Bash）：
//   WEAVE_E2E_LIVE=1 pnpm test:e2e:dispatch
// 未重启宿主时 dispatch 用例会在「绑定确认」处快速失败并提示重启（不产生垃圾任务）。
// 产物：.artifacts/weave-ui/e2e/dispatch-chain/report.json + 截图。
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { expect, test, type Page } from '@playwright/test'

import { ART, BASE_URL, LIVE_ENABLED, probeServer, shot } from '../helpers'

const WORKSPACE = process.env.WEAVE_DISPATCH_WORKSPACE ?? 'test'
const TEAM = process.env.WEAVE_DISPATCH_TEAM ?? 'deepseek-zcode-test'
const PROJECT = process.env.WEAVE_DISPATCH_PROJECT ?? 'snake'
const WORK_DIR = process.env.WEAVE_DISPATCH_CWD ?? `K:/work/${WORKSPACE}/zcode-squad/snake`
const MONITOR_MS = Number(process.env.WEAVE_DISPATCH_TIMEOUT_MS ?? 15 * 60_000)
const STATE_DIR = join(homedir(), '.dsh', 'state')
const SESSIONS_ROOT = join(homedir(), '.dsh', 'sessions')
/** cwd → sessions 目录名映射（DSH 约定：K:\work\test → --K-work-test--）。 */
const SESSION_DIR = `--K-work-${WORKSPACE}--`  // 目标 cwd 为 K:\work\<workspace> 的 sessions 目录名
const REPORT_DIR = resolve(ART, 'dispatch-chain')
mkdirSync(REPORT_DIR, { recursive: true })

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CLOSED', 'CANCELLED', 'SKIPPED', 'BANNED', 'LOOP_TERMINATED', 'INTERRUPTED'])

type Check = { name: string; ok: boolean; detail: string; at: number }
const checks: Check[] = []
const mark = (name: string, ok: boolean, detail = '') => {
  checks.push({ name, ok, detail, at: Date.now() })
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const DISPATCH_MESSAGE = [
  `【目标】用 weave_plan_tasks 拆解派发（project_id=${PROJECT}, version=v1），不要自己动手实现：`,
  `T1（developer/zcode）：实现 ${WORK_DIR}/game.html：单文件贪吃蛇，20x20 canvas、方向键/WASD 禁 180 度掉头、空格暂停、吃食物加分加速、撞墙/撞己结束、Enter/按钮重开、localStorage 最高分。`,
  `T2（dsh-developer/spawn）：编写并运行 ${WORK_DIR}/tests/smoke_check.py：校验 game.html 存在非空、DOCTYPE/canvas 在位、JS 括号平衡，输出结果。`,
  `T3（fork-developer/fork）：走查 game.html 逻辑与视觉，输出结论与改进点。`,
  `所有执行器必须显式携带 cwd=${WORK_DIR}（zcode 缺 cwd 会报 cwd required）。完成后汇总验收结论。`,
].join('\n')

let page: Page
let captainSessionId = ''
let t0 = 0

function openReadOnly(file: string): DatabaseSync {
  return new DatabaseSync(join(STATE_DIR, file), { readOnly: true })
}

function findCaptainSession(): string {
  const dir = join(SESSIONS_ROOT, SESSION_DIR)
  if (!existsSync(dir)) return ''
  let best = ''
  let bestMtime = t0 - 1
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    try {
      const m = statSync(p).mtimeMs
      if (m >= t0 - 1 && m >= bestMtime) { bestMtime = m; best = name }
    } catch { /* 并发删除等，忽略 */ }
  }
  // 返回完整 session id（core.db / tasks.db 的 session_id 均含 session- 前缀）
  return best
}

test.describe.serial('live: 派单全链路（工作区/绑定/团队/任务/产物）', () => {
  test.skip(!LIVE_ENABLED, 'live 层 env 门控：需 WEAVE_E2E_LIVE=1')

  test.beforeAll(async ({ browser }) => {
    // 1440 视口下侧边栏默认折叠，工作区按钮不可见——用宽视口保证侧边栏展开
    page = await browser.newPage({ viewport: { width: 1680, height: 950 } })
  })

  test.afterAll(async () => {
    const passed = checks.filter((c) => c.ok).length
    const report = {
      baseUrl: BASE_URL, workspace: WORKSPACE, team: TEAM, project: PROJECT,
      captainSessionId, sessionDir: SESSION_DIR,
      startedAt: new Date(t0).toISOString(), finishedAt: new Date().toISOString(),
      passed, failed: checks.length - passed, checks,
    }
    writeFileSync(join(REPORT_DIR, 'report.json'), JSON.stringify(report, null, 2), 'utf-8')
    console.log(`\n==== dispatch-chain 报告：${passed}/${checks.length} 通过，详见 ${REPORT_DIR}\\report.json ====`)
    await page?.close()
  })

  test('preflight: 宿主/团队配置/插件新代码就绪', async () => {
    test.setTimeout(60_000)
    const up = await probeServer()
    expect(up, `真实 DSH Web ${BASE_URL} 不可达`).toBe(true)
    mark('宿主可达', true, BASE_URL)

    const teamYaml = join(homedir(), '.dsh', 'teams', `${TEAM}.yaml`)
    mark('团队 YAML 存在', existsSync(teamYaml), teamYaml)

    const dist = resolve(process.cwd(), 'dist/plugins/weave/scheduling/session-delegation.js')
    const distCode = existsSync(dist) ? readFileSync(dist, 'utf-8') : ''
    mark('dist 含团队感知注入', distCode.includes('buildTeamAwarenessText'), dist)
    expect(existsSync(teamYaml), `缺少 ${teamYaml}`).toBe(true)
    expect(distCode.includes('buildTeamAwarenessText'), 'dist 未包含新 hook——先 pnpm build 并重启宿主').toBe(true)
  })

  test('dispatch: 目标工作区新会话 + 短句绑定 + 派单正文', async () => {
    test.setTimeout(120_000)
    t0 = Date.now()
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForTimeout(3500)

    const newInWs = page.getByRole('button', { name: `在“${WORKSPACE}”中新建会话` })
    if (!(await newInWs.first().isVisible().catch(() => false))) {
      // 窄视口下侧边栏可能折叠：先点「打开侧边栏」再找工作区入口
      const openSide = page.getByRole('button', { name: '打开侧边栏' })
      if (await openSide.isVisible().catch(() => false)) {
        await openSide.click()
        await page.waitForTimeout(1200)
      }
    }
    await newInWs.first().waitFor({ state: 'visible', timeout: 20_000 })
    await newInWs.first().click()
    await page.waitForTimeout(1500)
    mark(`工作区「${WORKSPACE}」新建会话入口可用`, true)

    const input = page.locator('textarea').first()
    await input.waitFor({ state: 'visible', timeout: 20_000 })
    await input.fill(`启动团队 ${TEAM}`)
    await input.press('Enter')

    let acked = false
    const bindDeadline = Date.now() + 45_000
    while (Date.now() < bindDeadline) {
      await page.waitForTimeout(3000)
      const body = await page.evaluate(() => document.body.innerText)
      if (body.includes('已在当前会话启用团队')) { acked = true; break }
    }
    mark('绑定确认 notice（pre-step hook 生效）', acked, acked ? `启动团队 ${TEAM}` : '宿主可能未重启加载新插件')
    expect(acked, '未检测到「已在当前会话启用团队」——weave 插件未随宿主生效，请重启宿主').toBe(true)

    for (let i = 0; i < 10 && captainSessionId === ''; i += 1) {
      captainSessionId = findCaptainSession()
      if (captainSessionId === '') await page.waitForTimeout(1500)
    }
    mark('队长会话建立在目标工作区目录', captainSessionId !== '', `${SESSION_DIR}/${captainSessionId}`)
    expect(captainSessionId, `未在 ${SESSION_DIR} 下发现新会话（cwd 又落错了？）`).not.toBe('')

    const core = openReadOnly('core.db')
    const row = core.prepare('SELECT team_id FROM team_bindings WHERE session_id = ?').get(captainSessionId) as { team_id?: string } | undefined
    core.close()
    mark('core.db 绑定 = 目标团队', row?.team_id === TEAM, String(row?.team_id ?? '无绑定'))
    expect(row?.team_id, `绑定错误：期望 ${TEAM}，实际 ${String(row?.team_id)}`).toBe(TEAM)

    await shot(page, 'dispatch-chain-01-bound')
    await input.fill(DISPATCH_MESSAGE)
    await input.press('Enter')
    mark('派单正文已发送', true)
    await page.waitForTimeout(5000)
  })

  test('monitor: 任务入库推进到终态且产物落盘', async () => {
    test.setTimeout(MONITOR_MS + 120_000)
    const deadline = Date.now() + MONITOR_MS
    let taskRows: Array<Record<string, unknown>> = []
    let dagRow: Record<string, unknown> | undefined
    let sawRunning = false

    while (Date.now() < deadline) {
      await page.waitForTimeout(10_000)
      const tasks = openReadOnly('tasks.db')
      try {
        taskRows = tasks.prepare(
          'SELECT id, status, executor, team_id, project_id, session_id FROM tasks WHERE session_id = ? ORDER BY id',
        ).all(captainSessionId) as Array<Record<string, unknown>>
        dagRow = tasks.prepare(
          'SELECT dag_id, team_id, status FROM dags WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1',
        ).get(PROJECT) as Record<string, unknown> | undefined
      } finally { tasks.close() }
      if (taskRows.length > 0) {
        const statuses = taskRows.map((r) => String(r.status))
        if (statuses.some((s) => s === 'RUNNING' || s === 'AWAITING_FEEDBACK')) sawRunning = true
        if (statuses.length >= 3 && statuses.every((s) => TERMINAL.has(s))) break
      }
    }

    mark('任务已入 tasks.db 且归属正确团队', taskRows.length > 0 && taskRows.every((r) => r.team_id === TEAM),
      taskRows.map((r) => `${r.id}:${r.status}`).join(' ') || '无任务（队长未派发？）')
    expect(taskRows.length, '队长未在 weave_plan_tasks 下创建任何任务').toBeGreaterThan(0)
    expect(taskRows.every((r) => r.team_id === TEAM), '任务归属团队错误（又解析到 changan？）').toBe(true)

    const statuses = taskRows.map((r) => String(r.status))
    const allTerminal = statuses.length >= 3 && statuses.every((s) => TERMINAL.has(s))
    mark(`任务全部终态（${statuses.join(',')}）`, allTerminal, sawRunning ? '观察到 RUNNING' : '轮询间隙未见 RUNNING')

    const game = `${WORK_DIR}/game.html`
    const smoke = `${WORK_DIR}/tests/smoke_check.py`
    mark('产物 game.html 落盘', existsSync(game), game)
    mark('产物 tests/smoke_check.py 落盘', existsSync(smoke), smoke)

    const tab = page.getByText('Weave 团队', { exact: false }).first()
    if (await tab.isVisible().catch(() => false)) { await tab.click(); await page.waitForTimeout(6000) }
    await shot(page, 'dispatch-chain-02-final')

    // 终态与产物是硬断言：失败即红，报告里保留全部过程信息
    expect(allTerminal, `任务未全部终态: ${statuses.join(',')}`).toBe(true)
    expect(existsSync(game), `缺少 ${game}`).toBe(true)
    expect(existsSync(smoke), `缺少 ${smoke}`).toBe(true)
  })

  test('knowledge: 任务完成后知识沉淀入库', async () => {
    test.setTimeout(6 * 60_000)
    const deadline = Date.now() + 5 * 60_000
    const KNOWLEDGE_DIR = join(homedir(), '.dsh', 'knowledge')
    let hit = ''

    const dbRows = (): Array<Record<string, unknown>> => {
      const db = openReadOnly('knowledge_meta.db')
      try {
        return db.prepare('SELECT id, path, status, layer, created FROM knowledge_meta').all() as Array<Record<string, unknown>>
      } catch { return [] } finally { db.close() }
    }
    const freshFile = (): string => {
      if (!existsSync(KNOWLEDGE_DIR)) return ''
      for (const dp of [KNOWLEDGE_DIR, ...readdirSync(KNOWLEDGE_DIR).map((d) => join(KNOWLEDGE_DIR, d))]) {
        try {
          for (const f of readdirSync(dp)) {
            const p = join(dp, f)
            if (statSync(p).isFile() && statSync(p).mtimeMs >= t0) return p
          }
        } catch { /* 非目录，忽略 */ }
      }
      return ''
    }

    while (Date.now() < deadline) {
      await page.waitForTimeout(15_000)
      const rows = dbRows().filter((r) => {
        const ts = Date.parse(String(r.created ?? '')) || Date.parse(String(r.updated ?? '')) || 0
        return ts >= t0 - 60_000
      })
      if (rows.length > 0) { hit = rows.map((r) => `${r.status}:${String(r.path).slice(-60)}`).join(' | '); break }
      const file = freshFile()
      if (file) { hit = `file:${file.slice(-70)}`; break }
    }
    mark('知识沉淀（knowledge_meta 新条目或知识文件）', hit !== '', hit || '5 分钟窗口内无新知识——执行器未输出 WEAVE_KNOWLEDGE 块且自动反思未产生条目')
    expect(hit, '任务完成后没有产生任何知识沉淀').not.toBe('')
  })

  test('graph: 代码图谱构建（Graphify extract + flows）', async () => {
    test.setTimeout(5 * 60_000)
    const { GraphService } = await import('../../../../dist/plugins/weave/graph/graph-service.js') as {
      GraphService: new (options: { projectRoot: string }) => { build(): Promise<{ graphPath: string; flowsPath: string }> }
    }
    const svc = new GraphService({ projectRoot: WORK_DIR })
    const built = await svc.build()
    mark('GraphService.build() 完成', true, `${built.graphPath} | ${built.flowsPath}`)

    const graphOk = existsSync(built.graphPath)
    const flowsOk = existsSync(built.flowsPath)
    mark('graph.json 落盘', graphOk, built.graphPath)
    mark('flows.json 落盘', flowsOk, built.flowsPath)
    if (graphOk) {
      const parsed = JSON.parse(readFileSync(built.graphPath, 'utf-8')) as { nodes?: unknown[]; edges?: unknown[] }
      const nodeCount = Array.isArray(parsed.nodes) ? parsed.nodes.length : -1
      mark('graph.json 可解析（nodes 数组在位）', nodeCount >= 0, `nodes=${nodeCount}`)
      expect(nodeCount, 'graph.json 缺少 nodes 数组').toBeGreaterThanOrEqual(0)
    }
    expect(graphOk, `缺少 ${built.graphPath}`).toBe(true)
    expect(flowsOk, `缺少 ${built.flowsPath}`).toBe(true)
    await shot(page, 'dispatch-chain-03-graph')
  })
})
