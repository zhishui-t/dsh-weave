/**
 * T8 console-pages e2e: U1-U3（harness UI + 构建产物）
 *
 * U1 未构建图谱 → 代码图谱页空态 + 构建按钮
 * U2 构建中 → 显示“构建中...”，不重复提交 code/build
 * U3 RPC 错误 → 显示明确错误提示，不显示假数据
 */
import { expect, test } from '@playwright/test'

import {
  loadHarnessAssets,
  openDashboardHarness,
  openHarnessPage,
  readCalls,
  setRpcHandler,
} from './harness/fixtures'

test.beforeAll(loadHarnessAssets)

test.describe('T8 console-pages U1-U3', () => {
  test('U1: 未构建图谱 → 代码图谱页空态 + 构建按钮', async ({ page }) => {
    await openHarnessPage(page, {
      'code/graph': { ok: false, error: { code: 'configuration_error', message: '代码图谱尚未构建，请先执行 pnpm code:scan' } },
    })
    await openDashboardHarness(page)
    await page.getByTestId('nav-code').click()

    await expect(page.getByTestId('page-code')).toBeVisible()
    await expect(page.getByTestId('code-empty')).toBeVisible()
    await expect(page.getByTestId('code-build')).toBeVisible()
    await expect(page.getByTestId('code-copy-command')).toBeVisible()
    // 未构建时不应出现伪造摘要
    await expect(page.getByTestId('code-summary-nodes')).toHaveCount(0)
  })

  test('U2: 构建中 → 显示构建中，不重复提交 code/build', async ({ page }) => {
    await openHarnessPage(page, {
      'code/graph': {
        ok: true,
        value: {
          nodeCount: 3,
          edgeCount: 3,
          communityCount: 1,
          graphPath: 'K:/work/project/weave/.graphify/graph.json',
          flowsPath: 'K:/work/project/weave/.graphify/flows.json',
          hasFlows: true,
        },
      },
    })
    await openDashboardHarness(page)
    await page.getByTestId('nav-code').click()
    await expect(page.getByTestId('code-summary-nodes')).toBeVisible()

    // code/build 延迟 500ms 完成，模拟真实构建过程
    await setRpcHandler(
      page,
      'code/build',
      `(payload) => new Promise(resolve => setTimeout(() => resolve({
        ok: true,
        value: { graphPath: 'K:/work/project/weave/.graphify/graph.json', flowsPath: 'K:/work/project/weave/.graphify/flows.json' }
      }), 500))`,
    )
    await page.getByTestId('code-build').click()

    const buildButton = page.getByTestId('code-build')
    await expect(buildButton).toBeDisabled()
    await expect(buildButton).toContainText('构建中...')
    await expect(buildButton).toContainText('构建中...')

    // 构建完成并可再次操作
    await expect(buildButton).toBeEnabled({ timeout: 5_000 })
    await expect(buildButton).not.toContainText('构建中...')

    const calls = await readCalls(page)
    const buildCalls = calls.filter((call) => call.endpoint === 'code/build')
    expect(buildCalls).toHaveLength(1)
  })

  test('U3: code/graph RPC 错误 → 明确错误提示，不显示假数据', async ({ page }) => {
    await openHarnessPage(page, {
      'code/graph': { ok: false, error: { code: 'bad-request', message: '图谱服务暂不可用' } },
    })
    await openDashboardHarness(page)
    await page.getByTestId('nav-code').click()

    await expect(page.getByTestId('page-code')).toBeVisible()
    await expect(page.getByTestId('code-empty')).toBeVisible()
    await expect(page.getByTestId('page-error')).toBeVisible()
    await expect(page.getByTestId('page-error')).toContainText('图谱服务暂不可用')
    await expect(page.getByTestId('code-summary-nodes')).toHaveCount(0)
  })
})
