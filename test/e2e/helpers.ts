import type { Page, Response } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** 真实 DSH Web 地址；可用 env 覆盖。 */
export const BASE_URL = process.env.WEAVE_E2E_BASE_URL ?? 'http://127.0.0.1:3080'
/** 本机已安装 Chromium；版本不匹配时可用 PW_CHROME 覆盖。 */
export const EXECUTABLE =
  process.env.PW_CHROME ??
  'C:/Users/10042/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe'
/** 截图与 trace 汇总目录（gitignore）。两层用例统一落在 weave-ui/e2e/ 下。 */
export const ART = resolve(process.cwd(), '.artifacts/weave-ui/e2e')
/** Dashboard 七个路由 key（任务中心/会话管理已移除，运行时信息在会话面板）。 */
export const ROUTES = ['overview', 'teams', 'knowledge', 'executors', 'audit', 'settings', 'manual'] as const
/** live 层 env 门控：仅 WEAVE_E2E_LIVE=1 时运行（harness 层不受影响，CI 常驻）。 */
export const LIVE_ENABLED = process.env.WEAVE_E2E_LIVE === '1'

mkdirSync(ART, { recursive: true })

/** 探测真实 DSH Web 是否可达（结果进程内缓存；异常一律视为不可达）。 */
let serverReachable: boolean | null = null
export async function probeServer(): Promise<boolean> {
  if (serverReachable !== null) return serverReachable
  try {
    const resp = await fetch(BASE_URL, { signal: AbortSignal.timeout(5000) })
    serverReachable = resp.status < 500
  } catch {
    serverReachable = false
  }
  return serverReachable
}

export type NetIssue = { status: number; url: string }
export type RpcIssue = { endpoint: string; message: string }

export type Observed = {
  httpIssues: NetIssue[]
  rpcFailures: RpcIssue[]
  rpcOk: Map<string, number>
  pageErrors: string[]
}

function scanEnvelopeText(state: Observed, raw: unknown): void {
  const text = typeof raw === 'string' ? raw : Buffer.from(raw as Uint8Array).toString('utf8')
  if (!text.includes('/dsh-weave')) return
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return
  }
  walk(parsed)
  function walk(node: unknown): void {
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (node && typeof node === 'object') {
      const item = node as Record<string, unknown>
      if (typeof item.ok === 'boolean' && ('value' in item || 'error' in item)) {
        const ep = String(item.endpoint ?? item.method ?? 'unknown')
        if (item.ok) state.rpcOk.set(ep, (state.rpcOk.get(ep) ?? 0) + 1)
        else {
          const err = item.error as { message?: string } | undefined
          state.rpcFailures.push({ endpoint: ep, message: String(err?.message ?? 'unknown') })
        }
      }
      Object.values(item).forEach(walk)
    }
  }
}

/** 给页面挂观察器：HTTP>=400、/dsh-weave 信封成败、未捕获异常。每个用例独立一份。 */
export function observe(page: Page): Observed {
  const state: Observed = { httpIssues: [], rpcFailures: [], rpcOk: new Map(), pageErrors: [] }
  page.on('pageerror', (err) => state.pageErrors.push(String(err)))
  page.on('response', (resp: Response) => {
    if (resp.status() >= 400) state.httpIssues.push({ status: resp.status(), url: resp.url() })
    if (resp.url().includes('/dsh-weave')) {
      resp.text().then((body) => {
        try {
          const msg = JSON.parse(body) as { result?: { ok?: boolean; error?: { message?: string }; endpoint?: string } }
          const result = msg.result
          if (result && typeof result.ok === 'boolean') {
            const ep = result.endpoint ?? new URL(resp.url()).pathname.replace('/dsh-weave/', '')
            if (result.ok) state.rpcOk.set(ep, (state.rpcOk.get(ep) ?? 0) + 1)
            else state.rpcFailures.push({ endpoint: ep, message: String(result.error?.message ?? 'unknown') })
          }
        } catch {
          /* 非 JSON 响应体，忽略 */
        }
      }).catch(() => {})
    }
  })
  page.on('websocket', (ws) => {
    ws.on('framereceived', (frame) => scanEnvelopeText(state, frame.payload))
  })
  return state
}

export function mergeObserved(states: Observed[]): Required<Pick<Observed, 'httpIssues' | 'rpcFailures' | 'pageErrors'>> & { rpcOk: Record<string, number> } {
  const rpcOk: Record<string, number> = {}
  const out = { httpIssues: [] as NetIssue[], rpcFailures: [] as RpcIssue[], pageErrors: [] as string[], rpcOk }
  for (const s of states) {
    out.httpIssues.push(...s.httpIssues)
    out.rpcFailures.push(...s.rpcFailures)
    out.pageErrors.push(...s.pageErrors)
    for (const [k, v] of s.rpcOk) rpcOk[k] = (rpcOk[k] ?? 0) + v
  }
  return out
}

export async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: resolve(ART, `${name}.png`) })
}

/** 打开真实 DSH Web 并进入 Weave Dashboard。 */
export async function openDashboard(page: Page): Promise<void> {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
  await page.getByTestId('weave-open').waitFor({ state: 'visible', timeout: 30_000 })
  await page.getByTestId('weave-open').click()
  await page.getByTestId('weave-dashboard').waitFor({ state: 'visible', timeout: 15_000 })
}

/** 断言当前页面没有渲染错误态。 */
export async function expectNoPageError(page: Page, where: string): Promise<void> {
  const note = page.locator('[data-testid="page-error"]').first()
  if (await note.isVisible().catch(() => false)) {
    throw new Error(`${where} 出现 page-error: ${(await note.innerText()).slice(0, 300)}`)
  }
}

export type StepRecord = { name: string; ok: boolean; info?: string }

export function recordStep(records: StepRecord[], name: string): (info?: string) => void {
  return (info?: string) => {
    records.push({ name, ok: !info, info })
    console.log(`${info ? 'FAIL' : 'PASS'} ${name}${info ? `: ${info.slice(0, 200)}` : ''}`)
  }
}

export function writeReport(payload: unknown, name = 'live-report.json'): void {
  writeFileSync(resolve(ART, name), JSON.stringify(payload, null, 2))
}
