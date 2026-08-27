// Weave 控制台确定性 UI 验收（t5 harness 层）。
// 运行：pnpm test:e2e:harness
// 原理：page.route 提供 https://weave.test 虚拟页 —— React/ReactDOM UMD + ModuleLoader 桩 +
// dist/client/index.js 构建产物；connection.rpc 由 window.__WEAVE_RPC__ 信封注册表stub。
// 被测对象是真实构建产物与真实 DOM 行为，仅 RPC 数据层可控可断言。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const CLIENT_JS = resolve(process.cwd(), 'dist/client/index.js')
const REACT_UMD = resolve(process.cwd(), 'node_modules/react/umd/react.production.min.js')
const REACT_DOM_UMD = resolve(process.cwd(), 'node_modules/react-dom/umd/react-dom.production.min.js')

type RpcEnvelope = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }

let clientCode = ''
let reactUmd = ''
let reactDomUmd = ''

test.beforeAll(() => {
  clientCode = readFileSync(CLIENT_JS, 'utf8')
  reactUmd = readFileSync(REACT_UMD, 'utf8')
  reactDomUmd = readFileSync(REACT_DOM_UMD, 'utf8')
})

/** 默认 RPC 场景：snapshot 有真实形态的执行器/ZCode 目录，各列表给最小非空数据。 */
function defaultScenario(): Record<string, RpcEnvelope> {
  return {
    snapshot: {
      ok: true,
      value: {
        teams: [{ id: 'seed-team', name: '种子团队', roles: 1 }],
        executors: [{ id: 'spawn', kind: 'dsh_subagent' }, { id: 'fork', kind: 'dsh_subagent' }],
      },
    },
    'team/delete': { ok: true, value: { existed: true } },
    'task/list': {
      ok: true,
      value: {
        total: 2,
        tasks: [
          { id: 'T-A', dag_id: 'D1', project: 'proj-a', version: 'v1', status: 'RUNNING', updated_at: 1 },
          { id: 'T-B', dag_id: 'D1', project: 'proj-b', version: 'v1', status: 'COMPLETED', updated_at: 2 },
        ],
      },
    },
    'task/get': {
      ok: true,
      value: {
        dag_id: 'D1',
        status: 'running',
        tasks: [
          { id: 'T-A', description: '实现登录页', status: 'RUNNING', dependencies: [], assigned_agent: 'coder' },
          { id: 'T-B', description: '校验产物', status: 'COMPLETED', dependencies: ['T-A'], assigned_agent: 'reviewer' },
        ],
        edges: [{ from: 'T-A', to: 'T-B' }],
      },
    },
    'task/action': { ok: true, value: { task_id: 'T-A', status: 'CANCELLED' } },
    'knowledge/list': {
      ok: true,
      value: { candidates: [{ id: 'kn-1', title: '候选知识', status: 'candidate', layer: 'project' }] },
    },
    'knowledge/graph': {
      ok: true,
      value: {
        nodes: [
          { id: 'kn-1', title: '候选知识', status: 'candidate', layer: 'project', tags: [] , kind: 'knowledge', path: 'k/kn-1.md' },
          { id: 'kn-2', title: '相关笔记', status: 'active', layer: 'shared', tags: [] , kind: 'knowledge' },
        ],
        edges: [{ source: 'kn-1', target: 'kn-2' }],
        counts: { knowledge: 2, missing: 0, edges: 1, unresolved: 0, skipped: 0 },
      },
    },
    'knowledge/approve': { ok: true, value: {} },
    'knowledge/reject': { ok: true, value: {} },
    'session/bindings': { ok: true, value: { bindings: [] } },
    'session/revisions': { ok: true, value: { revisions: [] } },
    'session/status': {
      ok: true,
      value: {
        session_id: 'sess-h',
        team: { team_id: 'seed-team', name: '种子团队' },
        members: [
          { role_id: 'coder', name: '程序员', executor: 'spawn', status: 'running', task_id: 'T-A', subject: '实现登录页' },
          { role_id: 'reviewer', name: '审核员', executor: 'fork', status: 'idle' },
        ],
      },
    },
    'session/set-binding': { ok: true, value: { session_id: 'sess-h', team_id: 'beta' } },
    'audit/list': { ok: true, value: { events: [{ type: 'task.status_changed', time: 1 }] } },
    'settings/describe': { ok: true, value: { stateDir: '~/.dsh/weave', version: '0.2.0', teams_dir: '/teams', audit_dir: '/audit', obsidian_dir: '~/.dsh/obsidian' } },
  }
}

