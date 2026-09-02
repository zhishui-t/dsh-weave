// harness 层共享设施：虚拟域 + ModuleLoader 桩 + __WEAVE_RPC__ 信封注册表 stub。
// 被测对象是 dist/client/index.js 真实构建产物与真实 DOM 行为，仅 RPC 数据层可控可断言。
// 运行前提：pnpm build（dist 与 src 同步）；GBK 坑见 doc/e2e-acceptance-plan.md（charset 必须 utf-8）。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, type Page } from '@playwright/test'

const CLIENT_JS = resolve(process.cwd(), 'dist/client/index.js')
const REACT_UMD = resolve(process.cwd(), 'node_modules/react/umd/react.production.min.js')
const REACT_DOM_UMD = resolve(process.cwd(), 'node_modules/react-dom/umd/react-dom.production.min.js')

export type RpcEnvelope = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }
export type RpcCall = { endpoint: string; payload: Record<string, unknown> }

let clientCode = ''
let reactUmd = ''
let reactDomUmd = ''

/** 在 beforeAll 里预读构建产物与 UMD（单次 IO，全部用例复用）。 */
export function loadHarnessAssets(): void {
  clientCode = readFileSync(CLIENT_JS, 'utf8')
  reactUmd = readFileSync(REACT_UMD, 'utf8')
  reactDomUmd = readFileSync(REACT_DOM_UMD, 'utf8')
}

/**
 * 默认 RPC 场景（真实数据形态）：
 * - snapshot 带 1 团队 + 2 执行器；session/status 双成员（RUNNING/IDLE）绑定 seed-team；
 * - task/list 2 条（RUNNING/COMPLETED）；task/get 两节点 DAG（T-A→T-B）；
 * - settings/describe 使用真实键名（state_dir/node_version/…）。
 */
export function defaultScenario(): Record<string, RpcEnvelope> {
  return {
    snapshot: {
      ok: true,
      value: {
        teams: [{
          team_id: 'seed-team',
          name: '种子团队',
          roles: [{ id: 'coder', name: '程序员', executor: 'spawn', stages: ['prepare', 'implement', 'review'] }],
        }],
        executors: [{ id: 'spawn', kind: 'dsh_subagent' }, { id: 'fork', kind: 'dsh_subagent' }],
      },
    },
    'team/delete': { ok: true, value: { existed: true } },
    'team/import': { ok: true, value: { team_id: 'seed-team' } },
    'team/get': {
      ok: true,
      value: {
        schema_version: '1',
        team_id: 'seed-team',
        name: '种子团队',
        default: true,
        roles: [{ id: 'coder', name: '程序员', executor: 'spawn', stages: ['prepare', 'implement', 'review'] }],
      },
    },
    'team/set-default': { ok: true, value: { flipped: ['other-team'] } },
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
          { id: 'kn-1', title: '候选知识', status: 'candidate', layer: 'project', tags: [], kind: 'knowledge', path: 'k/kn-1.md' },
          { id: 'kn-2', title: '相关笔记', status: 'active', layer: 'shared', tags: [], kind: 'knowledge' },
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
    'session/clear-binding': { ok: true, value: {} },
    'audit/list': { ok: true, value: { events: [{ type: 'task.status_changed', time: 1 }] } },
    'settings/describe': {
      ok: true,
      value: {
        version: '0.2.0',
        node_version: 'v20.0.0',
        state_dir: '~/.dsh/weave',
        teams_dir: '~/.dsh/teams',
        audit_dir: '~/.dsh/audit',
        providers_file: '~/providers.json',
        zcode: { configured: true, registered: false },
      },
    },
    'settings/update': { ok: true, value: {} },
    'provider/list': { ok: true, value: { providers: [] } },
  }
}

/**
 * 打开 harness 虚拟页并等 client 挂载（weave-open 可见）。
 * overrides 中的 envelope 按端点覆盖默认场景；value 仅支持可 JSON 序列化对象，
 * 需要按 payload 动态应答时用 setRpcHandler 注入函数。
 */
export async function openHarnessPage(page: Page, overrides?: Record<string, RpcEnvelope>): Promise<void> {
  const scenario = { ...defaultScenario(), ...overrides }
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

/** 注入/覆盖单个 RPC 端点处理器（可按 payload 动态应答；handler 为页面侧函数源码）。 */
export async function setRpcHandler(page: Page, endpoint: string, handlerSource: string): Promise<void> {
  await page.evaluate(({ endpoint, handlerSource }) => {
    ;(window.__WEAVE_RPC__ as Record<string, unknown>)[endpoint] = new Function('return (' + handlerSource + ')')()
  }, { endpoint, handlerSource })
}

/** 读取 harness 记录的 RPC 调用流水（endpoint + payload）。 */
export async function readCalls(page: Page): Promise<RpcCall[]> {
  return (await page.evaluate(() => window.__WEAVE_CALLS__)) as RpcCall[]
}

/** 清空调用流水（分段的调用次数断言互不串扰）。 */
export async function clearCalls(page: Page): Promise<void> {
  await page.evaluate(() => {
    ;(window as unknown as { __WEAVE_CALLS__: unknown[] }).__WEAVE_CALLS__.length = 0
  })
}

/** 打开 Dashboard（等 weave-dashboard 可见）。 */
export async function openDashboardHarness(page: Page): Promise<void> {
  await page.getByTestId('weave-open').click()
  await expect(page.getByTestId('weave-dashboard')).toBeVisible()
}

/** 把 conversation.view 面板（Weave 团队页签）挂载到主区域。 */
export async function mountSessionPanel(page: Page, sessionId = 'sess-h'): Promise<void> {
  await page.evaluate((sid) => {
    const root = document.getElementById('root')!
    root.innerHTML = ''
    window.ReactDOM.createRoot(root).render(
      window.React.createElement(window.__WEAVE_SLOTS__!['conversation.view'], { sessionId: sid }),
    )
  }, sessionId)
}

/** 断言某端点被以指定 payload 子集调用过至少一次。 */
export async function expectCalled(
  page: Page,
  endpoint: string,
  payloadSubset?: Record<string, unknown>,
): Promise<RpcCall> {
  const calls = await readCalls(page)
  const hit = calls.find(
    (call) =>
      call.endpoint === endpoint &&
      (payloadSubset === undefined ||
        Object.entries(payloadSubset).every(([key, value]) =>
          JSON.stringify(call.payload?.[key]) === JSON.stringify(value),
        )),
  )
  expect(hit, `应调用 ${endpoint}${payloadSubset ? ' payload=' + JSON.stringify(payloadSubset) : ''}；实际=${JSON.stringify(calls.map((c) => ({ endpoint: c.endpoint, payload: c.payload })))}`).toBeTruthy()
  return hit!
}

/** 走一遍「挂载面板 → 等 DAG 页签体出现」的公共前缀。 */
export async function openSessionPanelWithDag(page: Page, sessionId = 'sess-h'): Promise<void> {
  await mountSessionPanel(page, sessionId)
  await expect(page.getByTestId('weave-session-panel')).toBeVisible()
  await expect(page.getByTestId('session-tab-dag')).toBeVisible()
  await expect(page.getByTestId('dag-panel')).toBeVisible()
}

/** 声明用例归属（仅用于文件内 test.describe 统一标题）。 */
export const HARNESS_DESCRIBE = 'harness: 构建产物 UI 逻辑（stub RPC）'
