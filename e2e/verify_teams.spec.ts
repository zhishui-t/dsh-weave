import { test } from '@playwright/test'
test('verify teams visible', async ({ page }) => {
  const errs: string[] = []
  page.on('response', r => { if(r.status() >= 400) errs.push(`${r.status()} ${r.url().slice(0,100)}`) })
  await page.goto('http://127.0.0.1:3080', { waitUntil: 'networkidle' })
  await page.locator('button').filter({ hasText: 'Weave' }).first().click({ timeout: 10000 })
  await page.waitForTimeout(2000)
  await page.locator('button', { hasText: '团队' }).first().click({ timeout: 5000 })
  await page.waitForTimeout(4000)
  await page.screenshot({ path: '.artifacts/verify-final.png' })
  const hasChangan = await page.getByText('changan').first().isVisible().catch(() => false)
  const has405 = await page.getByText('405').first().isVisible().catch(() => false)
  console.log('changan visible:', hasChangan, '| 405 visible:', has405, '| http errs:', JSON.stringify(errs.slice(0,3)))
})
