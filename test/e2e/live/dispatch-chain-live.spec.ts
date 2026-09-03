// 派单全链路真实 E2E（live 层）v3 —— 端到端语义：
//   每轮新建交付目录 → 绑定团队 → 只给一句自然语言目标（零工具名，队长自主拆解派发）
//   → 全程盯 UI（团队面板/任务图 dag-panel/成员输出）→ 全部终态后【增量下发】
//   → 断言任务图生长 → 知识沉淀 → 代码图谱。
// 门控：WEAVE_E2E_LIVE=1；宿主需加载新 weave dist（boot executor refresh + 队长纪律闸门）。
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { expect, test, type Page } from '@playwright/test'

import { ART, BASE_URL, LIVE_ENABLED, probeServer, shot } from '../helpers'

const WORKSPACE = process.env.WEAVE_DISPATCH_WORKSPACE ?? 'test'
const TEAM = process.env.WEAVE_DISPATCH_TEAM ?? 'deepseek-zcode-test'
const MONITOR_MS = Number(process.env.WEAVE_DISPATCH_TIMEOUT_MS ?? 30 * 60_000)
const INCREMENTAL_MS = Number(process.env.WEAVE_DISPATCH_INCREMENTAL_MS ?? 15 * 60_000)
const STATE_DIR = join(homedir(), '.dsh', 'state')
const SESSION_DIR = `--K-work-${WORKSPACE}--`
const REPORT_DIR = resolve(ART, 'dispatch-chain')
mkdirSync(REPORT_DIR, { recursive: true })

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CLOSED', 'CANCELLED', 'SKIPPED', 'BANNED', 'LOOP_TERMINATED', 'INTERRUPTED'])

