import { test, expect } from '@playwright/test'
test('nav to teams', async ({ page }) => {
  await page.goto('http://127.0.0.1:3080', { waitUntil: 'networkidle' })
  // 左下角 Weave 按钮
  const btn = page.locator('button').filter({ hasText: 'Weave' }).first()
  await expect(btn).toBeVisible({ timeout: 10000 })
  await btn.click()
  await page.waitForTimeout(2000)
  await page.screenshot({ path: '.artifacts/p2-dash.png' })
  // 左侧导航里点「团队」
  const nav = page.locator('button', { hasText: '团队' }).first()
  await nav.click({ timeout: 5000 })
  await page.waitForTimeout(3000)
  await page.screenshot({ path: '.artifacts/p2-teams.png' })
})
