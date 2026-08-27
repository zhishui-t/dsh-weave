import { test } from '@playwright/test'
test('full ui walkthrough', async ({ page }) => {
  await page.goto('http://127.0.0.1:3080', { waitUntil: 'networkidle' })
  await page.locator('button').filter({ hasText: 'Weave' }).first().click({ timeout: 10000 })
  await page.waitForTimeout(1500)
  // 1. 团队页
  await page.locator('button', { hasText: '团队' }).first().click({ timeout: 5000 })
  await page.waitForTimeout(3000)
  await page.screenshot({ path: '.artifacts/final-teams.png' })
  // 2. 点详情看展开效果
  await page.locator('button', { hasText: '详情' }).first().click({ timeout: 3000 }).catch(()=>{})
  await page.waitForTimeout(2000)
  await page.screenshot({ path: '.artifacts/final-teams-detail.png' })
  // 3. 关控制台，进会话，点 Weave 团队 tab
  await page.locator('[data-testid="weave-close"]').click({ timeout: 3000 }).catch(()=>{})
  await page.waitForTimeout(2000)
  await page.locator('text=启用下团队长安').first().click({ timeout: 5000 }).catch(()=>{})
  await page.waitForTimeout(3000)
  await page.locator('text=Weave 团队').first().click({ timeout: 5000 }).catch(()=>{})
  await page.waitForTimeout(4000)
  await page.screenshot({ path: '.artifacts/final-session-panel.png', fullPage: true })
})
