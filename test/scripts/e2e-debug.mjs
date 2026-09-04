// t5 诊断探针：抓 tasks 页 page-error 全文 + 全量网络活动（HTTP/WS 双向）
// 运行：node scripts/e2e-debug.mjs [pageKey，默认 tasks]
import { chromium } from 'playwright-core'

const BASE_URL = process.env.WEAVE_E2E_BASE_URL ?? 'http://127.0.0.1:3080'
const EXECUTABLE =
  process.env.PW_CHROME ??
  'C:/Users/10042/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe'
const TARGET = process.argv[2] ?? 'tasks'

const net = []
const browser = await chromium.launch({ executablePath: EXECUTABLE, headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()

page.on('request', (req) => {
  const u = req.url()
  if (/rpc|weave|api\/|query/i.test(u)) net.push(`REQ  ${req.method()} ${u.slice(0, 140)} body=${(req.postData() ?? '').slice(0, 200)}`)
})
page.on('response', async (resp) => {
  const u = resp.url()
  if (!/rpc|weave|api\/|query/i.test(u)) return
  let body = ''
  try {
    body = (await resp.text()).slice(0, 260)
  } catch { /* ignore */ }
  net.push(`RESP ${resp.status()} ${u.slice(0, 140)} ${body}`)
})
page.on('websocket', (ws) => {
  net.push(`WS-OPEN ${ws.url()}`)
  ws.on('framereceived', (f) => {
    const s = typeof f.payload === 'string' ? f.payload : Buffer.from(f.payload).toString('utf8')
    if (/ok|weave|task/i.test(s)) net.push(`WS-R ${s.slice(0, 300)}`)
  })
  ws.on('framesent', (f) => {
    const s = typeof f.payload === 'string' ? f.payload : Buffer.from(f.payload).toString('utf8')
    if (/weave|task/i.test(s)) net.push(`WS-S ${s.slice(0, 300)}`)
  })
})
page.on('pageerror', (e) => net.push(`PAGEERROR ${String(e).slice(0, 300)}`))

await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
await page.getByTestId('weave-open').waitFor({ state: 'visible', timeout: 30_000 })
net.length = 0 // 首屏加载噪音不记
await page.getByTestId('weave-open').click()
await page.getByTestId('weave-dashboard').waitFor({ state: 'visible' })
await page.getByTestId(`nav-${TARGET}`).click()
await page.getByTestId(`page-${TARGET}`).waitFor({ state: 'visible' })
await page.waitForTimeout(2500)

const errNote = page.locator('[data-testid="page-error"]').first()
if (await errNote.isVisible().catch(() => false)) {
  console.log('=== PAGE-ERROR 全文 ===')
  console.log(await errNote.innerText())
} else {
  console.log('=== 无 page-error ===')
}
console.log(`\n=== 网络活动 (${net.length}) ===`)
for (const line of net.slice(0, 60)) console.log(line)
await browser.close()
