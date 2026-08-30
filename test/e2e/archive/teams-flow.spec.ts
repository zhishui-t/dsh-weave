// ④ 团队创建/绑定/切换流：创建校验与提交 payload、详情抽屉、删除与设默认的确认门径、
// 会话面板的团队绑定/解绑/进行中锁定。
import { expect, test, type Page } from '@playwright/test'

import { HARNESS_DESCRIBE, clearCalls, expectCalled, loadHarnessAssets, mountSessionPanel, openDashboardHarness, openHarnessPage, readCalls } from '../harness/fixtures'

test.beforeAll(loadHarnessAssets)

const TWO_TEAMS_SNAPSHOT = {
  ok: true,
  value: {
    teams: [
      {
        team_id: 'seed-team',
        name: '种子团队',
        default: true,
        roles: [{ id: 'coder', name: '程序员', executor: 'spawn', stages: ['prepare', 'implement', 'review'] }],
      },
      {
        team_id: 'beta-team',
        name: '备选团队',
        roles: [{ id: 'beta', name: '备选队员', executor: 'fork', stages: ['prepare', 'implement', 'review'] }],
      },
    ],
    executors: [{ id: 'spawn', kind: 'dsh_subagent' }, { id: 'fork', kind: 'dsh_subagent' }],
  },
}

async function openCreateEditor(page: Page): Promise<void> {
  await page.getByTestId('team-new-btn').click()
  await expect(page.getByTestId('team-editor')).toBeVisible()
  await page.getByTestId('team-id-input').waitFor()
}

