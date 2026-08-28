/// <reference lib="dom" />
// @vitest-environment jsdom
/**
 * dsh-weave Web 客户端端到端界面测试。
 *
 * 覆盖：
 * 1. 构建产物必须是 DSH ModuleLoader bundle；
 * 2. 客户端注册到 sidebar.footer.action，而不是 settings.section；
 * 3. 左侧动作可打开全屏 Dashboard；
 * 4. Dashboard 内部左侧导航可切换 7 个页面（任务中心/会话管理已移除）；
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
    expect(exported.inject).toEqual(['slots', 'connection', 'sessions'])
    expect(exported.apply).toBeTypeOf('function')
  })
})

const SEP = String.fromCharCode(92)

type RpcCall = { endpoint: string; payload: unknown }

function makeClientContext(endpointValues: Record<string, unknown> = {}) {
  const calls: RpcCall[] = []
  let component: WeaveActionComponent | undefined
  const registrations: Array<{ name: string; component: ComponentType<Record<string, unknown>> }> = []
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
                  executors: [{ id: 'spawn' }, { id: 'fork' }],
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
      register(def: { id?: string; name?: string }, registered: ComponentType) {
        registrations.push({ name: def?.name ?? '', component: registered })
        if (def?.name === 'sidebar.footer.action') component = registered
        return () => undefined
      },
    },
  }
  return {
    calls,
    ctx,
    get component() { return component },
    registration(name: string) {
      return registrations.find((item) => item.name === name)?.component
    },
  }
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
                return { ok: true, value: { teams: [], executors: [{ id: 'spawn' }, { id: 'fork' }] } }
              }
              return { ok: true, value: { team_id: 'my-team', name: '我的团队', roles: 1 } }
            },
          },
        }
      },
      slots: {
        inject(slot: string, register: () => unknown) {
          if (!registeredSlot) registeredSlot = slot
          register()
        },
        register(def: { id?: string }, component: ComponentType) {
          if (!registeredDef) registeredDef = def
          if (!registeredComponent) registeredComponent = component
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

    for (const route of ['overview', 'teams', 'knowledge', 'executors', 'audit', 'settings']) {
      expect(screen.getByTestId(`nav-${route}`)).toBeTruthy()
    }
    // 任务中心与会话管理已从导航中移除
    expect(screen.queryByTestId('nav-tasks')).toBeNull()
    expect(screen.queryByTestId('nav-sessions')).toBeNull()
  })

  it('非 ZCode 角色也展示 Provider/Model 下拉', async () => {
    const moduleRequire = (id: string) => {
      if (id === 'react') return React
      if (id === 'react-dom') return ReactDOM
      throw new Error(`unexpected client dependency: ${id}`)
    }
    const exported = getCapturedBundle().factory(moduleRequire)
    const fixture = makeClientContext({
      snapshot: {
        teams: [],
        executors: [{ id: 'spawn' }, { id: 'fork' }],
        zcodeCapabilities: {
          models: [{ value: ['prov-a', 'deepseek-v4-flash'].join(SEP), name: 'deepseek › deepseek-v4-flash' }],
          modes: [],
          thoughtLevels: [],
        },
      },
    })
    exported.apply(fixture.ctx as never)
    render(createElement(fixture.component!, { wide: true }))
    fireEvent.click(screen.getByTestId('weave-open'))
    fireEvent.click(screen.getByTestId('nav-teams'))
    await screen.findByTestId('page-teams')
    // 重构后表单移入「新建团队」模态，先打开编辑器再断言字段联动。
    fireEvent.click(screen.getByTestId('team-new-btn'))
    await screen.findByTestId('role-editor-0')
    const providerSelect = screen.getByTestId('provider-select-0') as HTMLSelectElement
    const modelSelect = screen.getByTestId('model-select-0') as HTMLSelectElement
    expect(Array.from(providerSelect.options).map((option) => option.value)).toContain('prov-a')
    fireEvent.change(providerSelect, { target: { value: 'prov-a' } })
    expect(Array.from(modelSelect.options).map((option) => option.value)).toContain('deepseek-v4-flash')
    expect(screen.getByTestId('fallback-provider-select-0')).toBeTruthy()
    expect(screen.getByTestId('fallback-model-select-0')).toBeTruthy()
  })

  it('团队页可通过 RPC 创建团队', async () => {
    const moduleRequire = (id: string) => {
      if (id === 'react') return React
      if (id === 'react-dom') return ReactDOM
      throw new Error(`unexpected client dependency: ${id}`)
    }
    const exported = getCapturedBundle().factory(moduleRequire)
    const fixture = makeClientContext({
      snapshot: {
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
    })
    exported.apply(fixture.ctx as never)

    render(createElement(fixture.component!, { wide: true }))
    fireEvent.click(screen.getByTestId('weave-open'))
    fireEvent.click(screen.getByTestId('nav-teams'))

    await screen.findByTestId('page-teams')
    // 重构后表单在「新建团队」模态内；先开编辑器，等执行器默认值填充。
    fireEvent.click(screen.getByTestId('team-new-btn'))
    const editor = await screen.findByTestId('team-editor')
    await waitFor(() => {
      expect((editor.querySelector('select') as HTMLSelectElement).value).toBe('zcode')
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

  it('Dashboard 内部导航可切换 7 个页面，关闭按钮可退出', async () => {
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
          if (!component) component = registered
          return () => undefined
        },
      },
    }
    exported.apply(ctx)

    render(createElement(component!))
    fireEvent.click(screen.getByTestId('weave-open'))
    expect(screen.getByTestId('page-overview')).toBeTruthy()

    for (const route of ['teams', 'knowledge', 'executors', 'audit', 'settings', 'manual']) {
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
    // 重构后多角色编辑器位于「新建团队」模态内。
    fireEvent.click(screen.getByTestId('team-new-btn'))
    await screen.findByTestId('role-editor-0')
    expect(screen.getByTestId('role-editor-0')).toBeTruthy()
    fireEvent.click(screen.getByTestId('team-add-role'))
    expect(screen.getByTestId('role-editor-1')).toBeTruthy()
    expect(screen.getByTestId('team-create-submit').textContent).toContain('包含 2 个角色')
    fireEvent.click(within(screen.getByTestId('role-editor-1')).getByText('删除角色'))
    expect(screen.queryByTestId('role-editor-1')).toBeNull()
    expect(screen.getByTestId('team-create-submit').textContent).toContain('包含 1 个角色')
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

  it('设置页只读配置渲染；会话绑定职责已移交会话面板', async () => {
    const exported = getCapturedBundle().factory(moduleRequireOf())
    const fixture = makeClientContext({
      'settings/describe': {
        version: '9.9.9-test',
        node_version: process.version,
        state_dir: '/state',
        teams_dir: '/teams',
        audit_dir: '/audit',
        zcode: { configured: false, registered: true },
      },
    })
    exported.apply(fixture.ctx as never)
    render(createElement(fixture.component!, { wide: true }))
    fireEvent.click(screen.getByTestId('weave-open'))
    fireEvent.click(screen.getByTestId('nav-settings'))
    const settings = await screen.findByTestId('settings-list')
    expect(settings.textContent).toContain('9.9.9-test')
    expect(settings.textContent).toContain(process.version)

    // nav-sessions 不存在：绑定在会话视图面板内完成
    expect(screen.queryByTestId('nav-sessions')).toBeNull()
  })
})
describe('t8 会话优先模型与治理化改造', () => {
  const moduleRequireOf = () => (id: string) => {
    if (id === 'react') return React
    if (id === 'react-dom') return ReactDOM
    throw new Error(`unexpected client dependency: ${id}`)
  }

  it('任务中心已整体移除：无导航入口、无任何任务创建/提交表单（下发只走对话）', async () => {
    const exported = getCapturedBundle().factory(moduleRequireOf())
    const fixture = makeClientContext()
    exported.apply(fixture.ctx as never)
    render(createElement(fixture.component!, { wide: true }))
    fireEvent.click(screen.getByTestId('weave-open'))
    expect(screen.queryByTestId('nav-tasks')).toBeNull()
    expect(screen.queryByText('创建任务')).toBeNull()
    expect(screen.queryByTestId('task-create-submit')).toBeNull()
    expect(screen.queryByTestId('task-project-input')).toBeNull()

    const source = await readFile(sourcePath, 'utf8')
    // 源码层面确认：路由与下发通道均已移除
    expect(source).not.toContain("'tasks'")
    expect(source).not.toContain("key: 'sessions'")
    expect(source).not.toContain('task/create')
  })

  it('不再注册输入框团队选择器；团队启停由当前会话自然语言处理', async () => {
    const exported = getCapturedBundle().factory(moduleRequireOf())
    const fixture = makeClientContext()
    exported.apply(fixture.ctx as never)
    expect(fixture.registration('conversation.input.right')).toBeUndefined()

    const source = await readFile(sourcePath, 'utf8')
    expect(source).not.toContain('conversation.input.right')
    expect(source).not.toContain('session-team-selector')
  })
  it('知识页：Obsidian Vault 入口可用，图谱按真实 [[双链]] 渲染', async () => {
    const exported = getCapturedBundle().factory(moduleRequireOf())
    const fixture = makeClientContext({
      'settings/describe': {
        version: '9.9.9-test',
        node_version: process.version,
        state_dir: '/state',
        teams_dir: '/teams',
        audit_dir: '/audit',
        providers_file: '/f/providers.json',
        obsidian_dir: '~/.dsh/obsidian',
      },
      'knowledge/graph': {
        nodes: [
          { id: 'g-a', title: 'A 指南', status: 'active', layer: 'project', tags: ['图谱'], kind: 'knowledge' },
          { id: 'g-b', title: 'B 指南', status: 'candidate', layer: 'project', tags: [], kind: 'knowledge' },
          { id: 'missing:未收录', title: '未收录', status: 'missing', layer: 'shared', tags: [], kind: 'missing' },
        ],
        edges: [
          { source: 'g-a', target: 'g-b' },
          { source: 'g-a', target: 'missing:未收录' },
        ],
        counts: { knowledge: 2, missing: 1, edges: 2, unresolved: 1, skipped: 0 },
      },
      'knowledge/list': {
        candidates: [
          { id: 'g-b', title: 'B 指南', layer: 'project', status: 'candidate', confidence: 0.5, freshness_score: 0.5 },
        ],
      },
    })
    exported.apply(fixture.ctx as never)
    render(createElement(fixture.component!, { wide: true }))
    fireEvent.click(screen.getByTestId('weave-open'))
    fireEvent.click(screen.getByTestId('nav-knowledge'))

    await screen.findByTestId('obsidian-panel')
    expect(screen.getByTestId('obsidian-path').textContent).toBe('~/.dsh/obsidian')
    expect(screen.getByTestId('obsidian-open').getAttribute('href')).toBe('obsidian://open?path=~%2F.dsh%2Fobsidian')
    await screen.findByTestId('knowledge-graph')
    expect(screen.getByTestId('knowledge-node-g-a').getAttribute('data-kind')).toBe('knowledge')
    fireEvent.click(screen.getByTestId('knowledge-node-g-a'))
    await screen.findByTestId('knowledge-graph-detail')
    expect(screen.getByTestId('knowledge-graph-detail').textContent).toContain('A 指南')

    fireEvent.change(screen.getByTestId('knowledge-graph-layer-filter'), { target: { value: 'project' } })
    await waitFor(() => {
      expect(fixture.calls.some((call) => call.endpoint === 'knowledge/graph' && (call.payload as Record<string, unknown>).layer === 'project')).toBe(true)
    })
  })

  it('独立命令手册页展示全部 /weave 命令', async () => {
    const exported = getCapturedBundle().factory(moduleRequireOf())
    const fixture = makeClientContext({
      'settings/describe': {
        version: '9.9.9-test',
        node_version: process.version,
        state_dir: '/state',
        teams_dir: '/teams',
        audit_dir: '/audit',
        obsidian_dir: '/obsidian',
      },
    })
    exported.apply(fixture.ctx as never)
    render(createElement(fixture.component!, { wide: true }))
    fireEvent.click(screen.getByTestId('weave-open'))
    fireEvent.click(screen.getByTestId('nav-manual'))
    await screen.findByTestId('page-manual')
    // 零仪式为首：直接描述目标即队长模式；启用短句退居多团队指定场景
    expect(screen.getByTestId('command-row-0').textContent).toContain('<直接描述目标>')
    expect(screen.getByText((t) => t.includes('启用 <团队名>'))).toBeTruthy()
    expect(screen.getByText('/weave provider add <JSON|YAML|文件路径|紧凑配置>')).toBeTruthy()
    expect(screen.queryByText((t) => t.includes('task submit'))).toBeNull()
  })

  it('执行器页展示动态 provider 与声明扩展；设置页展示配置来源', async () => {
    const exported = getCapturedBundle().factory(moduleRequireOf())
    const fixture = makeClientContext({
      'provider/list': {
        providers: [
          { name: 'myacp', transport: 'stdio', command: 'node', args: ['srv.js'], protocol: 'acp', declaredExtensions: ['zcode'], enabled: true },
        ],
      },
      'settings/describe': {
        version: '9.9.9-test',
        node_version: process.version,
        state_dir: '/state',
        teams_dir: '/teams',
        audit_dir: '/audit',
        providers_file: '/f/providers.json',
        zcode: { configured: false, registered: true },
      },
    })
    exported.apply(fixture.ctx as never)
    render(createElement(fixture.component!, { wide: true }))
    fireEvent.click(screen.getByTestId('weave-open'))

    fireEvent.click(screen.getByTestId('nav-executors'))
    const card = await screen.findByTestId('provider-card-myacp')
    expect(card.textContent).toContain('已生效')
    expect(card.textContent).toContain('node srv.js')
    expect(card.textContent).toContain('zcode')
    expect(card.textContent).toContain('自动降级')

    fireEvent.click(screen.getByTestId('nav-settings'))
    const summary = await screen.findByTestId('providers-summary')
    expect(summary.textContent).toContain('/f/providers.json')
    expect(summary.textContent).toContain('myacp · stdio · node · 已生效')
  })
})
describe('t9 会话即团队面板（conversation.view 槽位）与 DAG 可视化', () => {
  const moduleRequireOf = () => (id: string) => {
    if (id === 'react') return React
    if (id === 'react-dom') return ReactDOM
    throw new Error(`unexpected client dependency: ${id}`)
  }

  const THREE_NODE_DAG = {
    dag_id: 'D1',
    status: 'RUNNING',
    tasks: [
      { id: 'T-A', description: '根任务', status: 'RUNNING', dependencies: [], assigned_agent: 'agent-1', team_id: 'my-team', project_id: 'demo', version: '0.1.0', updated_at: '2025-01-05T09:00:00Z' },
      { id: 'T-B', description: '中间任务', status: 'WAITING', dependencies: ['T-A'] },
      { id: 'T-C', description: '末级任务', status: 'COMPLETED', dependencies: ['T-B'] },
    ],
    edges: [
      { from: 'T-A', to: 'T-B' },
      { from: 'T-B', to: 'T-C' },
    ],
  }

  const STATUS_OK = {
    session_id: 'sess-ui',
    team: { team_id: 'alpha', name: '阿尔法小队' },
    members: [
      { role_id: 'designer', name: '设计师', executor: 'zcode', status: 'idle' },
      { role_id: 'coder', name: '程序员', executor: 'zcode', status: 'running', task_id: 'T-A', subject: '根任务' },
      { role_id: 'reviewer', name: '审核员', executor: 'codex', status: 'idle' },
    ],
  }

  function panelFixture(endpointValues: Record<string, unknown>) {
    const exported = getCapturedBundle().factory(moduleRequireOf())
    const fixture = makeClientContext(endpointValues)
    exported.apply(fixture.ctx as never)
    const panel = fixture.registration('conversation.view')
    if (!panel) throw new Error('conversation.view slot not registered')
    return { fixture, panel }
  }

  it('面板结构：团队头 + 成员卡片 + 本会话任务图；执行中成员带当前任务', async () => {
    const { panel } = panelFixture({
      'session/status': STATUS_OK,
      'task/list': { total: 3, tasks: [{ id: 'T-A', dag_id: 'D1', description: '根任务', status: 'RUNNING', team_id: 'alpha', project_id: 'demo', version: '0.1.0', updated_at: '2025-01-05T09:00:00Z' }] },
      'task/get': THREE_NODE_DAG,
    })
    render(createElement(panel!, { sessionId: 'sess-ui' }))

    await screen.findByTestId('member-card-coder')
    expect(screen.getByTestId('weave-session-team-name').textContent).toContain('阿尔法小队')
    expect(screen.getByTestId('member-card-coder').textContent).toContain('程序员')
    expect(screen.getByTestId('member-card-coder').textContent).toContain('执行中')
    expect(screen.getByTestId('member-card-designer').textContent).toContain('空闲')

    await screen.findByTestId('dag-panel')
    expect(screen.getAllByTestId(/^dag-node-/).length).toBe(3)
    expect(screen.getByTestId('dag-edges').querySelectorAll('path').length).toBe(2)
    expect(screen.getByTestId('dag-node-T-C').textContent).toContain('已完成')

    // 层级：x 随最长依赖路径递增
    const leftOf = (id: string) => Number.parseInt((screen.getByTestId('dag-node-' + id) as HTMLElement).style.left, 10)
    expect(leftOf('T-C')).toBeGreaterThan(leftOf('T-B'))
    expect(leftOf('T-B')).toBeGreaterThan(leftOf('T-A'))
  })

  it('点节点聚焦上下游链：关联边 data-active 高亮、无关边/节点 data-dimmed 暗化', async () => {
    const { panel } = panelFixture({
      'session/status': STATUS_OK,
      'task/list': { total: 4, tasks: [{ id: 'T-A', dag_id: 'D1', description: '根任务', status: 'RUNNING', team_id: 'alpha', project_id: 'demo', version: '0.1.0', updated_at: '2025-01-05T09:00:00Z' }] },
      'task/get': {
        dag_id: 'D1',
        status: 'RUNNING',
        tasks: [
          { id: 'T-A', description: '根任务', status: 'COMPLETED', dependencies: [] },
          { id: 'T-B', description: '中间任务', status: 'RUNNING', dependencies: ['T-A'] },
          { id: 'T-C', description: '末级任务', status: 'WAITING', dependencies: ['T-B'] },
          { id: 'T-D', description: '旁路任务', status: 'WAITING', dependencies: ['T-A'] },
        ],
        edges: [
          { from: 'T-A', to: 'T-B' },
          { from: 'T-A', to: 'T-D' },
          { from: 'T-B', to: 'T-C' },
        ],
      },
    })
    render(createElement(panel!, { sessionId: 'sess-ui' }))

    await screen.findByTestId('dag-panel')
    // 默认选中首个任务 T-A（链头，全员相关）→ 无暗化
    expect(screen.getByTestId('dag-edges').querySelectorAll('path[data-dimmed="true"]').length).toBe(0)
    // 点击 T-B：聚焦其上下游链 T-A→T-B→T-C；旁路 T-D 及其入边暗化
    fireEvent.click(screen.getByTestId('dag-node-T-B'))
    const paths = screen.getByTestId('dag-edges').querySelectorAll('path')
    expect(paths).toHaveLength(3)
    expect(paths[0]!.getAttribute('data-active')).toBe('true') // T-A→T-B
    expect(paths[1]!.getAttribute('data-dimmed')).toBe('true') // T-A→T-D
    expect(paths[2]!.getAttribute('data-active')).toBe('true') // T-B→T-C
    expect((screen.getByTestId('dag-node-T-B') as HTMLElement).getAttribute('data-focused')).toBe('true')
    expect((screen.getByTestId('dag-node-T-D') as HTMLElement).getAttribute('data-dimmed')).toBe('true')
    expect((screen.getByTestId('dag-node-T-A') as HTMLElement).getAttribute('data-dimmed')).toBe('false')
  })

  it('dag 激活时页签体有真实高度预算（minHeight）且 dag-panel 渲染（图小修复）', async () => {
    const { panel } = panelFixture({
      'session/status': STATUS_OK,
      'task/list': { total: 3, tasks: [{ id: 'T-A', dag_id: 'D1', description: '根任务', status: 'RUNNING', team_id: 'alpha', project_id: 'demo', version: '0.1.0', updated_at: '2025-01-05T09:00:00Z' }] },
      'task/get': THREE_NODE_DAG,
    })
    render(createElement(panel!, { sessionId: 'sess-ui' }))

    await screen.findByTestId('dag-panel')
    // 页签体在 dag 激活时注入 minHeight 预算（视口高减固定 chrome，下限 420px）
    const body = screen.getByTestId('weave-session-tab-body') as HTMLElement
    expect(body.style.minHeight).toContain('100vh')
    expect(body.style.minHeight).toContain('420px')
    // 紧凑布局：画布=内容精确尺寸（3 节点链 328×30，不缩放不铺满），wrap 只做横向滚动
    const wrap = screen.getByTestId('dag-panel') as HTMLElement
    expect(wrap.style.overflowX).toBe('auto')
    const canvas = wrap.querySelector('.weave-dag-canvas') as HTMLElement
    expect(canvas.style.width).toBe('328px')
    expect(canvas.style.height).toBe('30px')
    // 节点为参照物固定几何 92×30
    expect(screen.getAllByTestId(/^dag-node-/).length).toBe(3)
    const node = screen.getByTestId('dag-node-T-A') as HTMLElement
    expect(node.style.width).toBe('92px')
    expect(node.style.height).toBe('30px')
  })

  it('节点治理动作：选中 RUNNING 节点出现取消按钮并调用 task/action', async () => {
    const { fixture, panel } = panelFixture({
      'session/status': STATUS_OK,
      'task/list': { total: 3, tasks: [{ id: 'T-A', dag_id: 'D1', description: '根任务', status: 'RUNNING', team_id: 'alpha', project_id: 'demo', version: '0.1.0', updated_at: '2025-01-05T09:00:00Z' }] },
      'task/get': THREE_NODE_DAG,
      'task/action': { task_id: 'T-A', status: 'CANCELLED' },
    })
    render(createElement(panel!, { sessionId: 'sess-ui' }))

    await screen.findByTestId('dag-panel')
    // 默认选中第一个节点 T-A（RUNNING）→ 出现「取消」动作
    await waitFor(() => expect(screen.getByTestId('session-task-action-cancel-T-A')).toBeTruthy())
    fireEvent.click(screen.getByTestId('session-task-action-cancel-T-A'))
    await screen.findByTestId('session-confirm-action')
    fireEvent.click(screen.getByTestId('session-confirm-action-confirm'))
    await waitFor(() => {
      const acts = fixture.calls.filter((item) => item.endpoint === 'task/action')
      expect(acts.some((item) => (item.payload as Record<string, unknown>).taskId === 'T-A')).toBe(true)
    })
  })

  it('无法确定团队时：展示多团队指定指引且不请求任务图', async () => {
    const { fixture, panel } = panelFixture({
      'session/status': { session_id: 'sess-ui', team: null, members: [] },
    })
    render(createElement(panel!, { sessionId: 'sess-ui' }))
    await screen.findByTestId('page-empty')
    expect(screen.getByTestId('page-empty').textContent).toContain('无法确定本次会话的团队')
    expect(screen.getByTestId('page-empty').textContent).toContain('多个团队')
    expect(fixture.calls.some((call) => call.endpoint === 'session/status' && (call.payload as Record<string, unknown>).sessionId === 'sess-ui')).toBe(true)
    expect(fixture.calls.some((call) => call.endpoint === 'task/get')).toBe(false)
  })

  it('绑定切换：下拉选择团队触发 session/set-binding', async () => {
    const { fixture, panel } = panelFixture({
      snapshot: {
        teams: [{ team_id: 'alpha', name: '阿尔法小队' }, { team_id: 'beta', name: '贝塔小队' }],
        executors: [],
      },
      'session/status': STATUS_OK,
      'task/list': { total: 0, tasks: [] },
      'session/set-binding': { session_id: 'sess-ui', team_id: 'beta' },
    })
    render(createElement(panel!, { sessionId: 'sess-ui' }))
    const select = (await screen.findByTestId('weave-session-team-select')) as HTMLSelectElement
    expect(select.value).toBe('alpha')
    fireEvent.change(select, { target: { value: 'beta' } })
    await waitFor(() => {
      expect(fixture.calls.some((call) => call.endpoint === 'session/set-binding' && (call.payload as Record<string, unknown>).teamId === 'beta')).toBe(true)
    })
  })

  it('分层布局回归：单节点无边图', async () => {
    const { panel } = panelFixture({
      'session/status': STATUS_OK,
      'task/list': { total: 1, tasks: [{ id: 'S-1', dag_id: 'S-DAG', description: '独立任务', status: 'RUNNING', updated_at: '2025-01-06T09:00:00Z' }] },
      'task/get': { dag_id: 'S-DAG', status: 'running', tasks: [{ id: 'S-1', status: 'RUNNING', dependencies: [] }], edges: [] },
    })
    render(createElement(panel!, { sessionId: 'sess-ui' }))
    await screen.findByTestId('dag-panel')
    expect(screen.getAllByTestId(/^dag-node-/).length).toBe(1)
    expect(screen.getByTestId('dag-edges').querySelectorAll('path').length).toBe(0)
    expect(screen.getByTestId('dag-node-S-1').textContent).toContain('执行中')
  })
})
