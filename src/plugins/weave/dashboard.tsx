/// <reference lib="dom" />
/**
 * P0-DASH-020 —— Dashboard 框架（Web 管理界面路由骨架，架构 12.1）。
 *
 * 范围：总览 / 任务中心 / 知识库 / 执行器 / 会话管理 / 审计日志 / 设置 七个路由骨架；
 * 每个页面为最小占位（标题 + 说明），数据接入（计数/图表）留待后续页面级任务。
 * 纯展示组件：无副作用、无网络、无持久化 —— 可被 DSH Web 层直接挂载。
 *
 * 兼容性（AC-COMPAT-005）：Weave **不向 DSH 设置页注册条目**（不调用任何 settings.section /
 * slots 注册），Weave 入口仅存在于本组件的左侧导航；`dshSettingsEntry()` 恒返回 null
 * 作为该契约的可测表达式。
 */
import { useState } from 'react'

export type DashboardRoute =
  | 'overview'
  | 'tasks'
  | 'knowledge'
  | 'executors'
  | 'sessions'
  | 'audit'
  | 'settings'

export interface DashboardPageDef {
  route: DashboardRoute
  /** 路由路径（架构 12.1）。 */
  path: string
  /** 左侧导航文案。 */
  label: string
  /** P0 页面状态：skeleton（骨架占位）。 */
  state: 'skeleton'
}

/** 路由表（架构 12.1 全部 7 条；顺序即左侧导航顺序）。 */
export const DASHBOARD_ROUTES: readonly DashboardPageDef[] = [
  { route: 'overview', path: '/weave/overview', label: '总览', state: 'skeleton' },
  { route: 'tasks', path: '/weave/tasks', label: '任务中心', state: 'skeleton' },
  { route: 'knowledge', path: '/weave/knowledge', label: '知识库', state: 'skeleton' },
  { route: 'executors', path: '/weave/executors', label: '执行器', state: 'skeleton' },
  { route: 'sessions', path: '/weave/sessions', label: '会话管理', state: 'skeleton' },
  { route: 'audit', path: '/weave/audit', label: '审计日志', state: 'skeleton' },
  { route: 'settings', path: '/weave/settings', label: '设置', state: 'skeleton' },
]

/** 已知路由判定（含路径/短名两种形态）。 */
export function isKnownRoute(input: string): boolean {
  return DASHBOARD_ROUTES.some((def) => def.route === input || def.path === input)
}

/** 规范化路径：'/weave/xxx' 或 'xxx' → 路由名；未知/空 → 'overview'（兜底）。 */
export function normalizePath(input: string): DashboardRoute {
  const bare = input.replace(/^\/weave\/?/, '').replace(/^\//, '')
  const matched = DASHBOARD_ROUTES.find((def) => def.route === bare)
  return matched?.route ?? 'overview'
}

/**
 * AC-COMPAT-005 契约：Weave 不向 DSH 设置页注册条目。
 * 恒为 null；若未来需要（如用户配置页），应改为返回注册对象并同步更新测试。
 */
export function dshSettingsEntry(): null {
  return null
}

export interface DashboardProps {
  /** 初始路由（默认总览）。 */
  initialPath?: string
  /** 路由切换回调（供宿主页面同步 URL / 埋点）。 */
  onNavigate?: (route: DashboardRoute) => void
  /** 品牌标题（默认 Weave）。 */
  title?: string
}

function PageSkeleton({ route }: { route: DashboardRoute }) {
  const def = DASHBOARD_ROUTES.find((d) => d.route === route)!
  const notes: Record<DashboardRoute, string> = {
    overview: '任务 / 知识 / 执行器概览骨架（计数与图表待接入）。',
    tasks: '任务列表与 DAG 视图骨架（P0-DAG-017 面板嵌入点）。',
    knowledge: '知识库列表与导入入口骨架（P0-KUI-011 / P0-KREVIEW-012 接入点）。',
    executors: '执行器列表骨架（ExecutorRegistry.list() 数据源，架构 12.2）。',
    sessions: '会话管理骨架（P0 占位）。',
    audit: '审计日志骨架（AuditLog.query() 数据源，架构 9.3）。',
    settings: 'Weave 独立设置页骨架（与 DSH 设置页无关联）。',
  }
  return (
    <section data-testid={`page-${route}`} className="weave-page">
      <h1>{def.label}</h1>
      <p className="weave-page-note">{notes[route]}</p>
    </section>
  )
}

/**
 * Dashboard 框架组件：左侧导航（Weave 入口）+ 路由内容区。
 * 纯受控+本地状态；路由切换经 onNavigate 上报。
 */
export function Dashboard({ initialPath = '/weave/overview', onNavigate, title = 'Weave' }: DashboardProps) {
  const [route, setRoute] = useState<DashboardRoute>(() => normalizePath(initialPath))

  const navigate = (next: DashboardRoute) => {
    setRoute(next)
    onNavigate?.(next)
  }

  return (
    <div data-testid="weave-dashboard" className="weave-dashboard">
      <aside data-testid="weave-nav" className="weave-nav">
        <div className="weave-brand">{title}</div>
        <ul aria-label="Weave 导航">
          {DASHBOARD_ROUTES.map((def) => (
            <li key={def.route}>
              <a
                href={def.path}
                data-testid={`nav-${def.route}`}
                data-active={route === def.route ? 'true' : 'false'}
                onClick={(event) => {
                  event.preventDefault()
                  navigate(def.route)
                }}
              >
                {def.label}
              </a>
            </li>
          ))}
        </ul>
      </aside>
      <main data-testid="weave-content" className="weave-content">
        <PageSkeleton route={route} />
      </main>
    </div>
  )
}