async function openHarnessPage(page: Page, scenarioOverrides?: Record<string, RpcEnvelope>): Promise<void> {
  const scenario = { ...defaultScenario(), ...scenarioOverrides }
  await page.route('https://weave.test/**', async (route) => {
    const url = new URL(route.request().url())
    switch (url.pathname) {
      case '/': {
        const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div>
<script src="https://weave.test/react.js"></script>
<script src="https://weave.test/react-dom.js"></script>
<script>window.__WEAVE_RPC__ = ${JSON.stringify(scenario)}; window.__WEAVE_CALLS__ = [];
window.__ModuleLoader__ = { load(reg){ window.__WEAVE_REG__ = reg } };</script>
<script src="https://weave.test/client.js"></script>
<script>(() => {
  const requireMap = (id) => {
    if (id === 'react') return window.React
    if (id === 'react-dom') return window.ReactDOM
    throw new Error('unexpected dependency: ' + id)
  }
  const mod = window.__WEAVE_REG__.factory(requireMap)
  const ctx = {
    effect(fn){ fn() },
    get(service){
      if (service !== 'connection') throw new Error('unexpected service: ' + service)
      return { rpc: { async call(_ch, endpoint, payload){
        window.__WEAVE_CALLS__.push({ endpoint, payload })
        const handler = window.__WEAVE_RPC__[endpoint]
        if (!handler) return { ok:false, error:{ code:'no-mock', message:'未配置 mock: '+endpoint } }
        const envelope = typeof handler === 'function' ? handler(payload) : handler
        return typeof envelope === 'object' && envelope !== null && 'ok' in envelope
          ? envelope : { ok:true, value:envelope }
      } } }
    },
    slots: {
      inject(_slot, register){ register() },
      register(def, registered){
        window.__WEAVE_SLOTS__ = window.__WEAVE_SLOTS__ || {}
        if (def && def.name) window.__WEAVE_SLOTS__[def.name] = registered
        if (!def || def.name === 'sidebar.footer.action') window.__WEAVE_ACTION__ = registered
      },
    },
  }
  mod.apply(ctx)
  window.ReactDOM.createRoot(document.getElementById('root')).render(
    window.React.createElement(window.__WEAVE_ACTION__),
  )
})()</script></body></html>`
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html })
      }
      case '/client.js':
        return route.fulfill({ contentType: 'application/javascript; charset=utf-8', body: clientCode })
      case '/react.js':
        return route.fulfill({ contentType: 'application/javascript; charset=utf-8', body: reactUmd })
      case '/react-dom.js':
        return route.fulfill({ contentType: 'application/javascript; charset=utf-8', body: reactDomUmd })
      default:
        return route.fulfill({ status: 404, body: 'unexpected request: ' + url.pathname })
    }
  })
  const logs: string[] = []
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 200)}`))
  page.on('pageerror', (e) => logs.push(`[pageerror] ${String(e).slice(0, 300)}`))
  await page.goto('https://weave.test/')
  try {
    await page.getByTestId('weave-open').waitFor({ state: 'visible', timeout: 20_000 })
  } catch {
    const state = await page
      .evaluate(() => ({
        reg: typeof window.__WEAVE_REG__,
        action: typeof window.__WEAVE_ACTION__,
        btns: document.querySelectorAll('[data-testid="weave-open"]').length,
        rootChildren: document.getElementById('root')?.children.length ?? -1,
      }))
      .catch(() => null)
    throw new Error(
      `harness mount failed; state=${JSON.stringify(state)}; logs=${logs.join(' || ').slice(0, 900)}`,
    )
  }
}

test.describe('harness: 构建产物 UI 逻辑（stub RPC）', () => {
  test('shell+nav: 七页可达且 data-active 正确切换；任务中心/会话管理不复存在', async ({ page }) => {
    await openHarnessPage(page)
    await page.getByTestId('weave-open').click()
    await expect(page.getByTestId('weave-dashboard')).toBeVisible()
    for (const key of ['overview', 'teams', 'knowledge', 'executors', 'audit', 'settings', 'manual'] as const) {
      await page.getByTestId(`nav-${key}`).click()
      await expect(page.getByTestId(`page-${key}`)).toBeVisible()
      await expect(page.getByTestId(`nav-${key}`)).toHaveAttribute('data-active', 'true')
    }
    await expect(page.locator('.weave-title')).toContainText('Weave 控制台 · 使用手册')
    await expect(page.getByTestId('nav-tasks')).toHaveCount(0)
    await expect(page.getByTestId('nav-sessions')).toHaveCount(0)
    // 总览带修订记录区块（原会话管理职责并入）
    await page.getByTestId('nav-overview').click()
    await expect(page.getByText('最近修订记录（保温期）')).toBeVisible()
  })

  /** 把 conversation.view 面板挂载到主区域。 */
  async function mountSessionPanel(page: Page, sessionId = 'sess-h'): Promise<void> {
    await page.evaluate((sid) => {
      const root = document.getElementById('root')!
      root.innerHTML = ''
      window.ReactDOM.createRoot(root).render(
        window.React.createElement(window.__WEAVE_SLOTS__!['conversation.view'], { sessionId: sid }),
      )
    }, sessionId)
  }

  test('session-panel: 团队头+成员卡片+本会话DAG；RUNNING 节点默认选中并出现治理动作', async ({ page }) => {
    await openHarnessPage(page)
    await mountSessionPanel(page)

    await expect(page.getByTestId('weave-session-panel')).toBeVisible()
    await expect(page.getByTestId('weave-session-team-name')).toContainText('种子团队')
    await expect(page.getByTestId('weave-session-team-name')).not.toContainText('（自动）')
    const coderCard = page.getByTestId('member-card-coder')
    await expect(coderCard).toContainText('程序员')
    await expect(coderCard).toContainText('执行中')
    await expect(coderCard).toContainText('实现登录页')
    await expect(page.getByTestId('member-card-reviewer')).toContainText('空闲')

    // 本会话 DAG 按sessionId 过滤请求 + 两节点图渲染
    const calls = (await page.evaluate(() => window.__WEAVE_CALLS__)) as Array<{ endpoint: string; payload: unknown }>
    const listCall = calls.find((c) => c.endpoint === 'task/list')
    expect(listCall).toBeTruthy()
    expect(listCall!.payload).toMatchObject({ sessionId: 'sess-h' })
    await expect(page.getByTestId('dag-node-T-A')).toBeVisible()
    await expect(page.getByTestId('dag-node-T-B')).toBeVisible()
    await expect(page.getByTestId('dag-edges').locator('line')).toHaveCount(1)
    // 默认选中首个节点 T-A（RUNNING）→ 出现取消动作；含 confirm 门径，dismiss 后不发 action
    await expect(page.getByTestId('session-task-action-cancel-T-A')).toContainText('取消')
    await page.getByTestId('session-task-action-cancel-T-A').click()
    const after = (await page.evaluate(() => window.__WEAVE_CALLS__)) as Array<{ endpoint: string }>
    expect(after.filter((c) => c.endpoint === 'task/action')).toHaveLength(0)
  })

  test('session-panel: 零仪式（resolved_via=default/single）标注 + 无法确定时的空态', async ({ page }) => {
    // 默认团队自动生效：头部带「（自动）」标记，成员照常渲染
    await openHarnessPage(page, {
      'session/status': {
        ok: true,
        value: {
          session_id: 'sess-auto',
          team: { team_id: 'seed-team', name: '种子团队' },
          resolved_via: 'default',
          members: [{ role_id: 'coder', name: '程序员', executor: 'spawn', status: 'idle' }],
        },
      },
    })
    await mountSessionPanel(page, 'sess-auto')
    await expect(page.getByTestId('weave-session-team-name')).toContainText('种子团队（自动）')

    // 多团队且无默认：引导空态，不发任务请求
    await openHarnessPage(page, {
      'session/status': { ok: true, value: { session_id: 'sess-x', team: null, resolved_via: null, members: [] } },
    })
    await mountSessionPanel(page, 'sess-x')
    await expect(page.getByTestId('page-empty')).toBeVisible()
    await expect(page.getByTestId('page-empty')).toContainText('无法确定本次会话的团队')
    const calls = (await page.evaluate(() => window.__WEAVE_CALLS__)) as Array<{ endpoint: string }>
    expect(calls.some((c) => c.endpoint === 'task/get')).toBe(false)
    // 未确定团队：任务列表轮询一并跳过
    expect(calls.some((c) => c.endpoint === 'task/list')).toBe(false)
  })

  test('teams: 创建按钮文案随角色数变化，执行器下拉来自 snapshot', async ({ page }) => {
    await openHarnessPage(page)
    await page.getByTestId('weave-open').click()
    await page.getByTestId('nav-teams').click()
    await page.getByTestId('team-id-input').waitFor()
    const select = page.locator('[data-testid="role-editor-0"] select').first()
    await expect(select.locator('option')).toHaveCount(2)
    await expect(page.getByTestId('team-create-submit')).toContainText('包含 1 个角色')
    await page.getByTestId('team-add-role').click()
    await expect(page.getByTestId('role-editor-1')).toBeVisible()
    await expect(page.getByTestId('team-create-submit')).toContainText('包含 2 个角色')
  })

  test('knowledge: reject 两步流必须填理由并携带 payload', async ({ page }) => {
    await openHarnessPage(page)
    // reject 走浏览器原生 confirm 门径，headless 默认 dismiss 会静默取消操作
    page.on('dialog', (dialog) => void dialog.accept())
    await page.getByTestId('weave-open').click()
    await page.getByTestId('nav-knowledge').click()
    await page.getByTestId('knowledge-reject-kn-1').click()
    const reason = page.getByTestId('knowledge-reason-kn-1')
    await reason.fill('依据过期')
    await page.getByTestId(`knowledge-reject-confirm-kn-1`).click()
    const calls = (await page.evaluate(() => window.__WEAVE_CALLS__)) as Array<{ endpoint: string; payload: unknown }>
    const rejectCall = calls.find((c) => c.endpoint === 'knowledge/reject')
    expect(rejectCall).toBeTruthy()
    expect(rejectCall!.payload).toMatchObject({ id: 'kn-1' })
  })

  test('error-path: 失败信封渲染为页面错误态（含 code: message）', async ({ page }) => {
    await openHarnessPage(page, {
      'audit/list': { ok: false, error: { code: 'invalid_argument', message: '时间区间非法' } },
    })
    await page.getByTestId('weave-open').click()
    await page.getByTestId('nav-audit').click()
    const note = page.getByTestId('page-error')
    await expect(note).toBeVisible()
    await expect(note).toContainText('invalid_argument')
    await expect(note).toContainText('时间区间非法')
  })
})
