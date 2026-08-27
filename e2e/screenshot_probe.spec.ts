import { test } from '@playwright/test'

test('screenshot teams page', async ({ page }) => {
  const errors: string[] = []
  const responses: string[] = []
  page.on('console', m => { if(m.type()==='error') errors.push('CONSOLE_ERR:'+m.text().slice(0,200)) })
  page.on('response', r => { if(r.status() >= 400) responses.push(`${r.status()} ${r.method()} ${r.url().slice(0,120)}`) })
  await page.goto('http://127.0.0.1:3080', { waitUntil: 'networkidle' }).catch(()=>{})
  await page.screenshot({ path: '.artifacts/probe-01-home.png', fullPage: false })
  await page.waitForTimeout(3000)
  // 找左下角 Weave 按钮
  const weaveBtn = page.locator('[data-testid="weave-sidebar-action"]').or(page.getByText('Weave')).first()
  try { await weaveBtn.click({ timeout: 5000 }) } catch { console.log('no weave button found') }
  await page.waitForTimeout(2000)
  await page.screenshot({ path: '.artifacts/probe-02-weave-panel.png' })
  // 点团队导航
  const navTeams = page.locator('[data-testid="nav-teams"]')
  try { await navTeams.click({ timeout: 3000 }) } catch {}
  await page.waitForTimeout(3000)
  await page.screenshot({ path: '.artifacts/probe-03-teams.png', fullPage: true })
  console.log('ERRORS:', JSON.stringify(errors))
  console.log('HTTP_FAILS:', JSON.stringify(responses))
})
