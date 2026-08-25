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
`
  document.head.appendChild(style)
}

function createApp(React: any, createPortal?: (node: any, container: Element) => any): any {
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
          React.createElement('div', { className: 'weave-content' }, React.createElement(Page, { route })),
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
    const { WeaveSidebarAction } = createApp(React, ReactDOM.createPortal)

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
