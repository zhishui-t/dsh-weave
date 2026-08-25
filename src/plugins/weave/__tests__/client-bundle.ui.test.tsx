/// <reference lib="dom" />
// @vitest-environment jsdom
/**
 * dsh-weave Web 客户端端到端界面测试。
 *
 * 覆盖：
 * 1. 构建产物必须是 DSH ModuleLoader bundle；
 * 2. 客户端注册到 sidebar.footer.action，而不是 settings.section；
 * 3. 左侧动作可打开全屏 Dashboard；
 * 4. Dashboard 内部左侧导航可切换 7 个页面；
 * 5. 关闭按钮能关闭界面。
 *
 * 运行：
 * pnpm build && pnpm vitest run src/plugins/weave/__tests__/client-bundle.ui.test.tsx
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React, { createElement, type ComponentType } from 'react'
import ReactDOM from 'react-dom'

type WeaveActionComponent = ComponentType<{ wide?: boolean }>
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

type ClientExports = {
  apply: (ctx: unknown) => void
  inject: string[]
}

type ClientBundle = {
  id: string
  factory: (moduleRequire: (id: string) => unknown) => ClientExports
}

const clientPath = resolve(process.cwd(), 'dist/client/index.js')
const sourcePath = resolve(process.cwd(), 'src/client/index.ts')

let clientCode = ''
let capturedBundle: ClientBundle | undefined

beforeAll(async () => {
  clientCode = await readFile(clientPath, 'utf8')

  ;(window as unknown as { __ModuleLoader__: { load(bundle: ClientBundle): void } }).__ModuleLoader__ = {
    load(bundle: ClientBundle) {
      capturedBundle = bundle
    },
  }

  // 客户端产物是无模块脚本；这里在 jsdom 全局环境中执行一次，
  // 让 window.__ModuleLoader__.load(...) 捕获注册的 bundle。
  const execute = new Function(clientCode)
  execute()
})

afterEach(() => {
  cleanup()
})

function getCapturedBundle(): ClientBundle {
  if (!capturedBundle) throw new Error('client bundle was not registered')
  return capturedBundle
}

describe('dsh-weave Web 客户端产物契约', () => {
  it('源码不再注册到 DSH 设置页，而是注册左侧导航动作位', async () => {
    const source = await readFile(sourcePath, 'utf8')
    expect(source).toContain("ctx.slots.inject('sidebar.footer.action'")
    expect(source).not.toContain("ctx.slots.inject('settings.section'")
  })

  it('构建产物使用 DSH ModuleLoader 注册，且导出 apply/inject', () => {
    expect(clientCode).toContain('__ModuleLoader__')
    expect(capturedBundle?.id).toBe('@deepseek-ai/dsh-plugin-weave')
    expect(capturedBundle?.factory).toBeTypeOf('function')

    const moduleRequire = (id: string) => {
      if (id === 'react') return React
      if (id === 'react-dom') return ReactDOM
      throw new Error(`unexpected client dependency: ${id}`)
    }
    const exported = getCapturedBundle().factory(moduleRequire)
    expect(exported.inject).toEqual(['slots'])
    expect(exported.apply).toBeTypeOf('function')
  })
})

describe('dsh-weave 左侧导航 + Dashboard 界面', () => {
  it('sidebar.footer.action 渲染 Weave 入口，点击打开完整控制台', async () => {
    const moduleRequire = (id: string) => {
      if (id === 'react') return React
      if (id === 'react-dom') return ReactDOM
      throw new Error(`unexpected client dependency: ${id}`)
    }
    const exported = getCapturedBundle().factory(moduleRequire)

    let registeredSlot = ''
    let registeredDef: { id?: string } | undefined
    let registeredComponent: WeaveActionComponent | undefined
    const ctx = {
      effect(execute: () => unknown) {
        execute()
      },
      slots: {
        inject(slot: string, register: () => unknown) {
          registeredSlot = slot
          register()
        },
        register(def: { id?: string }, component: ComponentType) {
          registeredDef = def
          registeredComponent = component
          return () => undefined
        },
      },
    }

    exported.apply(ctx)

    expect(registeredSlot).toBe('sidebar.footer.action')
    expect(registeredDef!.id).toBe('@deepseek-ai/dsh-plugin-weave')
    expect(registeredComponent).toBeTypeOf('function')

    // 宽侧栏：完整按钮。
    const wide = render(createElement(registeredComponent!, { wide: true }))
    const openButton = screen.getByTestId('weave-open')
    expect(openButton.textContent).toContain('Weave')
    expect(openButton.closest('.weave-action-layer')?.classList.contains('weave-action-rail')).toBe(false)
    wide.unmount()

    // 窄侧栏：圆形 rail 按钮，不渲染长文案。
    const rail = render(createElement(registeredComponent!, {}))
    const railButton = screen.getByTestId('weave-open')
    expect(railButton.closest('.weave-action-layer')?.classList.contains('weave-action-rail')).toBe(true)
    expect(railButton.querySelector('.weave-action-label')).toBeNull()
    rail.unmount()

    render(createElement(registeredComponent!, { wide: true }))

    expect(screen.getByTestId('weave-open')).toBeTruthy()
    expect(screen.queryByTestId('weave-dashboard')).toBeNull()

    fireEvent.click(screen.getByTestId('weave-open'))

    await waitFor(() => {
      expect(screen.getByTestId('weave-dashboard')).toBeTruthy()
    })
    expect(screen.getByTestId('weave-nav')).toBeTruthy()
    expect(screen.getByTestId('page-overview')).toBeTruthy()

    for (const route of ['overview', 'tasks', 'knowledge', 'executors', 'sessions', 'audit', 'settings']) {
      expect(screen.getByTestId(`nav-${route}`)).toBeTruthy()
    }
  })

  it('Dashboard 内部导航可切换 7 个页面，关闭按钮可退出', async () => {
    const moduleRequire = (id: string) => {
      if (id === 'react') return React
      if (id === 'react-dom') return ReactDOM
      throw new Error(`unexpected client dependency: ${id}`)
    }
    const exported = getCapturedBundle().factory(moduleRequire)

    let component: WeaveActionComponent | undefined
    const ctx = {
      effect(execute: () => unknown) {
        execute()
      },
      slots: {
        inject(_slot: string, register: () => unknown) {
          register()
        },
        register(_def: { id?: string }, registered: ComponentType) {
          component = registered
          return () => undefined
        },
      },
    }
    exported.apply(ctx)

    render(createElement(component!))
    fireEvent.click(screen.getByTestId('weave-open'))
    expect(screen.getByTestId('page-overview')).toBeTruthy()

    for (const route of ['tasks', 'knowledge', 'executors', 'sessions', 'audit', 'settings']) {
      fireEvent.click(screen.getByTestId(`nav-${route}`))
      expect(screen.getByTestId(`page-${route}`)).toBeTruthy()
      expect(screen.getByTestId(`nav-${route}`).getAttribute('data-active')).toBe('true')
    }

    fireEvent.click(screen.getByTestId('weave-close'))
    expect(screen.queryByTestId('weave-dashboard')).toBeNull()
  })
})
