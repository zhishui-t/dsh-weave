/// <reference lib="dom" />

/**
 * dsh-weave DSH Web 客户端插件。
 * 输出物是 DSH ModuleLoader bundle，不是 ESM。
 * 入口注册到左侧导航栏的 sidebar.footer.action，点击打开全屏 Dashboard。
 */

interface SlotDefinition {
  name: string
  id?: string
  order?: number
  label?: string | (() => string)
}

interface SlotsService {
  inject(slot: string, register: () => unknown): unknown
  register(def: SlotDefinition, component: unknown): () => void
}

interface ConnectionRpc {
  call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<{
    ok: boolean
    value?: unknown
    error?: { code: string; message: string }
  }>
}

interface ConnectionHandle {
  rpc: ConnectionRpc
}

interface ClientContext {
  effect(execute: () => unknown, label?: string): unknown
  get(service: 'connection'): ConnectionHandle
  slots: SlotsService
}

type RpcCaller = (endpoint: string, payload?: unknown) => Promise<unknown>

const PLUGIN_ID = '@deepseek-ai/dsh-plugin-weave'
const STYLE_ID = 'dsh-weave-client-style'

type Route =
  | 'overview'
  | 'teams'
  | 'tasks'
  | 'knowledge'
  | 'executors'
  | 'sessions'
  | 'audit'
  | 'settings'

