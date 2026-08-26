// Weave 控制台真实 DSH Web 端到端验收（t5 live 层）。
// 运行：pnpm test:e2e:live —— 访问真实 http://127.0.0.1:3080，走真实 Connection RPC，无任何 mock。
// 通过标准：八页可达；团队/任务创建成功；知识/审计/会话/设置真实数据或明确空态；
// 无 405、无 invalid client-request message、无未捕获页面异常、/dsh-weave 信封全部 ok=true。
import { expect, test, type Page } from '@playwright/test'

import {
  BASE_URL,
  mergeObserved,
  observe,
  expectNoPageError,
  recordStep,
  ROUTES,
  shot,
  writeReport,
  type Observed,
  type StepRecord,
} from '../helpers'

const records: StepRecord[] = []
const observedStates: Observed[] = []

test.describe.serial('Weave 控制台真实 Web 验收', () => {
  let page: Page
  let createdTeamId = ''

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
  })

  test.beforeEach(() => {
    observedStates.push(observe(page))
  })

  test.afterAll(async () => {
    const merged = mergeObserved(observedStates)
    writeReport({ baseUrl: BASE_URL, steps: records, ...merged })
    await page?.close()
  })

  const step = (name: string) => recordStep(records, name)

  test('shell: Weave 入口打开 Dashboard', async () => {
    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
      await page.getByTestId('weave-open').waitFor({ state: 'visible', timeout: 30_000 })
      await shot(page, '00-home')
      await page.getByTestId('weave-open').click()
      await page.getByTestId('weave-dashboard').waitFor({ state: 'visible', timeout: 15_000 })
      await expect(page.locator('.weave-title')).toContainText('Weave 控制台')
      await shot(page, '01-dashboard')
      step('入口打开 Dashboard')()
    } catch (err) {
      step('入口打开 Dashboard')(String(err))
      throw err
    }
  })

  test('nav: 八页全部可达且无错误态', async () => {
    try {
      for (let i = 0; i < ROUTES.length; i += 1) {
        const key = ROUTES[i]!
        await page.getByTestId(`nav-${key}`).click()
        await page.getByTestId(`page-${key}`).waitFor({ state: 'visible', timeout: 20_000 })
        await page.waitForTimeout(700)
        await expectNoPageError(page, key)
        await shot(page, `${String(i + 2).padStart(2, '0')}-page-${key}`)
        console.log(`  页面可达: ${key}`)
      }
      step('八页全部可达且无错误态')()
    } catch (err) {
      step('八页全部可达且无错误态')(String(err))
      throw err
    }
  })

  test('teams: snapshot 真实执行器 + 创建两角色团队并刷新可见', async () => {
    const tag = Date.now().toString(36)
    const teamId = `e2e-team-${tag}`
    try {
      await page.getByTestId('nav-teams').click()
      await page.getByTestId('team-id-input').waitFor({ state: 'visible', timeout: 10_000 })
      await page.waitForTimeout(800)
      const executorSelect = page.locator('[data-testid="role-editor-0"] select').first()
      const options = await executorSelect.locator('option').allInnerTexts()
      console.log(`  执行器选项(${options.length}): ${options.join(' | ')}`)
      if (options.some((text) => text.includes('未发现执行器'))) {
        throw new Error('snapshot 未返回任何注册执行器——团队页无法展示真实执行器列表')
      }
      await page.getByTestId('team-id-input').fill(teamId)
      await page.getByTestId('team-name-input').fill('E2E 验收团队')
      const fillRole = async (index: number, roleId: string): Promise<void> => {
        const scope = page.getByTestId(`role-editor-${index}`)
        await scope.locator('.weave-field', { hasText: '角色 ID' }).locator('input').fill(roleId)
        await scope.locator('.weave-field', { hasText: '名称' }).locator('input').first().fill(`${roleId} 成员`)
        await scope
          .locator('.weave-field', { hasText: 'Stages' })
          .locator('input')
          .fill('prepare,implement,review')
      }
      await page.getByTestId('team-add-role').click()
      await page.getByTestId('role-editor-1').waitFor({ state: 'visible' })
      await fillRole(0, 'alpha')
      await fillRole(1, 'beta')
      const submit = page.getByTestId('team-create-submit')
      await expect(submit).toContainText('2 个角色')
      await submit.click()
      await page.getByTestId(`team-delete-${teamId}`).waitFor({ state: 'visible', timeout: 20_000 })
      createdTeamId = teamId
      await shot(page, '10-team-created')
      console.log(`  团队已创建并出现在列表: ${teamId}`)
      step(`团队创建+列表可见 (${teamId})`)()
    } catch (err) {
      step(`团队创建+列表可见 (${teamId})`)(String(err))
      throw err
    }
  })

  test('tasks: 提交唯一 project 任务并在列表与详情可见', async () => {
    const tag = Date.now().toString(36)
    const project = `e2e-proj-${tag}`
    try {
      await page.getByTestId('nav-tasks').click()
      await page.getByTestId('task-project-input').waitFor({ state: 'visible', timeout: 10_000 })
      await page.getByTestId('task-project-input').fill(project)
      await page.getByTestId('task-version-input').fill('v0.1.0')
      await page
        .locator('.weave-field', { hasText: '任务描述' })
        .locator('textarea')
        .fill(project)
      if (createdTeamId !== '') {
        await page
          .locator('.weave-field', { hasText: '团队 ID（可选）' })
          .locator('input')
          .fill(createdTeamId)
      }
      await page.getByTestId('task-create-submit').click()
      await page.waitForTimeout(1500)
      const row = page.locator('[data-testid^="task-row-"]').filter({ hasText: project }).first()
      await row.waitFor({ state: 'visible', timeout: 20_000 })
      const rowId = (await row.getAttribute('data-testid'))!.replace('task-row-', '')
      await page.getByTestId(`task-detail-toggle-${rowId}`).click()
      await page.getByTestId('task-detail').waitFor({ state: 'visible', timeout: 10_000 })
      const detail = await page.getByTestId('task-detail').innerText()
      expect(detail.length).toBeGreaterThan(0)
      expect(detail).toMatch(/状态|WAITING|RUNNING|BLOCKED|PENDING/)
      await shot(page, '11-task-created')
      console.log(`  任务已创建: ${project} (id=${rowId})`)
      step(`任务创建+详情状态 (${project})`)()
    } catch (err) {
      step(`任务创建+详情状态 (${project})`)(String(err))
      throw err
    }
  })

  test('knowledge: 列表查询 + candidate 审核或明确空态', async () => {
    try {
      await page.getByTestId('nav-knowledge').click()
      await page.getByTestId('knowledge-status-filter').waitFor({ state: 'visible', timeout: 10_000 })
      await page.waitForTimeout(800)
      await expectNoPageError(page, 'knowledge')
      const items = page.locator('[data-testid^="knowledge-item-"]')
      const count = await items.count()
      if (count === 0) {
        await expect(page.getByTestId('page-empty').first()).toBeVisible()
        console.log('  知识库为空（空态明确呈现）')
      } else {
        const id = (await items.first().getAttribute('data-testid'))!.replace('knowledge-item-', '')
        const approve = page.getByTestId(`knowledge-approve-${id}`)
        if (await approve.isVisible().catch(() => false)) {
          await approve.click()
          await page.waitForTimeout(1000)
          await expectNoPageError(page, 'knowledge approve 后')
          console.log(`  已审核 candidate ${id}: approve`)
        } else {
          console.log(`  首条 ${id} 非 candidate（无 approve 按钮），仅验证列表`)
        }
      }
      await shot(page, '12-knowledge')
      step('知识库查询+审核或空态')()
    } catch (err) {
      step('知识库查询+审核或空态')(String(err))
      throw err
    }
  })

  test('executors/sessions/audit/settings: 真实数据或明确空态', async () => {
    try {
      // 执行器：列表来自 snapshot 注册项（zcode 目录仅存在时展示）
      await page.getByTestId('nav-executors').click()
      await page.getByTestId('page-executors').waitFor({ state: 'visible' })
      await page.waitForTimeout(600)
      await expectNoPageError(page, 'executors')

      // 会话管理：绑定/修订各自有数据或空态
      await page.getByTestId('nav-sessions').click()
      await page.getByTestId('page-sessions').waitFor({ state: 'visible' })
      await page.waitForTimeout(800)
      await expectNoPageError(page, 'sessions')
      for (const prefix of ['binding-row-', 'revision-row-']) {
        const rows = await page.locator(`[data-testid^="${prefix}"]`).count()
        if (rows === 0) await expect(page.getByTestId('page-empty').first()).toBeVisible()
      }

      // 审计日志：事件或空态
      await page.getByTestId('nav-audit').click()
      await page.getByTestId('audit-type-filter').waitFor({ state: 'visible', timeout: 10_000 })
      await page.waitForTimeout(800)
      await expectNoPageError(page, 'audit')
      const auditRows = await page.locator('[data-testid^="audit-event-"]').count()
      if (auditRows === 0) await expect(page.getByTestId('page-empty').first()).toBeVisible()

      // 设置：真实路径与版本文本
      await page.getByTestId('nav-settings').click()
      await page.getByTestId('settings-list').waitFor({ state: 'visible', timeout: 10_000 })
      const settings = await page.getByTestId('settings-list').innerText()
      expect(settings.length).toBeGreaterThan(10)

      await shot(page, '13-misc-pages')
      step('执行器/会话/审计/设置 真实数据或空态')()
    } catch (err) {
      step('执行器/会话/审计/设置 真实数据或空态')(String(err))
      throw err
    }
  })

  test('cleanup: 删除本次自建团队（confirm 门径）', async () => {
    if (createdTeamId === '') return
    const tid = createdTeamId
    page.on('dialog', (dialog) => void dialog.accept())
    await page.getByTestId('nav-teams').click()
    const del = page.getByTestId(`team-delete-${tid}`)
    await del.waitFor({ state: 'visible', timeout: 15_000 })
    await del.click()
    await page.getByTestId(`team-delete-${tid}`).waitFor({ state: 'detached', timeout: 20_000 })
    await shot(page, '14-team-cleaned')
    createdTeamId = ''
    step(`清理自建团队 (${tid})`)()
  })

  test('integrity: 无405 / 无invalid client-request / 无page error / RPC全绿', async () => {
    const merged = mergeObserved(observedStates)
    const bad400 = merged.httpIssues.filter((i) => i.status === 405 || i.status === 400)
    const invalidClientRequest = merged.rpcFailures.filter((f) => f.message.includes('invalid client-request message'))
    expect(bad400, JSON.stringify(bad400)).toEqual([])
    expect(invalidClientRequest, JSON.stringify(invalidClientRequest)).toEqual([])
    expect(merged.pageErrors, JSON.stringify(merged.pageErrors)).toEqual([])
    expect(merged.rpcFailures, JSON.stringify(merged.rpcFailures)).toEqual([])
    console.log(`RPC ok 统计: ${JSON.stringify(merged.rpcOk)}`)
    console.log(`HTTP>=400: ${merged.httpIssues.length}; RPC失败: ${merged.rpcFailures.length}; 页面异常: ${merged.pageErrors.length}`)
    step('完整性判据（405/bad-request/pageerror/rpc）')()
  })

  test('shell: 关闭 Dashboard', async () => {
    await page.getByTestId('weave-close').click()
    await page.getByTestId('weave-dashboard').waitFor({ state: 'detached', timeout: 10_000 })
  })
})