test.describe(HARNESS_DESCRIBE, () => {
  test('create: 编辑器打开，执行器下拉来自 snapshot，提交按钮文案随角色数变化', async ({ page }) => {
    await openHarnessPage(page)
    await openDashboardHarness(page)
    await page.getByTestId('nav-teams').click()
    await openCreateEditor(page)
    const select = page.locator('[data-testid="role-editor-0"] select').first()
    await expect(select.locator('option')).toHaveCount(2)
    await expect(page.getByTestId('team-create-submit')).toContainText('1 个角色')
    await page.getByTestId('team-add-role').click()
    await expect(page.getByTestId('role-editor-1')).toBeVisible()
    await expect(page.getByTestId('team-create-submit')).toContainText('2 个角色')
  })

  test('create: 必填校验——空名提交被拦截且不发送 team/import', async ({ page }) => {
    await openHarnessPage(page)
    await openDashboardHarness(page)
    await page.getByTestId('nav-teams').click()
    await openCreateEditor(page)
    await clearCalls(page)
    await page.getByTestId('team-create-submit').click()
    // 表单仍在（未通过校验），无提交请求
    await expect(page.getByTestId('team-editor')).toBeVisible()
    expect((await readCalls(page)).filter((call) => call.endpoint === 'team/import')).toHaveLength(0)
  })

  test('create: 填写后提交发送 team/import 完整 config，成功后出现新团队卡', async ({ page }) => {
    await openHarnessPage(page)
    await openDashboardHarness(page)
    await page.getByTestId('nav-teams').click()
    await openCreateEditor(page)
    await page.getByTestId('team-id-input').fill('e2e-team')
    await page.getByTestId('team-name-input').fill('E2E 团队')
    const scope = page.getByTestId('role-editor-0')
    await scope.locator('.weave-field', { hasText: '角色 ID' }).locator('input').fill('alpha')
    await scope.locator('.weave-field', { hasText: '名称' }).locator('input').first().fill('Alpha 成员')
    await page.getByTestId('team-create-submit').click()
    await expect(page.getByTestId('team-editor')).toBeHidden()

    const importCall = await expectCalled(page, 'team/import')
    const config = importCall.payload['config'] as Record<string, unknown>
    expect(importCall.payload).toMatchObject({ overwrite: true })
    expect(config).toMatchObject({ team_id: 'e2e-team', name: 'E2E 团队' })
    expect(Array.isArray(config['roles'])).toBe(true)
  })

  test('create: 新建模式直接关闭不弹丢弃确认（守卫仅作用于编辑模式）', async ({ page }) => {
    await openHarnessPage(page)
    await openDashboardHarness(page)
    await page.getByTestId('nav-teams').click()
    await openCreateEditor(page)
    await page.getByTestId('team-name-input').fill('未保存的团队')
    await page.keyboard.press('Escape')
    // 新建模式关闭无需确认（closeEditor 仅对 edit+dirty 弹确认）
    await expect(page.getByTestId('team-editor')).toBeHidden()
    await expect(page.getByTestId('confirm-discard-team')).toHaveCount(0)
  })

  test('edit: 编辑模式下有改动时 Esc → 丢弃确认门径', async ({ page }) => {
    await openHarnessPage(page)
    await openDashboardHarness(page)
    await page.getByTestId('nav-teams').click()
    await page.getByTestId('team-detail-seed-team').click()
    await expect(page.getByTestId('team-drawer-seed-team')).toBeVisible()
    // 点击队员卡进入编辑模式（载入全量配置；抽屉保留在编辑器下层）
    await page.getByTestId('team-member-card-coder').click()
    await expect(page.getByTestId('team-editor')).toBeVisible({ timeout: 10_000 })
    // 修改角色名称 → dirty
    const scope = page.getByTestId('role-editor-0')
    await scope.locator('.weave-field', { hasText: '名称' }).locator('input').first().fill('改名后的队员')
    // Esc 关闭优先级：先抽屉（detailTeamId）后编辑器（closeEditor → dirty → 丢弃确认）
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    const discardDialog = page.getByTestId('confirm-discard-team')
    await expect(discardDialog).toBeVisible()
    await page.getByTestId('confirm-discard-confirm').click()
    await expect(discardDialog).toBeHidden()
    await expect(page.getByTestId('team-editor')).toBeHidden()
  })

  test('detail: 团队卡详情抽屉打开，队员卡来自 team/get，可关闭', async ({ page }) => {
    await openHarnessPage(page)
    await openDashboardHarness(page)
    await page.getByTestId('nav-teams').click()
    await page.getByTestId('team-detail-seed-team').click()
    await expect(page.getByTestId('team-drawer-seed-team')).toBeVisible()
    await expect(page.getByTestId('team-member-card-coder')).toBeVisible()
    await expect(page.getByTestId('team-member-cards')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('team-drawer-seed-team')).toBeHidden()
  })

  test('delete: 删除走确认弹窗，confirm 发 team/delete{teamId}', async ({ page }) => {
    await openHarnessPage(page, { snapshot: TWO_TEAMS_SNAPSHOT })
    await openDashboardHarness(page)
    await page.getByTestId('nav-teams').click()
    await clearCalls(page)
    await page.getByTestId('team-delete-beta-team').click()
    await page.getByTestId('confirm-delete-team-danger').click()
    await expectCalled(page, 'team/delete', { teamId: 'beta-team' })
  })

  test('set-default: 已有默认时切换需互斥确认，confirm 发 team/set-default', async ({ page }) => {
    await openHarnessPage(page, { snapshot: TWO_TEAMS_SNAPSHOT })
    await openDashboardHarness(page)
    await page.getByTestId('nav-teams').click()
    await clearCalls(page)
    await page.getByTestId('team-set-default-beta-team').click()
    // seed-team 已是默认 → 互斥确认弹窗
    const dialog = page.getByTestId('confirm-set-default')
    await expect(dialog).toBeVisible()
    await page.getByTestId('confirm-set-default-cancel').click()
    await expect(dialog).toBeHidden()
    expect((await readCalls(page)).filter((call) => call.endpoint === 'team/set-default')).toHaveLength(0)

    await page.getByTestId('team-set-default-beta-team').click()
    await page.getByTestId('confirm-set-default-confirm').click()
    await expectCalled(page, 'team/set-default', { teamId: 'beta-team' })
  })

  test('bind: 会话面板下拉切团 → session/set-binding；未绑定 → clear-binding', async ({ page }) => {
    await openHarnessPage(page, {
      snapshot: TWO_TEAMS_SNAPSHOT,
      // 无任务 → 无进行中任务锁定，切团可用
      'task/list': { ok: true, value: { total: 0, tasks: [] } },
      'session/status': {
        ok: true,
        value: {
          session_id: 'sess-h',
          team: { team_id: 'seed-team', name: '种子团队' },
          members: [{ role_id: 'coder', name: '程序员', executor: 'spawn', status: 'idle' }],
        },
      },
    })
    await mountSessionPanel(page)
    const select = page.getByTestId('weave-session-team-select')
    await expect(select).toBeVisible()
    await expect(select).toHaveValue('seed-team')

    await clearCalls(page)
    await select.selectOption('beta-team')
    await expectCalled(page, 'session/set-binding', { sessionId: 'sess-h', teamId: 'beta-team' })

    // 切回「未绑定」空值 → 清除绑定
    await select.selectOption('')
    await expectCalled(page, 'session/clear-binding', { sessionId: 'sess-h' })
  })

  test('bind: 有进行中任务时锁定切团（weave-session-team-locked + select 禁用）', async ({ page }) => {
    await openHarnessPage(page)
    await mountSessionPanel(page)
    // 默认场景 T-A RUNNING → hasActiveTasks
    await expect(page.getByTestId('weave-session-team-locked')).toBeVisible()
    await expect(page.getByTestId('weave-session-team-select')).toBeDisabled()
    await expect(page.getByTestId('weave-session-team-locked')).toContainText('不能切团队')
  })

  test('bind: 团队下拉选项来自 snapshot（含默认标注）', async ({ page }) => {
    await openHarnessPage(page, { snapshot: TWO_TEAMS_SNAPSHOT })
    await mountSessionPanel(page)
    const select = page.getByTestId('weave-session-team-select')
    const texts = await select.locator('option').allInnerTexts()
    expect(texts.length).toBe(3) // 未绑定 + 两团队
    expect(texts.join('|')).toContain('种子团队')
    expect(texts.join('|')).toContain('备选团队')
  })
})
