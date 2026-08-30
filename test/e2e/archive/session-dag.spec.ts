// ① DAG 页签交互与治理动作：默认聚焦 RUNNING 节点、聚焦迁移、
// 动作按钮严格等于 TASK_ACTIONS_BY_STATUS 矩阵、confirm/revise 门径与 task/action payload。
import { expect, test } from '@playwright/test'

import { HARNESS_DESCRIBE, clearCalls, loadHarnessAssets, mountSessionPanel, openHarnessPage, readCalls } from '../harness/fixtures'

test.beforeAll(loadHarnessAssets)

test.describe(HARNESS_DESCRIBE, () => {
  test('focus: DAG 页签默认激活，首个节点默认选中并展示详情', async ({ page }) => {
    await openHarnessPage(page)
    await mountSessionPanel(page)
    await expect(page.getByTestId('session-tab-dag')).toHaveClass(/weave-tab-active/)
    await expect(page.getByTestId('dag-panel')).toBeVisible()
    // 派生选中：首个任务 data-selected=true（但 focusPinned=false，不触发暗化）
    await expect(page.getByTestId('dag-node-T-A')).toHaveAttribute('data-selected', 'true')
    await expect(page.getByTestId('dag-node-T-B')).toHaveAttribute('data-selected', 'false')
    const detail = page.getByTestId('weave-session-task-detail')
    await expect(detail).toBeVisible()
    await expect(detail).toContainText('A') // shortTaskId('T-A') → 'A'
  })

  test('focus: 点击另一节点迁移选中并切换详情', async ({ page }) => {
    await openHarnessPage(page)
    await mountSessionPanel(page)
    await page.getByTestId('dag-node-T-B').click()
    await expect(page.getByTestId('dag-node-T-B')).toHaveAttribute('data-selected', 'true')
    await expect(page.getByTestId('dag-node-T-A')).toHaveAttribute('data-selected', 'false')
    // COMPLETED 无治理动作 → 详情不出现动作按钮
    await expect(page.getByTestId('weave-session-task-detail')).toContainText('B')
    await expect(page.locator('[data-testid^="session-task-action-"]')).toHaveCount(0)
  })

  test('focus: 选中有可见高亮（border 品牌色）而非仅属性', async ({ page }) => {
    await openHarnessPage(page)
    await mountSessionPanel(page)
    // 点选固定聚焦后，节点边框应为品牌色
    await page.getByTestId('dag-node-T-A').click()
    const borderColor = await page
      .getByTestId('dag-node-T-A')
      .evaluate((el) => getComputedStyle(el).borderTopColor)
    expect(borderColor).toBe('rgb(22, 119, 255)')
  })

  test('actions: 动作矩阵——RUNNING 只有取消(confirm)', async ({ page }) => {
    await openHarnessPage(page)
    await mountSessionPanel(page)
    await expect(page.getByTestId('session-task-action-cancel-T-A')).toBeVisible()
    await expect(page.getByTestId('session-task-action-skip-T-A')).toHaveCount(0)
    await expect(page.getByTestId('session-task-action-retry-T-A')).toHaveCount(0)
  })

  test('actions: AWAITING_FEEDBACK → 返工/验收/跳过；FAILED → 重试/跳过', async ({ page }) => {
    await openHarnessPage(page, {
      'task/get': {
        ok: true,
        value: {
          dag_id: 'D1',
          status: 'running',
          tasks: [
            { id: 'T-FB', description: '待反馈任务', status: 'AWAITING_FEEDBACK', dependencies: [] },
            { id: 'T-FL', description: '失败任务', status: 'FAILED', dependencies: ['T-FB'] },
          ],
          edges: [{ from: 'T-FB', to: 'T-FL' }],
        },
      },
    })
    await mountSessionPanel(page)
    // 默认聚焦首个节点 T-FB
    for (const action of ['revise', 'accept', 'skip']) {
      await expect(page.getByTestId(`session-task-action-${action}-T-FB`)).toBeVisible()
    }
    await expect(page.getByTestId('session-task-action-cancel-T-FB')).toHaveCount(0)
    // 聚焦 FAILED 节点
    await page.getByTestId('dag-node-T-FL').click()
    await expect(page.getByTestId('session-task-action-retry-T-FL')).toBeVisible()
    await expect(page.getByTestId('session-task-action-skip-T-FL')).toBeVisible()
    await expect(page.getByTestId('session-task-action-cancel-T-FL')).toHaveCount(0)
  })

  test('actions: INTERRUPTED → 重试/取消；CLOSED → 重新打开', async ({ page }) => {
    await openHarnessPage(page, {
      'task/get': {
        ok: true,
        value: {
          dag_id: 'D1',
          status: 'running',
          tasks: [
            { id: 'T-IR', description: '被中断任务', status: 'INTERRUPTED', dependencies: [] },
            { id: 'T-CL', description: '已关闭任务', status: 'CLOSED', dependencies: ['T-IR'] },
          ],
          edges: [{ from: 'T-IR', to: 'T-CL' }],
        },
      },
    })
    await mountSessionPanel(page)
    await expect(page.getByTestId('session-task-action-retry-T-IR')).toBeVisible()
    await expect(page.getByTestId('session-task-action-cancel-T-IR')).toBeVisible()
    await page.getByTestId('dag-node-T-CL').click()
    await expect(page.getByTestId('session-task-action-reopen-T-CL')).toBeVisible()
    await expect(page.locator('[data-testid^="session-task-action-"]')).toHaveCount(1)
  })

  test('cancel: confirm 门径——dismiss 不发请求，confirm 发 task/action 并刷新', async ({ page }) => {
    await openHarnessPage(page)
    await mountSessionPanel(page)
    await expect(page.getByTestId('dag-panel')).toBeVisible()
    await clearCalls(page)

    // 打开确认框后取消：不发 task/action
    await page.getByTestId('session-task-action-cancel-T-A').click()
    const dialog = page.getByTestId('session-confirm-action')
    await expect(dialog).toBeVisible()
    await page.getByTestId('session-confirm-action-cancel').click()
    await expect(dialog).toBeHidden()
    expect((await readCalls(page)).filter((call) => call.endpoint === 'task/action')).toHaveLength(0)

    // 确认后发送 {action:'cancel', taskId:'T-A'} 并触发列表/详情刷新
    await page.getByTestId('session-task-action-cancel-T-A').click()
    await page.getByTestId('session-confirm-action-confirm').click()
    await expect(dialog).toBeHidden()
    const calls = await readCalls(page)
    const action = calls.find((call) => call.endpoint === 'task/action')
    expect(action, 'confirm 后应发送 task/action').toBeTruthy()
    expect(action!.payload).toMatchObject({ action: 'cancel', taskId: 'T-A' })
    expect(calls.some((call) => call.endpoint === 'task/list' || call.endpoint === 'task/get')).toBe(true)
  })

  test('accept: 无 confirm 类动作直接发送 task/action', async ({ page }) => {
    await openHarnessPage(page, {
      'task/get': {
        ok: true,
        value: {
          dag_id: 'D1',
          status: 'running',
          tasks: [{ id: 'T-FB', description: '待反馈任务', status: 'AWAITING_FEEDBACK', dependencies: [] }],
          edges: [],
        },
      },
    })
    await mountSessionPanel(page)
    await expect(page.getByTestId('dag-panel')).toBeVisible()
    await clearCalls(page)
    await page.getByTestId('session-task-action-accept-T-FB').click()
    const calls = await readCalls(page)
    const action = calls.find((call) => call.endpoint === 'task/action')
    expect(action, 'accept 无需 confirm 应直接发送').toBeTruthy()
    expect(action!.payload).toMatchObject({ action: 'accept', taskId: 'T-FB' })
  })

  test('revise: 返工走反馈输入框，payload 携带 feedback', async ({ page }) => {
    await openHarnessPage(page, {
      'task/get': {
        ok: true,
        value: {
          dag_id: 'D1',
          status: 'running',
          tasks: [{ id: 'T-FB', description: '待反馈任务', status: 'AWAITING_FEEDBACK', dependencies: [] }],
          edges: [],
        },
      },
    })
    await mountSessionPanel(page)
    await expect(page.getByTestId('dag-panel')).toBeVisible()
    await clearCalls(page)

    await page.getByTestId('session-task-action-revise-T-FB').click()
    const dialog = page.getByTestId('session-revise-dialog')
    await expect(dialog).toBeVisible()
    // 反馈输入为空时确认按钮禁用（PromptDialog 按 value.trim() 禁用）
    const confirmBtn = page.getByTestId('session-revise-confirm')
    await expect(confirmBtn).toBeDisabled()
    await dialog.locator('textarea').fill('把登录校验改成邮箱验证码')
    await confirmBtn.click()
    await expect(dialog).toBeHidden()

    const calls = await readCalls(page)
    const action = calls.find((call) => call.endpoint === 'task/action')
    expect(action, '返工确认后应发送 task/action').toBeTruthy()
    expect(action!.payload).toMatchObject({ action: 'revise', taskId: 'T-FB', feedback: '把登录校验改成邮箱验证码' })
  })
})
