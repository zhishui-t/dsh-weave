// 控制台七页：真实 RPC 信封形态对账 + 空态 + 失败信封渲染。
// 信封契约：成功 {ok:true,value} 渲染 value；失败 {ok:false,error:{code,message}} → page-error 含 "code: message"。
import { expect, test } from '@playwright/test'

import { HARNESS_DESCRIBE, loadHarnessAssets, openDashboardHarness, openHarnessPage, readCalls } from './fixtures'

test.beforeAll(loadHarnessAssets)

test.describe(HARNESS_DESCRIBE, () => {
  test('overview: 六卡数字与 RPC 场景数据对账，卡片点击跳转', async ({ page }) => {
    // task/list 需要 payload 感知：total 与 BANNED 过滤分别应答
    await openHarnessPage(page)
    await page.evaluate(() => {
      const rpc = window.__WEAVE_RPC__ as Record<string, unknown>
      rpc['task/list'] = (payload: { status?: string }) =>
        payload.status === 'BANNED'
          ? { ok: true, value: { total: 1, tasks: [] } }
          : { ok: true, value: { total: 7, tasks: [] } }
    })
    await openDashboardHarness(page)
    await page.getByTestId('nav-overview').click()
    await expect(page.getByTestId('page-overview')).toBeVisible()

    await expect(page.getByTestId('overview-card-teams')).toContainText('团队（1）')
    await expect(page.getByTestId('overview-card-executors')).toContainText('执行器（2）')
    await expect(page.getByTestId('overview-card-tasks')).toContainText('任务总数（7）')
    await expect(page.getByTestId('overview-card-banned')).toContainText('熔断/禁用任务（1）')
    await expect(page.getByTestId('overview-card-knowledge')).toContainText('待审知识（1）')

    // 最近审计卡来自 audit/list（≤3 条）
    await expect(page.getByTestId('overview-card-audit')).toContainText('task.status_changed')

    // 卡片跳转：teams / knowledge / audit
    await page.getByTestId('overview-card-teams').click()
    await expect(page.getByTestId('page-teams')).toBeVisible()
    await page.getByTestId('nav-overview').click()
    await page.getByTestId('overview-card-knowledge').click()
    await expect(page.getByTestId('page-knowledge')).toBeVisible()
  })

  test('audit: 事件渲染 + 过滤控件齐备，变更过滤触发携带参数的重新请求', async ({ page }) => {
    await openHarnessPage(page)
    await openDashboardHarness(page)
    await page.getByTestId('nav-audit').click()
    await expect(page.getByTestId('page-audit')).toBeVisible()
    await expect(page.locator('[data-testid^="audit-event-"]').first()).toBeVisible()
    for (const control of ['audit-type-filter', 'audit-from', 'audit-to', 'audit-order']) {
      await expect(page.getByTestId(control)).toBeVisible()
    }

    // 改排序方向 + 提交查询（过滤条件在表单提交时应用）→ 重新请求携带 order=asc
    await page.getByTestId('audit-order').selectOption('asc')
    await page.getByTestId('page-audit').locator('form button[type="submit"]').click()
    await expect
      .poll(async () => {
        const calls = await readCalls(page)
        return calls.filter((call) => call.endpoint === 'audit/list' && call.payload['order'] === 'asc').length
      }, { timeout: 5_000 })
      .toBeGreaterThan(0)
  })

  test('audit: 类型过滤下拉包含 14 事件类型中真实注册的类型', async ({ page }) => {
    await openHarnessPage(page)
    await openDashboardHarness(page)
    await page.getByTestId('nav-audit').click()
    const options = await page.getByTestId('audit-type-filter').locator('option').allInnerTexts()
    expect(options.length).toBeGreaterThan(1)
    expect(options.join('|')).toContain('task.status_changed')
  })

  test('knowledge: approve 单击即发 knowledge/approve{id}', async ({ page }) => {
    await openHarnessPage(page)
    await openDashboardHarness(page)
    await page.getByTestId('nav-knowledge').click()
    await expect(page.getByTestId('knowledge-item-kn-1')).toBeVisible()
    await page.getByTestId('knowledge-approve-kn-1').click()
    const calls = await readCalls(page)
    const approve = calls.find((call) => call.endpoint === 'knowledge/approve')
    expect(approve, 'approve 应直接发送 knowledge/approve').toBeTruthy()
    expect(approve!.payload).toMatchObject({ id: 'kn-1' })
  })

  test('knowledge: status/layer 过滤选项齐全，切换触发重新请求', async ({ page }) => {
    await openHarnessPage(page)
    await openDashboardHarness(page)
    await page.getByTestId('nav-knowledge').click()
    const statusOptions = await page.getByTestId('knowledge-status-filter').locator('option').count()
    expect(statusOptions).toBe(4) // candidate/active/deprecated/superseded
    const layerOptions = await page.getByTestId('knowledge-layer-filter').locator('option').count()
    expect(layerOptions).toBe(5) // 全部 + project/role/instance/shared

    await page.getByTestId('knowledge-status-filter').selectOption('active')
    await expect
      .poll(async () => {
        const calls = await readCalls(page)
        return calls.filter((call) => call.endpoint === 'knowledge/list' && call.payload['status'] === 'active').length
      }, { timeout: 5_000 })
      .toBeGreaterThan(0)
  })

  test('executors: 执行器卡来自 snapshot，无 zcode 目录时不渲染 zcode-catalog', async ({ page }) => {
    await openHarnessPage(page)
    await openDashboardHarness(page)
    await page.getByTestId('nav-executors').click()
    await expect(page.getByTestId('page-executors')).toBeVisible()
    await expect(page.getByTestId('executor-card-spawn')).toBeVisible()
    await expect(page.getByTestId('executor-card-fork')).toBeVisible()
    await expect(page.getByTestId('zcode-catalog')).toHaveCount(0)
  })

  test('settings: settings-list 键值来自 settings/describe 真实键名', async ({ page }) => {
    await openHarnessPage(page)
    await openDashboardHarness(page)
    await page.getByTestId('nav-settings').click()
    const list = page.getByTestId('settings-list')
    await expect(list).toBeVisible()
    await expect(list).toContainText('0.2.0')
    await expect(list).toContainText('~/.dsh/weave')
    await expect(list).toContainText('~/.dsh/teams')
    await expect(list).toContainText('~/.dsh/audit')
  })

  test('settings: 目录字段可编辑，保存发送 settings/update', async ({ page }) => {
    await openHarnessPage(page)
    await openDashboardHarness(page)
    await page.getByTestId('nav-settings').click()
    const field = page.getByTestId('settings-state_dir')
    await expect(field).toBeVisible()
    await field.fill('~/.dsh/weave-e2e')
    await page.getByTestId('settings-save').click()
    const calls = await readCalls(page)
    const update = calls.find((call) => call.endpoint === 'settings/update')
    expect(update, '保存应发送 settings/update').toBeTruthy()
    expect(JSON.stringify(update!.payload)).toContain('weave-e2e')
  })

  test('empty-state: teams/knowledge/audit 空数据渲染 page-empty', async ({ page }) => {
    await openHarnessPage(page, {
      snapshot: { ok: true, value: { teams: [], executors: [{ id: 'spawn', kind: 'dsh_subagent' }] } },
      'knowledge/list': { ok: true, value: { candidates: [] } },
      'knowledge/graph': { ok: true, value: { nodes: [], edges: [], counts: { knowledge: 0, missing: 0, edges: 0, unresolved: 0, skipped: 0 } } },
      'audit/list': { ok: true, value: { events: [] } },
    })
    await openDashboardHarness(page)

    await page.getByTestId('nav-teams').click()
    await expect(page.getByTestId('page-empty').first()).toBeVisible()
    await expect(page.getByTestId('team-card-seed-team')).toHaveCount(0)

    await page.getByTestId('nav-knowledge').click()
    await expect(page.getByTestId('page-empty').first()).toBeVisible()

    await page.getByTestId('nav-audit').click()
    await expect(page.getByTestId('page-empty').first()).toBeVisible()
  })

  test('envelope: 失败信封渲染 page-error 且含 code 与 message', async ({ page }) => {
    await openHarnessPage(page, {
      'audit/list': { ok: false, error: { code: 'invalid_argument', message: '时间区间非法' } },
    })
    await openDashboardHarness(page)
    await page.getByTestId('nav-audit').click()
    const note = page.getByTestId('page-error')
    await expect(note).toBeVisible()
    await expect(note).toContainText('invalid_argument')
    await expect(note).toContainText('时间区间非法')
  })

  test('envelope: snapshot 失败 → teams/overview 错误态而非崩溃', async ({ page }) => {
    await openHarnessPage(page, {
      snapshot: { ok: false, error: { code: 'internal', message: '状态目录不可读' } },
    })
    await openDashboardHarness(page)
    await page.getByTestId('nav-teams').click()
    const note = page.getByTestId('page-error').first()
    await expect(note).toBeVisible()
    await expect(note).toContainText('internal')
    // 页面骨架仍在，可导航
    await page.getByTestId('nav-overview').click()
    await expect(page.getByTestId('page-overview')).toBeVisible()
  })

  test('envelope: 未注册端点返回 no-mock 失败信封（防漏测）', async ({ page }) => {
    await openHarnessPage(page, {
      'settings/describe': { ok: false, error: { code: 'no-mock', message: '未配置 mock: settings/describe' } },
    })
    await openDashboardHarness(page)
    await page.getByTestId('nav-settings').click()
    const note = page.getByTestId('page-error').first()
    await expect(note).toBeVisible()
    await expect(note).toContainText('no-mock')
  })
})
