/// <reference lib="dom" />
// @vitest-environment jsdom
/**
 * dsh-weave Web 客户端端到端界面测试。
 *
 * 覆盖：
 * 1. 构建产物必须是 DSH ModuleLoader bundle；
 * 2. 客户端注册到 sidebar.footer.action，而不是 settings.section；
 * 3. 左侧动作可打开全屏 Dashboard；
 * 4. Dashboard 内部左侧导航可切换 8 个页面；
 * 5. 关闭按钮能关闭界面。
 *
 * 运行：
 * pnpm build && pnpm vitest run src/plugins/weave/__tests__/client-bundle.ui.test.tsx
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import React, { createElement, type ComponentType } from 'react'
import ReactDOM from 'react-dom'

type WeaveActionComponent = ComponentType<{ wide?: boolean }>
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

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
    expect(exported.inject).toEqual(['slots', 'connection'])
    expect(exported.apply).toBeTypeOf('function')
  })
})

const SEP = String.fromCharCode(92)

type RpcCall = { endpoint: string; payload: unknown }

function makeClientContext(endpointValues: Record<string, unknown> = {}) {
  const calls: RpcCall[] = []
  let component: WeaveActionComponent | undefined
  const ctx = {
    effect(execute: () => unknown) {
      execute()
    },
    get(service: string) {
      if (service !== 'connection') throw new Error(`unexpected service: ${service}`)
      return {
        rpc: {
          async call(_channel: string, endpoint: string, payload: unknown) {
            calls.push({ endpoint, payload })
            if (Object.prototype.hasOwnProperty.call(endpointValues, endpoint)) {
              return { ok: true, value: endpointValues[endpoint] }
            }
            if (endpoint === 'snapshot') {
              return {
                ok: true,
                value: {
                  teams: [],
                  executors: [{ id: 'zcode' }, { id: 'spawn' }],
                  zcodeCapabilities: {
                    models: [{ value: ['provider-id', 'deepseek-v4-flash'].join(SEP), name: 'deepseek › deepseek-v4-flash' }],
                    currentModel: ['provider-id', 'deepseek-v4-flash'].join(SEP),
                    modes: [{ value: 'plan' }, { value: 'build' }, { value: 'yolo' }],
                    currentMode: 'build',
                    thoughtLevels: [{ value: 'off' }, { value: 'high' }, { value: 'max' }],
                    currentThoughtLevel: 'max',
                  },
                },
              }
            }
            return { ok: true, value: { team_id: 'my-team', name: '我的团队', roles: 1 } }
          },
        },
      }
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
  return { calls, ctx, get component() { return component } }
}

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
    const calls: RpcCall[] = []
    const ctx = {
      effect(execute: () => unknown) {
        execute()
      },
      get(service: string) {
        if (service !== 'connection') throw new Error(`unexpected service: ${service}`)
        return {
          rpc: {
            async call(_channel: string, endpoint: string, payload: unknown) {
              calls.push({ endpoint, payload })
              if (endpoint === 'snapshot') {
                return { ok: true, value: { teams: [], executors: [{ id: 'zcode' }, { id: 'spawn' }] } }
              }
              return { ok: true, value: { team_id: 'my-team', name: '我的团队', roles: 1 } }
            },
          },
        }
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

  it('团队页可通过 RPC 创建团队', async () => {
    const moduleRequire = (id: string) => {
      if (id === 'react') return React
      if (id === 'react-dom') return ReactDOM
      throw new Error(`unexpected client dependency: ${id}`)
    }
    const exported = getCapturedBundle().factory(moduleRequire)
    const fixture = makeClientContext()
    exported.apply(fixture.ctx as never)

    render(createElement(fixture.component!, { wide: true }))
    fireEvent.click(screen.getByTestId('weave-open'))
 fireEvent.click(screen.getByTestId('nav-teams'))

    const page = await screen.findByTestId('page-teams')
    await waitFor(() => {
      expect((page.querySelector('select') as HTMLSelectElement).value).toBe('zcode')
    })
    expect(screen.getByTestId('model-select').textContent).toContain('deepseek-v4-flash')

    fireEvent.change(screen.getByTestId('team-id-input'), { target: { value: 'my-team' } })
    fireEvent.change(screen.getByTestId('team-name-input'), { target: { value: '我的团队' } })
    fireEvent.change(screen.getByTestId('model-select'), { target: { value: ['provider-id', 'deepseek-v4-flash'].join(SEP) } })
    expect(screen.getByTestId('team-create-submit').textContent).toContain('包含 1 个角色')
    fireEvent.click(screen.getByTestId('team-create-submit'))

    await waitFor(() => {
      expect(fixture.calls.some((call) => call.endpoint === 'team/import')).toBe(true)
    })
    const imported = fixture.calls.find((call) => call.endpoint === 'team/import')
    expect(imported?.payload).toMatchObject({
      overwrite: true,
      config: {
        team_id: 'my-team',
        roles: [{ id: 'member', executor: 'zcode', provider: 'provider-id', model: 'deepseek-v4-flash' }],
      },
    })
    await screen.findByText('已保存：my-team（1 个角色）')
  })

  it('Dashboard 内部导航可切换 8 个页面，关闭按钮可退出', async () => {
    const moduleRequire = (id: string) => {
      if (id === 'react') return React
      if (id === 'react-dom') return ReactDOM
      throw new Error(`unexpected client dependency: ${id}`)
    }
    const exported = getCapturedBundle().factory(moduleRequire)

    let component: WeaveActionComponent | undefined
    const calls: RpcCall[] = []
    const ctx = {
      effect(execute: () => unknown) {
        execute()
      },
      get(service: string) {
        if (service !== 'connection') throw new Error(`unexpected service: ${service}`)
        return {
          rpc: {
            async call(_channel: string, endpoint: string, payload: unknown) {
              calls.push({ endpoint, payload })
              if (endpoint === 'snapshot') {
                return { ok: true, value: { teams: [], executors: [{ id: 'zcode' }, { id: 'spawn' }] } }
              }
              return { ok: true, value: { team_id: 'my-team', name: '我的团队', roles: 1 } }
            },
          },
        }
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

    for (const route of ['teams', 'tasks', 'knowledge', 'executors', 'sessions', 'audit', 'settings']) {
      fireEvent.click(screen.getByTestId(`nav-${route}`))
      expect(screen.getByTestId(`page-${route}`)).toBeTruthy()
      expect(screen.getByTestId(`nav-${route}`).getAttribute('data-active')).toBe('true')
    }

    fireEvent.click(screen.getByTestId('weave-close'))
    expect(screen.queryByTestId('weave-dashboard')).toBeNull()
  })
})
describe('dsh-weave 全功能真实页面（t3 覆盖）', () => {
  const moduleRequireOf = () => (id: string) => {
    if (id === 'react') return React
    if (id === 'react-dom') return ReactDOM
    throw new Error(`unexpected client dependency: ${id}`)
  }

  it('总览卡片可跳转对应页面', async () => {
    const exported = getCapturedBundle().factory(moduleRequireOf())
    const fixture = makeClientContext()
    exported.apply(fixture.ctx as never)
    render(createElement(fixture.component!, { wide: true }))
    fireEvent.click(screen.getByTestId('weave-open'))
    await waitFor(() => expect(screen.getByTestId('weave-dashboard')).toBeTruthy())
    expect(screen.getByTestId('overview-card-teams')).toBeTruthy()
    expect(screen.getByTestId('overview-card-tasks')).toBeTruthy()
    expect(screen.getByTestId('overview-card-knowledge')).toBeTruthy()
    fireEvent.click(screen.getByTestId('overview-card-teams'))
    expect(await screen.findByTestId('page-teams')).toBeTruthy()
    expect(screen.getByTestId('nav-teams').getAttribute('data-active')).toBe('true')
  })

  it('团队页多角色编辑器：添加与删除角色', async () => {
    const exported = getCapturedBundle().factory(moduleRequireOf())
    const fixture = makeClientContext()
    exported.apply(fixture.ctx as never)
    render(createElement(fixture.component!, { wide: true }))
    fireEvent.click(screen.getByTestId('weave-open'))
    fireEvent.click(screen.getByTestId('nav-teams'))
    await screen.findByTestId('page-teams')
    expect(screen.getByTestId('role-editor-0')).toBeTruthy()
    fireEvent.click(screen.getByTestId('team-add-role'))
    expect(screen.getByTestId('role-editor-1')).toBeTruthy()
    expect(screen.getByTestId('team-create-submit').textContent).toContain('包含 2 个角色')
    fireEvent.click(within(screen.getByTestId('role-editor-1')).getByText('删除角色'))
    expect(screen.queryByTestId('role-editor-1')).toBeNull()
    expect(screen.getByTestId('team-create-submit').textContent).toContain('包含 1 个角色')
  })

  it('任务中心：真实列表渲染、状态过滤触发带 status 的请求、按状态出动作', async () => {
    const exported = getCapturedBundle().factory(moduleRequireOf())
    const fixture = makeClientContext({
      'task/list': {
        total: 2,
        tasks: [
          { id: 'T-1', description: '实现功能', status: 'RUNNING', team_id: 'my-team', project_id: 'demo', version: '0.1.0', updated_at: '2025-01-01T10:00:00Z' },
          { id: 'T-2', description: '修复缺陷', status: 'FAILED', team_id: 'my-team', project_id: 'demo', version: '0.1.0', updated_at: '2025-01-02T10:00:00Z' },
        ],
      },
    })
    exported.apply(fixture.ctx as never)
    render(createElement(fixture.component!, { wide: true }))
    fireEvent.click(screen.getByTestId('weave-open'))
    fireEvent.click(screen.getByTestId('nav-tasks'))
    await screen.findByTestId('task-row-T-1')
    expect(screen.getByTestId('task-row-T-2')).toBeTruthy()
    expect(screen.getByTestId('task-create-submit')).toBeTruthy()
    const filter = screen.getByTestId('task-status-filter') as HTMLSelectElement
    expect(filter.options.length).toBe(15)
    expect(screen.getByTestId('task-action-cancel-T-1')).toBeTruthy()
    expect(screen.getByTestId('task-action-retry-T-2')).toBeTruthy()
    fireEvent.change(filter, { target: { value: 'FAILED' } })
    await waitFor(() => {
      const listed = fixture.calls.filter((item) => item.endpoint === 'task/list')
      expect(listed.some((item) => (item.payload as Record<string, unknown>).status === 'FAILED')).toBe(true)
    })
  })

  it('知识库：candidate 审核通过会调用 knowledge/approve', async () => {
    const exported = getCapturedBundle().factory(moduleRequireOf())
    const fixture = makeClientContext({
      'knowledge/list': {
        candidates: [
          { id: 'k-1', title: '部署手册', layer: 'project', status: 'candidate', confidence: 0.9, freshness_score: 0.8, path: '/k/deploy.md' },
        ],
      },
      'knowledge/approve': {},
    })
    exported.apply(fixture.ctx as never)
    render(createElement(fixture.component!, { wide: true }))
    fireEvent.click(screen.getByTestId('weave-open'))
    fireEvent.click(screen.getByTestId('nav-knowledge'))
    await screen.findByTestId('knowledge-item-k-1')
    fireEvent.click(screen.getByTestId('knowledge-approve-k-1'))
    await waitFor(() => {
      expect(fixture.calls.some((item) => item.endpoint === 'knowledge/approve')).toBe(true)
    })
    const approved = fixture.calls.find((item) => item.endpoint === 'knowledge/approve')
    expect((approved?.payload as Record<string, unknown>).id).toBe('k-1')
    await screen.findByText('已通过：k-1')
  })

  it('会话管理与设置页：confirm 后解绑、只读配置渲染', async () => {
    const exported = getCapturedBundle().factory(moduleRequireOf())
    const fixture = makeClientContext({
      'session/bindings': { bindings: [{ session_id: 'sess-1', team_id: 'my-team', updated_at: '2025-01-03T08:00:00Z' }] },
      'session/clear-binding': { session_id: 'sess-1', unbound: true },
      'settings/describe': {
        version: '9.9.9-test',
        node_version: process.version,
        state_dir: '/state',
        teams_dir: '/teams',
        audit_dir: '/audit',
        zcode: { configured: false, registered: true },
      },
    })
    const confirmSpy = vi.fn(() => true)
    window.confirm = confirmSpy
    exported.apply(fixture.ctx as never)
    render(createElement(fixture.component!, { wide: true }))
    fireEvent.click(screen.getByTestId('weave-open'))
    fireEvent.click(screen.getByTestId('nav-sessions'))
    await screen.findByTestId('binding-row-sess-1')
    fireEvent.click(screen.getByTestId('binding-unbind-sess-1'))
    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalled()
      expect(fixture.calls.some((item) => item.endpoint === 'session/clear-binding')).toBe(true)
    })
    fireEvent.click(screen.getByTestId('nav-settings'))
    const settings = await screen.findByTestId('settings-list')
    expect(settings.textContent).toContain('9.9.9-test')
    expect(settings.textContent).toContain(process.version)
  })
})
