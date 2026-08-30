// 壳与导航：入口开合、七页可达、data-active 切换、已移除页签不复活。
// 覆盖范围 ②「控制台七页：可达性」的壳层部分。
import { expect, test } from '@playwright/test'

import { ROUTES } from '../helpers'
import { HARNESS_DESCRIBE, loadHarnessAssets, openDashboardHarness, openHarnessPage } from '../harness/fixtures'

test.beforeAll(loadHarnessAssets)

test.describe(HARNESS_DESCRIBE, () => {
  test('shell: weave-open 开合 Dashboard，weave-close 卸载且可重开', async ({ page }) => {
    await openHarnessPage(page)
    await openDashboardHarness(page)
    await expect(page.getByTestId('weave-nav')).toBeVisible()
    await expect(page.locator('.weave-title')).toContainText('Weave 控制台')

    await page.getByTestId('weave-close').click()
    await expect(page.getByTestId('weave-dashboard')).toBeHidden()

    // 关闭后可重开（portal 卸载/重挂载完整）
    await openDashboardHarness(page)
    await expect(page.getByTestId('weave-nav')).toBeVisible()
  })

  test('nav: 七页逐一可达，page-* 可见且 nav data-active 唯一切换', async ({ page }) => {
    await openHarnessPage(page)
    await openDashboardHarness(page)
    for (const key of ROUTES) {
      await page.getByTestId(`nav-${key}`).click()
      const pageEl = page.getByTestId(`page-${key}`)
      await expect(pageEl).toBeVisible()
      await expect(page.getByTestId(`nav-${key}`)).toHaveAttribute('data-active', 'true')
      // 其余页面全部隐藏（单页激活）
      const visibleOthers = ROUTES.filter((other) => other !== key)
        .map((other) => page.getByTestId(`page-${other}`))
      for (const other of visibleOthers) await expect(other).toHaveCount(0)
    }
  })

  test('nav: 任务中心/会话管理不复存在，运行时信息收敛到会话面板', async ({ page }) => {
    await openHarnessPage(page)
    await openDashboardHarness(page)
    await expect(page.getByTestId('nav-tasks')).toHaveCount(0)
    await expect(page.getByTestId('nav-sessions')).toHaveCount(0)
    // 会话面板槽位已注册（运行时唯一出口）
    const hasPanelSlot = await page.evaluate(
      () => Boolean((window as unknown as { __WEAVE_SLOTS__: Record<string, unknown> }).__WEAVE_SLOTS__['conversation.view']),
    )
    expect(hasPanelSlot).toBe(true)
  })

  test('overview: 总览含修订记录区块（保温期），空数据给明确空态', async ({ page }) => {
    await openHarnessPage(page)
    await openDashboardHarness(page)
    await page.getByTestId('nav-overview').click()
    await expect(page.getByTestId('page-overview')).toBeVisible()
    await expect(page.getByText('最近修订记录（保温期）')).toBeVisible()
    // 默认场景 revisions 为空 → 空态而非空白
    await expect(page.getByTestId('page-empty')).toBeVisible()
  })

  test('manual: 命令手册每条命令一行（command-row-*）', async ({ page }) => {
    await openHarnessPage(page)
    await openDashboardHarness(page)
    await page.getByTestId('nav-manual').click()
    await expect(page.getByTestId('page-manual')).toBeVisible()
    const rows = page.locator('[data-testid^="command-row-"]')
    const count = await rows.count()
    expect(count).toBeGreaterThan(0)
    // 每行都带命令名（b 元素）与说明
    for (let i = 0; i < count; i += 1) {
      await expect(rows.nth(i).locator('b')).not.toBeEmpty()
    }
  })
})
