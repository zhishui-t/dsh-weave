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

interface ClientContext {
  effect(execute: () => unknown, label?: string): unknown
  slots: SlotsService
}

const PLUGIN_ID = '@deepseek-ai/dsh-plugin-weave'
const STYLE_ID = 'dsh-weave-client-style'

type Route =
  | 'overview'
  | 'tasks'
  | 'knowledge'
  | 'executors'
  | 'sessions'
  | 'audit'
  | 'settings'

const ROUTES: Array<{ key: Route; label: string; desc: string }> = [
  { key: 'overview', label: '总览', desc: '任务、知识与执行器的整体运行状态。' },
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
.weave-sidebar-action{width:100%;height:36px;border:1px solid var(--theme-border,#333);border-radius:10px;background:transparent;color:var(--theme-text,#ddd);font:inherit;font-size:13px;display:flex;align-items:center;justify-content:center;gap:6px;cursor:pointer}
.weave-sidebar-action:hover{border-color:#4a9eff;color:#4a9eff}
.weave-overlay{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.62);backdrop-filter:blur(3px);display:flex}
.weave-shell{width:min(1280px,calc(100vw - 48px));height:min(860px,calc(100vh - 48px));background:#101418;color:#e6e8eb;border:1px solid #2a2f36;border-radius:16px;overflow:hidden;display:flex;box-shadow:0 24px 80px rgba(0,0,0,.55)}
.weave-side{width:216px;flex:0 0 216px;border-right:1px solid #23282f;padding:18px 12px;display:flex;flex-direction:column;gap:14px;background:#0c1013}
.weave-brand{font-size:18px;font-weight:700;padding:0 10px}
.weave-brand small{display:block;margin-top:2px;color:#7d8590;font-size:11px;font-weight:500}
.weave-nav{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none}
.weave-nav-item{width:100%;text-align:left;border:0;background:transparent;color:#b8bec6;border-radius:9px;padding:9px 12px;font:inherit;font-size:13px;cursor:pointer}
.weave-nav-item:hover{background:#161b21;color:#e6e8eb}
.weave-nav-item[data-active="true"]{background:#182430;color:#63a8ff;font-weight:650}
.weave-main{flex:1;min-width:0;display:flex;flex-direction:column}
.weave-header{height:58px;border-bottom:1px solid #23282f;display:flex;align-items:center;justify-content:space-between;padding:0 20px}
.weave-title{font-size:17px;font-weight:700}
.weave-close{border:1px solid #2a2f36;background:transparent;color:#b8bec6;width:30px;height:30px;border-radius:8px;cursor:pointer}
.weave-content{flex:1;overflow:auto;padding:22px}
.weave-page h1{margin:0 0 6px;font-size:20px}
.weave-note{margin:0 0 18px;color:#8b949e;font-size:13px}
.weave-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}
.weave-card{border:1px solid #242a31;border-radius:12px;padding:16px;background:#12171d}
.weave-card b{display:block;margin-bottom:5px}
.weave-card span{color:#98a2ad;font-size:12px;line-height:1.5}
`
  document.head.appendChild(style)
}

function createApp(React: any): any {
  const { useState } = React

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

  function WeaveDashboard({ onClose }: { onClose: () => void }) {
    const [route, setRoute] = useState('overview')
    return React.createElement(
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
          React.createElement('div', { className: 'weave-content' }, React.createElement(Page, { route })),
        ),
      ),
    )
  }

  function WeaveSidebarAction() {
    const [open, setOpen] = useState(false)
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(
        'button',
        {
          type: 'button',
          className: 'weave-sidebar-action',
          'data-testid': 'weave-open',
          onClick: () => setOpen(true),
        },
        'Weave',
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
    const { WeaveSidebarAction } = createApp(React)

    const localApply = (ctx: ClientContext): void => {
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
              WeaveSidebarAction,
            ),
          ),
        'dsh-weave sidebar action',
      )
    }

    const module = { exports: {} as Record<string, unknown> }
    module.exports.apply = localApply
    module.exports.inject = ['slots']
    return module.exports
  },
})