const ROUTES: Array<{ key: Route; label: string; desc: string }> = [
  { key: 'overview', label: '总览', desc: '任务、知识与执行器的整体运行状态。' },
  { key: 'teams', label: '团队', desc: '查看团队并创建新的协作团队。' },
  { key: 'tasks', label: '任务中心', desc: '任务 DAG、依赖状态与快速取消入口。' },
  { key: 'knowledge', label: '知识库', desc: '知识导入、候选审核与注入管理。' },
  { key: 'executors', label: '执行器', desc: 'DSH Subagent / Codex / Claude Code / ACP 状态。' },
  { key: 'sessions', label: '会话管理', desc: '团队会话与修订上下文概览。' },
  { key: 'audit', label: '审计日志', desc: '核心事件与恢复操作审计。' },
  { key: 'settings', label: '设置', desc: 'Weave 本地配置与运行参数。' },
]

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
.weave-action-layer{position:relative;width:calc(100% + 4px);height:42px;margin:8px -2px 0;display:flex;flex:none}
.weave-action-layer.weave-action-rail{width:36px;height:36px;margin:0}
.weave-action-button{box-sizing:border-box;width:100%;height:42px;border:0;border-radius:12px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;cursor:pointer;display:inline-flex;align-items:center;gap:8px;margin:0;padding:0 10px 0 8px;overflow:hidden}
.weave-action-rail .weave-action-button{width:36px;height:36px;border-radius:50%;justify-content:center;gap:0;padding:0}
.weave-action-button:hover,.weave-action-button[data-open="true"]{background:var(--dsw-alias-interactive-bg-hover)}
.weave-action-mark{width:16px;height:16px;border:1.5px solid currentColor;border-radius:5px;flex:none;display:inline-flex;align-items:center;justify-content:center;font-size:9px;font-weight:750;line-height:1}
.weave-action-rail .weave-action-mark{width:18px;height:18px;font-size:10px}
.weave-action-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.weave-action-state{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px;font-variant-numeric:tabular-nums;flex:none}
.weave-overlay{position:fixed;inset:0;z-index:2147483000;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur);display:flex;align-items:center;justify-content:center}
.weave-shell{width:min(1280px,calc(100vw - 48px));height:min(860px,calc(100vh - 48px));background:var(--dsw-specific-menu);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-inverted);border-radius:24px;overflow:hidden;display:flex;box-shadow:var(--dsw-shadow-lv3)}
.weave-side{width:216px;flex:0 0 216px;border-right:1px solid var(--dsw-alias-border-l2);padding:22px 12px 12px;display:flex;flex-direction:column;gap:18px;background:var(--dsw-alias-bg-layer-2)}
.weave-brand{color:var(--dsw-alias-label-primary);font-size:16px;font-weight:600;line-height:24px;padding:0 12px}
.weave-brand small{display:block;margin-top:2px;color:var(--dsw-alias-label-caption);font-size:11px;font-weight:450;line-height:16px}
.weave-nav{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none}
.weave-nav-item{width:100%;height:40px;text-align:left;border:0;background:transparent;color:var(--dsw-alias-label-primary);border-radius:12px;padding:9px 16px 9px 12px;font:inherit;font-size:14px;line-height:22px;cursor:pointer}
.weave-nav-item:hover{background:var(--dsw-specific-sidebar-nav-item-hover)}
.weave-nav-item[data-active="true"]{background:var(--dsw-specific-sidebar-nav-item-active);font-weight:550}
.weave-main{flex:1;min-width:0;display:flex;flex-direction:column}
.weave-header{height:54px;border-bottom:1px solid var(--dsw-alias-border-l2);display:flex;align-items:center;justify-content:space-between;padding:10px 14px 8px 20px}
.weave-title{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:550;line-height:22px}
.weave-close{border:0;background:transparent;color:var(--dsw-alias-label-primary);width:28px;height:28px;border-radius:50%;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-size:16px}
.weave-close:hover{background:var(--dsw-alias-interactive-bg-hover)}
.weave-content{flex:1;min-height:0;overflow-y:auto;padding:0 24px 24px;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}
.weave-page h1{margin:20px 0 6px;color:var(--dsw-alias-label-primary);font-size:20px;line-height:28px}
.weave-note{margin:0 0 20px;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.weave-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
.weave-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:14px 12px 10px;background:var(--dsw-alias-bg-layer-2)}
.weave-card b{display:block;margin-bottom:4px;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:550;line-height:20px}
.weave-card span{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.weave-layout{display:grid;grid-template-columns:minmax(300px,420px) minmax(260px,1fr);gap:20px;align-items:start}
@media (max-width:900px){.weave-layout{grid-template-columns:1fr}}
.weave-form,.weave-team-list{display:grid;gap:12px;align-content:start;padding:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:16px;background:var(--dsw-alias-bg-layer-2)}
.weave-field{display:grid;gap:5px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.weave-field input,.weave-field select,.weave-field textarea{box-sizing:border-box;width:100%;min-height:34px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-specific-menu);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;padding:7px 9px;outline:none}
.weave-field textarea{resize:vertical}
.weave-button{border:0;border-radius:10px;background:var(--dsw-alias-brand-primary,var(--dsw-alias-label-primary));color:var(--dsw-specific-menu);font:inherit;font-weight:550;height:34px;padding:0 14px;cursor:pointer}
.weave-button:hover{filter:brightness(1.08)}
.weave-button:disabled{opacity:.55;cursor:not-allowed}
.weave-button-secondary{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
`
  document.head.appendChild(style)
}

function createApp(React: any, createPortal?: (node: any, container: Element) => any, callRpc?: RpcCaller): any {
  const { useState, useCallback, useEffect } = React

  type TeamSummary = Record<string, unknown>
  type SelectOption = { value: string; name?: string }

  type TeamForm = {
    teamId: string
    name: string
    executor: string
    provider: string
    model: string
    thoughtLevel: string
    mode: string
    personality: string
  }

  const PageCard = ({ title, body }: { title: string; body: string }) =>
    React.createElement(
      'article',
      { className: 'weave-card' },
      React.createElement('b', null, title),
      React.createElement('span', null, body),
    )

  function Page({ route }: { route: Route }) {
    const def = ROUTES.find((item) => item.key === route) ?? ROUTES[0]!
    const cards: Record<Route, Array<[string, string]>> = {
      overview: [
        ['任务中心', '查看任务 DAG、失败传播与保温期任务。'],
        ['知识库', '管理 candidate 审核、active 知识和导入任务。'],
        ['执行器', '检查 spawn / fork / Codex / Claude / ACP 可用性。'],
      ],
      teams: [['团队管理', '创建团队、绑定执行器与模型路由。']],
      tasks: [
        ['DAG 视图', '展示任务依赖层级与当前状态。'],
        ['快速操作', '支持取消可取消任务并刷新视图。'],
        ['状态机', '由 14 态权威矩阵驱动，非法转移自动拒绝。'],
      ],
      knowledge: [
        ['候选审核', 'candidate 只能通过显式 approve 转正。'],
        ['导入管线', '上传 → 转换 → 预览 → 确认后才进入知识目录。'],
        ['注入限制', '按 max_entries 与字符上限安全注入 prompt。'],
      ],
      executors: [
        ['统一注册表', '所有执行器经 ExecutorRegistry 发现与分类。'],
        ['四类模型', 'DSH Subagent / Codex / Claude Code / ACP。'],
        ['熔断限流', '并发与频率超限时排队等待，不直接熔断。'],
      ],
      sessions: [['会话上下文', '跟踪修订记录并清理跨任务状态残留。']],
      audit: [['审计事件', '任务、知识、导入、禁令与会话切换事件可查询。']],
      settings: [['本地配置', '团队目录、持久化目录与执行器限制。']],
    }

    return React.createElement(
      'section',
      { className: 'weave-page', 'data-testid': `page-${def.key}` },
      React.createElement('h1', null, def.label),
      React.createElement('p', { className: 'weave-note' }, def.desc),
      React.createElement(
        'div',
        { className: 'weave-grid' },
        ...(cards[def.key] ?? []).map(([title, body]) =>
          React.createElement(PageCard, { key: title, title, body }),
        ),
      ),
    )
  }

  function TeamsPage() {
    const [teams, setTeams] = useState([] as TeamSummary[])
    const [executors, setExecutors] = useState([] as string[])
    const [models, setModels] = useState([] as SelectOption[])
    const [modes, setModes] = useState([] as string[])
    const [thoughtLevels, setThoughtLevels] = useState([] as string[])
    const [modelValue, setModelValue] = useState('')
    const [status, setStatus] = useState('正在加载...')
    const [busy, setBusy] = useState(false)
    const [form, setForm] = useState({
      teamId: '',
      name: '',
      executor: '',
      provider: '',
      model: '',
      thoughtLevel: '',
      mode: '',
      personality: '你是可靠的协作执行角色，输出可验证结果。',
    } as TeamForm)

    const refresh = useCallback(async () => {
      if (!callRpc) {
        setStatus('连接服务不可用')
        return
      }
      try {
        const separator = String.fromCharCode(92)
        const data = await callRpc('snapshot') as {
          teams?: Array<Record<string, unknown>>
          executors?: Array<{ id: string }>
          zcodeCapabilities?: {
            models?: SelectOption[]
            currentModel?: string
            modes?: Array<{ value: string }>
            currentMode?: string
            thoughtLevels?: Array<{ value: string }>
            currentThoughtLevel?: string
          }
        }
        const nextExecutors = (data.executors ?? []).map((item) => item.id)
        const capabilities = data.zcodeCapabilities
        const nextModels = capabilities?.models ?? []
        const nextModes = (capabilities?.modes ?? []).map((option) => option.value)
        const nextThoughts = (capabilities?.thoughtLevels ?? []).map((option) => option.value)
        const selectedModel = capabilities?.currentModel ?? nextModels[0]?.value ?? ''
        setTeams(data.teams ?? [])
        setExecutors(nextExecutors)
        setModels(nextModels)
        setModes(nextModes)
        setThoughtLevels(nextThoughts)
        setModelValue(selectedModel)
        setForm((current: TeamForm) => {
          let provider = current.provider
          let model = current.model
          if (!provider && !model && selectedModel) {
            const index = selectedModel.lastIndexOf(separator)
            provider = index >= 0 ? selectedModel.slice(0, index) : ''
            model = index >= 0 ? selectedModel.slice(index + 1) : selectedModel
          }
          return {
            ...current,
            provider,
            model,
            executor: current.executor || (nextExecutors.includes('zcode') ? 'zcode' : nextExecutors[0] ?? ''),
            mode: current.mode || capabilities?.currentMode || '',
            thoughtLevel: current.thoughtLevel || capabilities?.currentThoughtLevel || '',
          }
        })
        setStatus('')
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error))
      }
    }, [])

    useEffect(() => {
      void refresh()
    }, [refresh])

    const update = (key: keyof typeof form) => (event: { target: { value: string } }) => {
      setForm((current: TeamForm) => ({ ...current, [key]: event.target.value }))
    }

    const submit = async (event: { preventDefault(): void }) => {
      event.preventDefault()
      if (!callRpc || busy) return
      setBusy(true)
      setStatus('正在保存...')
      try {
        const teamId = (form.teamId || form.name || 'squad').trim()
          .toLowerCase()
          .replace(/[^a-z0-9._-]+/g, '-')
          .replace(/^-+|-+$/g, '') || 'squad'
        const stages = ['prepare', 'implement', 'review']
        const role: Record<string, unknown> = {
          id: 'member',
          name: form.name || '成员',
          bias: 'dev',
          executor: form.executor,
          stages,
          max_concurrent_tasks: 1,
          personality: form.personality,
        }
        if (form.provider) role.provider = form.provider
        if (form.model) role.model = form.model
        if (form.thoughtLevel) role.thought_level = form.thoughtLevel
        if (form.mode) role.mode = form.mode

        const config = {
          schema_version: '1',
          team_id: teamId,
          name: form.name || teamId,
          default: false,
          roles: [role],
          task_decomposition: {
            matchers: [],
            default_difficulty: 'hard',
            dag_templates: Object.fromEntries(['easy', 'medium', 'hard', 'critical'].map((level) => [level, stages])),
          },
          knowledge_injection: {
            max_entries: 3,
            max_chars_per_entry: 2000,
            max_total_chars: 6000,
            priority: 'freshness_first',
          },
          feedback: {
            feedback_timeout_seconds: 1800,
            max_revisions: 2,
            reopen_window_seconds: 86400,
          },
          executor_limits: {
            [form.executor || 'spawn']: { max_concurrent: 1, max_per_hour: 20 },
          },
        }
        await callRpc('team/import', { overwrite: true, config })
        setForm((current: TeamForm) => ({ ...current, teamId: '', name: '' }))
        await refresh()
        setStatus(`已保存：${teamId}`)
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error))
      } finally {
        setBusy(false)
      }
    }

    const updateModel = (event: { target: { value: string } }) => {
      const value = event.target.value
      const separator = String.fromCharCode(92)
      const index = value.lastIndexOf(separator)
      setModelValue(value)
      setForm((current: TeamForm) => ({
        ...current,
        provider: index >= 0 ? value.slice(0, index) : '',
        model: index >= 0 ? value.slice(index + 1) : value,
      }))
    }

    const field = (label: string, key: keyof typeof form, placeholder = '', type = 'text') =>
      React.createElement(
        'label',
        { className: 'weave-field' },
        React.createElement('span', null, label),
        type === 'textarea'
          ? React.createElement('textarea', { value: form[key], onChange: update(key), rows: 3 })
          : React.createElement('input', { type, value: form[key], onChange: update(key), placeholder }),
      )

    const select = (label: string, key: keyof typeof form, options: string[]) =>
      React.createElement(
        'label',
        { className: 'weave-field' },
        React.createElement('span', null, label),
        React.createElement(
          'select',
          { value: form[key], onChange: update(key) },
          React.createElement('option', { value: '' }, '默认'),
          ...options.map((value) => React.createElement('option', { key: value, value }, value)),
        ),
      )

    return React.createElement(
      'section',
      { className: 'weave-page', 'data-testid': 'page-teams' },
      React.createElement('h1', null, '团队'),
      React.createElement('p', { className: 'weave-note' }, status || '创建后会写入 ~/.dsh/teams 并通过完整校验。'),
      React.createElement(
        'div',
        { className: 'weave-layout' },
        React.createElement(
          'form',
          { className: 'weave-form', onSubmit: submit },
          field('团队 ID', 'teamId', 'my-squad'),
          field('名称', 'name', '我的团队'),
          React.createElement(
            'label',
            { className: 'weave-field' },
            React.createElement('span', null, '执行器'),
            React.createElement(
              'select',
              { value: form.executor, onChange: update('executor') },
              ...(executors.length ? executors.map((value: string) => React.createElement('option', { key: value, value }, value)) : [React.createElement('option', { key: 'empty', value: '' }, '加载中')]),
            ),
          ),
          React.createElement(
            'label',
            { className: 'weave-field' },
            React.createElement('span', null, '模型（ZCode 能力目录）'),
            React.createElement(
              'select',
              { 'data-testid': 'model-select', value: modelValue, onChange: updateModel },
              ...(models.length
                ? models.map((option: SelectOption) => React.createElement(
                  'option',
                  { key: option.value, value: option.value },
                  option.name ?? option.value,
                ))
                : [React.createElement('option', { key: 'empty', value: '' }, '加载中')]),
            ),
          ),
          field('Provider 覆盖', 'provider', '一般由模型选择自动填入'),
          field('Model 覆盖', 'model', '一般由模型选择自动填入'),
          select('思考深度', 'thoughtLevel', thoughtLevels.length ? thoughtLevels : ['off', 'high', 'max']),
          select('模式', 'mode', modes.length ? modes : ['plan', 'build', 'edit', 'yolo', 'auto']),
          field('角色提示词', 'personality', '', 'textarea'),
          React.createElement(
            'button',
            { className: 'weave-button', type: 'submit', disabled: busy },
            busy ? '保存中' : '创建团队',
          ),
        ),
        React.createElement(
          'div',
          { className: 'weave-team-list' },
          React.createElement(
            'button',
            { className: 'weave-button weave-button-secondary', type: 'button', onClick: () => void refresh() },
            '刷新',
          ),
          ...teams.map((team: TeamSummary) => React.createElement(
            'article',
            { className: 'weave-card', key: String(team.team_id) },
            React.createElement('b', null, `${String(team.name)}${team.default ? '（默认）' : ''}`),
            React.createElement('span', null, Array.isArray(team.roles)
              ? team.roles.map((role: Record<string, unknown>) => `${(role as Record<string, unknown>).id}/${(role as Record<string, unknown>).executor}`).join(', ')
              : ''),
          )),
          teams.length === 0 ? React.createElement('article', { className: 'weave-card' }, React.createElement('b', null, '暂无可用团队'), React.createElement('span', null, '请先创建一个团队。')) : null,
        ),
      ),
    )
  }

  function WeaveDashboard({ onClose }: { onClose: () => void }) {
    const [route, setRoute] = useState('overview')
    const content = React.createElement(
      'div',
      { className: 'weave-overlay', 'data-testid': 'weave-overlay' },
      React.createElement(
        'div',
        { className: 'weave-shell', 'data-testid': 'weave-dashboard' },
        React.createElement(
          'aside',
          { className: 'weave-side', 'data-testid': 'weave-nav' },
          React.createElement(
            'div',
            { className: 'weave-brand' },
            'Weave',
            React.createElement('small', null, 'dsh-weave v0.2.0'),
          ),
          React.createElement(
            'ul',
            { className: 'weave-nav', 'aria-label': 'Weave 导航' },
            ...ROUTES.map((item) =>
              React.createElement(
                'li',
                { key: item.key },
                React.createElement(
                  'button',
                  {
                    type: 'button',
                    className: 'weave-nav-item',
                    'data-testid': `nav-${item.key}`,
                    'data-active': route === item.key ? 'true' : 'false',
                    onClick: () => setRoute(item.key),
                  },
                  item.label,
                ),
              ),
            ),
          ),
        ),
        React.createElement(
          'main',
          { className: 'weave-main' },
          React.createElement(
            'header',
            { className: 'weave-header' },
            React.createElement('div', { className: 'weave-title' }, 'Weave 控制台'),
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'weave-close',
                'aria-label': '关闭 Weave',
                'data-testid': 'weave-close',
                onClick: onClose,
              },
              '×',
            ),
          ),
          React.createElement(
            'div',
            { className: 'weave-content' },
            route === 'teams' ? React.createElement(TeamsPage) : React.createElement(Page, { route }),
          ),
        ),
      ),
    )
    return createPortal ? createPortal(content, document.body) : content
  }

  function WeaveSidebarAction({ wide }: { wide?: boolean }) {
    const [open, setOpen] = useState(false)
    return React.createElement(
      'div',
      { className: wide ? 'weave-action-layer' : 'weave-action-layer weave-action-rail' },
      React.createElement(
        'button',
        {
          type: 'button',
          className: 'weave-action-button',
          'data-testid': 'weave-open',
          'data-open': open ? 'true' : undefined,
          'aria-expanded': open,
          onClick: () => setOpen((value: boolean) => !value),
        },
        React.createElement('span', { className: 'weave-action-mark', 'aria-hidden': true }, 'W'),
        wide ? React.createElement('span', { className: 'weave-action-label' }, 'Weave') : null,
        wide && open
          ? React.createElement('span', { className: 'weave-action-state' }, 'ON')
          : null,
      ),
      open ? React.createElement(WeaveDashboard, { onClose: () => setOpen(false) }) : null,
    )
  }

  return { WeaveSidebarAction }
}

const moduleLoader = (
  window as unknown as { __ModuleLoader__?: { load(value: unknown): void } }
).__ModuleLoader__

if (!moduleLoader) {
  throw new Error('dsh-weave client must run inside DSH Web ModuleLoader')
}

moduleLoader.load({
  id: PLUGIN_ID,
  factory: (moduleRequire: (id: string) => unknown) => {
    ensureStyle()
    const React = moduleRequire('react')
    const ReactDOM = moduleRequire('react-dom') as { createPortal: (node: any, container: Element) => any }
    let callRpc: RpcCaller | undefined
    const localApply = (ctx: ClientContext): void => {
      const connection = ctx.get('connection')
      callRpc = async (endpoint, payload) => {
        const result = await connection.rpc.call('/dsh-weave', endpoint, payload)
        if (!result.ok) throw new Error(`${result.error?.code ?? 'rpc-error'}: ${result.error?.message ?? 'RPC failed'}`)
        return result.value
      }
      const app = createApp(React, ReactDOM.createPortal, callRpc)
      const registered = app.WeaveSidebarAction

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.footer.action', () =>
            ctx.slots.register(
              {
                name: 'sidebar.footer.action',
                id: PLUGIN_ID,
                order: 80,
                label: () => 'Weave',
              },
              registered,
            ),
          ),
        'dsh-weave sidebar action',
      )
    }

    const module = { exports: {} as Record<string, unknown> }
    module.exports.apply = localApply
    module.exports.inject = ['slots', 'connection']
    return module.exports
  },
})