type Check = { name: string; ok: boolean; detail: string; at: number }
const checks: Check[] = []
const mark = (name: string, ok: boolean, detail = '') => {
  checks.push({ name, ok, detail, at: Date.now() })
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

let page: Page
let captainSessionId = ''
let t0 = 0
let runDir = ''
let firstWaveCount = 0

function openReadOnly(file: string): DatabaseSync {
  return new DatabaseSync(join(STATE_DIR, file), { readOnly: true })
}

function captainTasks(): Array<Record<string, unknown>> {
  if (captainSessionId === '') return []
  const tasks = openReadOnly('tasks.db')
  try {
    return tasks.prepare('SELECT id, status, executor, stage FROM tasks WHERE session_id = ? ORDER BY id').all(captainSessionId) as Array<Record<string, unknown>>
  } finally { tasks.close() }
}

async function openTeamDagTab(): Promise<number> {
  const panelBtn = page.getByText('Weave 团队', { exact: false }).first()
  if (!(await panelBtn.isVisible().catch(() => false))) return -1
  await panelBtn.click()
  await page.waitForTimeout(1500)
  const dagTab = page.getByTestId('session-tab-dag')
  if (!(await dagTab.isVisible().catch(() => false))) return -1
  await dagTab.click()
  await page.waitForTimeout(1200)
  return page.locator('[data-testid^="dag-node-"]').count()
}

test.describe.serial('live: 派单全链路 v3（自然语言/自主拆解/增量/知识/图谱）', () => {
  test.skip(!LIVE_ENABLED, 'live 层 env 门控：需 WEAVE_E2E_LIVE=1')

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ viewport: { width: 1680, height: 950 } })
  })

  test.afterAll(async () => {
    const passed = checks.filter((c) => c.ok).length
    const report = {
      baseUrl: BASE_URL, workspace: WORKSPACE, team: TEAM, runDir,
      captainSessionId, sessionDir: SESSION_DIR, firstWaveCount,
      startedAt: new Date(t0).toISOString(), finishedAt: new Date().toISOString(),
      passed, failed: checks.length - passed, checks,
    }
    writeFileSync(join(REPORT_DIR, 'report.json'), JSON.stringify(report, null, 2), 'utf-8')
    console.log(`\n==== dispatch-chain 报告：${passed}/${checks.length} 通过 ====`)
    await page?.close()
  })

  test('preflight: 宿主/团队/纪律闸门 dist/provider 注册', async () => {
    test.setTimeout(60_000)
    expect(await probeServer(), `真实 DSH Web ${BASE_URL} 不可达`).toBe(true)
    mark('宿主可达', true, BASE_URL)
    const teamYaml = join(homedir(), '.dsh', 'teams', `${TEAM}.yaml`)
    mark('团队 YAML 存在', existsSync(teamYaml), teamYaml)
    const dist = resolve(process.cwd(), 'dist/plugins/weave/scheduling/session-delegation.js')
    const distCode = existsSync(dist) ? readFileSync(dist, 'utf-8') : ''
    mark('dist 含队长纪律闸门', distCode.includes('buildCaptainDirectiveText'), dist)
    expect(distCode.includes('buildCaptainDirectiveText'), 'dist 缺纪律闸门——先 build 并重启宿主').toBe(true)
    const rpc = await fetch(`${BASE_URL}/dsh-weave/provider/list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'e2e-preflight', method: 'provider/list', payload: {} }),
    }).then((r) => r.json() as { result?: { value?: { providers?: Array<{ name: string; enabled: boolean }> } } }).catch(() => undefined)
    const providers = rpc?.result?.value?.providers ?? []
    const zcode = providers.find((p) => p.name === 'zcode')
    mark('zcode provider 注册且启用', !!zcode && zcode.enabled === true,
      providers.map((p) => `${p.name}:${p.enabled}`).join(' ') || '无返回')
    expect(zcode?.enabled, 'zcode provider 未注册——检查 providers.json 并重启宿主').toBe(true)
  })

  test('dispatch: 新建交付目录 + 切工作区 + 绑定团队 + 自然语言目标', async () => {
    test.setTimeout(120_000)
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    runDir = `K:/work/${WORKSPACE}/auto-${stamp}`
    rmSync(runDir, { recursive: true, force: true })
    mkdirSync(runDir, { recursive: true })
    mark('每轮新建交付目录', existsSync(runDir), runDir)

    t0 = Date.now()
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForTimeout(3500)
    const chooseBtn = page.getByRole('button', { name: /Choose workspace|选择工作区/ }).first()
    await chooseBtn.waitFor({ state: 'visible', timeout: 20_000 })
    await chooseBtn.click()
    await page.waitForTimeout(900)
    await page.getByRole('menuitem', { name: WORKSPACE, exact: true }).first().click()
    await page.waitForTimeout(900)
    const after = (await chooseBtn.textContent()) ?? ''
    mark(`composer 工作区 → ${WORKSPACE}`, after.trim() === WORKSPACE, after.trim())
    expect(after.trim(), `composer 仍指向 ${after.trim()}`).toBe(WORKSPACE)

    const input = page.locator('textarea').first()
    await input.waitFor({ state: 'visible', timeout: 20_000 })
    await input.fill(`启动团队 ${TEAM}`)
    await input.press('Enter')

    let boundRow: { session_id: string; team_id: string; updated_at: string } | undefined
    const bindDeadline = Date.now() + 45_000
    while (Date.now() < bindDeadline && !boundRow) {
      await page.waitForTimeout(3000)
      const core = openReadOnly('core.db')
      try {
        const rows = core.prepare('SELECT session_id, team_id, updated_at FROM team_bindings').all() as Array<{ session_id: string; team_id: string; updated_at: string }>
        boundRow = rows.find((r) => r.team_id === TEAM && Date.parse(r.updated_at) >= t0 - 5_000)
      } finally { core.close() }
    }
    mark('绑定写入 team_bindings（pre-step hook 生效）', !!boundRow,
      boundRow ? `${boundRow.session_id} @ ${boundRow.updated_at}` : '45s 内无新绑定')
    expect(boundRow, '未检测到新绑定——宿主未加载新插件').toBeTruthy()
    captainSessionId = boundRow!.session_id

    // 纯自然语言目标：零工具名、零任务清单——拆解/指派/顺序全部由队长自主设计
    const goal = `团队来做一个单文件贪吃蛇网页，放在 ${runDir} 目录，能玩就行。怎么拆任务、派给谁、什么顺序，你作为队长自行设计。`
    await input.fill(goal)
    await input.press('Enter')
    mark('自然语言目标已发送（无任何工具提示）', true, goal.slice(0, 60))
    await page.waitForTimeout(5000)
  })

  test('watch: 盯 UI（团队面板/任务图/成员输出）直到任务全部终态', async () => {
    test.setTimeout(MONITOR_MS + 120_000)
    const deadline = Date.now() + MONITOR_MS
    let rows: Array<Record<string, unknown>> = []
    let sawRunning = false
    let dagNodesSeen = 0
    let shotRunning = false
    let shotDone = false
    while (Date.now() < deadline) {
      await page.waitForTimeout(12_000)
      rows = captainTasks()
      const statuses = rows.map((r) => String(r.status))
      if (statuses.some((s) => s === 'RUNNING' || s === 'AWAITING_FEEDBACK')) sawRunning = true
      const dagNodes = await openTeamDagTab()
      if (dagNodes > dagNodesSeen) dagNodesSeen = dagNodes
      if (!shotRunning && statuses.includes('RUNNING')) { await shot(page, 'dispatch-chain-ui-running'); shotRunning = true }
      const doneCount = statuses.filter((s) => s === 'COMPLETED').length
      if (!shotDone && doneCount > 0) { await shot(page, 'dispatch-chain-ui-firstdone'); shotDone = true }
      if (statuses.length >= 2 && statuses.every((s) => TERMINAL.has(s))) break
    }
    firstWaveCount = rows.length
    mark('队长自主拆解出任务（≥2）', rows.length >= 2,
      rows.map((r) => `${r.id}[${r.stage || '-'}]→${r.executor}:${r.status}`).join(' ') || '无任务')
    expect(rows.length, '队长未自主创建任务').toBeGreaterThanOrEqual(2)
    const statuses = rows.map((r) => String(r.status))
    const allTerminal = statuses.length >= 2 && statuses.every((s) => TERMINAL.has(s))
    mark(`第一波任务全部终态（${statuses.join(',')}）`, allTerminal, sawRunning ? '观察到 RUNNING' : '未见 RUNNING')
    mark('任务图在 UI 渲染（dag-node）', dagNodesSeen >= 2, `最大节点数 ${dagNodesSeen}`)
    expect(dagNodesSeen, 'DAG 面板从未渲染出任务节点').toBeGreaterThanOrEqual(2)
    expect(allTerminal, `任务未全部终态: ${statuses.join(',')}`).toBe(true)
    const fresh = existsSync(runDir) && readdirSync(runDir).length > 0
    mark('交付目录有产出', fresh, runDir)
    await shot(page, 'dispatch-chain-wave1-final')
  })

  test('increment: 自然语言增量下发 → 任务图在原图上生长', async () => {
    test.setTimeout(INCREMENTAL_MS + 120_000)
    const input = page.locator('textarea').first()
    await input.waitFor({ state: 'visible', timeout: 20_000 })
    await input.fill('很好。在此基础上补一个自动冒烟检查：写个脚本能自动打开页面验证游戏真的能玩，并实际运行一次给出结果。')
    await input.press('Enter')
    mark('增量需求已用自然语言下发', true)

    const deadline = Date.now() + INCREMENTAL_MS
    let grew = false
    let rows: Array<Record<string, unknown>> = []
    while (Date.now() < deadline) {
      await page.waitForTimeout(12_000)
      rows = captainTasks()
      if (rows.length > firstWaveCount) grew = true
      const statuses = rows.map((r) => String(r.status))
      if (grew && statuses.length >= 2 && statuses.every((s) => TERMINAL.has(s))) break
    }

    mark(`增量下发生效（${firstWaveCount} → ${rows.length} 个任务）`, grew, rows.map((r) => `${r.id}:${r.status}`).join(' '))
    expect(grew, '追加需求没有产生新任务——增量派发失效').toBe(true)
    const statuses = rows.map((r) => String(r.status))
    expect(statuses.every((s) => TERMINAL.has(s)), `增量波未全部终态: ${statuses.join(',')}`).toBe(true)

    const list = await fetch(`${BASE_URL}/dsh-weave/task/list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'e2e-graph', method: 'task/list', payload: { sessionId: captainSessionId, limit: 50 } }),
    }).then((r) => r.json() as { result?: { value?: { tasks?: Array<{ dag_id: string; status: string }> } } }).catch(() => undefined)
    const graphTasks = list?.result?.value?.tasks ?? []
    mark('task/list 图数据与 tasks.db 一致', graphTasks.length === rows.length, `rpc=${graphTasks.length} db=${rows.length}`)
    expect(graphTasks.length, 'task/list 与 tasks.db 不一致').toBe(rows.length)

    const dagId = String(graphTasks[0]?.dag_id ?? '')
    if (dagId !== '') {
      const det = await fetch(`${BASE_URL}/dsh-weave/task/get`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'e2e-dag', method: 'task/get', payload: { dagId } }),
      }).then((r) => r.json() as { result?: { value?: { tasks?: unknown[] } } }).catch(() => undefined)
      const detailTasks = det?.result?.value?.tasks ?? []
      mark(`task/get 图详情（${dagId}）`, detailTasks.length >= rows.length, `detail tasks=${detailTasks.length}`)
    }
    await shot(page, 'dispatch-chain-wave2-final')
  })

  test('knowledge: 任务完成后知识沉淀入库', async () => {
    test.setTimeout(6 * 60_000)
    const deadline = Date.now() + 5 * 60_000
    const KNOWLEDGE_DIR = join(homedir(), '.dsh', 'knowledge')
    let hit = ''
    while (Date.now() < deadline) {
      await page.waitForTimeout(15_000)
      const db = openReadOnly('knowledge_meta.db')
      try {
        const rowsDb = db.prepare('SELECT status, created, path FROM knowledge_meta').all() as Array<Record<string, unknown>>
        const fresh = rowsDb.filter((r) => (Date.parse(String(r.created ?? '')) || 0) >= t0 - 60_000)
        if (fresh.length > 0) { hit = fresh.map((r) => `${r.status}:${String(r.path).slice(-60)}`).join(' | '); break }
      } finally { db.close() }
      if (hit === '' && existsSync(KNOWLEDGE_DIR)) {
        for (const d of readdirSync(KNOWLEDGE_DIR)) {
          const dp = join(KNOWLEDGE_DIR, d)
          try {
            for (const f of readdirSync(dp)) {
              const fp = join(dp, f)
              if (statSync(fp).isFile() && statSync(fp).mtimeMs >= t0) hit = `file:${fp.slice(-70)}`
            }
          } catch { /* 非目录 */ }
        }
        if (hit !== '') break
      }
    }
    mark('知识沉淀入库', hit !== '', hit || '5 分钟窗口无新知识')
    expect(hit, '任务完成后没有知识沉淀').not.toBe('')
  })

  test('graph: 代码图谱构建（Graphify extract + flows）', async () => {
    test.setTimeout(5 * 60_000)
    const { GraphService } = await import('../../../../dist/plugins/weave/graph/graph-service.js') as {
      GraphService: new (options: { projectRoot: string }) => { build(): Promise<{ graphPath: string; flowsPath: string }> }
    }
    const svc = new GraphService({ projectRoot: runDir })
    const built = await svc.build()
    mark('GraphService.build() 完成', true, built.graphPath)
    const graphOk = existsSync(built.graphPath)
    const flowsOk = existsSync(built.flowsPath)
    mark('graph.json 落盘', graphOk, built.graphPath)
    mark('flows.json 落盘', flowsOk, built.flowsPath)
    if (graphOk) {
      const parsed = JSON.parse(readFileSync(built.graphPath, 'utf-8')) as { nodes?: unknown[] }
      mark('graph.json 可解析（nodes 数组）', Array.isArray(parsed.nodes), `nodes=${Array.isArray(parsed.nodes) ? parsed.nodes.length : -1}`)
      expect(Array.isArray(parsed.nodes), 'graph.json 缺 nodes').toBe(true)
    }
    expect(graphOk, `缺少 ${built.graphPath}`).toBe(true)
    expect(flowsOk, `缺少 ${built.flowsPath}`).toBe(true)
    await shot(page, 'dispatch-chain-03-graph')
  })
})
