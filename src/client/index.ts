/// <reference lib="dom" />

/**
 * dsh-weave DSH Web 客户端插件（t3：全功能真实界面）。
 * 输出物是 DSH ModuleLoader bundle，不是 ESM——构建是纯 tsc 无打包器，
 * 因此必须保持单文件（任何 import 都会变成 require 并破坏 bundle 契约测试）。
 * 入口注册到左侧导航栏的 sidebar.footer.action，点击打开全屏 Dashboard。
 *
 * 数据来源全部是 /dsh-weave Connection RPC 的真实端点：
 * - 已上线（t1）：snapshot / team/* / settings/describe；
 * - t2 服务已备、t4 接线中：task/* / knowledge/* / audit/list / session/*。
 *   对应页面在端点缺失时展示明确的“未接入”空态，不渲染假数据、不放假入口。
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

/** dsh-client-runtime ObservableSnapshot 的最小结构视图（参照 ActivityPanel 订阅模式）。 */
interface ObservableSnapshotLike {
  subscribe(listener: () => void): () => void
  getSnapshot(): unknown
}

/** DSH sessions 服务的窄接口：用于打开 DSH 子代理会话。 */
interface SessionNavigator {
  open(id: string): void
  openSubagent?(address: { parentSessionId: string; childSessionId: string; mode?: string }): void
  refreshSubagents?(parentSessionId: string): Promise<void>
  subagentAddress?(id: string): { parentSessionId?: string; childSessionId?: string; mode?: string } | undefined
  /** 宿主会话列表快照（ObservableSnapshot）：成员子代理会话生成/退出即推。旧宿主可能缺失。 */
  list?: ObservableSnapshotLike
}

interface ClientContext {
  effect(execute: () => unknown, label?: string): unknown
  get(service: 'connection' | 'sessions'): ConnectionHandle | SessionNavigator
  slots: SlotsService
}

type RpcCaller = (endpoint: string, payload?: unknown) => Promise<unknown>

/** 宿主快照缺失时的 useSyncExternalStore 兜底（模块级稳定引用，避免重订阅风暴）。 */
const noopSnapshotSubscribe = (): (() => void) => () => undefined
const noopSnapshotGet = (): unknown => 0

const PLUGIN_ID = '@deepseek-ai/dsh-plugin-weave'
const STYLE_ID = 'dsh-weave-client-style'

type Route =
  | 'overview'
  | 'teams'
  | 'knowledge'
  | 'executors'
  | 'audit'
  | 'settings'
  | 'manual'

const ROUTES: Array<{ key: Route; label: string; desc: string }> = [
  { key: 'overview', label: '总览', desc: '任务、知识与执行器的整体运行状态，含修订记录。' },
  { key: 'teams', label: '团队', desc: '查看团队并创建新的协作团队。' },
  { key: 'knowledge', label: '知识库', desc: '知识导入、候选审核与注入管理。' },
  { key: 'executors', label: '执行器', desc: '实际注册的执行器与其能力。' },
  { key: 'audit', label: '审计日志', desc: '核心事件与恢复操作审计。' },
  { key: 'settings', label: '设置', desc: 'Weave 本地配置与运行参数。' },
  { key: 'manual', label: '使用手册', desc: '队长模式用法与 /weave 命令速查。' },
]

/* ------------------------------- 领域常量 ------------------------------- */

/** 会话面板活跃探测心跳间隔（ms）：与成员输出流轮询同频；探测极轻（两条小查询），
 * 指纹无变化不发刷新——保证状态变更 2 秒内反映且空闲零数据拉取。 */
const SESSION_HEARTBEAT_MS = 1000
/** 事件合并防抖（ms）：宿主推流/探测命中统一经此合并，避免连发风暴。 */
const SESSION_REFRESH_DEBOUNCE_MS = 150


/** 各状态下提供哪些快捷动作入口；最终合法性由服务端 14 态矩阵裁决，非法转移会被拒绝并展示错误。 */
const TASK_ACTIONS_BY_STATUS: Record<string, Array<{ action: string; label: string; confirm?: boolean }>> = {
  WAITING: [{ action: 'cancel', label: '取消', confirm: true }, { action: 'skip', label: '跳过' }],
  BLOCKED: [{ action: 'cancel', label: '取消', confirm: true }, { action: 'skip', label: '跳过' }],
  RUNNING: [{ action: 'cancel', label: '取消', confirm: true }],
  AWAITING_FEEDBACK: [
    { action: 'revise', label: '要求返工' },
    { action: 'accept', label: '验收' },
    { action: 'skip', label: '跳过' },
  ],
  REVISION_RUNNING: [{ action: 'cancel', label: '取消', confirm: true }],
  FAILED: [{ action: 'retry', label: '重试' }, { action: 'skip', label: '跳过' }],
  BANNED: [{ action: 'retry', label: '重试' }],
  LOOP_TERMINATED: [{ action: 'retry', label: '重试' }],
  INTERRUPTED: [{ action: 'retry', label: '重试' }, { action: 'cancel', label: '取消', confirm: true }],
  CLOSED: [{ action: 'reopen', label: '重新打开' }],
  CANCELLED: [{ action: 'reopen', label: '重新打开' }],
  SKIPPED: [{ action: 'reopen', label: '重新打开' }],
  COOLDOWN: [],
  COMPLETED: [],
}

const KNOWLEDGE_STATUSES = ['candidate', 'active', 'deprecated', 'superseded'] as const
const KNOWLEDGE_LAYERS = ['project', 'role', 'instance', 'shared'] as const

const EXECUTOR_LABELS: Record<string, string> = {
  spawn: 'DSH 子代理（新启）',
  fork: 'DSH 子代理（分支）',
  dsh_subagent: 'DSH 子代理',
  zcode: 'ZCode 执行器',
  codex: 'Codex 执行器',
  'claude-code': 'Claude Code',
  claude_code: 'Claude Code',
  acp: 'ACP 执行器',
}
const TASK_STATUS_LABELS: Record<string, string> = {
  WAITING: '等待中',
  BLOCKED: '已阻塞',
  RUNNING: '执行中',
  COMPLETED: '已完成',
  AWAITING_FEEDBACK: '待反馈',
  REVISION_RUNNING: '修订执行中',
  CLOSED: '已关闭',
  FAILED: '已失败',
  BANNED: '已熔断',
  LOOP_TERMINATED: '循环终止',
  INTERRUPTED: '已中断',
  CANCELLED: '已取消',
  SKIPPED: '已跳过',
  COOLDOWN: '冷却中',
}
const KNOWLEDGE_STATUS_LABELS: Record<string, string> = {
  candidate: '候选',
  active: '已生效',
  deprecated: '已弃用',
  superseded: '已替代',
  missing: '缺失目标',
}
const KNOWLEDGE_LAYER_LABELS: Record<string, string> = {
  project: '项目',
  role: '角色',
  instance: '实例',
  shared: '共享',
}
const AUDIT_EVENT_LABELS: Record<string, string> = {
  'task.status_changed': '任务状态变更',
  'task.feedback_received': '收到任务反馈',
  'knowledge.status_changed': '知识状态变更',
  'knowledge.superseded': '知识被替代',
  'import.confirmed': '导入确认',
  'ban.created': '创建熔断',
  'ban.resolved': '解除熔断',
  'team.switched': '切换团队',
  'recovery.task_repaired': '修复任务',
  'recovery.import_repaired': '修复导入',
}
const labelOf = (labels: Record<string, string>, value: unknown): string =>
  labels[String(value ?? '')] ?? String(value ?? '—')
const executorLabel = (value: unknown): string => labelOf(EXECUTOR_LABELS, value)
const AUDIT_EVENT_TYPES = [
  'task.status_changed',
  'task.feedback_received',
  'knowledge.status_changed',
  'knowledge.superseded',
  'import.confirmed',
  'ban.created',
  'ban.resolved',
  'team.switched',
] as const

/* ------------------------------- 领域类型 ------------------------------- */

type Json = Record<string, unknown>

interface SelectOption {
  value: string
  name?: string
}

interface ExecutorInfo {
  id: string
  kind?: string
  capabilities?: Json
}

interface ZcodeCapabilities {
  models?: SelectOption[]
  currentModel?: string
  modes?: SelectOption[]
  currentMode?: string
  thoughtLevels?: SelectOption[]
  currentThoughtLevel?: string
}

interface TeamSummaryRow {
  team_id?: string
  name?: string
  description?: string
  default?: boolean
  roles?: Array<Json>
}

interface SnapshotData {
  teams?: TeamSummaryRow[]
  executors?: ExecutorInfo[]
  overview?: Json
  zcodeCapabilities?: ZcodeCapabilities
  modelCatalog?: Array<{ provider: string; name: string; models: Array<{ id: string; name: string }> }>
}

/** 创建团队时的角色草稿（界面态，字段均为字符串便于受控输入）。 */
interface RoleDraft {
  id: string
  name: string
  bias: string
  executor: string
  stages: string
  personality: string
  provider: string
  model: string
  thoughtLevel: string
  mode: string
  fallbackProvider: string
  fallbackModel: string
  priority: string
  strengths: string
}

interface TaskRow {
  id?: string
  dag_id?: string
  description?: string
  status?: string
  team_id?: string
  project_id?: string
  version?: string
  created_at?: string
  updated_at?: string
  /** task/get 返回完整记录时携带；列表行可能缺省。 */
  dependencies?: string[] | null
  assigned_agent?: string | null
}

interface TaskDagDetail {
  dag_id?: string
  status?: string
  tasks?: TaskRow[]
  edges?: Array<{ from: string; to: string }>
}

interface KnowledgeItem {
  id?: string
  path?: string
  layer?: string
  status?: string
  confidence?: number
  freshness_score?: number
  last_confirmed?: string | null
  created?: string
  updated?: string
  superseded_by?: string
  title?: string
  tags?: string[]
}

interface AuditEventView extends Json {
  type?: string
  occurred_at?: string
  session_id?: string | null
}

interface RevisionRow {
  task_id: string
  revision_count?: number
  previous_result?: string | null
  user_feedback?: string[]
  updated_at?: string
}

/** session/status 单成员视图（运行时状态 + 最近任务派生）。 */
interface SessionStatusMember {
  role_id?: string
  name?: string
  executor?: string
  status?: string
  task_id?: string
  subject?: string
  started_at?: string
  /** queued=已派发等待执行器槽；running=真正执行（假并行修复）。 */
  phase?: string
  last_task_id?: string
  last_status?: string
  last_subject?: string
}

interface SessionStatusData {
  session_id?: string
  team?: { team_id?: string; name?: string; description?: string } | null
  /** binding=已启用/绑定；default/single=配置自动生效，未锁定。 */
  resolved_via?: 'binding' | 'default' | 'single' | null
  members?: SessionStatusMember[]
}

interface KnowledgeGraphNode {
  id: string
  title: string
  status: string
  layer: string
  tags: string[]
  kind: 'knowledge' | 'missing'
  path?: string
}
interface KnowledgeGraphData {
  nodes?: KnowledgeGraphNode[]
  edges?: Array<{ source: string; target: string }>
  projects?: string[]
  counts?: { knowledge: number; missing: number; edges: number; unresolved: number; skipped: number }
}
interface SettingsInfo {
  obsidian_dir?: string
  version?: string
  node_version?: string
  state_dir?: string
  teams_dir?: string
  audit_dir?: string
  /** t8：providers.json 路径（providerStore 注入时才返回）。 */
  providers_file?: string
  zcode?: { configured?: boolean; registered?: boolean }
}

/** provider/list 单条（服务端从真实 providers.json + 注册表推导）。 */
interface ProviderRow {
  name: string
  transport: string
  command: string
  args?: string[]
  cwd?: string
  protocol: string
  declaredExtensions?: string[]
  enabled?: boolean
  envKeys?: string[]
}

/* ------------------------------- 样式 ------------------------------- */

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
.weave-card[data-clickable="true"]{cursor:pointer}
.weave-card[data-clickable="true"]:hover{border-color:var(--dsw-alias-label-tertiary)}
.weave-layout{display:grid;grid-template-columns:minmax(300px,420px) minmax(260px,1fr);gap:20px;align-items:start}
@media (max-width:900px){.weave-layout{grid-template-columns:1fr}}
.weave-form,.weave-panel{display:grid;gap:12px;align-content:start;padding:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:16px;background:var(--dsw-alias-bg-layer-2)}
.weave-field{display:grid;gap:5px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.weave-field input,.weave-field select,.weave-field textarea{box-sizing:border-box;width:100%;min-height:34px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-specific-menu);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;padding:7px 9px;outline:none}
.weave-field textarea{resize:vertical}
.weave-button{border:0;border-radius:10px;background:var(--dsw-alias-brand-primary,var(--dsw-alias-label-primary));color:var(--dsw-specific-menu);font:inherit;font-weight:550;height:34px;padding:0 14px;cursor:pointer}
.weave-button:hover{filter:brightness(1.08)}
.weave-button:disabled{opacity:.55;cursor:not-allowed}
.weave-button-secondary{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-weight:450}
.weave-button-small{height:26px;padding:0 10px;font-size:12px;font-weight:500;border-radius:8px}
.weave-toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 16px}
.weave-pill{display:inline-block;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:1px 10px;font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary);flex:none}
.weave-pill[data-tone="good"]{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-tertiary)}
.weave-pill[data-tone="run"]{font-weight:600}
.weave-control{box-sizing:border-box;width:auto;min-width:150px;min-height:34px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-specific-menu);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;padding:7px 9px;outline:none}
.weave-control:focus{border-color:var(--dsw-alias-label-tertiary)}
.weave-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.weave-graph-wrap{position:relative;border:1px solid var(--dsw-alias-border-l2);border-radius:16px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;margin-bottom:16px}
.weave-graph-node{cursor:pointer}
.weave-graph-node circle{fill:var(--dsw-specific-menu);stroke:var(--dsw-alias-border-l2)}
.weave-graph-node:hover circle{stroke:var(--dsw-alias-label-tertiary)}
.weave-graph-node[data-selected="true"] circle{stroke:var(--dsw-alias-brand-primary,var(--dsw-alias-label-primary));stroke-width:2.5}
.weave-graph-node[data-kind="missing"] circle{stroke-dasharray:4 3}
.weave-graph-node text{fill:var(--dsw-alias-label-primary);font-size:11px;text-anchor:middle;dominant-baseline:middle}
.weave-graph-detail{display:grid;gap:8px;padding:14px;border-top:1px solid var(--dsw-alias-border-l2)}
.weave-list{display:grid;gap:10px}
.weave-list-item{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px;display:grid;gap:6px;background:var(--dsw-alias-bg-layer-2)}
.weave-list-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.weave-list-head b{font-size:13px;font-weight:550;color:var(--dsw-alias-label-primary)}
.weave-muted{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.weave-actions{display:flex;gap:8px;flex-wrap:wrap}
.weave-empty{border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;padding:26px 16px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;display:grid;gap:4px}
.weave-empty b{color:var(--dsw-alias-label-secondary);font-size:13px}
.weave-kv{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;font-size:13px;line-height:20px}
.weave-kv span{color:var(--dsw-alias-label-tertiary)}
.weave-kv b{color:var(--dsw-alias-label-primary);font-weight:500;word-break:break-all}
.weave-role{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px;display:grid;gap:10px}
.weave-role-head{display:flex;justify-content:space-between;align-items:center;color:var(--dsw-alias-label-secondary);font-size:12px}
.weave-role-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.weave-subh{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:550;line-height:20px}
.weave-chiprow{display:flex;gap:6px;flex-wrap:wrap}
.weave-chip{border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:1px 10px;font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary)}
/* 紧凑 DAG（参照物 ActivityPanel 观感）：画布=内容精确尺寸，wrap 只横向滚动；
   节点固定 92×30；边为短柄贝塞尔，聚焦链 data-active 高亮、无关 data-dimmed 暗化 */
