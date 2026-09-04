// ① 会话面板（Weave 团队页签）：团队头绑定标注、成员卡实时状态、任务列表对账、
// 运行总览分段、输出页签开合、左右折叠、刷新补偿。
import { expect, test } from '@playwright/test'

import { HARNESS_DESCRIBE, expectCalled, loadHarnessAssets, mountSessionPanel, openHarnessPage, readCalls } from './fixtures'

test.beforeAll(loadHarnessAssets)

test.describe(HARNESS_DESCRIBE, () => {
  test('team-head: 绑定团队名直显；resolved_via≠binding 时带（自动）标注', async ({ page }) => {
    await openHarnessPage(page)
    // binding 生效：无（自动）
    await mountSessionPanel(page)
    await expect(page.getByTestId('weave-session-team-name')).toContainText('种子团队')
    await expect(page.getByTestId('weave-session-team-name')).not.toContainText('（自动）')

    // default 生效：带（自动）
    await openHarnessPage(page, {
      'session/status': {
        ok: true,
        value: {
          session_id: 'sess-auto',
          team: { team_id: 'seed-team', name: '种子团队' },
          resolved_via: 'default',
          members: [{ role_id: 'coder', name: '程序员', executor: 'spawn', status: 'idle' }],
        },
      },
    })
    await mountSessionPanel(page, 'sess-auto')
    await expect(page.getByTestId('weave-session-team-name')).toContainText('种子团队（自动）')
  })

  test('members: 成员卡状态映射（执行中/空闲）+ data-status 原值透传', async ({ page }) => {
    await openHarnessPage(page)
    await mountSessionPanel(page)
    const coder = page.getByTestId('member-card-coder')
    await expect(coder).toBeVisible()
    await expect(coder).toContainText('程序员')
    await expect(coder).toContainText('执行中')
    await expect(coder).toHaveAttribute('data-status', 'running')
    await expect(coder.locator('.weave-dot')).toHaveAttribute('data-tone', 'run')

    const reviewer = page.getByTestId('member-card-reviewer')
    await expect(reviewer).toContainText('空闲')
    await expect(reviewer).toHaveAttribute('data-status', 'idle')
    await expect(reviewer.locator('.weave-dot')).toHaveAttribute('data-tone', 'idle')
  })

  test('members: 空闲超时中断成员显示红色警示与中断态', async ({ page }) => {
    await openHarnessPage(page, {
      'session/status': {
        ok: true,
        value: {
          session_id: 'sess-h',
          team: { team_id: 'seed-team', name: '种子团队' },
          members: [
            { role_id: 'coder', name: '程序员', executor: 'spawn', status: 'running', error_type: 'idle_timeout', task_id: 'T-A' },
          ],
        },
      },
    })
    await mountSessionPanel(page)
    const coder = page.getByTestId('member-card-coder')
    await expect(coder).toContainText('中断')
    await expect(coder.locator('.weave-dot')).toHaveAttribute('data-tone', 'bad')
    await expect(coder).toContainText('已被空闲超时中断')
  })

  test('task-list: 成员任务 chips 对账（member-assignments-* + data-state）', async ({ page }) => {
    await openHarnessPage(page)
    await mountSessionPanel(page)
    // T-A(RUNNING) 指派 coder → chip data-state=running
    const coderChips = page.getByTestId('member-assignments-coder')
    await expect(coderChips).toBeVisible()
    await expect(coderChips.locator('.weave-assignment-chip')).toHaveCount(1)
    await expect(coderChips.locator('.weave-assignment-chip').first()).toHaveAttribute('data-state', 'running')
    // T-B(COMPLETED) assigned_agent=reviewer → reviewer 有 1 个完成态 chip
    const reviewerChips = page.getByTestId('member-assignments-reviewer')
    await expect(reviewerChips.locator('.weave-assignment-chip')).toHaveCount(1)
    await expect(reviewerChips.locator('.weave-assignment-chip').first()).toHaveAttribute('data-state', 'completed')
  })

  test('runtime: 团队运行总览统计与任务进度分段对账', async ({ page }) => {
    await openHarnessPage(page)
    await mountSessionPanel(page)
    const stats = page.getByTestId('weave-session-team-stats')
    await expect(stats).toBeVisible()
    await expect(stats).toContainText('2') // 成员数
    await expect(stats).toContainText('执行中')
    const progress = page.getByTestId('weave-session-progress')
    await expect(progress).toBeVisible()
    const segments = progress.locator('span')
    await expect(segments).toHaveCount(2) // dag 两任务两分段
    await expect(segments.nth(0)).toHaveAttribute('data-state', 'running')
    await expect(segments.nth(1)).toHaveAttribute('data-state', 'completed')
  })

  test('output-tab: 点击有任务的成员卡打开输出页签，可关闭回 DAG', async ({ page }) => {
    await openHarnessPage(page)
    await mountSessionPanel(page)
    await page.getByTestId('member-card-coder').click()
    const tab = page.getByTestId('session-tab-coder')
    await expect(tab).toBeVisible()
    await expect(page.getByTestId('session-output-coder')).toBeVisible()
    // 打开成员页签后 DAG 页签仍在，可切回
    await page.getByTestId('session-tab-dag').click()
    await expect(page.getByTestId('dag-panel')).toBeVisible()
    // 关闭输出页签 → 回到 DAG
    await page.getByTestId('session-tab-close-coder').click()
    await expect(page.getByTestId('session-tab-coder')).toHaveCount(0)
    await expect(page.getByTestId('dag-panel')).toBeVisible()
  })

  test('output-gating: DSH spawn/fork 成员即使有任务也不打开过程输出页签', async ({ page }) => {
    await openHarnessPage(page, {
      'session/status': {
        ok: true,
        value: {
          session_id: 'sess-h',
          team: { team_id: 'seed-team', name: '种子团队' },
          members: [
            { role_id: 'coder', name: '程序员', executor: 'spawn', executor_kind: 'dsh_subagent', output_available: false, status: 'running', task_id: 'T-A' },
          ],
        },
      },
    })
    await mountSessionPanel(page)
    const card = page.getByTestId('member-card-coder')
    await expect(card).toBeVisible()
    await expect(card).not.toHaveAttribute('data-clickable', 'true')
    await card.click()
    await expect(page.getByTestId('session-tab-coder')).toHaveCount(0)
  })

  test('layout: 左右分栏折叠后可再展开，任务区整体可折叠', async ({ page }) => {
    await openHarnessPage(page)
    await mountSessionPanel(page)
    await expect(page.getByTestId('member-card-coder')).toBeVisible()
    await page.getByTestId('session-collapse-left').click()
    await expect(page.getByTestId('member-card-coder')).toHaveCount(0)
    await page.getByTestId('session-expand-left').click()
    await expect(page.getByTestId('member-card-coder')).toBeVisible()

    await page.getByTestId('session-collapse-right').click()
    await expect(page.getByTestId('dag-panel')).toHaveCount(0)
    await page.getByTestId('session-expand-right').click()
    await expect(page.getByTestId('dag-panel')).toBeVisible()

    await page.getByTestId('session-tabs-toggle').click()
    await expect(page.getByTestId('dag-panel')).toHaveCount(0)
    await page.getByTestId('session-tabs-toggle').click()
    await expect(page.getByTestId('dag-panel')).toBeVisible()

    await page.getByTestId('session-members-toggle').click()
    await expect(page.getByTestId('member-card-coder')).toHaveCount(0)
    await page.getByTestId('session-members-toggle').click()
    await expect(page.getByTestId('member-card-coder')).toBeVisible()
  })

  test('refresh: 点击刷新按钮重新拉取 status/list/detail', async ({ page }) => {
    await openHarnessPage(page)
    await mountSessionPanel(page)
    await expect(page.getByTestId('dag-panel')).toBeVisible()
    const before = await readCalls(page)
    const beforeList = before.filter((call) => call.endpoint === 'task/list').length
    await page.getByTestId('weave-session-refresh').click()
    await expect
      .poll(async () => {
        const calls = await readCalls(page)
        return calls.filter((call) => call.endpoint === 'task/list').length
      }, { timeout: 5_000 })
      .toBeGreaterThan(beforeList)
    await expectCalled(page, 'session/status', { sessionId: 'sess-h' })
  })
})
