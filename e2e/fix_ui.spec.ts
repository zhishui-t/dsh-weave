import { test } from '@playwright/test'
test('capture current state', async ({ page }) => {
  await page.goto('http://127.0.0.1:3080', { waitUntil: 'networkidle' })
  await page.locator('button').filter({ hasText: 'Weave' }).first().click({ timeout: 10000 })
  await page.waitForTimeout(1500)
  await page.locator('button', { hasText: '团队' }).first().click({ timeout: 5000 })
  await page.waitForTimeout(3000)
  await page.screenshot({ path: '.artifacts/fix-01-teams.png', fullPage: true })
  // 关掉回到会话看DAG
  await page.locator('[data-testid="weave-close"]').click({ timeout: 3000 }).catch(()=>{})
  await page.waitForTimeout(2000)
  await page.screenshot({ path: '.artifacts/fix-02-session-dag.png', fullPage: false })
})