.weave-dag-wrap{position:relative;overflow-x:auto;overflow-y:hidden;margin:8px 0;width:100%}
.weave-dag-canvas{position:relative;min-width:100%}
.weave-dag-edges{position:absolute;inset:0;overflow:visible;pointer-events:none}
.weave-dag-edges path{fill:none;stroke:var(--dsw-alias-border-l2);stroke-width:1;transition:opacity 140ms ease,stroke 140ms ease,stroke-width 140ms ease}
.weave-dag-edges path[data-active="true"]{stroke:var(--dsw-alias-brand-primary,#1677ff);stroke-width:1.6}
.weave-dag-edges path[data-dimmed="true"]{opacity:.24}
.weave-dag-node{position:absolute;box-sizing:border-box;width:92px;height:30px;padding:0 6px;display:flex;flex-direction:column;justify-content:center;gap:1px;background:var(--dsw-specific-menu);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;cursor:pointer;text-align:left;overflow:hidden;user-select:none;transition:opacity 140ms ease,border-color 140ms ease,background-color 140ms ease}
.weave-dag-node:hover{border-color:var(--dsw-alias-brand-primary,#1677ff)}
.weave-dag-node[data-selected="true"],.weave-dag-node[data-focused="true"]{border-color:var(--dsw-alias-brand-primary,#1677ff)}
.weave-dag-node[data-focused="true"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#1677ff) 6%,var(--dsw-specific-menu))}
.weave-dag-node[data-dimmed="true"]{opacity:.3}
.weave-dag-node b{display:flex;align-items:center;gap:4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:9.5px;font-weight:700;color:var(--dsw-alias-label-primary);line-height:12px;white-space:nowrap}
.weave-dag-node-dot{flex:none;width:5px;height:5px;border-radius:1.5px}
.weave-dag-node .weave-muted{display:block;font-size:8.5px;line-height:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.weave-spanel{display:grid;gap:14px;align-content:start;padding:14px;border-radius:16px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);min-height:calc(100vh - 80px)}
.weave-spanel-head{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.weave-members{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:6px;align-items:start;align-content:start}
/* 团队详情弹窗（.weave-dialog-wide）与抽屉内的队员卡固定网格：一行 4 个、同行等高；
   覆盖窄屏/竖屏单列媒体查询（其本意只作用于会话页 spanel） */
.weave-dialog-wide .weave-members,.weave-drawer .weave-members{grid-template-columns:repeat(4,1fr);align-items:stretch}
.weave-member{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 8px;display:grid;gap:2px;background:var(--dsw-specific-menu)}
.weave-member b{font-size:12px;font-weight:550;color:var(--dsw-alias-label-primary);line-height:16px}
.weave-member .weave-muted{font-size:11px;line-height:15px}
.weave-member .weave-member-assignments{gap:3px}
.weave-member[data-status="running"]{border-color:#1677ff;background:rgba(22,119,255,.06)}
.weave-member[data-status="idle"]{border-color:#d9d9d9;background:var(--dsw-alias-bg-layer-2)}
.weave-member[data-status="interrupted"]{border-color:#f5222d;background:rgba(245,34,45,.06)}
.weave-member[data-status="awaiting"]{border-left:3px solid #faad14;border-color:#faad14;background:rgba(250,173,20,.06)}
.weave-member[data-status="failed"]{border-left:3px solid #f5222d;border-color:#f5222d;background:rgba(245,34,45,.06)}
.weave-member[data-status="completed"]{border-left:3px solid #52c41a;border-color:#52c41a;background:rgba(82,196,26,.06)}
.weave-member[data-status="ready"]{border-left:3px solid #52c41a;border-color:#52c41a;background:rgba(82,196,26,.06)}
.weave-member[data-clickable="true"]{cursor:pointer}
.weave-member[data-clickable="true"]:hover{border-color:var(--dsw-alias-label-tertiary)}
.weave-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:#8c8c8c;vertical-align:middle;flex:none}
.weave-dot[data-tone="run"]{background:#1677ff}
.weave-dot[data-tone="good"]{background:#52c41a}
.weave-dot[data-tone="bad"]{background:#f5222d}
.weave-toolbar-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 14px}
.weave-card-actions{display:flex;gap:8px;flex-wrap:wrap}
.weave-button-danger{background:transparent;border:1px solid #f5222d;color:#f5222d;font-weight:550}
.weave-button-danger:hover{filter:brightness(1.15)}
.weave-dialog{box-sizing:border-box;width:min(520px,calc(100vw - 32px));max-height:min(760px,calc(100vh - 48px));overflow-y:auto;background:var(--dsw-specific-menu);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:16px;padding:18px;display:grid;gap:12px;box-shadow:var(--dsw-shadow-lv3)}
.weave-dialog-wide{width:min(960px,calc(100vw - 32px));max-height:min(920px,calc(100vh - 32px))}
.weave-dialog-title{font-size:15px;font-weight:600;line-height:22px}
.weave-dialog-body{display:grid;gap:12px;min-height:0}
.weave-dialog-actions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
.weave-drawer-wrap{position:fixed;inset:0;z-index:2147483000;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur);display:flex;justify-content:flex-end}
.weave-drawer{box-sizing:border-box;width:min(430px,94vw);height:100%;overflow-y:auto;background:var(--dsw-specific-menu);border-left:1px solid var(--dsw-alias-border-l2);padding:16px;display:grid;gap:10px;align-content:start}
.weave-drawer-foot{display:flex;gap:8px;flex-wrap:wrap;border-top:1px solid var(--dsw-alias-border-l2);padding-top:12px;margin-top:4px}
.weave-collapse{border-top:1px solid var(--dsw-alias-border-l2);padding-top:10px;display:grid;gap:10px}
.weave-collapse-head{display:flex;align-items:center;gap:6px;border:0;background:transparent;padding:0;font:inherit;font-size:13px;font-weight:550;color:var(--dsw-alias-label-secondary);cursor:pointer;text-align:left}
.weave-collapse-mark{width:70px;margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:450;text-align:right}
.weave-field-error{color:#f5222d;font-size:11px;line-height:16px}
.weave-field[data-invalid="true"] input,.weave-field[data-invalid="true"] select,.weave-field[data-invalid="true"] textarea{border-color:#f5222d}
.weave-checkrow{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:20px}
.weave-adv-group{display:grid;gap:8px;border-left:2px solid var(--dsw-alias-border-l2);padding-left:10px}
.weave-adv-note{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
@media (max-width:600px){
  .weave-role-grid{grid-template-columns:1fr}
  .weave-field input,.weave-field select,.weave-field textarea,.weave-control{min-height:40px}
  .weave-dialog{width:calc(100vw - 16px);max-height:calc(100vh - 24px);padding:14px}
  .weave-drawer{width:100vw;border-left:0}
  .weave-dialog-actions{justify-content:stretch}
  .weave-dialog-actions .weave-button{flex:1;min-height:40px}
}
.weave-member-actions{display:flex;gap:4px;flex-wrap:wrap;margin-top:2px}
.weave-eventstream{box-sizing:border-box;max-height:180px;overflow-y:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 8px;display:grid;gap:3px;background:var(--dsw-specific-menu)}
.weave-eventline{display:flex;gap:6px;align-items:baseline;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.weave-eventline time{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex:none}
.weave-eventline b{font-weight:550;color:var(--dsw-alias-label-primary);flex:none}
.weave-event-meta{display:grid;gap:4px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
@media (max-width:600px){.weave-eventstream{max-height:140px}}
.weave-split-toggle-row{display:flex;gap:8px;margin-top:4px}
.weave-split-toggle{border:1px solid var(--dsw-alias-border-l2);background:transparent;border-radius:8px;padding:3px 8px;font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.weave-split-toggle-active{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-tertiary)}
.weave-session-split{display:grid;grid-template-columns:260px minmax(0,1fr);gap:12px;align-items:stretch;min-height:calc(100vh - 220px)}
.weave-session-split[data-left="closed"]{grid-template-columns:40px minmax(0,1fr)}
.weave-session-split[data-right="closed"]{grid-template-columns:260px 40px}
.weave-session-split[data-left="closed"][data-right="closed"]{grid-template-columns:40px 40px}
.weave-side-collapsed{display:flex;align-items:center;justify-content:center;width:100%;min-height:160px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:16px;cursor:pointer}
.weave-side-collapsed:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-tertiary)}
body.weave-session-active textarea[placeholder*="发消息"],
body.weave-session-active textarea[placeholder*="描述你想要构建的内容"]{display:none}
body.weave-session-active .uV2eYG_grow,
body.weave-session-active [class*="uV2eYG"]{display:none !important}
.weave-session-left{display:grid;gap:4px;min-width:0;align-items:start;align-content:start}
.weave-session-right{display:flex;flex-direction:column;gap:0;width:100%;min-width:0;max-width:100%}
.weave-session-right > .weave-section{display:flex;flex-direction:column;flex:1}
.weave-session-right .weave-section-body{display:flex;flex-direction:column;flex:1}
.weave-session-right .weave-panel-tab-body{flex:1}
@media (max-width:900px){
  /* 始终左右布局：只调整面板高度与队员列数，不切上下 */
  .weave-spanel{min-height:auto}
  .weave-members{grid-template-columns:1fr}
}
@media (orientation:portrait){
  .weave-spanel{min-height:auto}
  .weave-members{grid-template-columns:1fr}
  .weave-session-right .weave-panel-tab-body{height:auto;min-height:0;max-height:none;overflow-y:visible}
}
.weave-session-runtime{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:2px 0;margin-top:2px}
.weave-team-stats{display:flex;gap:8px;flex-wrap:wrap;font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary)}
.weave-team-stats b{font-weight:550;color:var(--dsw-alias-label-primary);margin-right:1px}
.weave-progress-segments{display:flex;gap:2px;height:4px;flex:1;min-width:100px;border-radius:999px;overflow:hidden;background:var(--dsw-alias-bg-layer-2)}
.weave-progress-segments span{display:block;height:100%;min-width:2px}
.weave-progress-segments span[data-state="running"]{background:#1677ff}
.weave-progress-segments span[data-state="waiting"]{background:#bfbfbf}
.weave-progress-segments span[data-state="awaiting"]{background:#faad14}
.weave-progress-segments span[data-state="completed"]{background:#52c41a}
.weave-progress-segments span[data-state="failed"]{background:#f5222d}
.weave-panel-tabs{display:flex;gap:16px;flex-wrap:wrap;border-bottom:1px solid var(--dsw-alias-border-l2);padding:0 4px;margin-top:4px}
.weave-tab{display:inline-flex;align-items:center;gap:6px;border:0;border-bottom:2px solid transparent;background:transparent;padding:6px 2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.weave-tab-active{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary,var(--dsw-alias-label-primary));font-weight:550}
.weave-tab-label{border:0;background:transparent;padding:0;font:inherit;color:inherit;cursor:pointer}
.weave-tab-close{border:0;background:transparent;padding:0 0 0 4px;font:inherit;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.weave-panel-tab-body{min-height:0;height:auto;width:100%;border:1px solid var(--dsw-alias-border-l2);border-top:0;border-radius:0 0 12px 12px;padding:14px;background:var(--dsw-alias-bg-layer-2)}
.weave-section{display:grid;gap:8px;margin-top:12px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:8px}
.weave-section-head-row{display:flex;align-items:center;justify-content:space-between;gap:8px}
.weave-section-collapse{border:1px solid var(--dsw-alias-border-l2);background:transparent;border-radius:6px;padding:1px 6px;font-size:11px;line-height:14px;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.weave-section-collapse:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-tertiary)}
.weave-section-head{display:flex;align-items:center;gap:6px;border:0;background:transparent;padding:0;font:inherit;font-size:13px;font-weight:550;color:var(--dsw-alias-label-secondary);cursor:pointer;text-align:left}
.weave-section-body{display:grid;gap:8px;padding-top:4px}
.weave-member-assignments{display:flex;gap:6px;flex-wrap:wrap;align-items:center;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.weave-assignment-chip{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l2);border-left-width:3px;border-radius:8px;padding:1px 7px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);background:var(--dsw-specific-menu)}
.weave-assignment-chip b{font-weight:550;color:var(--dsw-alias-label-primary)}
.weave-assignment-chip[data-state="running"]{border-color:#1677ff;background:rgba(22,119,255,.08)}
.weave-assignment-chip[data-state="waiting"]{border-color:#bfbfbf;background:rgba(191,191,191,.12)}
.weave-assignment-chip[data-state="awaiting"]{border-color:#faad14;background:rgba(250,173,20,.10)}
.weave-assignment-chip[data-state="completed"]{border-color:#52c41a;background:rgba(82,196,26,.10)}
.weave-assignment-chip[data-state="failed"]{border-color:#f5222d;background:rgba(245,34,45,.08)}
`
  document.head.appendChild(style)
}

/* ------------------------------- 应用工厂 ------------------------------- */

function createApp(React: any, createPortal?: (node: any, container: Element) => any, callRpc?: RpcCaller, sessionNavigator?: SessionNavigator): any {
  const { useState, useCallback, useEffect, useRef, useSyncExternalStore } = React

  /* ----------------------------- 基础工具 ----------------------------- */

  /** 所有 RPC 调用的唯一入口：payload 恒为对象；信封解包与报错由 localApply 注入的 callRpc 完成。 */
  const rpc = async (endpoint: string, payload: Json = {}): Promise<unknown> => {
    if (!callRpc) throw new Error('连接服务不可用')
    return callRpc(endpoint, payload)
  }

  const errText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

  const safeNum = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined

  const fmtTime = (value: unknown): string => {
    if (typeof value !== 'string' || value === '') return '—'
    return value.replace('T', ' ').slice(0, 19)
  }

  /** 展示用短任务 ID：dag-...-t1 → t1，便于成员卡/DAG 节点一眼区分。 */
  const shortTaskId = (value: unknown): string => {
    const raw = String(value ?? '')
    const parts = raw.split('-')
    const tail = parts.length > 0 ? (parts[parts.length - 1] ?? '') : ''
    const matched = /^[tT](\d+)$/.exec(tail)
    if (matched) return `T${matched[1] ?? ''}`
    return tail !== '' ? tail : raw
  }


  /** 打开 DSH 子代理会话：优先走新版 openSubagent，旧版回退 open(childSessionId)。 */
  const openSubagentSession = async (parentSessionId: string, childSessionId: string): Promise<void> => {
    if (!sessionNavigator) return
    if (sessionNavigator.openSubagent === undefined || sessionNavigator.refreshSubagents === undefined) {
      sessionNavigator.open(childSessionId)
      return
    }
    try {
      await sessionNavigator.refreshSubagents(parentSessionId)
    } catch {
      // 刷新失败不阻断跳转尝试
    }
    const retained = sessionNavigator.subagentAddress?.(childSessionId)
    sessionNavigator.openSubagent?.(
      retained?.parentSessionId === parentSessionId
        ? (retained as { parentSessionId: string; childSessionId: string; mode?: string })
        : { parentSessionId, childSessionId, mode: 'continuable' },
    )
  }

  /* ----------------------------- 通用 Hooks ----------------------------- */

  /**
   * 资源加载：loading / data / error 三态 + refresh。
   * deps 变化或 refresh 时重新拉取；卸载后不再 setState。
   */
  function useResource<T>(fetcher: () => Promise<T>, deps: Array<unknown>) {
    const [data, setData] = useState(undefined as T | undefined)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')
    const [tick, setTick] = useState(0)

    useEffect(() => {
      let alive = true
      setLoading(true)
      setError('')
      fetcher()
        .then((next: T) => {
          if (!alive) return
          setData(next)
          setLoading(false)
        })
        .catch((cause: unknown) => {
          if (!alive) return
          setError(errText(cause))
          setLoading(false)
        })
      return () => {
        alive = false
      }
    }, [...deps, tick])

    const refresh = useCallback(() => setTick((value: number) => value + 1), [])
    return { data, loading, error, refresh }
  }

  /** 动作执行：busy / 成功与失败提示。每个异步操作都必须经过它反馈结果。 */
  function useAction() {
    const [busy, setBusy] = useState(false)
    const [note, setNote] = useState('')
    const [ok, setOk] = useState(null as boolean | null)
    const run = useCallback(async (fn: () => Promise<string>) => {
      setBusy(true)
      try {
        const result = await fn()
        setOk(true)
        setNote(result)
        return true
      } catch (cause) {
        setOk(false)
        setNote(errText(cause))
        return false
      } finally {
        setBusy(false)
      }
    }, [])
    return { busy, note, ok, run }
  }

  /* ----------------------------- 原子组件 ----------------------------- */

  const Note = ({ text, kind }: { text: string; kind?: 'error' }) =>
    text === ''
      ? null
      : React.createElement(
          'p',
          { className: 'weave-note', 'data-testid': kind === 'error' ? 'page-error' : 'page-note' },
          text,
        )

  const EmptyState = ({ title, reason }: { title: string; reason: string }) =>
    React.createElement(
      'div',
      { className: 'weave-empty', 'data-testid': 'page-empty' },
      React.createElement('b', null, title),
      React.createElement('span', null, reason),
    )

  interface CardProps {
    title: string
    meta?: any
    onClick?: () => void
    testId?: string
  }

  const Card = (props: CardProps) =>
    React.createElement(
      'article',
      {
        className: 'weave-card',
        'data-testid': props.testId,
        'data-clickable': props.onClick ? 'true' : undefined,
        onClick: props.onClick,
        role: props.onClick ? 'button' : undefined,
      },
      React.createElement('b', null, props.title),
      props.meta ?? React.createElement('span', null, ''),
    )

  const toneOf = (status: string): string => {
    if (status === 'COMPLETED' || status === 'CLOSED') return 'good'
    if (status === 'FAILED' || status === 'BANNED' || status === 'CANCELLED') return 'bad'
    if (status === 'RUNNING' || status === 'REVISION_RUNNING') return 'run'
    return 'idle'
  }

  const Pill = ({ label, tone, title }: { label: string; tone?: string; title?: string }) =>
    React.createElement('span', { className: 'weave-pill', 'data-tone': tone ?? 'idle', title: title ?? label }, label)

  /** 通用确认弹窗：替代原生 window.confirm，统一移动端体验。 */
  const ConfirmDialog = ({ open, title, body, confirmText = '确认', cancelText = '取消', danger = false, busy = false, testId = 'confirm-dialog', onConfirm, onCancel }: {
    open: boolean
    title: string
    body: string
    confirmText?: string
    cancelText?: string
    danger?: boolean
    busy?: boolean
    testId?: string
    onConfirm: () => void
    onCancel: () => void
  }) => {
    if (!open) return null
    return React.createElement(
      'div',
      {
        className: 'weave-overlay',
        'data-testid': testId,
        onClick: (event: { target: unknown; currentTarget: unknown }) => {
          if (event.target === event.currentTarget) onCancel()
        },
      },
      React.createElement(
        'div',
        { className: 'weave-dialog', role: 'dialog', 'aria-modal': 'true' },
        React.createElement('b', { className: 'weave-dialog-title' }, title),
        React.createElement('p', { style: { margin: 0, fontSize: 13, lineHeight: '20px' } }, body),
        React.createElement(
          'div',
          { className: 'weave-dialog-actions' },
          React.createElement(
            'button',
            { className: 'weave-button weave-button-secondary', type: 'button', disabled: busy, autoFocus: true, onClick: onCancel, 'data-testid': `${testId}-cancel` },
            cancelText,
          ),
          React.createElement(
            'button',
            { className: danger ? 'weave-button weave-button-danger' : 'weave-button', type: 'button', disabled: busy, onClick: onConfirm, 'data-testid': `${testId}-confirm` },
            busy ? '处理中...' : confirmText,
          ),
        ),
      ),
    )
  }

  /** 通用输入弹窗：替代原生 window.prompt（如任务返工反馈）。 */
  const PromptDialog = ({ open, title, placeholder = '', initialValue = '', testId = 'prompt-dialog', confirmTestId, onConfirm, onCancel }: {
    open: boolean
    title: string
    placeholder?: string
    initialValue?: string
    testId?: string
    confirmTestId?: string
    onConfirm: (value: string) => void
    onCancel: () => void
  }) => {
    const [value, setValue] = useState(initialValue)
    useEffect(() => {
      if (open) setValue(initialValue)
    }, [open, initialValue])
    if (!open) return null
    return React.createElement(
      'div',
      {
        className: 'weave-overlay',
        'data-testid': testId,
        onClick: (event: { target: unknown; currentTarget: unknown }) => {
          if (event.target === event.currentTarget) onCancel()
        },
      },
      React.createElement(
        'div',
        { className: 'weave-dialog', role: 'dialog', 'aria-modal': 'true' },
        React.createElement('b', { className: 'weave-dialog-title' }, title),
        React.createElement(
          'label',
          { className: 'weave-field' },
          React.createElement('span', null, '反馈内容'),
          React.createElement('textarea', {
            value,
            placeholder,
            rows: 3,
            autoFocus: true,
            onChange: (event: { target: { value: string } }) => setValue(event.target.value),
          }),
        ),
        React.createElement(
          'div',
          { className: 'weave-dialog-actions' },
          React.createElement(
            'button',
            { className: 'weave-button weave-button-secondary', type: 'button', onClick: onCancel, 'data-testid': `${testId}-cancel` },
            '取消',
          ),
          React.createElement(
            'button',
            { className: 'weave-button', type: 'button', disabled: value.trim() === '', onClick: () => onConfirm(value.trim()), 'data-testid': confirmTestId ?? `${testId}-confirm` },
            '提交反馈',
          ),
        ),
      ),
    )
  }


  /* ============================== 总览页 ============================== */

  interface OverviewData {
    teams?: number
    executors?: number
    tasks?: number
    banned?: number
    candidates?: number
    recent?: AuditEventView[]
    revisions?: RevisionRow[]
    revisionError?: string
    snapError?: string
    taskError?: string
    knowledgeError?: string
    auditError?: string
  }

  function OverviewPage({ navigate }: { navigate: (route: Route) => void }) {
    const overview = useResource<OverviewData>(async () => {
      const next: OverviewData = {}
      try {
        const snap = (await rpc('snapshot')) as SnapshotData
        next.teams = snap.teams?.length ?? 0
        next.executors = snap.executors?.length ?? 0
      } catch (cause) {
        next.snapError = errText(cause)
      }
      try {
        const listed = (await rpc('task/list', { limit: 1 })) as { total?: number }
        next.tasks = safeNum(listed.total)
      } catch (cause) {
        next.taskError = errText(cause)
      }
      try {
        const banned = (await rpc('task/list', { status: 'BANNED', limit: 1 })) as { total?: number }
        next.banned = safeNum(banned.total) ?? 0
      } catch {
        next.banned = undefined
      }
      try {
        const knowledge = (await rpc('knowledge/list', { status: 'candidate', limit: 50 })) as { candidates?: unknown[] }
        next.candidates = knowledge.candidates?.length
      } catch (cause) {
        next.knowledgeError = errText(cause)
      }
      try {
        const audit = (await rpc('audit/list', { limit: 5 })) as { events?: AuditEventView[] }
        next.recent = audit.events ?? []
      } catch (cause) {
        next.auditError = errText(cause)
      }
      try {
        const revisions = (await rpc('session/revisions', { limit: 10 })) as { revisions?: RevisionRow[] }
        next.revisions = revisions.revisions ?? []
      } catch (cause) {
        next.revisionError = errText(cause)
      }
      return next
    }, [])
    const data = overview.data ?? {}

    const missing = '数据源尚未接入（等待 RPC 端点上线）'
    return React.createElement(
      'section',
      { className: 'weave-page', 'data-testid': 'page-overview' },
      React.createElement('h1', null, '总览'),
      Note({ text: overview.loading ? '正在加载...' : overview.error }),
      React.createElement(
        'div',
        { className: 'weave-grid' },
        Card({
          title: `团队（${data.teams ?? '—'}）`,
          meta: data.snapError ? React.createElement('span', null, data.snapError) : React.createElement('span', null, '查看团队列表与创建新团队。'),
          onClick: () => navigate('teams'),
          testId: 'overview-card-teams',
        }),
        Card({
          title: `执行器（${data.executors ?? '—'}）`,
          meta: data.snapError ? React.createElement('span', null, data.snapError) : React.createElement('span', null, '检查各执行器注册状态。'),
          onClick: () => navigate('executors'),
          testId: 'overview-card-executors',
        }),
        Card({
          title: `任务总数（${data.tasks ?? '—'}）`,
          meta: React.createElement('span', null, data.taskError ? missing : '成员与当前会话任务图见会话视图的「Weave 团队」页签。'),
          testId: 'overview-card-tasks',
        }),
        Card({
          title: `熔断/禁用任务（${data.banned ?? (data.tasks === undefined ? '—' : 0)}）`,
          meta: React.createElement('span', null, data.taskError ? missing : '熔断状态任务数量。'),
          testId: 'overview-card-banned',
        }),
        Card({
          title: `待审知识（${data.candidates ?? (data.knowledgeError ? '—' : 0)}）`,
          meta: React.createElement('span', null, data.knowledgeError ? missing : '候选队列等待审核。'),
          onClick: () => navigate('knowledge'),
          testId: 'overview-card-knowledge',
        }),
        Card({
          title: '最近审计',
          meta: data.auditError
            ? React.createElement('span', null, missing)
            : React.createElement(
                'span',
                null,
                (data.recent ?? []).slice(0, 3).map((event: AuditEventView, index: number) =>
                  React.createElement('div', { key: `${String(event.type ?? 'event')}-${index}` }, `${fmtTime(event.occurred_at)} · ${String(event.type ?? '未知事件')}`),
                ),
                (data.recent ?? []).length === 0 ? '暂无审计事件。' : null,
              ),
          onClick: () => navigate('audit'),
          testId: 'overview-card-audit',
        }),
      ),
      React.createElement(
        'div',
        { className: 'weave-list', style: { marginTop: 20 } },
        React.createElement('b', { className: 'weave-subh' }, '最近修订记录（保温期）'),
        data.revisionError
          ? EmptyState({ title: '修订记录不可用', reason: data.revisionError })
          : (data.revisions ?? []).length === 0
            ? EmptyState({ title: '暂无修订记录', reason: 'feedback.db 中尚无修订上下文。' })
            : (data.revisions ?? []).map((row: RevisionRow) =>
                React.createElement(
                  'article',
                  { className: 'weave-list-item', key: row.task_id, 'data-testid': `revision-row-${row.task_id}` },
                  React.createElement(
                    'div',
                    { className: 'weave-list-head' },
                    React.createElement('b', null, row.task_id),
                    React.createElement(Pill, { label: `第 ${safeNum(row.revision_count) ?? 0} 次修订` }),
                  ),
                  React.createElement(
                    'span',
                    { className: 'weave-muted' },
                    `反馈：${(row.user_feedback ?? []).join(' ／ ') || '（无文字反馈）'}`,
                  ),
                  React.createElement(
                    'span',
                    { className: 'weave-muted' },
                    `上次结果：${row.previous_result ? String(row.previous_result).slice(0, 120) : '—'} · 更新 ${fmtTime(row.updated_at)}`,
                  ),
                ),
              ),
      ),
    )
  }

  /* ============================== 团队页 ============================== */

  const DEFAULT_STAGES = ''
  const DEFAULT_PERSONALITY = '你是可靠的协作执行角色，输出可验证结果。'

  const blankRole = (): RoleDraft => ({
    id: '',
    name: '',
    bias: 'dev',
    executor: '',
    stages: DEFAULT_STAGES,
    personality: DEFAULT_PERSONALITY,
    provider: '',
    model: '',
    thoughtLevel: '',
    mode: '',
    fallbackProvider: '',
    fallbackModel: '',
    priority: '',
    strengths: '',
  })

  /** 「高级配置」三段（任务拆解/知识注入/反馈策略）的表单默认值：= 原提交逻辑的硬编码字面量。 */
  const blankAdvanced = () => ({
    difficulty: 'hard',
    templatesEasy: 'prepare, implement, review',
    templatesMedium: 'prepare, implement, review',
    templatesHard: 'prepare, implement, review',
    templatesCritical: 'prepare, implement, review',
    knowledgeMaxEntries: '3',
    knowledgePerEntry: '2000',
    knowledgeTotalChars: '6000',
    priority: 'freshness_first',
    feedbackTimeoutSeconds: '1800',
    maxRevisions: '2',
    reopenWindowSeconds: '86400',
  })
  type AdvancedDraft = ReturnType<typeof blankAdvanced>

  /** 数值字段宽松解析：非法/越界回落到与原硬编码行为一致的缺省。 */
  const advInt = (raw: string, fallback: number, isValid: (n: number) => boolean): number => {
    const parsed = Number.parseInt(raw, 10)
    return Number.isInteger(parsed) && isValid(parsed) ? parsed : fallback
  }

  /** serializeTeam 全量（team/get 返回）→ 高级配置表单态；缺失项回落默认值。 */
  const advancedFromConfig = (cfg?: Json): AdvancedDraft => {
    const base = blankAdvanced()
    if (!cfg) return base
    const td = (cfg['task_decomposition'] ?? {}) as Json
    const templates = (td['dag_templates'] ?? {}) as Json
    const know = (cfg['knowledge_injection'] ?? {}) as Json
    const fb = (cfg['feedback'] ?? {}) as Json
    const tpl = (level: string, fallback: string): string => {
      const value = templates[level]
      return Array.isArray(value) && value.length > 0 ? value.map((item) => String(item)).join(', ') : fallback
    }
    const str = (value: unknown, fallback: string): string =>
      typeof value === 'string' && value !== '' ? value : value === undefined || value === null ? fallback : String(value)
    return {
      difficulty: str(td['default_difficulty'], base.difficulty),
      templatesEasy: tpl('easy', base.templatesEasy),
      templatesMedium: tpl('medium', base.templatesMedium),
      templatesHard: tpl('hard', base.templatesHard),
      templatesCritical: tpl('critical', base.templatesCritical),
      knowledgeMaxEntries: str(know['max_entries'], base.knowledgeMaxEntries),
      knowledgePerEntry: str(know['max_chars_per_entry'], base.knowledgePerEntry),
      knowledgeTotalChars: str(know['max_total_chars'], base.knowledgeTotalChars),
      priority: str(know['priority'], base.priority),
      feedbackTimeoutSeconds: str(fb['feedback_timeout_seconds'], base.feedbackTimeoutSeconds),
      maxRevisions: str(fb['max_revisions'], base.maxRevisions),
      reopenWindowSeconds: str(fb['reopen_window_seconds'], base.reopenWindowSeconds),
    }
  }

  /** 高级配置表单态 → YAML 配置段；dag 模板空串兜底『prepare, implement, review』。 */
  const configFromAdvanced = (draft: AdvancedDraft) => {
    const stages = (raw: string, fallback: string): string[] => {
      const list = raw.split(',').map((part) => part.trim()).filter(Boolean)
      return list.length > 0 ? list : fallback.split(',').map((part) => part.trim())
    }
    return {
      task_decomposition: {
        default_difficulty: draft.difficulty,
        dag_templates: {
          easy: stages(draft.templatesEasy, 'prepare, implement, review'),
          medium: stages(draft.templatesMedium, 'prepare, implement, review'),
          hard: stages(draft.templatesHard, 'prepare, implement, review'),
          critical: stages(draft.templatesCritical, 'prepare, implement, review'),
        },
      },
      knowledge_injection: {
        max_entries: advInt(draft.knowledgeMaxEntries, 3, (n) => n >= 0 && n <= 20),
        max_chars_per_entry: advInt(draft.knowledgePerEntry, 2000, (n) => n >= 100),
        max_total_chars: advInt(draft.knowledgeTotalChars, 6000, (n) => n >= 100),
        priority: draft.priority,
      },
      feedback: {
        feedback_timeout_seconds: advInt(draft.feedbackTimeoutSeconds, 1800, (n) => n >= 60),
        max_revisions: advInt(draft.maxRevisions, 2, (n) => n >= 0 && n <= 10),
        reopen_window_seconds: advInt(draft.reopenWindowSeconds, 86400, (n) => n >= 0),
      },
    }
  }

  /** 与原创建链一致的团队 ID 规整：小写、非 [a-z0-9._-] 折线、去首尾连字符。 */
  const slugifyTeamId = (raw: string): string =>
    raw.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')

  function TeamsPage() {
    const snapshot = useResource<SnapshotData>(() => rpc('snapshot') as Promise<SnapshotData>, [])
    const snap = snapshot.data ?? {}
    const executors = snap.executors ?? []
    const teams = snap.teams ?? []
    const capabilities = snap.zcodeCapabilities
    const rawModels = (capabilities?.models ?? []) as SelectOption[]
    const zcodeModelCatalog = rawModels.map((option: SelectOption) => {
      const sep = String.fromCharCode(92)
      const cut = option.value.lastIndexOf(sep)
      return cut >= 0
        ? { provider: option.value.slice(0, cut), model: option.value.slice(cut + 1), label: option.name ?? option.value }
        : { provider: '', model: option.value, label: option.name ?? option.value }
    })
    const llmModelCatalog = (snap.modelCatalog ?? []).flatMap((group: { provider: string; name: string; models: Array<{ id: string; name: string }> }) =>
      group.models.map((item: { id: string; name: string }) => ({ provider: group.provider, model: item.id, label: item.name ?? item.id })),
    )
    const modelCatalog = [...llmModelCatalog, ...zcodeModelCatalog]
    const providerItems: string[] = [...new Set(modelCatalog.map((item) => item.provider).filter((item: string): item is string => item !== ''))]
    const modelsByProvider: Record<string, string[]> = {}
    for (const item of modelCatalog) {
      if (item.provider === '') continue
      const bucket = modelsByProvider[item.provider] ?? []
      if (!bucket.includes(item.model)) bucket.push(item.model)
      modelsByProvider[item.provider] = bucket
    }

    /* ---- 浮层状态机：编辑器（create/edit 显式分离）/ 删除确认 / 设默认确认 / 详情抽屉 ---- */
    const [editorMode, setEditorMode] = useState(null as null | 'create' | 'edit')
    const [teamId, setTeamId] = useState('')
    const [editingTeamId, setEditingTeamId] = useState('')
    const [name, setName] = useState('')
    const [description, setDescription] = useState('')
    const [defaultFlag, setDefaultFlag] = useState(false)
    const [roles, setRoles] = useState([blankRole()] as RoleDraft[])
    const [advanced, setAdvancedState] = useState(blankAdvanced())
    const [editBase, setEditBase] = useState(null as Json | null)
    const [advancedOpen, setAdvancedOpen] = useState(false)
    const [roleOpen, setRoleOpen] = useState([true])
    const [detailTeamId, setDetailTeamId] = useState(null as string | null)
    /** 队员聚焦模式：null=整队编辑器；>=0=只编辑该下标成员；-1=只编辑末尾新追加的队员。 */
    const [memberFocus, setMemberFocus] = useState(null as null | number)
    const [deleteTarget, setDeleteTarget] = useState(null as null | { id: string; name: string })
    const [confirmDefaultTarget, setConfirmDefaultTarget] = useState(null as null | { id: string; name: string })
    const creator = useAction()
    const [fieldErrors, setFieldErrors] = useState({} as Record<string, string>)
    const [confirmDiscard, setConfirmDiscard] = useState(false)
    const [editSnapshotJson, setEditSnapshotJson] = useState('')

    const setAdvancedField = <K extends keyof ReturnType<typeof blankAdvanced>>(key: K, value: string): void => {
      for (const errorKey of ['advancedKnowledgeMaxEntries', 'advancedKnowledgePerEntry', 'advancedKnowledgeTotalChars', 'advancedFeedbackTimeoutSeconds', 'advancedMaxRevisions', 'advancedReopenWindowSeconds']) {
        clearFieldError(errorKey)
      }
      setAdvancedState((current: ReturnType<typeof blankAdvanced>) => ({ ...current, [key]: value }))
    }

    const resetEditorForm = (): void => {
      setEditingTeamId('')
      setTeamId('')
      setName('')
      setDescription('')
      setDefaultFlag(false)
      setRoles([blankRole()])
      setAdvancedState(blankAdvanced())
      setEditBase(null)
      setAdvancedOpen(false)
      setRoleOpen([true])
      setFieldErrors({})
      setConfirmDiscard(false)
      setEditSnapshotJson('')
      setMemberFocus(null)
    }

    const buildDraftJson = (): string =>
      JSON.stringify({ teamId, name, description, defaultFlag, roles, advanced })
    const dirty = editorMode === 'edit' && editSnapshotJson !== '' && buildDraftJson() !== editSnapshotJson

    const closeEditor = (): void => {
      if (editorMode === 'edit' && dirty) {
        setConfirmDiscard(true)
        return
      }
      setFieldErrors({})
      setConfirmDiscard(false)
      setEditorMode(null)
    }

    const clearFieldError = (key: string): void =>
      setFieldErrors((current: Record<string, string>) => {
        if (!(key in current)) return current
        const next = { ...current }
        delete next[key]
        return next
      })

    const validateTeamForm = (): Record<string, string> => {
      const errors: Record<string, string> = {}
      const resolvedName = name.trim()
      if (resolvedName === '') errors.name = '请填写团队名称'
      const resolvedId = editorMode === 'edit'
        ? editingTeamId
        : (teamId.trim() || slugifyTeamId(name) || 'team')
      if (editorMode === 'create') {
        if (!/^[a-z0-9._-]+$/.test(resolvedId)) errors.teamId = '只能使用小写字母、数字和 . _ -'
        if (resolvedId.length > 64) errors.teamId = '长度不能超过 64'
        if (teams.some((team: TeamSummaryRow) => String(team.team_id ?? '') === resolvedId)) {
          errors.teamId = `已存在同名团队 ID：${resolvedId}`
        }
      }
      const seen = new Map<string, number>()
      roles.forEach((role: RoleDraft, index: number) => {
        const roleId = role.id.trim() || `member${index > 0 ? `-${index + 1}` : ''}`
        const prev = seen.get(roleId)
        if (prev !== undefined) {
          errors[`role-${index}-id`] = `角色 ID 在团队内需唯一，与「${roleId}」冲突`
          errors[`role-${prev}-id`] = `角色 ID 在团队内需唯一，与「${roleId}」冲突`
        } else {
          seen.set(roleId, index)
        }
      })
      const intIn = (raw: string, min: number, max: number): boolean => {
        const n = Number.parseInt(raw, 10)
        return Number.isInteger(n) && n >= min && n <= max
      }
      if (!intIn(advanced.knowledgeMaxEntries, 0, 20)) errors.advancedKnowledgeMaxEntries = '应在 0–20 之间'
      if (!intIn(advanced.knowledgePerEntry, 100, 100000)) errors.advancedKnowledgePerEntry = '不能小于 100'
      if (!intIn(advanced.knowledgeTotalChars, 100, 1000000)) errors.advancedKnowledgeTotalChars = '不能小于 100'
      if (!intIn(advanced.feedbackTimeoutSeconds, 60, 604800)) errors.advancedFeedbackTimeoutSeconds = '应在 60 秒以上'
      if (!intIn(advanced.maxRevisions, 0, 10)) errors.advancedMaxRevisions = '应在 0–10 之间'
      if (!intIn(advanced.reopenWindowSeconds, 0, 31536000)) errors.advancedReopenWindowSeconds = '不能小于 0'
      return errors
    }

    /** 新建模式：空白草稿（高级配置默认值与原提交硬编码一致）；执行器直接取当前已注册的首个，避免依赖只在快照首次到达时运行的补默认 effect。 */
    const openCreate = (): void => {
      resetEditorForm()
      const firstExecutorId = (executors[0] as ExecutorInfo | undefined)?.id ?? ''
      if (firstExecutorId !== '') {
        setRoles([{ ...blankRole(), executor: firstExecutorId }])
      }
      setEditorMode('create')
      setDetailTeamId(null)
    }

    const updateRole = (index: number, key: keyof RoleDraft, value: string) => {
      clearFieldError(`role-${index}-${String(key)}`)
      setRoles((current: RoleDraft[]) => current.map((role, i) => (i === index ? { ...role, [key]: value } : role)))
    }

    const addRole = () => {
      setRoleOpen((current: boolean[]) => [...current, true])
      setRoles((current: RoleDraft[]) => [
        ...current,
        { ...blankRole(), executor: current[current.length - 1]?.executor ?? '' },
      ])
    }
    const removeRole = (index: number) => {
      if (roles.length <= 1) return
      setRoleOpen((current: boolean[]) => current.filter((_v, i) => i !== index))
      setRoles((current: RoleDraft[]) => current.filter((_role, i) => i !== index))
    }

    // 快照到达后（或编辑器打开时），为尚未选择执行器的角色补默认值（取实际注册的第一个执行器，有什么显示什么，不强制 ZCode）。
    // editorMode 入依赖：新建/载入产生的新角色需要重新兜底，不能只在快照首次到达时运行一次。
    useEffect(() => {
      const firstExecutor = ((snapshot.data?.executors ?? [])[0] as ExecutorInfo | undefined)?.id ?? ''
      if (firstExecutor === '') return
      setRoles((current: RoleDraft[]) =>
        current.some((role: RoleDraft) => role.executor === '')
          ? current.map((role: RoleDraft) => (role.executor === '' ? { ...role, executor: firstExecutor } : role))
          : current,
      )
    }, [snapshot.data, editorMode])

    /* ---- 提交（唯一写入路径）：create 全新构建；edit 以 team/get 全量为基底展开，
       只覆写表单可见字段，matchers/executor_limits 等未编辑内容原样保留（评审 C1）。 ---- */
    const submit = async (event: { preventDefault(): void }) => {
      event.preventDefault()
      if (editorMode === null) return
      const errors = validateTeamForm()
      if (Object.keys(errors).length > 0) {
        setFieldErrors(errors)
        return
      }
      setFieldErrors({})
      const mode = editorMode
      await creator.run(async () => {
        const fallbackExecutor = executors[0]?.id ?? ''
        const separator = String.fromCharCode(92)
        const builtRoles = roles.map((draft: RoleDraft, index: number) => {
          const suffix = index > 0 ? `-${index + 1}` : ''
          const stages = draft.stages.split(',').map((part: string) => part.trim()).filter(Boolean)
          const role: Json = {
            id: draft.id.trim() || `member${suffix}`,
            name: draft.name.trim() || '成员',
            bias: draft.bias.trim() || 'dev',
            executor: draft.executor || fallbackExecutor,
            stages,
            // 每名成员同一时间只执行一个任务：调度器强制串行（忽略历史 yaml 值），统一写 1 仅供后端校验通过。
            max_concurrent_tasks: 1,
            personality: draft.personality,
          }
          if (draft.priority.trim() !== '') {
            const priority = Number.parseInt(draft.priority, 10)
            if (Number.isInteger(priority) && priority >= 0) role.priority = priority
          }
          const strengths = draft.strengths.split(',').map((part) => part.trim()).filter(Boolean)
          if (strengths.length > 0) role.strengths = strengths
          if (draft.executor === 'zcode') {
            if (draft.model) {
              const cut = draft.model.lastIndexOf(separator)
              if (cut >= 0) {
                role.provider = draft.model.slice(0, cut)
                role.model = draft.model.slice(cut + 1)
              } else {
                role.model = draft.model
              }
            }
            if (draft.mode) role.mode = draft.mode
          } else {
            if (draft.provider) role.provider = draft.provider
            if (draft.model) role.model = draft.model
          }
          // DSH 原生子代理也支持 thought_level（Weave 安装到子代理模型选择）。
          if (draft.thoughtLevel) role.thought_level = draft.thoughtLevel
          if (draft.fallbackProvider && draft.fallbackModel) {
            role.fallback_provider = draft.fallbackProvider
            role.fallback_model = draft.fallbackModel
          }
          return role
        })
        const resolvedId =
          (mode === 'edit' ? editingTeamId : teamId || slugifyTeamId(name) || 'team') || 'team'
        const executorLimits: Json = {}
        for (const role of builtRoles) {
          const key = String(role.executor ?? 'spawn')
          if (!(key in executorLimits)) executorLimits[key] = { max_concurrent: 1, max_per_hour: 20 }
        }
        const advancedConfig = configFromAdvanced(advanced)
        const base = mode === 'edit' && editBase ? editBase : null
        const config: Json = base
          ? {
              ...base,
              schema_version: String(base['schema_version'] ?? '1'),
              team_id: resolvedId,
              name: name.trim() || resolvedId,
              description: description.trim(),
              default: defaultFlag,
              roles: builtRoles,
              // spread 基底在前：matchers 等表单外字段原样保留，仅覆写三段可编辑值。
              task_decomposition: {
                ...(base['task_decomposition'] as Json | undefined ?? {}),
                ...advancedConfig.task_decomposition,
              },
              knowledge_injection: {
                ...(base['knowledge_injection'] as Json | undefined ?? {}),
                ...advancedConfig.knowledge_injection,
              },
              feedback: {
                ...(base['feedback'] as Json | undefined ?? {}),
                ...advancedConfig.feedback,
              },
              executor_limits:
                (base['executor_limits'] as Json | undefined) && Object.keys(base['executor_limits'] as Json).length > 0
                  ? base['executor_limits']
                  : executorLimits,
            }
          : {
              schema_version: '1',
              team_id: resolvedId,
              name: name.trim() || resolvedId,
              description: description.trim(),
              default: defaultFlag,
              roles: builtRoles,
              task_decomposition: advancedConfig.task_decomposition,
              knowledge_injection: advancedConfig.knowledge_injection,
              feedback: advancedConfig.feedback,
              executor_limits: executorLimits,
            }
        await rpc('team/import', { overwrite: true, config })
        setEditorMode(null)
        setEditBase(null)
        setEditingTeamId('')
        setMemberFocus(null)
        setDetailTeamId(mode === 'edit' ? editingTeamId : null)
        void snapshot.refresh()
        return `${mode === 'edit' ? '已更新' : '已保存'}：${resolvedId}（${builtRoles.length} 个角色）`
      })
    }

    /* ---- 删除（应用内二次确认弹窗，替代原生 window.confirm 保移动端体验） ---- */
    const remover = useAction()
    const loader = useAction()
    const defaulter = useAction()

    const confirmRemove = async (): Promise<void> => {
      const target = deleteTarget
      if (!target) return
      await remover.run(async () => {
        await rpc('team/delete', { teamId: target.id })
        void snapshot.refresh()
        setDeleteTarget(null)
        setDetailTeamId((current: string | null) => (current === target.id ? null : current))
        return `已删除：${target.id}`
      })
    }

    /** 设默认团队（互斥）：无其他默认时直接执行；有则先弹互斥确认。 */
    const runSetDefault = async (id: string): Promise<void> => {
      await defaulter.run(async () => {
        const result = (await rpc('team/set-default', { teamId: id })) as { flipped?: string[] } | undefined
        void snapshot.refresh()
        const flipped = Array.isArray(result?.flipped) ? result.flipped : []
        return flipped.length > 0
          ? `已设为默认：${id}（并取消 ${flipped.join('、')} 的默认标记）`
          : `已设为默认：${id}`
      })
      setConfirmDefaultTarget(null)
    }

    const requestSetDefault = (id: string): void => {
      const hasOtherDefault = teams.some((team: TeamSummaryRow) => String(team.team_id ?? '') !== id && team.default === true)
      if (hasOtherDefault) {
        const row = teams.find((team: TeamSummaryRow) => String(team.team_id ?? '') === id)
        setConfirmDefaultTarget({ id, name: String(row?.name ?? id) })
      } else {
        void runSetDefault(id)
      }
    }

    const roleToDraft = (role: Json): RoleDraft => ({
      id: String(role.id ?? ''),
      name: String(role.name ?? ''),
      bias: String(role.bias ?? ''),
      executor: String(role.executor ?? ''),
      stages: Array.isArray(role.stages) ? (role.stages as string[]).join(',') : String(role.stages ?? ''),
      personality: String(role.personality ?? ''),
      provider: String(role.provider ?? ''),
      model: String(role.model ?? ''),
      thoughtLevel: String(role.thought_level ?? ''),
      mode: String(role.mode ?? ''),
      fallbackProvider: String(role.fallback_provider ?? ''),
      fallbackModel: String(role.fallback_model ?? ''),
      priority: String(role.priority ?? ''),
      strengths: Array.isArray(role.strengths) ? (role.strengths as string[]).join(',') : String(role.strengths ?? ''),
    })

    /** 编辑模式：载入全量配置预填（含高级三段），作为提交基底防丢字段。 */
    const loadTeam = async (id: string) => {
      await loader.run(async () => {
        const team = (await rpc('team/get', { teamId: id })) as Json
        const drafts =
          Array.isArray(team.roles) && team.roles.length > 0 ? (team.roles as Json[]).map(roleToDraft) : [blankRole()]
        setEditorMode('edit')
        setEditingTeamId(String(team.team_id ?? id))
        setTeamId(String(team.team_id ?? id))
        setName(String(team.name ?? ''))
        setDescription(String(team.description ?? ''))
        setDefaultFlag(team.default === true)
        setRoles(drafts)
        setAdvancedState(advancedFromConfig(team))
        setEditBase(team)
        setAdvancedOpen(false)
        setRoleOpen(Array.from({ length: drafts.length }, () => true))
        setMemberFocus(null)
        setFieldErrors({})
        setConfirmDiscard(false)
        setEditSnapshotJson(JSON.stringify({
          teamId: String(team.team_id ?? id),
          name: String(team.name ?? ''),
          description: String(team.description ?? ''),
          defaultFlag: team.default === true,
          roles: drafts,
          advanced: advancedFromConfig(team),
        }))
        return `已载入团队：${String(team.team_id ?? id)}`
      })
    }

    /** 详情抽屉点队员卡片：载入整队进编辑器并只展开该成员（其余折叠），保存/取消后回到抽屉。 */
    const openMemberEditor = async (id: string, roleIndex: number): Promise<void> => {
      if (loader.busy) return
      try {
        await loadTeam(id)
      } catch {
        return
      }
      setDetailTeamId(id)
      setRoleOpen((current: boolean[]) => current.map((_v: boolean, i: number) => i === roleIndex))
      setMemberFocus(roleIndex)
    }

    /** 详情弹窗「添加队员」：整队末尾追加空白成员并聚焦（memberFocus=-1 表示取列表最后一个）。 */
    const openAddMember = async (id: string): Promise<void> => {
      if (loader.busy) return
      try {
        await loadTeam(id)
      } catch {
        return
      }
      setDetailTeamId(id)
      setRoles((current: RoleDraft[]) => [...current, { ...blankRole(), executor: executors[0]?.id ?? '' }])
      setMemberFocus(-1)
    }

    /* ---- 删除队员（卡片右上角 × → 二次确认 → team/get 全量去掉该角色后 team/import） ---- */
    const memberRemover = useAction()
    const [deleteMember, setDeleteMember] = useState(null as null | { teamId: string; name: string; roleIndex: number })

    const confirmDeleteMember = async (): Promise<void> => {
      const target = deleteMember
      if (!target) return
      await memberRemover.run(async () => {
        const team = (await rpc('team/get', { teamId: target.teamId })) as Json
        const allRoles = Array.isArray(team.roles) ? [...(team.roles as Json[])] : []
        if (allRoles.length <= 1) throw new Error('团队至少保留一名队员，无法删除')
        allRoles.splice(target.roleIndex, 1)
        await rpc('team/import', { overwrite: true, config: { ...team, roles: allRoles } })
        void snapshot.refresh()
        setDeleteMember(null)
        return `已删除队员：${target.name}`
      })
    }

    const models = capabilities?.models ?? []
    const modes = (capabilities?.modes ?? []).map((option: SelectOption) => option.value)
    const thoughts = (capabilities?.thoughtLevels ?? []).map((option: SelectOption) => option.value)

    const roleField = (index: number, label: string, key: keyof RoleDraft, placeholder = '', type = 'text', rows = 2) => {
      const errorKey = `role-${index}-${String(key)}`
      const error = fieldErrors[errorKey]
      return React.createElement(
        'label',
        { className: 'weave-field', 'data-invalid': error ? 'true' : undefined },
        React.createElement('span', null, label),
        type === 'textarea'
          ? React.createElement('textarea', {
              value: roles[index]?.[key] ?? '',
              onChange: (event: { target: { value: string } }) => updateRole(index, key, event.target.value),
              rows,
            })
          : React.createElement('input', {
              type,
              value: roles[index]?.[key] ?? '',
              placeholder,
              onChange: (event: { target: { value: string } }) => updateRole(index, key, event.target.value),
            }),
        error ? React.createElement('span', { className: 'weave-field-error' }, error) : null,
      )
    }

    const roleSelect = (index: number, label: string, key: keyof RoleDraft, options: string[], emptyLabel = '默认') =>
      React.createElement(
        'label',
        { className: 'weave-field' },
        React.createElement('span', null, label),
        React.createElement(
          'select',
          { value: roles[index]?.[key] ?? '', onChange: (event: { target: { value: string } }) => updateRole(index, key, event.target.value) },
          React.createElement('option', { value: '' }, emptyLabel),
          ...options.map((value: string) => React.createElement('option', { key: value, value }, value)),
        ),
      )

    const roleAdvancedFields = (index: number): Array<React.ReactElement> => {
      const executorId = roles[index]?.executor ?? ''
      const caps = executors.find((item: ExecutorInfo) => item.id === executorId)?.capabilities as
        | { thoughtControl?: boolean; modeControl?: boolean; thoughtLevels?: unknown[]; modes?: unknown[] }
        | undefined
      const toValues = (list: unknown[] | undefined): string[] =>
        Array.isArray(list)
          ? list.map((item) => typeof item === 'string' ? item : String((item as SelectOption).value ?? ''))
          : []
      const thoughtValues = toValues(caps?.thoughtLevels)
      const modeValues = toValues(caps?.modes)
      const thoughtSupported = caps?.thoughtControl === true || executorId === 'spawn' || executorId === 'fork'
      const modeSupported = caps?.modeControl === true
      const disabledSelect = (label: string, unsupported: string): React.ReactElement =>
        React.createElement(
          'label',
          { className: 'weave-field' },
          React.createElement('span', null, label),
          React.createElement(
            'select',
            { className: 'weave-control', disabled: true, value: '' },
            React.createElement('option', { value: '' }, unsupported),
          ),
        )
      return [
        thoughtSupported
          ? roleSelect(index, '思考深度', 'thoughtLevel', thoughtValues.length ? thoughtValues : ['off', 'high', 'max'])
          : disabledSelect('思考深度', '继承当前会话默认（DSH 子代理不支持单独设置）'),
        modeSupported
          ? roleSelect(index, '模式', 'mode', modeValues.length ? modeValues : ['plan', 'build', 'edit', 'yolo', 'auto'])
          : disabledSelect('模式', '继承当前会话默认（DSH 子代理不支持单独设置）'),
      ]
    }

    const roleFallbackLinkedFields = (index: number): Array<React.ReactElement> => {
      if (providerItems.length === 0) {
        return [
          roleField(index, '备用推理服务', 'fallbackProvider', '可选（无目录时手填）'),
          roleField(index, '备用模型', 'fallbackModel', '可选（无目录时手填）'),
        ]
      }
      const provider = roles[index]?.fallbackProvider ?? ''
      const models = modelsByProvider[provider] ?? []
      return [
        React.createElement(
          'label',
          { className: 'weave-field' },
          React.createElement('span', null, '备用推理服务'),
          React.createElement(
            'select',
            {
              className: 'weave-control',
              'data-testid': `fallback-provider-select-${index}`,
              value: provider,
              onChange: (event: { target: { value: string } }) => {
                const value = event.target.value
                const next = modelsByProvider[value] ?? []
                const current = roles[index]?.fallbackModel ?? ''
                updateRole(index, 'fallbackProvider', value)
                updateRole(index, 'fallbackModel', next.includes(current) ? current : (next[0] ?? ''))
              },
            },
            React.createElement('option', { value: '' }, '不启用'),
            ...providerItems.map((value: string) => React.createElement('option', { key: value, value }, value)),
          ),
        ),
        React.createElement(
          'label',
          { className: 'weave-field' },
          React.createElement('span', null, '备用模型'),
          React.createElement(
            'select',
            {
              className: 'weave-control',
              'data-testid': `fallback-model-select-${index}`,
              value: roles[index]?.fallbackModel ?? '',
              disabled: provider === '',
              onChange: (event: { target: { value: string } }) => updateRole(index, 'fallbackModel', event.target.value),
            },
            React.createElement('option', { value: '' }, provider === '' ? '先选备用推理服务' : '不启用'),
            ...models.map((value: string) => React.createElement('option', { key: value, value }, value)),
          ),
        ),
      ]
    }

    const roleLinkedModelFields = (index: number): Array<React.ReactElement> => {
      if (providerItems.length === 0) {
        return [
          roleField(index, '推理服务覆盖', 'provider', '可选（无目录时手填）'),
          roleField(index, '模型覆盖', 'model', '可选（无目录时手填）'),
        ]
      }
      const provider = roles[index]?.provider ?? ''
      const models = modelsByProvider[provider] ?? []
      return [
        React.createElement(
          'label',
          { className: 'weave-field' },
          React.createElement('span', null, '推理服务覆盖'),
          React.createElement(
            'select',
            {
              className: 'weave-control',
              'data-testid': `provider-select-${index}`,
              value: provider,
              onChange: (event: { target: { value: string } }) => {
                const value = event.target.value
                const next = modelsByProvider[value] ?? []
                const current = roles[index]?.model ?? ''
                updateRole(index, 'provider', value)
                updateRole(index, 'model', next.includes(current) ? current : (next[0] ?? ''))
              },
            },
            React.createElement('option', { value: '' }, '继承默认'),
            ...providerItems.map((value: string) => React.createElement('option', { key: value, value }, value)),
          ),
        ),
        React.createElement(
          'label',
          { className: 'weave-field' },
          React.createElement('span', null, '模型覆盖'),
          React.createElement(
            'select',
            {
              className: 'weave-control',
              'data-testid': `model-select-${index}`,
              value: roles[index]?.model ?? '',
              disabled: provider === '',
              onChange: (event: { target: { value: string } }) => updateRole(index, 'model', event.target.value),
            },
            React.createElement('option', { value: '' }, provider === '' ? '请先选择推理服务' : '继承默认'),
            ...models.map((value: string) => React.createElement('option', { key: value, value }, value)),
          ),
        ),
      ]
    }


    // Esc 关闭最上层浮层（优先级：删除确认 > 设默认确认 > 编辑器 > 抽屉）。
    useEffect(() => {
      if (!deleteTarget && !confirmDefaultTarget && detailTeamId === null && editorMode === null && !confirmDiscard) return
      const handler = (): void => {
        if (confirmDiscard) {
          setConfirmDiscard(false)
          return
        }
        if (deleteTarget) {
          setDeleteTarget(null)
          return
        }
        if (confirmDefaultTarget) {
          setConfirmDefaultTarget(null)
          return
        }
        if (detailTeamId !== null) {
          setDetailTeamId(null)
          return
        }
        closeEditor()
      }
      window.addEventListener('keydown', handler as never)
      return () => window.removeEventListener('keydown', handler as never)
    }, [deleteTarget, confirmDefaultTarget, detailTeamId, editorMode, confirmDiscard])

    const editorBusy = creator.busy || loader.busy
    const otherDefaultRow = teams.find(
      (team: TeamSummaryRow) => String(team.team_id ?? '') !== editingTeamId && team.default === true,
    )

    /** 高级配置数值/文本输入（type=number；宽松解析在提交时统一兜底）。 */
    const ADV_ERROR_KEYS: Record<string, string> = {
      knowledgeMaxEntries: 'advancedKnowledgeMaxEntries',
      knowledgePerEntry: 'advancedKnowledgePerEntry',
      knowledgeTotalChars: 'advancedKnowledgeTotalChars',
      feedbackTimeoutSeconds: 'advancedFeedbackTimeoutSeconds',
      maxRevisions: 'advancedMaxRevisions',
      reopenWindowSeconds: 'advancedReopenWindowSeconds',
    }
    const advNumField = (
      label: string,
      key: keyof AdvancedDraft,
      value: string,
      hint: string,
    ): React.ReactElement => {
      const errorKey = ADV_ERROR_KEYS[String(key)] ?? ''
      const error = errorKey !== '' ? fieldErrors[errorKey] : undefined
      return React.createElement(
        'label',
        { className: 'weave-field', key, 'data-invalid': error ? 'true' : undefined },
        React.createElement('span', null, label),
        React.createElement('input', {
          type: 'number',
          value,
          onChange: (event: { target: { value: string } }) => setAdvancedField(key, event.target.value),
        }),
        React.createElement('span', { className: 'weave-adv-note' }, hint),
        error ? React.createElement('span', { className: 'weave-field-error' }, error) : null,
      )
    }

    /** 卡片/抽屉共用的角色只读块（紧凑卡片 + 可折叠人格）。 */
    /** 详情抽屉的队员卡片：点击载入编辑器并只展开该成员（其余折叠）。 */
    const roleDetailBlocks = (teamIdForKeys: string, rows?: Json[]): Array<React.ReactElement> =>
      Array.isArray(rows) && rows.length > 0
        ? rows.map((role: Json, roleIndex: number) => {
            const roleId = String(role.id ?? '') || `role-${roleIndex + 1}`
            const model = String(role.model ?? '')
            const stages = Array.isArray(role.stages) ? (role.stages as string[]).join(', ') : ''
            return React.createElement(
              'div',
              {
                className: 'weave-member',
                key: `${teamIdForKeys}-member-${roleIndex}`,
                'data-testid': `team-member-card-${roleId}`,
                'data-clickable': 'true',
                title: '点击修改该成员',
                style: { position: 'relative', paddingRight: 26 },
                onClick: () => void openMemberEditor(teamIdForKeys, roleIndex),
              },
              React.createElement('button', {
                key: 'member-delete-x',
                className: 'weave-close',
                type: 'button',
                title: '删除该队员',
                style: { position: 'absolute', top: 2, right: 2, width: 22, height: 22, fontSize: 14 },
                onClick: (event: { stopPropagation(): void }) => {
                  event.stopPropagation()
                  setDeleteMember({ teamId: teamIdForKeys, name: String(role.name ?? roleId), roleIndex })
                },
              }, '×'),
              React.createElement('b', null, String(role.name ?? roleId)),
              React.createElement(
                'span',
                { className: 'weave-muted', style: { fontSize: '11px' } },
                model === '' ? executorLabel(String(role.executor ?? '')) : `${executorLabel(String(role.executor ?? ''))} · ${model}`,
              ),
              React.createElement(
                'span',
                { className: 'weave-muted', style: { fontSize: '11px' } },
                `阶段：${stages === '' ? '默认' : stages} · 点击修改`,
              ),
            )
          })
        : [React.createElement('span', { key: 'no-roles', className: 'weave-muted' }, '该团队暂无角色')]

    const detailRows =
      detailTeamId !== null ? teams.find((team: TeamSummaryRow) => String(team.team_id ?? '') === detailTeamId) : undefined

    return React.createElement(
      'section',
      { className: 'weave-page', 'data-testid': 'page-teams' },
      React.createElement('h1', null, '团队'),
      Note({
        text: snapshot.loading
          ? '正在加载...'
          : snapshot.error ||
            loader.note ||
            creator.note ||
            defaulter.note ||
            remover.note ||
            '任务只在会话内面板展示；本页仅管理团队配置。创建或编辑后会写入 ~/.dsh/teams 并通过完整校验。',
      }),
      snapshot.error ? Note({ text: snapshot.error, kind: 'error' }) : null,
      creator.ok === false || loader.ok === false || remover.ok === false || defaulter.ok === false
        ? Note({ text: creator.note || loader.note || remover.note || defaulter.note, kind: 'error' })
        : null,

      /* ---- 工具行 + 团队卡片网格 ---- */
      React.createElement(
        'div',
        { className: 'weave-toolbar-row' },
        React.createElement(
          'button',
          { className: 'weave-button', type: 'button', 'data-testid': 'team-new-btn', onClick: openCreate },
          '＋ 新建团队',
        ),
        React.createElement(
          'button',
          {
            className: 'weave-button weave-button-secondary',
            type: 'button',
            onClick: () => void snapshot.refresh(),
            disabled: snapshot.loading,
          },
          '刷新',
        ),
      ),
      snapshot.loading && teams.length === 0
        ? React.createElement('div', { className: 'weave-muted' }, '正在加载团队...')
        : React.createElement(
            'div',
            { className: 'weave-grid' },
            ...(teams.length
              ? teams.map((team: TeamSummaryRow) => {
                  const id = String(team.team_id ?? '')
                  return React.createElement(
                    'article',
                    { className: 'weave-list-item', key: id, 'data-testid': `team-card-${id}` },
                    React.createElement(
                      'div',
                      { className: 'weave-list-head' },
                      React.createElement('b', null, String(team.name ?? id)),
                      team.default === true
                        ? React.createElement(Pill, { label: '默认', tone: 'good', title: '未绑定会话自动启用本团队' })
                        : null,
                      React.createElement(Pill, { label: id, title: `团队 ID：${id}` }),
                    ),
                    typeof team.description === 'string' && team.description.trim() !== ''
                      ? React.createElement(
                          'span',
                          { className: 'weave-muted', 'data-testid': `team-description-${id}` },
                          team.description,
                        )
                      : null,
                    React.createElement(
                      'span',
                      { className: 'weave-muted' },
                      `${Array.isArray(team.roles) ? team.roles.length : 0} 个角色 · ${
                        Array.isArray(team.roles)
                          ? team.roles
                              .map((role: Json) => `${String(role.id ?? '?')}/${String(role.executor ?? '?')}`)
                              .join(', ')
                          : ''
                      }`,
                    ),
                    React.createElement(
                      'div',
                      { className: 'weave-card-actions' },
                      React.createElement(
                        'button',
                        {
                          className: 'weave-button weave-button-secondary weave-button-small',
                          type: 'button',
                          'data-testid': `team-detail-${id}`,
                          disabled: loader.busy,
                          onClick: () => setDetailTeamId(id),
                        },
                        '详情',
                      ),
                      team.default === true
                        ? React.createElement(
                            'button',
                            {
                              className: 'weave-button weave-button-secondary weave-button-small',
                              type: 'button',
                              disabled: true,
                              title: '已是默认团队',
                            },
                            '默认团队',
                          )
                        : React.createElement(
                            'button',
                            {
                              className: 'weave-button weave-button-secondary weave-button-small',
                              type: 'button',
                              'data-testid': `team-set-default-${id}`,
                              disabled: defaulter.busy,
                              onClick: () => requestSetDefault(id),
                            },
                            '设为默认',
                          ),
                      React.createElement(
                        'button',
                        {
                          className: 'weave-button weave-button-small weave-button-danger',
                          type: 'button',
                          'data-testid': `team-delete-${id}`,
                          disabled: remover.busy,
                          onClick: () => setDeleteTarget({ id, name: String(team.name ?? id) }),
                        },
                        '删除',
                      ),
                    ),
                  )
                })
              : [
                  EmptyState({
                    title: '暂无可用团队',
                    reason: snapshot.error
                      ? `加载失败：${snapshot.error}`
                      : '点右上角「＋ 新建团队」开始；若已有配置，请检查执行器注册状态。',
                  }),
                ]),
          ),

      /* ---- 详情抽屉 ---- */
      detailRows
        ? React.createElement(
            'div',
            {
              className: 'weave-overlay',
              'data-testid': `team-drawer-${String(detailRows.team_id ?? '')}`,
              onClick: (event: { target: unknown; currentTarget: unknown }) => {
                if (event.target === event.currentTarget) setDetailTeamId(null)
              },
            },
            React.createElement(
              'div',
              { className: 'weave-dialog weave-dialog-wide' },
              React.createElement(
                'div',
                { className: 'weave-list-head' },
                React.createElement('b', null, String(detailRows.name ?? detailTeamId)),
                detailRows.default === true ? React.createElement(Pill, { label: '默认', tone: 'good' }) : null,
                React.createElement(Pill, { label: String(detailRows.team_id ?? '') }),
                React.createElement(
                  'button',
                  { className: 'weave-close', type: 'button', style: { marginLeft: 'auto' }, onClick: () => setDetailTeamId(null) },
                  '×',
                ),
              ),
              React.createElement(
                'span',
                { className: 'weave-muted' },
                `ID：${String(detailRows.team_id ?? '')}${detailRows.default === true ? ' · 未绑定的会话自动启用本团队' : ''}`,
              ),
              typeof detailRows.description === 'string' && detailRows.description.trim() !== ''
                ? React.createElement(
                    'p',
                    { 'data-testid': `team-detail-description-${String(detailRows.team_id ?? '')}` },
                    detailRows.description,
                  )
                : null,
              React.createElement(
                'span',
                { className: 'weave-adv-note' },
                '每名成员同一时间只执行一个任务；点击成员卡片可修改其配置。',
              ),
              React.createElement(
                'div',
                { className: 'weave-members', 'data-testid': 'team-member-cards' },
                ...roleDetailBlocks(String(detailRows.team_id ?? ''), detailRows.roles),
              ),
              React.createElement(
                'div',
                { className: 'weave-drawer-foot' },
                React.createElement(
                  'button',
                  {
                    className: 'weave-button weave-button-secondary',
                    type: 'button',
                    'data-testid': `team-add-member-${String(detailRows.team_id ?? '')}`,
                    disabled: loader.busy,
                    onClick: () => void openAddMember(String(detailRows.team_id ?? '')),
                  },
                  '＋ 添加队员',
                ),
                React.createElement(
                  'button',
                  {
                    className: 'weave-button weave-button-secondary',
                    type: 'button',
                    disabled: loader.busy,
                    onClick: () => void loadTeam(String(detailRows.team_id ?? '')),
                  },
                  '编辑团队',
                ),
                detailRows.default !== true
                  ? React.createElement(
                      'button',
                      {
                        className: 'weave-button weave-button-secondary',
                        type: 'button',
                        disabled: defaulter.busy,
                        onClick: () => requestSetDefault(String(detailRows.team_id ?? '')),
                      },
                      '设为默认',
                    )
                  : null,

                React.createElement(
                  'button',
                  { className: 'weave-button weave-button-secondary', type: 'button', onClick: () => setDetailTeamId(null) },
                  '关闭',
                ),
              ),
            ),
          )
        : null,

      /* ---- 编辑器弹层（新建/编辑同一组件、显式分模态） ---- */
      editorMode !== null && !(editorMode === 'edit' && loader.busy && editBase === null)
        ? React.createElement(
            'form',
            {
              className: 'weave-overlay',
              style: { justifyContent: 'center', alignItems: 'center', overflowY: 'auto', padding: '16px' },
              onSubmit: (event: { preventDefault(): void }) => void submit(event),
              onClick: (event: { target: unknown; currentTarget: unknown }) => {
                if (event.target === event.currentTarget) closeEditor()
              },
            },
            React.createElement(
              'div',
              {
                className: 'weave-dialog weave-dialog-wide',
                role: 'dialog',
                'aria-modal': 'true',
                'data-testid': 'team-editor',
              },
              React.createElement(
                'b',
                { className: 'weave-dialog-title' },
                memberFocus !== null
                  ? memberFocus === -1
                    ? '添加队员'
                    : `编辑队员：${roles[memberFocus]?.name?.trim() || roles[memberFocus]?.id?.trim() || '队员'}`
                  : editorMode === 'edit'
                    ? `正在编辑：${editingTeamId}`
                    : '新建团队',
              ),
              creator.ok === false ? Note({ text: creator.note, kind: 'error' }) : null,
              loader.ok === false ? Note({ text: loader.note, kind: 'error' }) : null,
              React.createElement(
                'div',
                { className: 'weave-role-grid', style: memberFocus !== null ? { display: 'none' } : undefined },
                React.createElement(
                  'label',
                  { className: 'weave-field', 'data-invalid': fieldErrors.teamId ? 'true' : undefined },
                  React.createElement('span', null, '团队 ID'),
                  React.createElement('input', {
                    'data-testid': 'team-id-input',
                    value: teamId,
                    placeholder: 'my-team',
                    disabled: editorMode === 'edit',
                    title: editorMode === 'edit' ? '团队 ID 创建后不可变' : '小写字母、数字与 . _ -',
                    onChange: (event: { target: { value: string } }) => {
                      setTeamId(event.target.value)
                      clearFieldError('teamId')
                    },
                  }),
                  editorMode === 'create'
                    ? React.createElement(
                        'span',
                        { className: 'weave-adv-note' },
                        `保存为：${slugifyTeamId(teamId) || slugifyTeamId(name) || 'team'}`,
                      )
                    : null,
                  fieldErrors.teamId
                    ? React.createElement('span', { className: 'weave-field-error' }, fieldErrors.teamId)
                    : null,
                ),
                React.createElement(
                  'label',
                  { className: 'weave-field', 'data-invalid': fieldErrors.name ? 'true' : undefined },
                  React.createElement('span', null, '名称'),
                  React.createElement('input', {
                    'data-testid': 'team-name-input',
                    value: name,
                    placeholder: '我的团队',
                    onChange: (event: { target: { value: string } }) => {
                      setName(event.target.value)
                      clearFieldError('name')
                    },
                    onBlur: () => {
                      if (editorMode === 'create' && teamId.trim() === '' && name.trim() !== '') {
                        setTeamId(slugifyTeamId(name))
                      }
                    },
                  }),
                  fieldErrors.name
                    ? React.createElement('span', { className: 'weave-field-error' }, fieldErrors.name)
                    : null,
                ),
                React.createElement(
                  'label',
                  { className: 'weave-field' },
                  React.createElement('span', null, '团队简介'),
                  React.createElement('textarea', {
                    className: 'weave-control',
                    rows: 2,
                    value: description,
                    placeholder: '简要说明团队定位、职责或协作方式（会话启用团队时展示）',
                    'data-testid': 'team-description-input',
                    onChange: (event: { target: { value: string } }) => setDescription(event.target.value),
                  }),
                ),
              ),
              React.createElement(
                'label',
                { className: 'weave-checkrow', style: memberFocus !== null ? { display: 'none' } : undefined },
                React.createElement('input', {
                  type: 'checkbox',
                  'data-testid': 'form-default-toggle',
                  checked: defaultFlag,
                  onChange: (event: { target: { checked: boolean } }) => setDefaultFlag(event.target.checked),
                }),
                React.createElement('span', null, '设为默认团队（未绑定会话自动启用）'),
              ),
              defaultFlag && otherDefaultRow
                ? React.createElement(
                    'span',
                    { className: 'weave-field-error' },
                    `将取代当前默认「${String(otherDefaultRow.name ?? otherDefaultRow.team_id ?? '')}」，保存后会取消其默认标记`,
                  )
                : memberFocus === null ? React.createElement('span', { className: 'weave-adv-note' }, defaultFlag ? '该团队将成为全局唯一默认。' : '') : null,
              React.createElement(
                'div',
                { className: 'weave-list-head', style: memberFocus !== null ? { display: 'none' } : undefined },
                React.createElement('b', null, `角色（${roles.length}）`),
                React.createElement(
                  'button',
                  {
                    className: 'weave-button weave-button-secondary weave-button-small',
                    type: 'button',
                    onClick: addRole,
                    'data-testid': 'team-add-role',
                  },
                  '＋ 添加角色',
                ),
              ),
              ...roles.map((_draft: RoleDraft, index: number) => {
                if (memberFocus !== null && index !== memberFocus && !(memberFocus === -1 && index === roles.length - 1)) return null
                const expanded = roleOpen[index] !== false
                const summary = `${roles[index]?.name?.trim() || roles[index]?.id?.trim() || `角色 ${index + 1}`}（${executorLabel(roles[index]?.executor)}·模型 ${roles[index]?.model || '继承默认'}）`
                return React.createElement(
                  'fieldset',
                  { className: 'weave-role', key: `role-${index}`, 'data-testid': `role-editor-${index}` },
                  React.createElement(
                    'div',
                    { className: 'weave-role-head' },
                    React.createElement(
                      'button',
                      {
                        className: 'weave-collapse-head',
                        type: 'button',
                        onClick: () =>
                          setRoleOpen((cur: boolean[]) => cur.map((v: boolean, i: number) => (i === index ? !v : v))),
                      },
                      expanded ? '▾' : '▸',
                      React.createElement('span', null, expanded ? `角色 ${index + 1}` : summary),
                    ),
                    roles.length > 1
                      ? React.createElement(
                          'button',
                          {
                            className: 'weave-button weave-button-secondary weave-button-small',
                            type: 'button',
                            onClick: () => {
                              // 「编辑队员」模式（memberFocus）下 removeRole 只改表单本地 state，
                              // 编辑器直接关闭即丢弃、不落盘（submit 是唯一写入路径）；
                              // 必须改走与详情抽屉 × 相同的确认删除链路（team/get → splice → team/import）。
                              if (memberFocus !== null) {
                                const role = roles[index]
                                setMemberFocus(null)
                                setEditorMode(null)
                                setDeleteMember({
                                  teamId: detailTeamId ?? '',
                                  name: String(role?.name?.trim() || role?.id?.trim() || '队员'),
                                  roleIndex: index,
                                })
                                return
                              }
                              removeRole(index)
                            },
                          },
                          '删除角色',
                        )
                      : null,
                  ),
                  expanded
                    ? React.createElement(
                        'div',
                        null,
                        React.createElement(
                          'div',
                          { className: 'weave-role-grid' },
                          roleField(index, '角色 ID', 'id', 'member'),
                          roleField(index, '名称', 'name', '成员'),
                          roleField(index, '角色倾向', 'bias', 'dev'),
                          React.createElement(
                            'label',
                            { className: 'weave-field' },
                            React.createElement('span', null, '执行器'),
                            React.createElement(
                              'select',
                              {
                                value: roles[index]?.executor ?? '',
                                onChange: (event: { target: { value: string } }) => updateRole(index, 'executor', event.target.value),
                              },
                              ...(executors.length
                                ? executors.map((executor: ExecutorInfo) =>
                                    React.createElement(
                                      'option',
                                      { key: executor.id, value: executor.id, title: executor.id },
                                      executorLabel(executor.id),
                                    ),
                                  )
                                : [React.createElement('option', { key: 'empty', value: '' }, '未发现执行器')]),
                            ),
                          ),
                          roleField(index, '职责标签（逗号分隔，可选）', 'stages', DEFAULT_STAGES),
                          roleField(index, '派发优先级', 'priority', '10'),
                          roleField(index, '擅长方向（逗号分隔）', 'strengths', 'implementation, refactor'),
                        ),
                        roles[index]?.executor === 'zcode'
                          ? React.createElement(
                              'div',
                              { className: 'weave-role-grid', style: { marginTop: 10 } },
                              React.createElement(
                                'label',
                                { className: 'weave-field' },
                                React.createElement('span', null, 'ZCode 模型目录'),
                                React.createElement(
                                  'select',
                                  {
                                    'data-testid': index === 0 ? 'model-select' : `model-select-${index}`,
                                    value: roles[index]?.model ?? '',
                                    onChange: (event: { target: { value: string } }) => updateRole(index, 'model', event.target.value),
                                  },
                                  ...(models.length
                                    ? models.map((option: SelectOption) =>
                                        React.createElement('option', { key: option.value, value: option.value }, option.name ?? option.value),
                                      )
                                    : [React.createElement('option', { key: 'loading', value: '' }, '加载能力目录')]),
                                ),
                              ),
                              roleSelect(index, '思考深度', 'thoughtLevel', thoughts.length ? thoughts : ['off', 'high', 'max']),
                              roleSelect(index, '模式', 'mode', modes.length ? modes : ['plan', 'build', 'edit', 'yolo', 'auto']),
                              ...roleFallbackLinkedFields(index),
                            )
                          : React.createElement(
                              'div',
                              { className: 'weave-role-grid', style: { marginTop: 10 } },
                              ...roleLinkedModelFields(index),
                              ...roleAdvancedFields(index),
                              ...roleFallbackLinkedFields(index),
                            ),
                        React.createElement('div', { style: { marginTop: 10 } }, roleField(index, '角色提示词', 'personality', '', 'textarea', 9)),
                      )
                    : null,
                )
              }),
              /* ---- 高级配置（折叠区；默认值 = 原硬编码；编辑模式回显 yaml 实值） ---- */
              React.createElement(
                'div',
                { className: 'weave-collapse', style: memberFocus !== null ? { display: 'none' } : undefined },
                React.createElement(
                  'button',
                  { className: 'weave-collapse-head', type: 'button', onClick: () => setAdvancedOpen(!advancedOpen) },
                  React.createElement('span', null, advancedOpen ? '▾ 高级配置' : '▸ 高级配置'),
                  React.createElement('span', { className: 'weave-collapse-mark', title: '任务拆解 / 知识注入 / 反馈策略' }, '3 段'),
                ),
                advancedOpen
                  ? React.createElement(
                      'div',
                      { className: 'weave-dialog-body' },
                      React.createElement(
                        'div',
                        { className: 'weave-adv-group' },
                        React.createElement('b', null, '任务拆解'),
                        React.createElement('span', { className: 'weave-adv-note' }, '匹配规则（matchers）保持团队原配置不变，此处不提供编辑。'),
                        React.createElement(
                          'div',
                          { className: 'weave-role-grid' },
                          React.createElement(
                            'label',
                            { className: 'weave-field' },
                            React.createElement('span', null, '默认难度（未命中匹配时）'),
                            React.createElement(
                              'select',
                              {
                                value: advanced.difficulty,
                                onChange: (event: { target: { value: string } }) => setAdvancedField('difficulty', event.target.value),
                              },
                              ...['easy', 'medium', 'hard', 'critical'].map((level) =>
                                React.createElement('option', { key: level, value: level }, level),
                              ),
                            ),
                          ),
                        ),
                        React.createElement(
                          'div',
                          { className: 'weave-role-grid' },
                          (['templatesEasy', 'templatesMedium', 'templatesHard', 'templatesCritical'] as const).map((key) =>
                            React.createElement(
                              'label',
                              { className: 'weave-field', key },
                              React.createElement('span', null, `DAG 模板 · ${key.replace('templates', '').toLowerCase()}`),
                              React.createElement('input', {
                                value: advanced[key],
                                onChange: (event: { target: { value: string } }) => setAdvancedField(key, event.target.value),
                              }),
                            ),
                          ),
                        ),
                      ),
                      React.createElement(
                        'div',
                        { className: 'weave-adv-group' },
                        React.createElement('b', null, '知识注入'),
                        React.createElement(
                          'div',
                          { className: 'weave-role-grid' },
                          advNumField('单次最多注入条数', 'knowledgeMaxEntries', advanced.knowledgeMaxEntries, '3–20 条'),
                          advNumField('单条最长字符', 'knowledgePerEntry', advanced.knowledgePerEntry, '字符数'),
                          advNumField('注入总长上限', 'knowledgeTotalChars', advanced.knowledgeTotalChars, '字符数'),
                          React.createElement(
                            'label',
                            { className: 'weave-field' },
                            React.createElement('span', null, '优先级策略'),
                            React.createElement(
                              'select',
                              {
                                value: advanced.priority,
                                onChange: (event: { target: { value: string } }) => setAdvancedField('priority', event.target.value),
                              },
                              React.createElement('option', { value: 'freshness_first' }, 'freshness_first（新知识优先）'),
                            ),
                          ),
                        ),
                      ),
                      React.createElement(
                        'div',
                        { className: 'weave-adv-group' },
                        React.createElement('b', null, '反馈策略'),
                        React.createElement(
                          'div',
                          { className: 'weave-role-grid' },
                          advNumField('反馈等待超时（秒）', 'feedbackTimeoutSeconds', advanced.feedbackTimeoutSeconds, '秒'),
                          advNumField('最多返工次数', 'maxRevisions', advanced.maxRevisions, '次'),
                          advNumField('重开窗口（秒）', 'reopenWindowSeconds', advanced.reopenWindowSeconds, '秒'),
                        ),
                      ),
                    )
                  : React.createElement(
                      'span',
                      { className: 'weave-adv-note' },
                      editorMode === 'edit' ? '展开后编辑任务拆解 / 知识注入 / 反馈策略（当前为 YAML 实际值）。' : '使用推荐默认值；展开后可调整。',
                    ),
              ),
              React.createElement(
                'div',
                { className: 'weave-dialog-actions' },
                React.createElement(
                  'button',
                  {
                    className: 'weave-button weave-button-secondary',
                    type: 'button',
                    disabled: creator.busy,
                    onClick: closeEditor,
                  },
                  '取消',
                ),
                React.createElement(
                  'button',
                  {
                    className: 'weave-button',
                    type: 'submit',
                    disabled: editorBusy,
                    'data-testid': editorMode === 'edit' ? 'team-edit-submit' : 'team-create-submit',
                  },
                  editorBusy
                    ? '保存中'
                    : `${editorMode === 'edit' ? '保存修改' : '创建团队'}（包含 ${roles.length} 个角色）`,
                ),
              ),
            ),
          )
        : null,

      /* ---- 编辑弃改确认 ---- */
      confirmDiscard
        ? React.createElement(
            'div',
            {
              className: 'weave-overlay',
              'data-testid': 'confirm-discard-team',
              onClick: (event: { target: unknown; currentTarget: unknown }) => {
                if (event.target === event.currentTarget) setConfirmDiscard(false)
              },
            },
            React.createElement(
              'div',
              { className: 'weave-dialog', role: 'dialog', 'aria-modal': 'true' },
              React.createElement('b', { className: 'weave-dialog-title' }, '放弃修改？'),
              React.createElement(
                'p',
                { style: { margin: 0, fontSize: 13, lineHeight: '20px' } },
                '未保存的更改将丢失。',
              ),
              React.createElement(
                'div',
                { className: 'weave-dialog-actions' },
                React.createElement(
                  'button',
                  {
                    className: 'weave-button weave-button-secondary',
                    type: 'button',
                    'data-testid': 'confirm-discard-cancel',
                    autoFocus: true,
                    onClick: () => setConfirmDiscard(false),
                  },
                  '继续编辑',
                ),
                React.createElement(
                  'button',
                  {
                    className: 'weave-button weave-button-danger',
                    type: 'button',
                    'data-testid': 'confirm-discard-confirm',
                    onClick: () => {
                      setConfirmDiscard(false)
                      setFieldErrors({})
                      setEditorMode(null)
                    },
                  },
                  '放弃修改',
                ),
              ),
            ),
          )
        : null,

      /* ---- 删除队员二次确认 ---- */
      deleteMember
        ? React.createElement(
            'div',
            {
              className: 'weave-overlay',
              'data-testid': 'confirm-delete-member',
              onClick: (event: { target: unknown; currentTarget: unknown }) => {
                if (event.target === event.currentTarget) setDeleteMember(null)
              },
            },
            React.createElement(
              'div',
              { className: 'weave-dialog', role: 'dialog', 'aria-modal': 'true' },
              React.createElement('b', { className: 'weave-dialog-title' }, '删除队员'),
              React.createElement(
                'p',
                { style: { margin: 0, fontSize: 13, lineHeight: '20px' } },
                `即将从团队「${deleteMember.teamId}」移除队员「${deleteMember.name}」，其配置将从团队配置中删除。`,
              ),
              // 删除失败（如「团队至少保留一名队员，无法删除」、team/import 失败）必须可见，
              // 否则弹窗原样保留、无任何反馈，表现为“点了没反应”。
              memberRemover.ok === false ? Note({ text: memberRemover.note, kind: 'error' }) : null,
              React.createElement(
                'div',
                { className: 'weave-dialog-actions' },
                React.createElement(
                  'button',
                  {
                    className: 'weave-button weave-button-secondary',
                    type: 'button',
                    'data-testid': 'confirm-delete-member-cancel',
                    autoFocus: true,
                    disabled: memberRemover.busy,
                    onClick: () => setDeleteMember(null),
                  },
                  '取消',
                ),
                React.createElement(
                  'button',
                  {
                    className: 'weave-button weave-button-danger',
                    type: 'button',
                    disabled: memberRemover.busy,
                    onClick: () => void confirmDeleteMember(),
                  },
                  '确认删除',
                ),
              ),
            ),
          )
        : null,

      /* ---- 删除二次确认（应用内弹窗替代 window.confirm） ---- */
      deleteTarget
        ? React.createElement(
            'div',
            {
              className: 'weave-overlay',
              'data-testid': 'confirm-delete-team',
              onClick: (event: { target: unknown; currentTarget: unknown }) => {
                if (event.target === event.currentTarget) setDeleteTarget(null)
              },
            },
            React.createElement(
              'div',
              { className: 'weave-dialog', role: 'dialog', 'aria-modal': 'true' },
              React.createElement('b', { className: 'weave-dialog-title' }, '删除团队'),
              React.createElement(
                'p',
                { style: { margin: 0, fontSize: 13, lineHeight: '20px' } },
                `即将删除团队「${deleteTarget.name}」（${deleteTarget.id}）。其 YAML 配置文件会被一并移除，且不可恢复。`,
              ),
              React.createElement(
                'span',
                { className: 'weave-muted' },
                '如有会话绑定本团队，这些会话将在下次解析时回落到默认团队或提示重新选择。',
              ),
              React.createElement(
                'div',
                { className: 'weave-dialog-actions' },
                React.createElement(
                  'button',
                  {
                    className: 'weave-button weave-button-secondary',
                    type: 'button',
                    'data-testid': 'confirm-delete-team-cancel',
                    autoFocus: true,
                    disabled: remover.busy,
                    onClick: () => setDeleteTarget(null),
                  },
                  '取消',
                ),
                React.createElement(
                  'button',
                  {
                    className: 'weave-button weave-button-danger',
                    type: 'button',
                    'data-testid': 'confirm-delete-team-danger',
                    disabled: remover.busy,
                    onClick: () => void confirmRemove(),
                  },
                  remover.busy ? '删除中' : '确认删除',
                ),
              ),
            ),
          )
        : null,

      /* ---- 设为默认互斥确认 ---- */
      confirmDefaultTarget
        ? React.createElement(
            'div',
            {
              className: 'weave-overlay',
              'data-testid': 'confirm-set-default',
              onClick: (event: { target: unknown; currentTarget: unknown }) => {
                if (event.target === event.currentTarget) setConfirmDefaultTarget(null)
              },
            },
            React.createElement(
              'div',
              { className: 'weave-dialog', role: 'dialog', 'aria-modal': 'true' },
              React.createElement('b', { className: 'weave-dialog-title' }, '设为默认团队'),
              React.createElement(
                'p',
                { style: { margin: 0, fontSize: 13, lineHeight: '20px' } },
                `将取消「${String(otherDefaultRow?.name ?? otherDefaultRow?.team_id ?? '')}」的默认标记，未绑定的会话此后自动启用「${confirmDefaultTarget.name}」。`,
              ),
              React.createElement(
                'div',
                { className: 'weave-dialog-actions' },
                React.createElement(
                  'button',
                  {
                    className: 'weave-button weave-button-secondary',
                    type: 'button',
                    'data-testid': 'confirm-set-default-cancel',
                    autoFocus: true,
                    onClick: () => setConfirmDefaultTarget(null),
                  },
                  '取消',
                ),
                React.createElement(
                  'button',
                  {
                    className: 'weave-button',
                    type: 'button',
                    'data-testid': 'confirm-set-default-confirm',
                    disabled: defaulter.busy,
                    onClick: () => void runSetDefault(confirmDefaultTarget.id),
                  },
                  '设为默认',
                ),
              ),
            ),
          )
        : null,
    )
  }

  /* ------------------------------ 任务依赖图（t9） ------------------------------ */

  // 紧凑 DAG 几何（对齐参照物 ActivityPanel / 宿主 dag-panel compactDagLayout）：
  // 节点固定 92×30，列间距 26、行间距 8；画布=内容精确尺寸（不缩放不铺满），横向溢出走滚动。
  const DAG_NODE_W = 92
  const DAG_NODE_H = 30
  const DAG_COLUMN_GAP = 26
  const DAG_ROW_GAP = 8

  /**
   * 紧凑左→右 DAG 布局：列 = 依赖深度 stage（computeDagLevels，edges 与 dependencies
   * 取并集），行 = stage 内任务 id 稳定排序；边为水平出入节点中线的短柄三次贝塞尔
   * （M x1 y1 C x1+14 y1, x2-14 y2, x2 y2）。与宿主 dag-panel.tsx compactDagLayout 同构
   * 的单文件移植（bundle 禁 import）。
   */
  function compactDagLayout(tasks: TaskRow[], edges: Array<{ from: string; to: string }>): {
    width: number
    height: number
    nodes: Array<{ task: TaskRow; id: string; x: number; y: number }>
    paths: Array<{ from: string; to: string; path: string }>
  } {
    const levels = computeDagLevels(tasks, edges)
    const byLevel = new Map<number, TaskRow[]>()
    for (const task of tasks) {
      const id = String(task.id ?? '')
      if (id === '') continue
      const lv = levels.get(id) ?? 0
      const group = byLevel.get(lv) ?? []
      group.push(task)
      byLevel.set(lv, group)
    }
    const stages = [...byLevel.entries()].sort((a, b) => a[0] - b[0])
    const positions = new Map<string, { x: number; y: number }>()
    const nodes: Array<{ task: TaskRow; id: string; x: number; y: number }> = []
    for (const [column, [, group]] of stages.entries()) {
      const ordered = group.slice().sort((left: TaskRow, right: TaskRow) =>
        String(left.id ?? '').localeCompare(String(right.id ?? ''), 'en', { numeric: true }))
      for (const [row, task] of ordered.entries()) {
        const id = String(task.id ?? '')
        const x = column * (DAG_NODE_W + DAG_COLUMN_GAP)
        const y = row * (DAG_NODE_H + DAG_ROW_GAP)
        positions.set(id, { x, y })
        nodes.push({ task, id, x, y })
      }
    }
    const rows = Math.max(1, ...stages.map(([, group]) => group.length))
    const width = stages.length === 0
      ? 0
      : stages.length * DAG_NODE_W + (stages.length - 1) * DAG_COLUMN_GAP
    const height = stages.length === 0
      ? 0
      : rows * DAG_NODE_H + (rows - 1) * DAG_ROW_GAP
    const paths: Array<{ from: string; to: string; path: string }> = []
    for (const edge of edges) {
      const source = positions.get(String(edge.from))
      const target = positions.get(String(edge.to))
      if (!source || !target) continue
      const x1 = source.x + DAG_NODE_W
      const y1 = source.y + DAG_NODE_H / 2
      const x2 = target.x
      const y2 = target.y + DAG_NODE_H / 2
      paths.push({
        from: String(edge.from),
        to: String(edge.to),
        path: `M${x1} ${y1}C${x1 + 14} ${y1},${x2 - 14} ${y2},${x2} ${y2}`,
      })
    }
    return { width, height, nodes, paths }
  }

  /**
   * 聚焦任务的完整上下游链（dependencyFocus）：沿依赖两个方向遍历且环安全。
   * 与宿主 dag-panel.tsx relatedTaskIds 同构的单文件移植（bundle 禁 import）。
   */
  function relatedDagTaskIds(taskId: string, tasks: TaskRow[], edges: Array<{ from: string; to: string }>): ReadonlySet<string> {
    const upstream = new Map<string, string[]>()
    const addUpstream = (from: string, to: string) => {
      if (from === '' || to === '') return
      const arr = upstream.get(to) ?? []
      arr.push(from)
      upstream.set(to, arr)
    }
    for (const task of tasks) {
      for (const dep of task.dependencies ?? []) addUpstream(dep, String(task.id ?? ''))
    }
    for (const edge of edges) addUpstream(edge.from, edge.to)
    if (!upstream.has(taskId) && !tasks.some((task: TaskRow) => String(task.id ?? '') === taskId)) {
      return new Set<string>()
    }
    const dependents = new Map<string, string[]>()
    for (const [to, sources] of upstream) {
      for (const from of sources) {
        const arr = dependents.get(from) ?? []
        arr.push(to)
        dependents.set(from, arr)
      }
    }
    const related = new Set<string>()
    const seenUp = new Set<string>()
    const seenDown = new Set<string>()
    const visitUpstream = (id: string): void => {
      if (seenUp.has(id)) return
      seenUp.add(id)
      related.add(id)
      for (const dep of upstream.get(id) ?? []) visitUpstream(dep)
    }
    const visitDownstream = (id: string): void => {
      if (seenDown.has(id)) return
      seenDown.add(id)
      related.add(id)
      for (const dependent of dependents.get(id) ?? []) visitDownstream(dependent)
    }
    visitUpstream(taskId)
    visitDownstream(taskId)
    return related
  }

  /** 状态 → 节点左边框颜色（与宿主 dag-panel P0 视图同源）。 */
  const DAG_STATUS_COLORS: Record<string, string> = {
    WAITING: '#8c8c8c',
    BLOCKED: '#bfbfbf',
    RUNNING: '#1677ff',
    COMPLETED: '#52c41a',
    AWAITING_FEEDBACK: '#faad14',
    REVISION_RUNNING: '#722ed1',
    CLOSED: '#13c2c2',
    FAILED: '#f5222d',
    BANNED: '#a8071a',
    LOOP_TERMINATED: '#d4380d',
    INTERRUPTED: '#fa8c16',
    CANCELLED: '#595959',
    SKIPPED: '#d9d9d9',
    COOLDOWN: '#6b6b6b',
  }

  /**
   * level = 最长依赖路径深度；依赖取 dag.edges 与 task.dependencies 的并集。
   * 与 src/plugins/weave/dag/dag-panel.tsx 的 computeLevels 同算法的单文件移植（bundle 不允许 import）。
   */
  function computeDagLevels(tasks: TaskRow[], edges: Array<{ from: string; to: string }>): Map<string, number> {
    const upstream = new Map<string, string[]>()
    const addDep = (from: string, to: string) => {
      if (from === '' || to === '') return
      const arr = upstream.get(to) ?? []
      arr.push(from)
      upstream.set(to, arr)
    }
    for (const task of tasks) {
      for (const dep of task.dependencies ?? []) addDep(dep, String(task.id ?? ''))
    }
    for (const edge of edges) addDep(edge.from, edge.to)
    const level = new Map<string, number>()
    const visit = (id: string): number => {
      const cached = level.get(id)
      if (cached !== undefined) return cached
      level.set(id, 0) // 环保护：访问中先置 0
      const deps = upstream.get(id) ?? []
      const lv = deps.length === 0 ? 0 : Math.max(...deps.map(visit)) + 1
      level.set(id, lv)
      return lv
    }
    for (const task of tasks) {
      if (task.id) visit(task.id)
    }
    return level
  }

  interface DagGraphProps {
    dag: TaskDagDetail
    selectedId: string
    /** true = 用户显式点选（selectedId0 非空）；false = 默认派生选中（仅驱动详情区，不做聚焦暗化）。 */
    focusPinned?: boolean
    onSelect: (taskId: string) => void
  }

  /**
   * 紧凑任务依赖图：画布=内容精确尺寸放入滚动容器；点节点（或悬停预览）聚焦上下游链，
   * 关联边高亮、无关节点/边暗化；Esc 解除固定聚焦。默认派生选中不触发暗化——初始
   * 视图与参照物一致为无聚焦干净图。布局与聚焦算法与宿主 dag-panel
   * compactDagLayout/relatedTaskIds 同构（bundle 禁 import，手工移植）。
   */
  function DagGraph({ dag, selectedId, focusPinned = false, onSelect }: DagGraphProps) {
    // 悬停为延迟生效的瞬态聚焦（180ms），固定选中优先——与参照物 dependencyFocus 一致。
    const [hoverId, setHoverId] = useState('')
    const hoverTimer = useRef(null as number | null)
    useEffect(() => () => {
      if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current)
    }, [])
    useEffect(() => {
      const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') onSelect('')
      }
      window.addEventListener('keydown', onKeyDown)
      return () => window.removeEventListener('keydown', onKeyDown)
    }, [onSelect])
    const scheduleHover = (id: string): void => {
      if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current)
      hoverTimer.current = window.setTimeout(() => {
        hoverTimer.current = null
        setHoverId(id)
      }, 180)
    }
    const clearHover = (): void => {
      if (hoverTimer.current !== null) {
        window.clearTimeout(hoverTimer.current)
        hoverTimer.current = null
      }
      setHoverId('')
    }
    if (!dag || !Array.isArray(dag.tasks)) return null
    const tasks = dag.tasks ?? []
    const edges = (dag.edges ?? []).length > 0
      ? dag.edges ?? []
      : tasks.flatMap((task: TaskRow) =>
          (task.dependencies ?? []).map((dep: string) => ({ from: dep, to: String(task.id ?? '') })),
        )
    const focusId = focusPinned && selectedId !== '' ? selectedId : hoverId
    const related = focusId !== '' ? relatedDagTaskIds(focusId, tasks, edges) : null
    const layout = compactDagLayout(tasks, edges)
    return React.createElement(
      'div',
      {
        className: 'weave-dag-wrap',
        'data-testid': 'dag-panel',
        // 画布=内容精确尺寸（宽高写在 weave-dag-canvas 上），wrap 只做横向滚动，
        // 不再做视口 fit（页签体 minHeight 高度预算由外层保留）。
        style: { overflowX: 'auto' },
      },
      React.createElement(
        'div',
        {
          className: 'weave-dag-canvas',
          'data-testid': 'dag-canvas',
          style: { position: 'relative', width: layout.width, height: layout.height, minWidth: '100%' },
        },
        React.createElement(
          'svg',
          {
            className: 'weave-dag-edges',
            width: layout.width,
            height: layout.height,
            'data-testid': 'dag-edges',
          },
          ...layout.paths.map((edge) => {
            const active = related !== null && related.has(edge.from) && related.has(edge.to)
            return React.createElement('path', {
              key: edge.from + '->' + edge.to,
              d: edge.path,
              'data-edge': edge.from + '->' + edge.to,
              'data-active': related !== null ? String(active) : 'false',
              'data-dimmed': related !== null && !active ? 'true' : 'false',
            })
          }),
        ),
        ...layout.nodes.map((node) => {
          const focused = related?.has(node.id) === true
          const dimmed = related !== null && !focused
          const status = String(node.task.status ?? '')
          const assigned = String(node.task.assigned_agent ?? '未分配')
          return React.createElement(
            'div',
            {
              key: node.id,
              className: 'weave-dag-node',
              'data-testid': 'dag-node-' + node.id,
              'data-selected': node.id === selectedId ? 'true' : 'false',
              'data-focused': focused ? 'true' : 'false',
              'data-dimmed': dimmed ? 'true' : 'false',
              onClick: () => onSelect(selectedId === node.id ? '' : node.id),
              onMouseEnter: () => scheduleHover(node.id),
              onMouseLeave: clearHover,
              title: String(node.task.description ?? ''),
              // 参照物同款：left/top/width/height 内联（几何即数据）；字号/配色走 CSS
              style: {
                left: node.x,
                top: node.y,
                width: DAG_NODE_W,
                height: DAG_NODE_H,
              },
            },
            React.createElement('b', null,
              React.createElement('i', { className: 'weave-dag-node-dot', style: { background: DAG_STATUS_COLORS[status] ?? '#8c8c8c' } }),
              shortTaskId(node.id),
            ),
            React.createElement('span', { className: 'weave-muted' },
              React.createElement('span', { 'data-status': status, title: status }, labelOf(TASK_STATUS_LABELS, node.task.status)),
              ' · ' + assigned,
            ),
          )
        }),
      ),
    )
  }

  function KnowledgeGraphView({ graph, selectedId, onSelect }: {
    graph: KnowledgeGraphData
    selectedId: string
    onSelect: (id: string) => void
  }) {
    const nodes = [...(graph.nodes ?? [])].sort((a: KnowledgeGraphNode, b: KnowledgeGraphNode) => a.title.localeCompare(b.title))
    if (nodes.length === 0) {
      return EmptyState({ title: '知识图谱为空', reason: '当前知识库还没有可展示的条目。' })
    }

    const width = 760
    const height = 430
    const centerX = width / 2
    const centerY = height / 2
    const radius = Math.min(170, 70 + nodes.length * 8)
    const positions = new Map(nodes.map((node: { id: string }, index: number) => {
      const angle = (index / Math.max(1, nodes.length)) * Math.PI * 2 - Math.PI / 2
      return [node.id, {
        x: centerX + Math.cos(angle) * radius,
        y: centerY + Math.sin(angle) * radius,
      }]
    }))
    const selected = nodes.find((node: KnowledgeGraphNode) => node.id === selectedId)

    return React.createElement(
      'div',
      null,
      React.createElement(
        'div',
        { className: 'weave-graph-wrap', 'data-testid': 'knowledge-graph' },
        React.createElement(
          'svg',
          { width: '100%', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': '知识双链图谱' },
          ...(graph.edges ?? []).map((edge: { source: string; target: string }) => {
            const source = positions.get(edge.source)
            const target = positions.get(edge.target)
            if (!source || !target) return null
            return React.createElement('line', {
              key: edge.source + '->' + edge.target,
              x1: source.x,
              y1: source.y,
              x2: target.x,
              y2: target.y,
              stroke: 'var(--dsw-alias-border-l2)',
              strokeWidth: 1.5,
              'data-edge': edge.source + '->' + edge.target,
            })
          }),
          ...nodes.map((node: KnowledgeGraphNode) => {
            const point = positions.get(node.id)!
            return React.createElement(
              'g',
              {
                key: node.id,
                className: 'weave-graph-node',
                transform: `translate(${point.x}, ${point.y})`,
                'data-kind': node.kind,
                'data-id': node.id,
                'data-selected': node.id === selectedId ? 'true' : 'false',
                'data-testid': `knowledge-node-${node.id}`,
                onClick: () => onSelect(node.id),
              },
              React.createElement('circle', { r: node.kind === 'missing' ? 7 : 10 }),
              React.createElement('text', { y: -16 }, node.title),
            )
          }),
        ),
        selected
          ? React.createElement(
              'div',
              { className: 'weave-graph-detail', 'data-testid': 'knowledge-graph-detail' },
              React.createElement('b', null, selected.title),
              React.createElement(
                'div',
                { className: 'weave-list-head' },
                React.createElement(Pill, { label: labelOf(KNOWLEDGE_STATUS_LABELS, selected.status), title: selected.status }),
                React.createElement(Pill, { label: labelOf(KNOWLEDGE_LAYER_LABELS, selected.layer), title: selected.layer }),
                React.createElement(Pill, { label: selected.kind === 'missing' ? '缺失目标' : '已有条目' }),
              ),
              selected.tags.length ? React.createElement('span', { className: 'weave-muted' }, '标签：' + selected.tags.join('、')) : null,
              selected.path ? React.createElement('span', { className: 'weave-code weave-muted' }, selected.path) : null,
            )
          : React.createElement('div', { className: 'weave-note', style: { padding: '0 14px 12px' } }, '点击节点查看知识条目详情。'),
      ),
    )
  }

  /* ============================== 知识库 ============================== */

  function KnowledgeImportPanel() {
    const [note, setNote] = useState('')
    const [jobId, setJobId] = useState('')
    const [preview, setPreview] = useState('')
    const [target, setTarget] = useState('project')
    const [projectId, setProjectId] = useState('')
    const [version, setVersion] = useState('')
    const [roleId, setRoleId] = useState('')
    const [instanceId, setInstanceId] = useState('')
    const [visibility, setVisibility] = useState('project_only')
    const [busy, setBusy] = useState(false)

    const uploadAndConvert = async (event: { target: { files?: ArrayLike<File> } }) => {
      const file = event.target.files?.[0]
      if (!file) return
      setBusy(true)
      setNote('')
      try {
        const b64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => {
            const text = String(reader.result ?? '')
            resolve(text.includes(',') ? text.split(',').slice(1).join(',') : text)
          }
          reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
          reader.readAsDataURL(file)
        })
        const meta: Record<string, unknown> = { target, visibility }
        if (projectId) meta.project_id = projectId
        if (version) meta.version = version
        if (roleId) meta.role_id = roleId
        if (instanceId) meta.instance_id = instanceId
        const uploaded = (await rpc('knowledge/import/upload', { filename: file.name, data: b64, meta })) as { jobId?: string; id?: string }
        const id = String(uploaded.jobId ?? uploaded.id ?? '')
        setJobId(id)
        const converted = (await rpc('knowledge/import/convert', { jobId: id })) as { markdown?: string; output?: { markdown?: string } }
        const md = String(converted.markdown ?? converted.output?.markdown ?? '')
        setPreview(md)
        setNote('转换完成，请确认候选知识。')
      } catch (cause) {
        setNote('导入失败：' + errText(cause))
      } finally {
        setBusy(false)
      }
    }

    const confirm = async () => {
      if (!jobId) return
      setBusy(true)
      setNote('')
      try {
        const title = preview.split(String.fromCharCode(10)).find((entry: string) => entry.trim().startsWith('#'))?.replace(/^#+/, '').trim() || '导入知识'
        await rpc('knowledge/import/confirm', {
          jobId,
          candidate: {
            title,
            content: preview,
            type: 'doc',
            visibility,
            tags: [],
          },
        })
        setNote('已生成候选知识，可在上方候选列表审核。')
        setPreview('')
        setJobId('')
      } catch (cause) {
        setNote('确认失败：' + errText(cause))
      } finally {
        setBusy(false)
      }
    }

    return React.createElement(
      'div',
      { className: 'weave-panel', 'data-testid': 'knowledge-import-panel' },
      React.createElement('b', { className: 'weave-subh' }, '导入知识'),
      React.createElement(
        'div',
        { className: 'weave-toolbar' },
        React.createElement('input', {
          className: 'weave-control',
          type: 'file',
          accept: '.doc,.docx,.pdf,.ppt,.pptx,.xls,.xlsx,.epub,.csv,.rtf,.odt',
          disabled: busy,
          'data-testid': 'import-file',
          onChange: (event: { target: { files?: ArrayLike<File> } }) => void uploadAndConvert(event),
        }),
        React.createElement(
          'select',
          { className: 'weave-control', 'data-testid': 'import-target', value: target, onChange: (event: { target: { value: string } }) => setTarget(event.target.value) },
          React.createElement('option', { value: 'project' }, '项目'),
          React.createElement('option', { value: 'role' }, '角色'),
          React.createElement('option', { value: 'instance' }, '实例'),
          React.createElement('option', { value: 'global' }, '全局'),
        ),
        target === 'project'
          ? React.createElement(React.Fragment, null,
              React.createElement('input', { className: 'weave-control', placeholder: '项目ID', value: projectId, onChange: (e: { target: { value: string } }) => setProjectId(e.target.value), 'data-testid': 'import-project' }),
              React.createElement('input', { className: 'weave-control', placeholder: '版本', value: version, onChange: (e: { target: { value: string } }) => setVersion(e.target.value), 'data-testid': 'import-version' }),
            )
          : null,
        target === 'role'
          ? React.createElement('input', { className: 'weave-control', placeholder: '角色ID', value: roleId, onChange: (e: { target: { value: string } }) => setRoleId(e.target.value), 'data-testid': 'import-role' })
          : null,
        target === 'instance'
          ? React.createElement('input', { className: 'weave-control', placeholder: '实例ID', value: instanceId, onChange: (e: { target: { value: string } }) => setInstanceId(e.target.value), 'data-testid': 'import-instance' })
          : null,
        React.createElement(
          'select',
          { className: 'weave-control', 'data-testid': 'import-visibility', value: visibility, onChange: (event: { target: { value: string } }) => setVisibility(event.target.value) },
          React.createElement('option', { value: 'project_only' }, '项目可见'),
          React.createElement('option', { value: 'role_only' }, '角色可见'),
          React.createElement('option', { value: 'instance_only' }, '实例可见'),
          React.createElement('option', { value: 'global' }, '全局可见'),
        ),
        React.createElement('button', { className: 'weave-button weave-button-secondary', type: 'button', disabled: busy, onClick: () => void confirm(), 'data-testid': 'import-confirm' }, '确认生成候选'),
      ),
      preview
        ? React.createElement('textarea', {
            className: 'weave-control',
            style: { minHeight: 160, width: '100%', marginTop: 8 },
            value: preview,
            onChange: (event: { target: { value: string } }) => setPreview(event.target.value),
            'data-testid': 'import-preview',
          })
        : null,
      note ? React.createElement(Note, { text: note }) : null,
    )
  }

  function KnowledgePage() {
    const [status, setStatus] = useState('candidate')
    const [layer, setLayer] = useState('')
    const [reasonFor, setReasonFor] = useState('')
    const [reasonDraft, setReasonDraft] = useState('')
    const [rejectTarget, setRejectTarget] = useState(null as null | string)
    const [selectedNodeId, setSelectedNodeId] = useState('')
    const [copiedPath, setCopiedPath] = useState(false)
    const [graphStatus, setGraphStatus] = useState('')
    const [graphLayer, setGraphLayer] = useState('')
    const [graphProject, setGraphProject] = useState('')

    const info = useResource<SettingsInfo>(() => rpc('settings/describe') as Promise<SettingsInfo>, [])
    const vaultPath = String(info.data?.obsidian_dir ?? '')
    const obsidianHref = vaultPath === '' ? undefined : `obsidian://open?path=${encodeURIComponent(vaultPath)}`

    const list = useResource<{ candidates?: KnowledgeItem[] }>(async () => {
      const payload: Json = { status, limit: 50 }
      if (layer !== '') payload.layer = layer
      return (await rpc('knowledge/list', payload)) as { candidates?: KnowledgeItem[] }
    }, [status, layer])
    const items = list.data?.candidates ?? []
    const graph = useResource<KnowledgeGraphData>(
      async () => {
        const payload: Json = { limit: 200 }
        if (graphStatus !== '') payload.status = graphStatus
        if (graphLayer !== '') payload.layer = graphLayer
        if (graphProject !== '') payload.project = graphProject
        return (await rpc('knowledge/graph', payload)) as KnowledgeGraphData
      },
      [graphStatus, graphLayer, graphProject],
    )
    const graphNodes = graph.data?.nodes ?? []

    const approver = useAction()
    const rejecter = useAction()
    const approve = async (id: string) => {
      await approver.run(async () => {
        await rpc('knowledge/approve', { id })
        void list.refresh()
        return `已通过：${id}`
      })
    }
    const reject = (id: string) => {
      setRejectTarget(id)
    }
    const confirmReject = async () => {
      const id = rejectTarget
      if (!id) return
      setRejectTarget(null)
      await rejecter.run(async () => {
        const payload: Json = { id }
        if (reasonDraft !== '') payload.reason = reasonDraft
        await rpc('knowledge/reject', payload)
        setReasonFor('')
        setReasonDraft('')
        void list.refresh()
        return `已驳回：${id}`
      })
    }

    const copyVaultPath = async () => {
      try {
        await navigator.clipboard.writeText(vaultPath)
        setCopiedPath(true)
        window.setTimeout(() => setCopiedPath(false), 1800)
      } catch {
        window.prompt('复制 Obsidian Vault 路径：', vaultPath)
      }
    }

    return React.createElement(
      'section',
      { className: 'weave-page', 'data-testid': 'page-knowledge' },
      React.createElement('h1', null, '知识库'),
      React.createElement(
        'div',
        { className: 'weave-panel', 'data-testid': 'knowledge-team-guide' },
        React.createElement('b', { className: 'weave-subh' }, '团队如何使用知识库'),
        React.createElement(
          'div',
          { className: 'weave-list' },
          React.createElement('span', { className: 'weave-muted' }, '① 执行器在任务输出中写 `WEAVE_KNOWLEDGE` 块 → 自动生成候选知识；'),
          React.createElement('span', { className: 'weave-muted' }, '② 在这里审核：通过（approve）进入可注入知识，驳回（reject）归档；'),
          React.createElement('span', { className: 'weave-muted' }, '③ 后续任务派发时按团队 `knowledge_injection` 限额自动注入相关知识；'),
          React.createElement('span', { className: 'weave-muted' }, '④ 知识按 项目 / 角色 / 实例 / 全局 分层，下方双链图谱可查看关联与缺失目标。'),
        ),
      ),
      Note({
        text: list.loading
          ? '正在加载...'
          : list.error || approver.note || rejecter.note || '候选知识必须显式审核，才能生效或驳回。',
      }),
      list.error ? Note({ text: list.error, kind: 'error' }) : null,
      approver.ok === false || rejecter.ok === false ? Note({ text: approver.note || rejecter.note, kind: 'error' }) : null,
      React.createElement(KnowledgeImportPanel, null),
      React.createElement(
        'div',
        { className: 'weave-panel', 'data-testid': 'obsidian-panel' },
        React.createElement('b', { className: 'weave-subh' }, 'Obsidian Vault'),
        React.createElement(
          'div',
          { className: 'weave-actions', style: { alignItems: 'center' } },
          vaultPath ? React.createElement('span', { className: 'weave-code weave-muted', 'data-testid': 'obsidian-path' }, vaultPath) : null,
          obsidianHref
            ? React.createElement(
                'a',
                { className: 'weave-button weave-button-secondary', href: obsidianHref, target: '_blank', rel: 'noreferrer', 'data-testid': 'obsidian-open' },
                '打开 Obsidian',
              )
            : React.createElement('button', { className: 'weave-button weave-button-secondary', type: 'button', disabled: true }, '路径不可用'),
          React.createElement(
            'button',
            { className: 'weave-button weave-button-secondary', type: 'button', disabled: vaultPath === '', 'data-testid': 'obsidian-copy', onClick: () => void copyVaultPath() },
            copiedPath ? '已复制' : '复制路径',
          ),
        ),
        React.createElement('span', { className: 'weave-muted' }, '知识主存储仍是 Markdown + frontmatter；P0 只提供入口，不做双向同步。'),
      ),
      graph.loading
        ? React.createElement(Note, { text: '正在加载知识图谱...' })
        : graph.error
          ? React.createElement(Note, { text: graph.error, kind: 'error' })
          : React.createElement(
              'div',
              { className: 'weave-panel' },
              React.createElement('b', { className: 'weave-subh' }, '知识图谱（双链预览）'),
              React.createElement(
                'div',
                { className: 'weave-toolbar' },
                React.createElement(
                  'select',
                  {
                    className: 'weave-control',
                    'data-testid': 'knowledge-graph-status-filter',
                    value: graphStatus,
                    onChange: (event: { target: { value: string } }) => setGraphStatus(event.target.value),
                  },
                  React.createElement('option', { value: '' }, '全部状态'),
                  ...KNOWLEDGE_STATUSES.map((value: string) => React.createElement(
                    'option',
                    { key: value, value },
                    labelOf(KNOWLEDGE_STATUS_LABELS, value),
                  )),
                ),
                React.createElement(
                  'select',
                  {
                    className: 'weave-control',
                    'data-testid': 'knowledge-graph-layer-filter',
                    value: graphLayer,
                    onChange: (event: { target: { value: string } }) => setGraphLayer(event.target.value),
                  },
                  React.createElement('option', { value: '' }, '全部层级'),
                  ...KNOWLEDGE_LAYERS.map((value: string) => React.createElement(
                    'option',
                    { key: value, value },
                    labelOf(KNOWLEDGE_LAYER_LABELS, value),
                  )),
                ),
                React.createElement(
                  'select',
                  {
                    className: 'weave-control',
                    'data-testid': 'knowledge-graph-project-filter',
                    value: graphProject,
                    onChange: (event: { target: { value: string } }) => setGraphProject(event.target.value),
                  },
                  React.createElement('option', { value: '' }, '全部项目'),
                  ...(graph.data?.projects ?? []).map((value: string) => React.createElement('option', { key: value, value }, value)),
                ),
              ),
              React.createElement(KnowledgeGraphView, {
                graph: graph.data ?? {},
                selectedId: selectedNodeId,
                onSelect: (id: string) => setSelectedNodeId(id === selectedNodeId ? '' : id),
              }),
              React.createElement(
                'span',
                { className: 'weave-muted' },
                `共 ${graphNodes.filter((node: KnowledgeGraphNode) => node.kind === 'knowledge').length} 条 · ${graph.data?.counts?.missing ?? 0} 个缺失目标 · ${graph.data?.counts?.edges ?? 0} 条关联；完整 Graphify 查询属于后续版本。`,
              ),
            ),
      React.createElement(
        'div',
        { className: 'weave-toolbar' },
        React.createElement(
          'select',
          { className: 'weave-control', 'data-testid': 'knowledge-status-filter', value: status, onChange: (event: { target: { value: string } }) => setStatus(event.target.value) },
          ...KNOWLEDGE_STATUSES.map((value: string) => React.createElement('option', { key: value, value }, `${labelOf(KNOWLEDGE_STATUS_LABELS, value)}（${value}）`)),
        ),
        React.createElement(
          'select',
          { className: 'weave-control', 'data-testid': 'knowledge-layer-filter', value: layer, onChange: (event: { target: { value: string } }) => setLayer(event.target.value) },
          React.createElement('option', { value: '' }, '全部层级'),
          ...KNOWLEDGE_LAYERS.map((value: string) => React.createElement('option', { key: value, value }, `${labelOf(KNOWLEDGE_LAYER_LABELS, value)}（${value}）`)),
        ),
        React.createElement('button', { className: 'weave-button weave-button-secondary', type: 'button', onClick: () => void list.refresh() }, '刷新'),
      ),
      list.error
        ? EmptyState({ title: '知识列表不可用', reason: `${list.error}（knowledge 端点尚未接入 RPC 时会出现此提示）` })
        : items.length
          ? React.createElement(
              'div',
              { className: 'weave-list' },
              ...items.map((item: KnowledgeItem, index: number) => {
                const id = String(item.id ?? `item-${index}`)
                return React.createElement(
                  'article',
                  { className: 'weave-list-item', key: id, 'data-testid': `knowledge-item-${id}` },
                  React.createElement(
                    'div',
                    { className: 'weave-list-head' },
                    React.createElement(Pill, { label: labelOf(KNOWLEDGE_STATUS_LABELS, item.status), title: String(item.status ?? '') }),
                    React.createElement(Pill, { label: labelOf(KNOWLEDGE_LAYER_LABELS, item.layer), title: String(item.layer ?? '') }),
                    React.createElement('b', null, String(item.title ?? id)),
                  ),
                  item.path ? React.createElement('span', { className: 'weave-muted' }, String(item.path)) : null,
                  React.createElement(
                    'span',
                    { className: 'weave-muted' },
                    `置信度 ${safeNum(item.confidence) ?? '—'} · 新鲜度 ${safeNum(item.freshness_score) ?? '—'} · 更新 ${fmtTime(item.updated)}`,
                  ),
                  item.superseded_by ? React.createElement('span', { className: 'weave-muted' }, `被 ${String(item.superseded_by)} 取代`) : null,
                  status === 'candidate'
                    ? React.createElement(
                        'div',
                        { className: 'weave-actions' },
                        React.createElement(
                          'button',
                          {
                            className: 'weave-button weave-button-small',
                            type: 'button',
                            disabled: approver.busy,
                            'data-testid': `knowledge-approve-${id}`,
                            onClick: () => void approve(id),
                          },
                          '通过',
                        ),
                        React.createElement(
                          'button',
                          {
                            className: 'weave-button weave-button-secondary weave-button-small',
                            type: 'button',
                            disabled: rejecter.busy,
                            'data-testid': `knowledge-reject-${id}`,
                            onClick: () => {
                              setReasonFor(reasonFor === id ? '' : id)
                              setReasonDraft('')
                            },
                          },
                          '驳回',
                        ),
                      )
                    : null,
                  reasonFor === id
                    ? React.createElement(
                        'div',
                        { className: 'weave-actions' },
                        React.createElement('input', {
                          className: 'weave-control',
                          style: { minWidth: 220 },
                          'data-testid': `knowledge-reason-${id}`,
                          value: reasonDraft,
                          placeholder: '驳回原因（可选）',
                          onChange: (event: { target: { value: string } }) => setReasonDraft(event.target.value),
                        }),
                        React.createElement(
                          'button',
                          {
                            className: 'weave-button weave-button-secondary weave-button-small',
                            type: 'button',
                            disabled: rejecter.busy,
                            'data-testid': `knowledge-reject-confirm-${id}`,
                            onClick: () => void reject(id),
                          },
                          '确认驳回',
                        ),
                      )
                    : null,
                )
              }),
            )
          : EmptyState({
              title: '没有知识条目',
              reason: list.loading ? '正在加载...' : `当前过滤条件（status=${status}${layer !== '' ? `，layer=${layer}` : ''}）下没有条目。`,
            }),
      rejectTarget
        ? React.createElement(ConfirmDialog, {
            open: true,
            title: '确认驳回知识条目？',
            body: `确认驳回知识条目 ${rejectTarget}？其状态将置为 deprecated。`,
            confirmText: '确认驳回',
            cancelText: '取消',
            danger: true,
            busy: rejecter.busy,
            testId: 'knowledge-reject-dialog',
            onConfirm: () => void confirmReject(),
            onCancel: () => setRejectTarget(null),
          } as never)
        : null,
    )
  }

  /* ============================== 执行器 ============================== */

  function ExecutorsPage() {
    const snapshot = useResource<SnapshotData>(() => rpc('snapshot') as Promise<SnapshotData>, [])
    const executors = snapshot.data?.executors ?? []
    const capabilities = snapshot.data?.zcodeCapabilities
    // t8：动态注册的 ACP provider（真实 providers.json；未注入时端点报 configuration_error → 显式空态）。
    const providers = useResource<{ providers?: ProviderRow[] }>(
      () => rpc('provider/list') as Promise<{ providers?: ProviderRow[] }>,
      [],
    )
    const providerRows = providers.data?.providers ?? []

    /** 声明态能力行：supported 来自执行器标准能力；requested/effective 运行值随任务产生，此处如实标注。 */
    const capabilityLabels: Record<string, string> = {
    model: '模型选择',
    thought: '思考控制',
    mode: '模式控制',
    tools: '工具过滤',
  }
  const intentLine = (executorId: string) => {
      const caps = executors.find((executor: ExecutorInfo) => executor.id === executorId)?.capabilities as
        | { modelSelection?: boolean; thoughtControl?: boolean; modeControl?: boolean; tools?: { externalRuntime?: boolean; filtering?: string } }
        | undefined
      const entries: Array<[string, boolean]> = [
        ['model', caps?.modelSelection === true],
        ['thought', caps?.thoughtControl === true],
        ['mode', caps?.modeControl === true],
        ['tools', caps?.tools?.filtering !== undefined && caps.tools.filtering !== 'none'],
      ]
      return entries.map(([label, supported]) =>
        React.createElement(
          'span',
          { className: 'weave-muted', key: label },
          labelOf(capabilityLabels, label) + '：' + (supported
            ? '支持运行时指定；实际值随运行上报'
            : '可按会话意图请求；当前不支持；自动降级'),
        ),
      )
    }

    const providersBlock = providers.error
      ? React.createElement(
          'div',
          { className: 'weave-panel', 'data-testid': 'providers-unavailable' },
          React.createElement('b', { className: 'weave-subh' }, '动态 ACP 执行器'),
          React.createElement('span', { className: 'weave-muted' }, providers.error + '（providerStore 未注入时出现此提示）'),
        )
      : providerRows.length
        ? React.createElement(
            'div',
            { className: 'weave-panel', 'data-testid': 'providers-panel' },
            React.createElement('b', { className: 'weave-subh' }, '动态 ACP 执行器（providers.json，注册即生效）'),
            ...providerRows.map((provider: ProviderRow) =>
              React.createElement(
                'article',
                { className: 'weave-list-item', key: provider.name, 'data-testid': 'provider-card-' + provider.name },
                React.createElement(
                  'div',
                  { className: 'weave-list-head' },
                  React.createElement('b', null, provider.name),
                  React.createElement(Pill, { label: provider.enabled ? '已生效' : '未注册', tone: provider.enabled ? 'good' : 'idle' }),
                ),
                React.createElement(
                  'span',
                  { className: 'weave-muted' },
                  provider.transport + ' · ' + provider.command +
                    (provider.args && provider.args.length ? ' ' + provider.args.join(' ') : '') +
                    (provider.cwd ? ' · cwd ' + provider.cwd : '') +
                    ((provider.envKeys && provider.envKeys.length) ? ' · env(' + String(provider.envKeys.length) + '项)' : ''),
                ),
                React.createElement(
                  'div',
                  { className: 'weave-chiprow' },
                  ...(provider.declaredExtensions && provider.declaredExtensions.length
                    ? provider.declaredExtensions.map((extension) => React.createElement('span', { className: 'weave-chip weave-code', key: extension }, extension))
                    : [React.createElement('span', { className: 'weave-chip', key: 'none' }, '未声明扩展')]),
                ),
                ...intentLine(provider.name),
              ),
            ),
            React.createElement('span', { className: 'weave-muted' }, 'ZCode 只是其中一个可选 extension；requested/effective 的运行值在任务执行后由协商结果产生。'),
          )
        : React.createElement(
            'div',
            { className: 'weave-panel', 'data-testid': 'providers-empty' },
            React.createElement('b', { className: 'weave-subh' }, '动态 ACP Provider'),
            React.createElement('span', { className: 'weave-muted' }, 'providers.json 中暂无条目。'),
          )

    return React.createElement(
      'section',
      { className: 'weave-page', 'data-testid': 'page-executors' },
      React.createElement('h1', null, '执行器'),
      Note({
        text: snapshot.loading ? '正在加载...' : snapshot.error || '以下为运行时实际注册的执行器；ZCode 目录仅在发现时展示。',
      }),
      snapshot.error ? Note({ text: snapshot.error, kind: 'error' }) : null,
      React.createElement(
        'div',
        { className: 'weave-grid' },
        ...(executors.length
          ? executors.map((executor: ExecutorInfo) =>
              React.createElement(Card, {
                key: executor.id,
                title: executorLabel(executor.id),
                testId: `executor-card-${executor.id}`,
                meta: React.createElement(
                  'span',
                  null,
                  executor.capabilities && Object.keys(executor.capabilities).length
                    ? `capabilities：${Object.keys(executor.capabilities).join(' / ')}`
                    : '无附加能力声明。',
                ),
              }),
            )
          : [
              EmptyState({
                title: '未发现已注册执行器',
                reason: snapshot.error ? `加载失败：${snapshot.error}` : '宿主尚未注册任何 subagent / ACP 执行器。',
              }),
            ]),
      ),
      providersBlock,
      capabilities && (
          (capabilities.models?.length ?? 0) > 0 ||
          (capabilities.modes?.length ?? 0) > 0 ||
          (capabilities.thoughtLevels?.length ?? 0) > 0 ||
          capabilities.currentModel || capabilities.currentMode || capabilities.currentThoughtLevel
        )
        ? React.createElement(
            'div',
            { className: 'weave-panel', 'data-testid': 'zcode-catalog' },
            React.createElement('b', { className: 'weave-subh' }, 'ZCode 能力目录'),
            React.createElement(
              'span',
              { className: 'weave-muted' },
              `当前模型：${capabilities.currentModel ?? '—'} · 当前模式：${capabilities.currentMode ?? '—'} · 思考深度：${capabilities.currentThoughtLevel ?? '—'}`,
            ),
            React.createElement(
              'div',
              { className: 'weave-chiprow' },
              ...(Array.from(
                new Map<string, SelectOption>(
                  (capabilities.models ?? []).map((option: SelectOption) => [option.value, option]),
                ).values(),
              ).map((option: SelectOption) =>
                React.createElement('span', { className: 'weave-chip', key: option.value }, option.name ?? option.value),
              )),
            ),
          )
        : null,
    )
  }

  /* ============================== 会话管理 ============================== */

  /* ============================== 审计日志 ============================== */

  function AuditPage() {
    const [type, setType] = useState('')
    const [from, setFrom] = useState('')
    const [to, setTo] = useState('')
    const [order, setOrder] = useState('desc')
    const [applied, setApplied] = useState({ type: '', from: '', to: '', order: 'desc' })

    const list = useResource<{ events?: AuditEventView[] }>(async () => {
      const payload: Json = { order: applied.order, limit: 100 }
      if (applied.type !== '') payload.types = [applied.type]
      if (applied.from !== '') payload.from = new Date(applied.from).toISOString()
      if (applied.to !== '') payload.to = new Date(applied.to).toISOString()
      return (await rpc('audit/list', payload)) as { events?: AuditEventView[] }
    }, [applied])

    const events = list.data?.events ?? []
    const summarize = (event: AuditEventView): string => {
      const parts: string[] = []
      const fieldLabels: Record<string, string> = {
        task_id: '任务ID',
        knowledge_id: '知识ID',
        dag_id: 'DAG ID',
        by: '操作者',
        from: '原值',
        to: '新值',
        session_id: '会话ID',
        reason: '原因',
      }
      for (const key of Object.keys(fieldLabels)) {
        const value = event[key]
        if (value !== undefined && value !== null && value !== '') parts.push(`${fieldLabels[key]}=${String(value)}`)
      }
      return parts.join(' · ')
    }

    return React.createElement(
      'section',
      { className: 'weave-page', 'data-testid': 'page-audit' },
      React.createElement('h1', null, '审计日志'),
      Note({ text: list.loading ? '正在加载...' : list.error || '事件来自真实 JSONL 审计日志。' }),
      list.error ? Note({ text: list.error, kind: 'error' }) : null,
      React.createElement(
        'form',
        {
          className: 'weave-toolbar',
          onSubmit: (event: { preventDefault(): void }) => {
            event.preventDefault()
            setApplied({ type, from, to, order })
          },
        },
        React.createElement(
          'select',
          { className: 'weave-control', 'data-testid': 'audit-type-filter', value: type, onChange: (event: { target: { value: string } }) => setType(event.target.value) },
          React.createElement('option', { value: '' }, '全部类型'),
          ...AUDIT_EVENT_TYPES.map((value: string) => React.createElement('option', { key: value, value }, `${labelOf(AUDIT_EVENT_LABELS, value)}（${value}）`)),
        ),
        React.createElement('input', {
          'data-testid': 'audit-from',
          type: 'datetime-local',
          value: from,
          className: 'weave-control',
          onChange: (event: { target: { value: string } }) => setFrom(event.target.value),
        }),
        React.createElement('input', {
          'data-testid': 'audit-to',
          type: 'datetime-local',
          value: to,
          className: 'weave-control',
          onChange: (event: { target: { value: string } }) => setTo(event.target.value),
        }),
        React.createElement(
          'select',
          { className: 'weave-control', 'data-testid': 'audit-order', value: order, onChange: (event: { target: { value: string } }) => setOrder(event.target.value) },
          React.createElement('option', { value: 'desc' }, '最新优先'),
          React.createElement('option', { value: 'asc' }, '最旧优先'),
        ),
        React.createElement('button', { className: 'weave-button weave-button-secondary', type: 'submit', 'data-testid': 'audit-query-btn' }, '查询'),
        React.createElement('button', { className: 'weave-button weave-button-secondary', type: 'button', onClick: () => void list.refresh() }, '刷新'),
      ),
      list.error
        ? EmptyState({ title: '审计事件不可用', reason: `${list.error}（audit/list 尚未接入时会出现此提示）` })
        : events.length
          ? React.createElement(
              'div',
              { className: 'weave-list' },
              ...events.map((event: AuditEventView, index: number) =>
                React.createElement(
                  'article',
                  { className: 'weave-list-item', key: `${String(event.type ?? 'event')}-${index}`, 'data-testid': `audit-event-${index}` },
                  React.createElement(
                    'div',
                    { className: 'weave-list-head' },
                    React.createElement(Pill, { label: labelOf(AUDIT_EVENT_LABELS, event.type), title: String(event.type ?? '') }),
                    React.createElement('span', { className: 'weave-muted' }, fmtTime(event.occurred_at)),
                  ),
                  React.createElement('span', { className: 'weave-muted' }, summarize(event) || '（无附加字段）'),
                ),
              ),
            )
          : EmptyState({ title: '没有匹配的审计事件', reason: list.loading ? '正在加载...' : '放宽过滤条件或确认审计目录配置后再试。' }),
    )
  }

  /* ============================== 设置 ============================== */

  const WEAVE_COMMAND_MANUAL: Array<{ cmd: string; desc: string }> = [
    { cmd: '<直接描述目标>', desc: '队长模式开箱即用：已配置默认团队或仅有一个团队时自动生效——直接说需求即可拆解派发、调度汇总' },
    { cmd: '启用 <团队名> / 切换 <团队> / 关闭团队', desc: '仅在多团队需要指定时使用一次（之后长期生效）；关闭团队回到自动解析' },
    { cmd: '/weave team list', desc: '查看全部团队与角色' },
    { cmd: '/weave team switch <team_id>', desc: '切换当前会话团队' },
    { cmd: '/weave task status --dag <dag_id> | --task <task_id>', desc: '查看任务/依赖图状态' },
    { cmd: '/weave task revise <task_id> <反馈>', desc: '对保温期任务反馈返工' },
    { cmd: '/weave task accept <task_id>', desc: '验收任务' },
    { cmd: '/weave task retry|skip|cancel|reopen <task_id>', desc: '任务生命周期治理操作（取消/重试与真实运行联动）' },
    { cmd: '/weave executor list', desc: '列出当前实际注册的执行器' },
    { cmd: '/weave dag <dag_id>', desc: '查看任务依赖图' },
    { cmd: '/weave provider add <JSON|YAML|文件路径|紧凑配置>', desc: '注册一个或多个外部 ACP 执行器' },
    { cmd: '/weave provider list', desc: '列出已持久化的动态 Provider' },
    { cmd: '/weave provider remove <name>', desc: '移除并注销动态 Provider' },
    { cmd: '/weave knowledge search <关键词> [--project <pid>] [--version <ver>] [--role <rid>]', desc: '按需检索已审核通过的知识（执行器/子代理可调用）' },
    { cmd: '/weave knowledge review', desc: '知识候选队列' },
    { cmd: '/weave knowledge approve <id>', desc: '知识审核通过' },
    { cmd: '/weave knowledge reject <id> <原因>', desc: '知识驳回' },
    { cmd: '/weave ban list', desc: '查看熔断/冷却实体' },
  ]
  const SETTINGS_DIR_FIELDS: Array<{ key: string; label: string; placeholder: string }> = [
    { key: 'state_dir', label: '状态目录', placeholder: '默认 ~/.dsh/state' },
    { key: 'teams_dir', label: '团队目录', placeholder: '默认 ~/.dsh/teams' },
    { key: 'audit_dir', label: '审计目录', placeholder: '默认 ~/.dsh/audit' },
    { key: 'knowledge_dir', label: '知识库目录', placeholder: '默认 ~/.dsh/knowledge' },
    { key: 'obsidian_dir', label: 'Obsidian Vault', placeholder: '默认 ~/.dsh/obsidian' },
    { key: 'providers_file', label: '执行器配置来源', placeholder: '默认 ~/.dsh/weave/providers.json' },
  ]
  function SettingsPage() {
    const info = useResource<SettingsInfo>(() => rpc('settings/describe') as Promise<SettingsInfo>, [])
    const [draft, setDraft] = useState({} as Record<string, string>)
    const [saveNote, setSaveNote] = useState('')
    const [busy, setBusy] = useState(false)
    useEffect(() => {
      if (!info.data) return
      setDraft((current: Record<string, string>) => {
        const next: Record<string, string> = { ...current }
        for (const field of SETTINGS_DIR_FIELDS) if (next[field.key] === undefined) next[field.key] = ''
        return next
      })
    }, [info.data])
    const savePaths = async (reset: boolean) => {
      setBusy(true)
      setSaveNote('')
      try {
        const payload: Record<string, string> = {}
        for (const field of SETTINGS_DIR_FIELDS) payload[field.key] = reset ? '' : String(draft[field.key] ?? '')
        await rpc('settings/update', payload)
        setSaveNote('已保存到 ' + String(info.data?.settings_file ?? 'settings.json') + '；重启/重新加载插件后生效。')
        void info.refresh()
      } catch (cause) {
        setSaveNote('保存失败：' + errText(cause))
      } finally {
        setBusy(false)
      }
    }
    // t8：provider 配置来源与注册摘要（provider/list 不可用时静默降级为一行说明）。
    const providers = useResource<{ providers?: ProviderRow[] }>(
      () => rpc('provider/list') as Promise<{ providers?: ProviderRow[] }>,
      [],
    )
    const providerRows = providers.data?.providers ?? []
    const data = info.data ?? {}
    const extensionUnion: string[] = []
    for (const provider of providerRows) {
      for (const extension of provider.declaredExtensions ?? []) {
        if (!extensionUnion.includes(extension)) extensionUnion.push(extension)
      }
    }
    const providersSummary = React.createElement(
      'div',
      { className: 'weave-panel', 'data-testid': 'providers-summary' },
      React.createElement('b', { className: 'weave-subh' }, '执行器配置'),
      React.createElement(
        'div',
        { className: 'weave-kv' },
        React.createElement('span', { key: 'src-k' }, '配置来源'),
        React.createElement('b', { key: 'src-v' }, String(data.providers_file ?? '—')),
      ),
      ...(providers.error
        ? [React.createElement('span', { className: 'weave-muted', key: 'err' }, providers.error)]
        : providerRows.length
          ? providerRows.map((provider: ProviderRow) =>
              React.createElement(
                'span',
                { className: 'weave-muted', key: provider.name },
                provider.name + ' · ' + provider.transport + ' · ' + provider.command + (provider.enabled ? ' · 已生效' : ' · 未注册'),
              ),
            )
          : [React.createElement('span', { className: 'weave-muted', key: 'empty' }, '暂无动态 provider。')]),
      extensionUnion.length
        ? React.createElement(
            'div',
            { className: 'weave-chiprow', key: 'ext' },
            ...extensionUnion.map((extension) => React.createElement('span', { className: 'weave-chip', key: extension }, extension)),
          )
        : null,
    )
    const row = (label: string, value: string) => [
      React.createElement('span', { key: `${label}-k` }, label),
      React.createElement('b', { key: `${label}-v` }, value),
    ]
    return React.createElement(
      'section',
      { className: 'weave-page', 'data-testid': 'page-settings' },
      React.createElement('h1', null, '设置'),
      Note({ text: info.loading ? '正在加载...' : info.error || saveNote || '目录可在下方修改并持久化；保存后下次加载生效。' }),
      info.error ? Note({ text: info.error, kind: 'error' }) : null,
      React.createElement(
        'div',
        { className: 'weave-panel', 'data-testid': 'settings-list' },
        React.createElement(
          'div',
          { className: 'weave-kv' },
          row('Weave 版本', String(data.version ?? '—')),
          row('Node 版本', String(data.node_version ?? '—')),
          row('状态目录', String(data.state_dir ?? '—')),
          row('团队目录', String(data.teams_dir ?? '—')),
          row('审计目录', String(data.audit_dir ?? '—')),
          row('Provider 配置来源', String(data.providers_file ?? '—')),
          row('ZCode 发现', data.zcode?.configured ? '已配置' : '未配置'),
          row('ZCode 注册', data.zcode?.registered ? '已注册' : '未注册'),
        ),
        React.createElement(
          'div',
          { className: 'weave-settings-grid', style: { marginTop: 14, display: 'grid', gap: 10 } },
          ...SETTINGS_DIR_FIELDS.map((field) =>
            React.createElement(
              'label',
              { className: 'weave-field', key: field.key },
              React.createElement('span', null, field.label),
              React.createElement('input', {
                className: 'weave-control',
                value: String(draft[field.key] ?? ''),
                placeholder: field.placeholder,
                'data-testid': `settings-${field.key}`,
                onChange: (event: { target: { value: string } }) =>
                  setDraft((current: Record<string, string>) => ({ ...current, [field.key]: event.target.value })),
              }),
            ),
          ),
          React.createElement(
            'div',
            { className: 'weave-actions' },
            React.createElement(
              'button',
              { className: 'weave-button', type: 'button', disabled: busy, 'data-testid': 'settings-save', onClick: () => void savePaths(false) },
              busy ? '保存中...' : '保存目录设置',
            ),
            React.createElement(
              'button',
              { className: 'weave-button weave-button-secondary', type: 'button', disabled: busy, 'data-testid': 'settings-reset', onClick: () => void savePaths(true) },
              '恢复默认',
            ),
          ),
        ),
        React.createElement(
          'button',
          { className: 'weave-button weave-button-secondary', type: 'button', onClick: () => void info.refresh() },
          '刷新',
        ),
      ),
      providersSummary,
    )
  }


  function ManualPage() {
    return React.createElement(
      'section',
      { className: 'weave-page', 'data-testid': 'page-manual' },
      React.createElement('h1', null, '命令手册'),
      Note({ text: '以下命令与当前 DSH 会话的 /weave 命令一致；团队启停也可用自然语言。' }),
      React.createElement(
        'div',
        { className: 'weave-list' },
        ...WEAVE_COMMAND_MANUAL.map((entry: { cmd: string; desc: string }, index: number) =>
          React.createElement(
            'article',
            { className: 'weave-list-item', key: entry.cmd, 'data-testid': `command-row-${index}` },
            React.createElement('b', null, entry.cmd),
            React.createElement('span', { className: 'weave-muted' }, entry.desc),
          ),
        ),
      ),
    )
  }

  /* ============================== 壳与入口 ============================== */

  function WeaveDashboard({ onClose }: { onClose: () => void }) {
    const [route, setRoute] = useState('overview' as Route)
    const go = (next: Route) => setRoute(next)
    const pages: Record<Route, any> = {
      overview: React.createElement(OverviewPage, { navigate: go }),
      teams: React.createElement(TeamsPage),
      knowledge: React.createElement(KnowledgePage),
      executors: React.createElement(ExecutorsPage),
      audit: React.createElement(AuditPage),
      settings: React.createElement(SettingsPage),
      manual: React.createElement(ManualPage),
    }
    const def = ROUTES.find((item) => item.key === route) ?? ROUTES[0]!
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
            React.createElement('div', { className: 'weave-title' }, `Weave 控制台 · ${def.label}`),
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
          React.createElement('div', { className: 'weave-content' }, pages[route as Route]),
        ),
      ),
    )
    return createPortal ? createPortal(content, document.body) : content
  }

  /* ============================ 会话视图面板（会话即团队） ============================ */

  /* ---- E 块：成员卡「查看输出」事件流 ---- */
  /** 后端 executor/run-events 就绪后置 false 直接联调；true 时用确定性 mock 数据开发。 */
  const RUN_EVENTS_MOCK = false
  /** 事件流轮询间隔（≥1s，约束上限）。 */
  const RUN_EVENTS_POLL_MS = 1000
  /** 卡片内联展开区最多渲染的事件条数（完整历史看抽屉）。 */
  const RUN_EVENTS_INLINE_CAP = 30
  /** 抽屉全量历史的硬顶（防极端内存占用；超出提示截断）。 */
  const RUN_EVENTS_DRAWER_CAP = 500

  interface ExecutorEventRow {
    ts: number
    type: string
    tool?: string
    text?: string
  }

  interface RunEventsPayload {
    unavailable?: boolean
    sessionId?: string
    modelIoPath?: string
    events: ExecutorEventRow[]
    truncated?: boolean
  }

  const EVENT_TYPE_LABELS: Record<string, string> = {
    status: '状态',
    output: '输出',
    reasoning: '思考',
    tool_call: '工具',
    tool_result: '结果',
  }

  const normalizeExecutorEvent = (raw: unknown): ExecutorEventRow => {
    const row = (typeof raw === 'object' && raw !== null ? raw : {}) as Json
    const tsRaw = row['ts'] ?? row['timestamp']
    const ts = typeof tsRaw === 'number' && Number.isFinite(tsRaw) ? tsRaw : Date.parse(String(tsRaw ?? '')) || 0
    return {
      ts,
      type: String(row['type'] ?? 'status'),
      // RPC 侧 toClientEvent 输出键为 tool；mock 数据用 name，两者都兼容。
      ...((row['tool'] ?? row['name']) !== undefined ? { tool: String(row['tool'] ?? row['name']) } : {}),
      ...(row['text'] !== undefined ? { text: String(row['text']) } : {}),
    }
  }

  /**
   * 确定性 mock 事件流：按 taskId 播种、tick 推进累计两条/秒（封顶），
   * 让 UI 开发不依赖后端；taskId 含「idle」时模拟 stream_unavailable 空态。
   */
  const mockRunEvents = (taskId: string, tick: number): RunEventsPayload => {
    if (/idle/.test(taskId)) return { unavailable: true, events: [] }
    const seed = [...taskId].reduce((sum, ch) => sum + ch.charCodeAt(0), 7)
    const tools = ['Read', 'Grep', 'Edit', 'Bash', 'TodoWrite']
    const texts = [
      '解析任务目标并拆解验收点',
      '定位相关实现文件…',
      '命中现有组件可直接复用',
      '应用补丁并保持既有风格',
      '准备执行回归验证',
    ]
    const kinds: Array<keyof typeof EVENT_TYPE_LABELS> = ['status', 'output', 'tool_call', 'tool_result', 'reasoning']
    const baseTick = Math.min(tick, 40)
    const total = 2 + baseTick * 2
    const capped = total > RUN_EVENTS_DRAWER_CAP ? RUN_EVENTS_DRAWER_CAP : total
    const now = Date.now()
    const events: ExecutorEventRow[] = []
    for (let i = 0; i < capped; i += 1) {
      const kind = kinds[(seed + i) % kinds.length] ?? 'status'
      const withTool = kind === 'tool_call' || kind === 'tool_result'
      const withText = kind === 'output' || kind === 'reasoning' || kind === 'tool_call'
      events.push({
        ts: now - (capped - i) * 1500,
        type: kind,
        ...(withTool ? { tool: tools[(seed + i) % tools.length] } : {}),
        ...(withText ? { text: `${texts[i % texts.length]}#${i + 1}` } : {}),
      })
    }
    return {
      sessionId: `sess-mock-${(seed % 9973).toString(16).padStart(4, '0')}`,
      modelIoPath: `~/.dsh/state/executors/mock/${taskId}.jsonl`,
      events,
      truncated: total > RUN_EVENTS_DRAWER_CAP,
    }
  }

  /** executor/run-events 取数：未就绪走 mock（RUN_EVENTS_MOCK）；真实路径带降级空态。 */
  const fetchRunEvents = async (taskId: string, tick: number): Promise<RunEventsPayload> => {
    if (RUN_EVENTS_MOCK) return mockRunEvents(taskId, tick)
    try {
      const res = (await rpc('executor/run-events', { taskId })) as Json
      return {
        sessionId: typeof res['session_id'] === 'string' && res['session_id'] !== '' ? res['session_id'] : undefined,
        modelIoPath: typeof res['model_io_path'] === 'string' ? res['model_io_path'] : undefined,
        events: Array.isArray(res['events']) ? (res.events as unknown[]).map(normalizeExecutorEvent) : [],
      }
    } catch {
      return { unavailable: true, events: [] }
    }
  }

  const formatEventClock = (ts: number): string => {
    if (!Number.isFinite(ts) || ts <= 0) return '--:--:--'
    const date = new Date(ts)
    const pad = (n: number): string => String(n).padStart(2, '0')
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  }

  /** 共享轮询 Hook 形态的取数逻辑（两个面板复用；卸载清理定时器）。 */
  function useRunEvents(taskId: string, cap: number): { rows: ExecutorEventRow[]; meta: RunEventsPayload; loading: boolean } {
    const [rows, setRows] = useState([] as ExecutorEventRow[])
    const [meta, setMeta] = useState({ events: [] as ExecutorEventRow[] } as RunEventsPayload)
    const [loading, setLoading] = useState(true)
    useEffect(() => {
      if (taskId === '') return
      let alive = true
      let tick = 0
      const pull = async (): Promise<void> => {
        const payload = await fetchRunEvents(taskId, tick)
        if (!alive) return
        tick += 1
        setLoading(false)
        setMeta(payload)
        setRows(payload.unavailable ? [] : payload.events.slice(-cap))
      }
      void pull()
      const timer = setInterval(() => void pull(), RUN_EVENTS_POLL_MS)
      return () => {
        alive = false
        clearInterval(timer)
      }
    }, [taskId, cap])
    return { rows, meta, loading }
  }

  const eventLineOf = (row: ExecutorEventRow): React.ReactElement =>
    React.createElement(
      'div',
      { className: 'weave-eventline', key: `${row.ts}-${row.type}-${row.tool ?? ''}` },
      React.createElement('time', null, formatEventClock(row.ts)),
      React.createElement('b', null, row.tool ? `${EVENT_TYPE_LABELS[row.type] ?? row.type}·${row.tool}` : (EVENT_TYPE_LABELS[row.type] ?? row.type)),
      row.text ? React.createElement('span', null, row.text.length > 80 ? `${row.text.slice(0, 80)}…` : row.text) : null,
    )

  const eventStreamEmptyNote = (status: boolean): React.ReactElement =>
    React.createElement(
      'div',
      { className: 'weave-adv-note' },
      status
        ? '该执行器未提供实时事件流（stream_unavailable）：无法查看过程输出，仅展示最终结果与状态变更。'
        : '连接事件流…',
    )

  /** 成员卡内联展开区：最近事件（限条数）+ 打开完整历史入口。 */
  function InlineRunEventsPane(props: { taskId: string; onOpenDrawer: () => void; showMeta?: boolean; sessionLabel?: string; onOpenSubagent?: (childSessionId: string) => void; autoOpenSubagent?: boolean }): React.ReactElement | null {
    const { rows, meta, loading } = useRunEvents(props.taskId, RUN_EVENTS_INLINE_CAP)
    const autoOpenedSubagent = useRef(false)
    useEffect(() => {
      if (props.autoOpenSubagent && props.onOpenSubagent && meta.sessionId && !autoOpenedSubagent.current) {
        autoOpenedSubagent.current = true
        props.onOpenSubagent(meta.sessionId)
      }
    }, [props.autoOpenSubagent, props.onOpenSubagent, meta.sessionId])
    if (loading) return React.createElement('span', { className: 'weave-muted' }, '连接事件流...')
    if (meta.unavailable) return eventStreamEmptyNote(true)
    return React.createElement(
      'div',
      null,
      React.createElement('div', { className: 'weave-eventstream', role: 'log' }, rows.map(eventLineOf)),
      props.showMeta
        ? React.createElement(
            'div',
            { className: 'weave-event-meta', style: { marginTop: 4 } },
            React.createElement('span', null, `${props.sessionLabel ?? 'sessionId'}：${meta.sessionId ?? '—'}`),
            React.createElement('span', null, `模型 IO：${meta.modelIoPath ?? '—'}`),
            props.onOpenSubagent && meta.sessionId
              ? React.createElement(
                  'button',
                  {
                    className: 'weave-button weave-button-secondary weave-button-small',
                    type: 'button',
                    'data-testid': 'session-open-subagent',
                    onClick: () => props.onOpenSubagent?.(meta.sessionId ?? ''),
                  },
                  '打开子代理会话',
                )
              : null,
          )
        : null,
    )
  }

  /** 完整历史抽屉：滚动只读展示全部事件 + zcode sessionId / 模型 IO 路径提示。 */
  function RunEventsDrawer(props: { taskId: string; title: string; onClose: () => void }): React.ReactElement {
    const { rows, meta } = useRunEvents(props.taskId, RUN_EVENTS_DRAWER_CAP)
    return React.createElement(
      'div',
      {
        className: 'weave-drawer-wrap',
        'data-testid': 'run-events-drawer',
        onClick: (event: { target: unknown; currentTarget: unknown }) => {
          if (event.target === event.currentTarget) props.onClose()
        },
      },
      React.createElement(
        'aside',
        { className: 'weave-drawer' },
        React.createElement(
          'div',
          { className: 'weave-list-head' },
          React.createElement('b', null, `运行输出 · ${props.title}`),
          React.createElement(Pill, { label: props.taskId }),
          React.createElement(
            'button',
            { className: 'weave-close', type: 'button', style: { marginLeft: 'auto' }, onClick: props.onClose },
            '×',
          ),
        ),
        meta.unavailable
          ? eventStreamEmptyNote(true)
          : React.createElement('div', { className: 'weave-eventstream', style: { maxHeight: '50vh' }, role: 'log' }, rows.map(eventLineOf)),
        React.createElement(
          'div',
          { className: 'weave-event-meta' },
          React.createElement('span', null, `sessionId：${meta.sessionId ?? '—'}（zcode 会话标识，只读）`),
          React.createElement('span', null, `模型 IO：${meta.modelIoPath ?? '~/.dsh/state/executors/<task>.jsonl'}（只读展示）`),
          meta.truncated ? React.createElement('span', null, `事件过多，仅保留最近 ${RUN_EVENTS_DRAWER_CAP} 条`) : null,
        ),
      ),
    )
  }


  /** 成员状态徽标色（与节点边框色系一致）。 */
  const memberToneOf = (status: string): string => {
    if (status === 'running') return 'run'
    if (status === 'interrupted' || status === 'idle_timeout') return 'bad'
    return 'idle'
  }

  const memberStatusLabel = (status: string): string => {
    const lower = String(status ?? '').toLowerCase()
    if (lower === 'running') return '执行中'
    if (lower === 'queued') return '排队中'
    if (lower === 'interrupted' || lower === 'idle_timeout') return '中断'
    return '空闲'
  }

  /**
   * 会话面板活跃探测指纹（纯函数）：团队 + 成员占用 + 最近任务。
   * 探测取回与已加载资源共用同一结构，保证基线与探测可比；
   * 全部任务状态写点都会刷新 updated_at，指纹可覆盖任务域全部迁移。
   */
  const sessionFingerprint = (
    next: SessionStatusData | undefined,
    listed: { tasks?: TaskRow[] } | undefined,
  ): unknown[] => [
    String(next?.team?.team_id ?? ''),
    (next?.members ?? []).map((member) => [
      String(member.role_id ?? ''),
      String(member.status ?? ''),
      String(member.task_id ?? ''),
      String(member.phase ?? ''),
      String(member.started_at ?? ''),
      String(member.last_task_id ?? ''),
      String(member.last_status ?? ''),
    ]),
    ...((listed?.tasks ?? []).slice(0, 1).map((task) => [
      String(task.id ?? ''),
      String(task.status ?? ''),
      String(task.updated_at ?? ''),
    ])),
  ]

  /**
   * 会话即团队面板：挂在 conversation.view 槽位，宿主注入框架标准 kit
   * （sessionId 即当前会话）。三段：团队绑定头 / 成员实时状态卡片 / 本会话任务 DAG。
   * 任务下发只有对话一条路——队长模型调用 weave_plan_tasks；本面板只做展示与治理动作。
   */
  function WeaveSessionPanel({ sessionId }: { sessionId?: string }) {
    const sid = String(sessionId ?? '')
    const snapshot = useResource<SnapshotData>(() => rpc('snapshot') as Promise<SnapshotData>, [])
    const teams = snapshot.data?.teams ?? []

    const status = useResource<SessionStatusData | undefined>(
      () =>
        sid === ''
          ? Promise.resolve(undefined)
          : rpc('session/status', { sessionId: sid }) as Promise<SessionStatusData>,
      [sid],
    )
    const boundTeamId = String(status.data?.team?.team_id ?? '')

    // 本会话最近任务（updated_at 倒序）→ 首行的 dag_id 即最近活跃任务图。
    // 团队状态确定前不拉任务；未启用团队的会话直接跳过任务轮询（无意义请求）。
    const statusKnown = status.data !== undefined || status.error !== ''
    const teamBound = Boolean(status.data?.team)
    const list = useResource<{ total?: number; tasks?: TaskRow[] } | undefined>(
      async () => {
        if (sid === '' || !statusKnown || !teamBound) return undefined
        // 只取当前会话的任务，避免把其他会话的同团队任务误显示到本会话。
        return (await rpc('task/list', { sessionId: sid, limit: 20 })) as { total?: number; tasks?: TaskRow[] }
      },
      [sid, statusKnown, teamBound],
    )
    const latestDagId = String((list.data?.tasks ?? [])[0]?.dag_id ?? '')
    const detail = useResource<TaskDagDetail | undefined>(
      () =>
        latestDagId === ''
          ? Promise.resolve(undefined)
          : rpc('task/get', { dagId: latestDagId }) as Promise<TaskDagDetail>,
      [latestDagId],
    )
    // 就绪判定：详情必须与当前最新 DAG 匹配才渲染图（避免资源切换瞬间读到上一份/空数据）。
    const pendingDetail = latestDagId !== '' && detail.loading
    const dag = detail.data && String(detail.data.dag_id ?? '') === latestDagId ? detail.data : undefined

    const binder = useAction()
    const bindTeam = async (teamId: string) => {
      if (teamId === boundTeamId) return
      await binder.run(async () => {
        if (teamId === '') {
          await rpc('session/clear-binding', { sessionId: sid })
          return '已关闭当前会话的团队。'
        }
        await rpc('session/set-binding', { sessionId: sid, teamId })
        return `已启用团队：${teamId}`
      })
      void status.refresh()
    }

    const actor = useAction()
    const [confirmTask, setConfirmTask] = useState(null as null | { taskId: string; action: string; label: string })
    const [reviseTask, setReviseTask] = useState(null as null | { taskId: string })

    const performTaskAction = async (taskId: string, action: string, feedback?: string) => {
      await actor.run(async () => {
        await rpc('task/action', { action, taskId, ...(feedback !== undefined ? { feedback } : {}) })
        void list.refresh()
        void detail.refresh()
        void status.refresh()
        const label = TASK_ACTIONS_BY_STATUS[String(selectedNode?.status ?? '')]?.find((entry) => entry.action === action)?.label ?? action
        return `已${label}：${taskId}`
      })
    }

    const runTaskAction = async (taskId: string, action: string, needsConfirm: boolean, label: string) => {
      if (action === 'revise') {
        setReviseTask({ taskId })
        return
      }
      if (needsConfirm) {
        setConfirmTask({ taskId, action, label })
        return
      }
      await performTaskAction(taskId, action)
    }

    const refreshAll = useCallback(() => {
      void status.refresh()
      void list.refresh()
      if (latestDagId !== '') void detail.refresh()
    }, [status.refresh, list.refresh, detail.refresh, latestDagId])

    /* ---- 事件驱动刷新（参照 dsh-agent-teams ActivityPanel 的 ObservableSnapshot 订阅模式） ----
     * ① 宿主推流：订阅 ctx.sessions.list（ObservableSnapshot）——成员子代理会话生成/退出即推，
     *    状态一变即刷（零轮询主路径）；旧宿主无此面时静默降级。
     * ② 活跃探测：团队已绑定时按 SESSION_HEARTBEAT_MS 心跳拉轻量指纹（成员占用 + 最近任务
     *    updated_at，全部状态写点都会刷新 updated_at），指纹变化才全量刷新——变更检测与数据
     *    获取分离（细粒度订阅），覆盖 zcode ACP 等不产生宿主会话 churn 的执行器；页签隐藏时暂停。
     * ③ 手动「刷新」按钮保留为兜底路径，同样走防抖合并。 */
    const sessionsList = sessionNavigator?.list
    const subscribeSessions =
      typeof sessionsList?.subscribe === 'function' ? sessionsList.subscribe : noopSnapshotSubscribe
    const getSessionsSnapshot =
      typeof sessionsList?.getSnapshot === 'function' ? sessionsList.getSnapshot : noopSnapshotGet
    const sessionVersion = useSyncExternalStore(subscribeSessions, getSessionsSnapshot)

    const refreshTimer = useRef(null as null | number)
    const scheduleRefresh = useCallback(() => {
      if (refreshTimer.current !== null) return
      refreshTimer.current = window.setTimeout(() => {
        refreshTimer.current = null
        refreshAll()
      }, SESSION_REFRESH_DEBOUNCE_MS)
    }, [refreshAll])
    useEffect(
      () => () => {
        if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current)
      },
      [],
    )

    // 宿主推流 → 版本变化 → 防抖刷新（挂载首帧同值不触发）。
    const seenSessionVersion = useRef(sessionVersion)
    useEffect(() => {
      if (seenSessionVersion.current === sessionVersion) return
      seenSessionVersion.current = sessionVersion
      scheduleRefresh()
    }, [sessionVersion, scheduleRefresh])

    // 活跃探测：成员占用 + 最近任务的轻量指纹；探测自带的 inFlight 闸防重叠。
    // 基线从已加载资源同步（而非首拍置空）——挂载后首个心跳前发生的变更不被吞。
    const probeBusy = useRef(false)
    const seenFingerprint = useRef('')
    const loadedFingerprint = status.data
      ? JSON.stringify(sessionFingerprint(status.data, list.data))
      : ''
    useEffect(() => {
      if (loadedFingerprint !== '') seenFingerprint.current = loadedFingerprint
    }, [loadedFingerprint])
    const probe = useCallback(async () => {
      if (sid === '' || !statusKnown || !teamBound || probeBusy.current) return
      probeBusy.current = true
      try {
        const [next, listed] = await Promise.all([
          rpc('session/status', { sessionId: sid }) as Promise<SessionStatusData>,
          rpc('task/list', { sessionId: sid, limit: 1 }) as Promise<{ tasks?: TaskRow[] }>,
        ])
        const fingerprint = JSON.stringify(sessionFingerprint(next, listed))
        if (seenFingerprint.current !== '' && seenFingerprint.current !== fingerprint) scheduleRefresh()
        seenFingerprint.current = fingerprint
      } catch {
        // 探测失败（连接抖动）静默：下个心跳再试，不打扰用户。
      } finally {
        probeBusy.current = false
      }
    }, [sid, statusKnown, teamBound, scheduleRefresh])
    useEffect(() => {
      if (sid === '' || !statusKnown || !teamBound) return
      const timer = window.setInterval(() => {
        if (typeof document !== 'undefined' && document.hidden) return
        void probe()
      }, SESSION_HEARTBEAT_MS)
      return () => window.clearInterval(timer)
    }, [sid, statusKnown, teamBound, probe])

    const members = status.data?.members ?? []
    /* ---- 底部 Tab 组：固定「任务依赖图」+ 队员输出 Tab（可关闭） ---- */
    const [outputTabs, setOutputTabs] = useState([] as Array<{ roleId: string; name: string; taskId: string; executor?: string }>)
    const [activeTab, setActiveTab] = useState('dag' as string)
    const [membersOpen, setMembersOpen] = useState(true)
    const [tabsOpen, setTabsOpen] = useState(true)
    const [showLeft, setShowLeft] = useState(true)
    const [showRight, setShowRight] = useState(true)
    useEffect(() => {
      document.body.classList.add('weave-session-active')
      return () => document.body.classList.remove('weave-session-active')
    }, [])
    const [streamDrawer, setStreamDrawer] = useState(null as null | { taskId: string; name: string })
    const isDshExecutor = (executor?: string): boolean =>
      executor === 'spawn' || executor === 'fork' || executor === 'dsh_subagent'
    const openOutputTab = (roleId: string, name: string, taskId: string, executor?: string): void => {
      setOutputTabs((current: Array<{ roleId: string; name: string; taskId: string; executor?: string }>) =>
        current.some((tab) => tab.roleId === roleId) ? current : [...current, { roleId, name, taskId, executor }],
      )
      setActiveTab(`member-${roleId}`)
    }
    const closeOutputTab = (roleId: string): void => {
      setOutputTabs((current: Array<{ roleId: string; name: string; taskId: string }>) => current.filter((tab) => tab.roleId !== roleId))
      setActiveTab((current: string) => (current === `member-${roleId}` ? 'dag' : current))
    }
    const selectedFromDag = String((dag?.tasks ?? [])[0]?.id ?? '')
    const [selectedId0, setSelectedId0] = useState('')
    const selectedId = selectedId0 !== '' ? selectedId0 : selectedFromDag
    const selectedNode = (dag?.tasks ?? []).find((task: TaskRow) => String(task.id ?? '') === selectedId)
    const nodeActions = TASK_ACTIONS_BY_STATUS[String(selectedNode?.status ?? '')] ?? []

    /* ---- AgentTeams 风格运行视图派生：进度分段、成员已接任务 ---- */
    const sessionTasks = ((dag?.tasks ?? list.data?.tasks ?? []) as TaskRow[])
    const hasActiveTasks = sessionTasks.some((task: TaskRow) =>
      !['COMPLETED', 'CLOSED', 'FAILED', 'CANCELLED', 'SKIPPED', 'BANNED', 'LOOP_TERMINATED', 'INTERRUPTED', 'COOLDOWN'].includes(String(task.status ?? '')),
    )
    const sessionTaskStateOf = (status: string | undefined): string => {
      const s = String(status ?? '')
      if (s === 'RUNNING' || s === 'REVISION_RUNNING') return 'running'
      if (s === 'WAITING' || s === 'BLOCKED' || s === 'COOLDOWN') return 'waiting'
      if (s === 'AWAITING_FEEDBACK') return 'awaiting'
      if (s === 'COMPLETED' || s === 'CLOSED') return 'completed'
      return 'failed'
    }
    const sessionTaskCounts = (tasks: TaskRow[]): { running: number; waiting: number; awaiting: number; completed: number; failed: number; total: number } => {
      const counts = { running: 0, waiting: 0, awaiting: 0, completed: 0, failed: 0, total: tasks.length }
      for (const task of tasks) {
        const state = sessionTaskStateOf(task.status)
        if (state === 'running') counts.running += 1
        else if (state === 'waiting') counts.waiting += 1
        else if (state === 'awaiting') counts.awaiting += 1
        else if (state === 'completed') counts.completed += 1
        else counts.failed += 1
      }
      return counts
    }
    const memberAssignedTasks = (member: SessionStatusMember): TaskRow[] => {
      const roleId = String(member.role_id ?? '')
      const current = String(member.task_id ?? '')
      const last = String(member.last_task_id ?? '')
      return sessionTasks.filter((task: TaskRow) =>
        String(task.assigned_agent ?? '') === roleId ||
        (current !== '' && String(task.id ?? '') === current) ||
        (last !== '' && String(task.id ?? '') === last),
      )
    }
    const sessionProgressBar = (tasks: TaskRow[], testId: string): React.ReactElement =>
      React.createElement(
        'div',
        { className: 'weave-progress-segments', 'data-testid': testId },
        ...tasks.map((task: TaskRow) =>
          React.createElement('span', {
            key: String(task.id ?? ''),
            'data-state': sessionTaskStateOf(task.status),
            title: `${String(task.id ?? '')} · ${labelOf(TASK_STATUS_LABELS, task.status)}`,
          }),
        ),
      )

    if (sid === '') {
      return React.createElement(
        'div',
        { className: 'weave-spanel', 'data-testid': 'weave-session-panel' },
        React.createElement('span', { className: 'weave-muted' }, 'Weave 团队面板等待会话上下文...'),
      )
    }

    return React.createElement(
      'div',
      { className: 'weave-spanel', 'data-testid': 'weave-session-panel' },
      /* ---- 头部：团队绑定 ---- */
      React.createElement(
        'div',
        { className: 'weave-spanel-head' },
        React.createElement('b', { 'data-testid': 'weave-session-team-name' },
          status.data?.team
            ? `团队 · ${String(status.data.team.name ?? status.data.team.team_id)}${status.data.resolved_via && status.data.resolved_via !== 'binding' ? '（自动）' : ''}`
            : '未确定团队'),
        status.data?.team && typeof status.data.team.description === 'string' && status.data.team.description.trim() !== ''
          ? React.createElement(
              'div',
              { className: 'weave-muted', style: { fontSize: '11px', lineHeight: '14px' }, 'data-testid': 'weave-session-team-description' },
              status.data.team.description,
            )
          : null,
        hasActiveTasks
          ? React.createElement(
              'span',
              { className: 'weave-muted', style: { fontSize: '11px', lineHeight: '14px' }, 'data-testid': 'weave-session-team-locked' },
              '有进行中任务，不能切团队',
            )
          : null,
        React.createElement(
          'select',
          {
            className: 'weave-control',
            value: boundTeamId,
            disabled: binder.busy || teams.length === 0 || hasActiveTasks,
            title: hasActiveTasks ? '当前团队有进行中任务，不能切换团队' : '选择当前会话使用的团队',
            'data-testid': 'weave-session-team-select',
            onChange: (event: { target: { value: string } }) => void bindTeam(event.target.value),
          },
          React.createElement('option', { value: '' }, teams.length === 0 ? '（无可用团队）' : '未绑定'),
          ...teams.map((team: TeamSummaryRow) =>
            React.createElement(
              'option',
              { key: String(team.team_id ?? ''), value: String(team.team_id ?? '') },
              `${String(team.name ?? team.team_id)}${team.default ? '（默认）' : ''}`,
            ),
          ),
        ),
        React.createElement(
          'button',
          { className: 'weave-button weave-button-secondary weave-button-small', type: 'button', 'data-testid': 'weave-session-refresh', onClick: scheduleRefresh },
          '刷新',
        ),
        React.createElement('span', { className: 'weave-muted', style: { marginLeft: 'auto' } }, `会话 ${sid.slice(0, 18)}${sid.length > 18 ? '…' : ''}`),
      ),
      binder.note ? Note({ text: binder.note }) : null,
      binder.ok === false || actor.ok === false ? Note({ text: binder.note || actor.note, kind: 'error' }) : null,

      /* ---- AgentTeams 风格：团队运行总览（进度分段 + 状态统计） ---- */
      status.data?.team
        ? React.createElement(
            'div',
            { className: 'weave-session-runtime', 'data-testid': 'weave-session-runtime' },
            React.createElement(
              'div',
              { className: 'weave-team-stats', 'data-testid': 'weave-session-team-stats' },
              React.createElement('span', null, React.createElement('b', null, String(members.length)), ' 成员'),
              React.createElement('span', null, React.createElement('b', null, String(sessionTasks.length)), ' 任务'),
              React.createElement('span', null, React.createElement('b', null, String(sessionTaskCounts(sessionTasks).completed)), ` / ${String(sessionTasks.length)} 已完成`),
              React.createElement('span', null, React.createElement('b', null, String(sessionTaskCounts(sessionTasks).running)), ' 执行中'),
            ),
            sessionTasks.length > 0
              ? sessionProgressBar(sessionTasks, 'weave-session-progress')
              : null,
          )
        : null,

      /* ---- 左右分栏：左成员 / 右任务与输出 ---- */
      React.createElement(
        'div',
        {
          className: 'weave-session-split',
          'data-left': showLeft ? 'open' : 'closed',
          'data-right': showRight ? 'open' : 'closed',
        },
        showLeft
          ? React.createElement(
          'div',
          { className: 'weave-session-left' },
      /* ---- 成员区（可折叠） ---- */
      React.createElement(
        'div',
        { className: 'weave-section' },
        React.createElement(
          'div',
          { className: 'weave-section-head-row' },
          React.createElement(
            'button',
            { className: 'weave-section-head', 'data-testid': 'session-members-toggle', onClick: () => setMembersOpen(!membersOpen) },
            membersOpen ? '▾ 成员' : '▸ 成员',
          ),
          React.createElement(
            'button',
            { className: 'weave-section-collapse', 'data-testid': 'session-collapse-left', title: '收起左侧队员区', onClick: () => setShowLeft(false) },
            '◀',
          ),
        ),
        membersOpen
          ? React.createElement(
              'div',
              { className: 'weave-section-body' },
      React.createElement(
        'div',
        null,
        React.createElement('b', { className: 'weave-subh' }, '成员'),
        status.loading
          ? React.createElement('div', { className: 'weave-members' }, React.createElement('span', { className: 'weave-muted' }, '加载中...'))
          : !status.data?.team
            ? EmptyState({
                title: '无法确定本次会话的团队',
                reason: '已配置默认团队或仅有一个团队时会自动生效；当前存在多个团队且未指定——在上方下拉选择一次或发送「启用 <团队名>」，之后长期生效。',
              })
            : members.length === 0
              ? React.createElement('span', { className: 'weave-muted' }, '该团队没有角色。')
              : React.createElement(
                  'div',
                  { className: 'weave-members', 'data-testid': 'weave-session-members' },
                  ...members.map((member: SessionStatusMember) => {
                    const st = String(member.status ?? 'idle')
                    const roleId = String(member.role_id ?? '')
                    const idleTimeoutHit =
                      String((member as Json)['error_type'] ?? '') === 'idle_timeout' ||
                      String((member as Json)['interrupt_reason'] ?? '') === 'idle_timeout'
                    const streamTaskId = String(member.task_id || member.last_task_id || '')
                    const assignedTasks = memberAssignedTasks(member)
                    const interrupted = idleTimeoutHit || st === 'interrupted'
                    const dotTone = interrupted ? 'bad' : memberToneOf(st)
                    const statusText = interrupted ? '中断' : memberStatusLabel(st)
                    const cardChildren: Array<React.ReactElement> = [
                      React.createElement(
                        'b',
                        { key: 'name' },
                        `${String(member.name ?? member.role_id ?? '成员')}`,
                      ),
                      React.createElement(
                        'span',
                        { className: 'weave-muted', key: 'status' },
                        React.createElement('span', { className: 'weave-dot', 'data-tone': dotTone }),
                        statusText,
                      ),
                      // 空闲超时细分提示（B0 死亡递送文案；红色警示，区别于普通失败）。
                      idleTimeoutHit
                        ? React.createElement('span', { className: 'weave-field-error', key: 'idle-note' }, '已被空闲超时中断：长时间无模型输出或工具活动，可重试恢复')
                        : null,
                      assignedTasks.length > 0
                        ? React.createElement(
                            'div',
                            { className: 'weave-member-assignments', key: 'assignments', 'data-testid': `member-assignments-${roleId}` },
                            ...assignedTasks.slice(0, 8).map((task: TaskRow) =>
                              React.createElement(
                                'span',
                                {
                                  className: 'weave-assignment-chip',
                                  key: String(task.id ?? ''),
                                  'data-state': sessionTaskStateOf(task.status),
                                  title: `${String(task.id ?? '')} · ${labelOf(TASK_STATUS_LABELS, task.status)}`,
                                },
                                React.createElement('b', null, shortTaskId(task.id)),
                              ),
                            ),
                          )
                        : null,
                    ]
                    return React.createElement(
                      'div',
                      {
                        className: 'weave-member',
                        key: roleId,
                        'data-testid': `member-card-${roleId}`,
                        'data-status': st,
                        'data-clickable': streamTaskId !== '' ? 'true' : undefined,
                        onClick: () => {
                          if (streamTaskId !== '') openOutputTab(roleId, String(member.name ?? roleId), streamTaskId, member.executor)
                        },
                      },
                      ...cardChildren,
                    )
                  }),
                ),
      )
            )
          : null,
      ),
        )
          : React.createElement(
              'button',
              {
                type: 'button',
                className: 'weave-side-collapsed',
                'data-testid': 'session-expand-left',
                title: '展开队员',
                onClick: () => setShowLeft(true),
              },
              '▶',
            ),
      /* ---- 完整历史抽屉 ---- */
      streamDrawer
        ? React.createElement(RunEventsDrawer, {
            taskId: streamDrawer.taskId,
            title: streamDrawer.name,
            onClose: () => setStreamDrawer(null),
          } as never)
        : null,
        showRight
          ? React.createElement(
          'div',
          { className: 'weave-session-right' },
      /* ---- 底部 Tab 组（可折叠）：任务依赖图 + 队员输出 ---- */
      React.createElement(
        'div',
        { className: 'weave-section' },
        React.createElement(
          'div',
          { className: 'weave-section-head-row' },
          React.createElement(
            'button',
            { className: 'weave-section-head', 'data-testid': 'session-tabs-toggle', onClick: () => setTabsOpen(!tabsOpen) },
            tabsOpen ? '▾ 任务 / 输出' : '▸ 任务 / 输出',
          ),
          React.createElement(
            'button',
            { className: 'weave-section-collapse', 'data-testid': 'session-collapse-right', title: '收起右侧任务/输出区', onClick: () => setShowRight(false) },
            '▶',
          ),
        ),
        tabsOpen
          ? React.createElement(
              'div',
              { className: 'weave-section-body' },
      React.createElement(
        'div',
        { className: 'weave-panel-tabs', 'data-testid': 'weave-session-tabs' },
        React.createElement(
          'button',
          {
            type: 'button',
            className: activeTab === 'dag' ? 'weave-tab weave-tab-active' : 'weave-tab',
            'data-testid': 'session-tab-dag',
            onClick: () => setActiveTab('dag'),
          },
          '任务依赖图',
        ),
        ...outputTabs.map((tab: { roleId: string; name: string; taskId: string; executor?: string }) =>
          React.createElement(
            'span',
            { key: tab.roleId, className: activeTab === `member-${tab.roleId}` ? 'weave-tab weave-tab-active' : 'weave-tab', 'data-testid': `session-tab-${tab.roleId}` },
            React.createElement(
              'button',
              { type: 'button', className: 'weave-tab-label', onClick: () => setActiveTab(`member-${tab.roleId}`) },
              tab.name,
            ),
            React.createElement(
              'button',
              { type: 'button', className: 'weave-tab-close', 'data-testid': `session-tab-close-${tab.roleId}`, onClick: () => closeOutputTab(tab.roleId) },
              '×',
            ),
          ),
        ),
      ),
      React.createElement(
        'div',
        {
          className: 'weave-panel-tab-body',
          'data-testid': 'weave-session-tab-body',
          // T-fix（Playwright 实测）：CSS :524 height:auto;min-height:0 会把页签体
          // 塌缩成内容高度（283px），DAG 图被压成小图。dag 激活时给真实高度预算：
          // 视口高减固定 chrome，下限 420px；fit 尺度由 RO 实测的大盒子驱动。
          ...(activeTab === 'dag'
            ? { style: { minHeight: 'max(calc(100vh - 300px), 420px)' } }
            : {}),
        },
        activeTab === 'dag'
          ? React.createElement(
              'div',
              null,
              React.createElement(
                'div',
                { className: 'weave-list-head' },
                React.createElement('b', { className: 'weave-subh' }, '任务依赖图'),
                latestDagId !== ''
                  ? React.createElement(Pill, { label: String(dag?.dag_id ?? latestDagId), title: '最近活跃任务图' })
                  : null,
              ),
              list.loading || pendingDetail
                ? React.createElement('span', { className: 'weave-muted' }, '加载中...')
                : !status.data?.team
                  ? null
                  : latestDagId === ''
                    ? null
                    : !dag
                      ? React.createElement('span', { className: 'weave-muted' }, `加载失败：${detail.error || '未知错误'}`)
                      : React.createElement(
                          React.Fragment,
                          null,
                          React.createElement(DagGraph, {
                            dag: dag as TaskDagDetail,
                            selectedId,
                            // 默认派生选中只驱动下方详情区；聚焦暗化仅在用户显式点选后生效
                            focusPinned: selectedId0 !== '',
                            onSelect: (next: string) => setSelectedId0(next),
                          }),
                          selectedNode
                            ? React.createElement(
                                'div',
                                { className: 'weave-graph-detail', 'data-testid': 'weave-session-task-detail' },
                                React.createElement(
                                  'div',
                                  { className: 'weave-list-head' },
                                  React.createElement('b', null, shortTaskId(selectedNode.id)),
                                  React.createElement(Pill, {
                                    label: labelOf(TASK_STATUS_LABELS, selectedNode.status),
                                    tone: toneOf(String(selectedNode.status ?? '')),
                                    title: String(selectedNode.status ?? ''),
                                  }),
                                  ...(nodeActions.map((entry) =>
                                    React.createElement(
                                      'button',
                                      {
                                        key: entry.action,
                                        className: 'weave-button weave-button-secondary weave-button-small',
                                        type: 'button',
                                        disabled: actor.busy,
                                        'data-testid': `session-task-action-${entry.action}-${String(selectedNode.id ?? '')}`,
                                        onClick: () => void runTaskAction(String(selectedNode.id ?? ''), entry.action, entry.confirm === true, entry.label),
                                      },
                                      entry.label,
                                    ),
                                  )),
                                ),
                              )
                            : null,
                        ),
            )
          : (() => {
              const tab = outputTabs.find((item: { roleId: string; name: string; taskId: string; executor?: string }) => `member-${item.roleId}` === activeTab)
              if (!tab) return React.createElement('span', { className: 'weave-muted' }, '没有打开的输出')
              return React.createElement(
                'div',
                { 'data-testid': `session-output-${tab.roleId}` },
                React.createElement(
                  'div',
                  { className: 'weave-list-head' },
                  React.createElement('b', null, `${tab.name} 输出`),
                  React.createElement(Pill, { label: shortTaskId(tab.taskId), title: tab.taskId }),
                ),
                React.createElement(InlineRunEventsPane, {
                  taskId: tab.taskId,
                  onOpenDrawer: () => setStreamDrawer({ taskId: tab.taskId, name: tab.name }),
                  showMeta: true,
                  sessionLabel: isDshExecutor(tab.executor) ? '子代理会话' : 'sessionId',
                  onOpenSubagent: isDshExecutor(tab.executor) && sessionNavigator
                    ? (childSessionId: string) => void openSubagentSession(sid, childSessionId)
                    : undefined,
                  autoOpenSubagent: isDshExecutor(tab.executor) && sessionNavigator ? true : undefined,
                } as never),
              )
            })(),
      )
            )
          : null,
      ),
        )
          : React.createElement(
              'button',
              {
                type: 'button',
                className: 'weave-side-collapsed',
                'data-testid': 'session-expand-right',
                title: '展开任务/输出',
                onClick: () => setShowRight(true),
              },
              '◀',
            ),
      ),
      actor.note && actor.ok === true ? Note({ text: actor.note }) : null,
      confirmTask
        ? React.createElement(ConfirmDialog, {
            open: true,
            title: '确认操作',
            body: `确认对任务 ${shortTaskId(confirmTask.taskId)} 执行「${confirmTask.label}」？`,
            confirmText: '确认',
            cancelText: '取消',
            danger: confirmTask.action === 'cancel' || confirmTask.action === 'skip',
            busy: actor.busy,
            testId: 'session-confirm-action',
            onConfirm: () => {
              const target = confirmTask
              setConfirmTask(null)
              if (target) void performTaskAction(target.taskId, target.action)
            },
            onCancel: () => setConfirmTask(null),
          } as never)
        : null,
      reviseTask
        ? React.createElement(PromptDialog, {
            open: true,
            title: `返工反馈 · ${shortTaskId(reviseTask.taskId)}`,
            placeholder: '例如：把登录校验改成邮箱验证码',
            testId: 'session-revise-dialog',
            confirmTestId: 'session-revise-confirm',
            onConfirm: (value: string) => {
              const target = reviseTask
              setReviseTask(null)
              if (target) void performTaskAction(target.taskId, 'revise', value)
            },
            onCancel: () => setReviseTask(null),
          } as never)
        : null,
    )
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

  return { WeaveSidebarAction, WeaveSessionPanel }
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
      const connection = ctx.get('connection') as ConnectionHandle
      let sessions: SessionNavigator | undefined
      try {
        sessions = ctx.get('sessions') as SessionNavigator
      } catch {
        sessions = undefined
      }
      callRpc = async (endpoint, payload) => {
        const result = await connection.rpc.call('/dsh-weave', endpoint, payload ?? {})
        if (!result.ok) throw new Error(`${result.error?.code ?? 'rpc-error'}: ${result.error?.message ?? 'RPC failed'}`)
        return result.value
      }
      const app = createApp(React, ReactDOM.createPortal, callRpc, sessions)
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

      const sessionPanel = app.WeaveSessionPanel
      ctx.effect(
        () =>
          ctx.slots.inject('conversation.view', () =>
            ctx.slots.register(
              {
                name: 'conversation.view',
                id: PLUGIN_ID,
                order: 70,
                label: () => 'Weave 团队',
              },
              sessionPanel,
            ),
          ),
        'dsh-weave conversation session panel',
      )

    }

    const module = { exports: {} as Record<string, unknown> }
    module.exports.apply = localApply
    module.exports.inject = ['slots', 'connection', 'sessions']
    return module.exports
  },
})
