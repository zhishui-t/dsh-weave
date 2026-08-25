/// <reference lib="dom" />
// @vitest-environment jsdom
/**
 * P0-DASH-020 —— Dashboard 框架测试（路由骨架 + AC-COMPAT-005）。
 *
 * 覆盖：7 路由渲染与左侧导航、默认/初始路由、路由切换（点击 + onNavigate 回调）、
 * 未知路径兜底 overview、DSH 设置页零条目契约（AC-COMPAT-005）。
 *
 * 运行：pnpm vitest run src/plugins/weave/__tests__/dashboard.test.tsx
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(cleanup)

import {
  DASHBOARD_ROUTES,
  Dashboard,
  dshSettingsEntry,
  isKnownRoute,
  normalizePath,
} from '../dashboard'

describe('DASH：路由表与路径规范化（架构 12.1）', () => {
  it('路由表含 7 条且路径与架构 12.1 一致', () => {
    expect(DASHBOARD_ROUTES.map((r) => r.path)).toEqual([
      '/weave/overview',
      '/weave/tasks',
      '/weave/knowledge',
      '/weave/executors',
      '/weave/sessions',
      '/weave/audit',
      '/weave/settings',
    ])
    expect(DASHBOARD_ROUTES.every((r) => r.state === 'skeleton')).toBe(true)
  })

  it('normalizePath：/weave/xxx 与短名均可解析；未知/空 → overview 兜底', () => {
    expect(normalizePath('/weave/tasks')).toBe('tasks')
    expect(normalizePath('executors')).toBe('executors')
    expect(normalizePath('/weave/no-such')).toBe('overview')
    expect(normalizePath('')).toBe('overview')
    expect(isKnownRoute('/weave/audit')).toBe(true)
    expect(isKnownRoute('nope')).toBe(false)
  })
})

describe('DASH：框架渲染（左侧导航 = Weave 入口）', () => {
  it('默认渲染总览页 + 7 个导航项，当前项高亮', () => {
    render(<Dashboard />)
    expect(screen.getByTestId('weave-dashboard')).toBeTruthy()
    expect(screen.getByTestId('weave-nav')).toBeTruthy()
    expect(screen.getByTestId('page-overview')).toBeTruthy()
    for (const def of DASHBOARD_ROUTES) {
      const link = screen.getByTestId(`nav-${def.route}`)
      expect(link.textContent).toBe(def.label)
    }
    expect(screen.getByTestId('nav-overview').getAttribute('data-active')).toBe('true')
    expect(screen.getByTestId('nav-tasks').getAttribute('data-active')).toBe('false')
  })

  it('initialPath：/weave/tasks 直接打开任务中心；initialPath 未知 → overview', () => {
    const { unmount } = render(<Dashboard initialPath="/weave/tasks" />)
    expect(screen.getByTestId('page-tasks')).toBeTruthy()
    expect(screen.queryByTestId('page-overview')).toBeNull()
    unmount()

    render(<Dashboard initialPath="/weave/void" />)
    expect(screen.getByTestId('page-overview')).toBeTruthy()
  })

  it('点击导航切换页面，onNavigate 回调携带路由名，高亮同步', () => {
    const onNavigate = vi.fn()
    render(<Dashboard onNavigate={onNavigate} />)

    fireEvent.click(screen.getByTestId('nav-executors'))
    expect(screen.getByTestId('page-executors')).toBeTruthy()
    expect(screen.getByTestId('nav-executors').getAttribute('data-active')).toBe('true')
    expect(onNavigate).toHaveBeenLastCalledWith('executors')

    fireEvent.click(screen.getByTestId('nav-knowledge'))
    expect(screen.getByTestId('page-knowledge')).toBeTruthy()
    expect(onNavigate).toHaveBeenLastCalledWith('knowledge')
  })

  it('每个页面骨架均有标题与说明，且不含任何表单/数据副作用（骨架契约）', () => {
    render(<Dashboard />)
    for (const route of DASHBOARD_ROUTES) {
      fireEvent.click(screen.getByTestId(`nav-${route.route}`))
      const page = screen.getByTestId(`page-${route.route}`)
      expect(page.querySelector('h1')?.textContent).toBe(route.label)
      expect(page.querySelector('p')?.textContent?.length).toBeGreaterThan(0)
    }
  })
})

describe('DASH：AC-COMPAT-005 —— DSH 设置页不出现 Weave 条目', () => {
  it('dshSettingsEntry() 恒为 null（Weave 不提供 DSH 设置页条目）', () => {
    expect(dshSettingsEntry()).toBeNull()
  })

  it('组件渲染不产生任何 DSH 设置注册痕迹（无 settings 注册节点/表单提交/副作用通道）', () => {
    render(<Dashboard />)
    // Weave 入口只在左侧导航；不存在 dsh-settings 注册节点
    expect(screen.queryByTestId('dsh-settings-entry')).toBeNull()
    expect(screen.queryByTestId('weave-dashboard')!.querySelector('form')).toBeNull()
    // 我们自己的 /weave/settings 页是独立骨架，与 DSH 设置页无关
    fireEvent.click(screen.getByTestId('nav-settings'))
    expect(screen.getByTestId('page-settings')).toBeTruthy()
    expect(screen.getByTestId('page-settings').textContent).toContain('与 DSH 设置页无关联')
  })

  it('导航即 Weave 入口：7 项全部位于左侧导航容器内', () => {
    render(<Dashboard />)
    const nav = screen.getByTestId('weave-nav')
    for (const def of DASHBOARD_ROUTES) {
      expect(nav.contains(screen.getByTestId(`nav-${def.route}`))).toBe(true)
    }
  })
})
