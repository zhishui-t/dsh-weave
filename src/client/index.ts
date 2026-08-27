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
  | 'manual'

const ROUTES: Array<{ key: Route; label: string; desc: string }> = [
  { key: 'overview', label: '总览', desc: '任务、知识与执行器的整体运行状态。' },
  { key: 'teams', label: '团队', desc: '查看团队并创建新的协作团队。' },
  { key: 'tasks', label: '任务中心', desc: '任务依赖图、状态与快速操作入口。' },
  { key: 'knowledge', label: '知识库', desc: '知识导入、候选审核与注入管理。' },
  { key: 'executors', label: '执行器', desc: '实际注册的执行器与其能力。' },
  { key: 'sessions', label: '会话管理', desc: '会话绑定与修订上下文概览。' },
  { key: 'audit', label: '审计日志', desc: '核心事件与恢复操作审计。' },
  { key: 'settings', label: '设置', desc: 'Weave 本地配置与运行参数。' },
  { key: 'manual', label: '命令手册', desc: '/weave 命令与自然语言团队控制速查。' },
]

/* ------------------------------- 领域常量 ------------------------------- */

/** 与服务端 TASK_STATUSES（state/types.ts 14 态权威矩阵）一致。 */
const TASK_STATUSES = [
  'WAITING',
  'BLOCKED',
  'RUNNING',
  'COMPLETED',
  'AWAITING_FEEDBACK',
  'REVISION_RUNNING',
  'CLOSED',
  'FAILED',
  'BANNED',
  'LOOP_TERMINATED',
  'INTERRUPTED',
  'CANCELLED',
  'SKIPPED',
  'COOLDOWN',
] as const

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
  maxConcurrent: string
  personality: string
  provider: string
  model: string
  thoughtLevel: string
  mode: string
  fallbackProvider: string
  fallbackModel: string
}

interface TaskRow {
  id?: string
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

interface BindingRow {
  session_id: string
  team_id: string
  updated_at?: string
}

interface RevisionRow {
  task_id: string
  revision_count?: number
  previous_result?: string | null
  user_feedback?: string[]
  updated_at?: string
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
.weave-dag-wrap{position:relative;overflow:auto;margin:8px 0}
.weave-dag-node{position:absolute;box-sizing:border-box;background:var(--dsw-specific-menu);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:6px 8px;display:flex;flex-direction:column;gap:2px;cursor:pointer}
.weave-dag-node:hover{border-color:var(--dsw-alias-label-tertiary)}
.weave-dag-node[data-selected="true"]{outline:2px solid var(--dsw-alias-label-primary);outline-offset:1px}
.weave-dag-node b{font-size:12px;font-weight:550;color:var(--dsw-alias-label-primary);line-height:16px}
.weave-dag-node .weave-muted{font-size:11px;line-height:14px}
`
  document.head.appendChild(style)
}

/* ------------------------------- 应用工厂 ------------------------------- */

function createApp(React: any, createPortal?: (node: any, container: Element) => any, callRpc?: RpcCaller): any {
  const { useState, useCallback, useEffect } = React

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

  const askConfirm = (message: string): boolean => Boolean(window.confirm(message))

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

  const Pager = ({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (next: number) => void }) => {
    const pages = Math.max(1, Math.ceil(total / pageSize))
    return React.createElement(
      'div',
      { className: 'weave-actions', 'data-testid': 'pager' },
      React.createElement('span', { className: 'weave-muted' }, `共 ${total} 条 · 第 ${page} / ${pages} 页`),
      React.createElement(
        'button',
        { className: 'weave-button weave-button-secondary weave-button-small', type: 'button', disabled: page <= 1, onClick: () => onPage(page - 1) },
        '上一页',
      ),
      React.createElement(
        'button',
        { className: 'weave-button weave-button-secondary weave-button-small', type: 'button', disabled: page >= pages, onClick: () => onPage(page + 1) },
        '下一页',
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
          meta: React.createElement('span', null, data.taskError ? missing : '进入任务中心查看依赖图与状态。'),
          onClick: () => navigate('tasks'),
          testId: 'overview-card-tasks',
        }),
        Card({
          title: `熔断/禁用任务（${data.banned ?? (data.tasks === undefined ? '—' : 0)}）`,
          meta: React.createElement('span', null, data.taskError ? missing : '熔断状态任务数量。'),
          onClick: () => navigate('tasks'),
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
    maxConcurrent: '1',
    personality: DEFAULT_PERSONALITY,
    provider: '',
    model: '',
    thoughtLevel: '',
    mode: '',
    fallbackProvider: '',
    fallbackModel: '',
  })

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

    const [teamId, setTeamId] = useState('')
    const [name, setName] = useState('')
    const [roles, setRoles] = useState([blankRole()] as RoleDraft[])
    const [editingTeamId, setEditingTeamId] = useState('')
    const [detailTeamId, setDetailTeamId] = useState(null as string | null)
    const creator = useAction()

    const updateRole = (index: number, key: keyof RoleDraft, value: string) => {
      setRoles((current: RoleDraft[]) => current.map((role, i) => (i === index ? { ...role, [key]: value } : role)))
    }

    const addRole = () =>
      setRoles((current: RoleDraft[]) => [...current, { ...blankRole(), executor: current[current.length - 1]?.executor ?? '' }])
    const removeRole = (index: number) => {
      setRoles((current: RoleDraft[]) => (current.length > 1 ? current.filter((_role, i) => i !== index) : current))
    }

    const submit = async (event: { preventDefault(): void }) => {
      event.preventDefault()
      await creator.run(async () => {
        const fallbackExecutor = executors[0]?.id ?? ''
        const separator = String.fromCharCode(92)
        const builtRoles = roles.map((draft: RoleDraft, index: number) => {
          const suffix = index > 0 ? `-${index + 1}` : ''
          const stages = draft.stages.split(',').map((part: string) => part.trim()).filter(Boolean)
          const maxConcurrent = Number.parseInt(draft.maxConcurrent, 10)
          const role: Json = {
            id: draft.id.trim() || `member${suffix}`,
            name: draft.name.trim() || '成员',
            bias: draft.bias.trim() || 'dev',
            executor: draft.executor || fallbackExecutor,
            stages,
            max_concurrent_tasks: Number.isInteger(maxConcurrent) && maxConcurrent > 0 ? maxConcurrent : 1,
            personality: draft.personality,
          }
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
            if (draft.thoughtLevel) role.thought_level = draft.thoughtLevel
            if (draft.mode) role.mode = draft.mode
          } else {
            if (draft.provider) role.provider = draft.provider
            if (draft.model) role.model = draft.model
          }
          if (draft.fallbackProvider && draft.fallbackModel) {
            role.fallback_provider = draft.fallbackProvider
            role.fallback_model = draft.fallbackModel
          }
          return role
        })
        const resolvedId =
          (editingTeamId || teamId || name || 'team').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'team'
        const executorLimits: Json = {}
        for (const role of builtRoles) {
          const key = String(role.executor ?? 'spawn')
          if (!(key in executorLimits)) executorLimits[key] = { max_concurrent: 1, max_per_hour: 20 }
        }
        await rpc('team/import', {
          overwrite: true,
          config: {
            schema_version: '1',
            team_id: resolvedId,
            name: name.trim() || resolvedId,
            default: false,
            roles: builtRoles,
            task_decomposition: {
              matchers: [],
              default_difficulty: 'hard',
              dag_templates: Object.fromEntries(
                ['easy', 'medium', 'hard', 'critical'].map((level) => [level, ['prepare', 'implement', 'review']]),
              ),
            },
            knowledge_injection: { max_entries: 3, max_chars_per_entry: 2000, max_total_chars: 6000, priority: 'freshness_first' },
            feedback: { feedback_timeout_seconds: 1800, max_revisions: 2, reopen_window_seconds: 86400 },
            executor_limits: executorLimits,
          },
        })
        setTeamId('')
        setName('')
        setRoles([blankRole()])
        setEditingTeamId('')
        void snapshot.refresh()
        return `${editingTeamId ? '已更新' : '已保存'}：${resolvedId}（${builtRoles.length} 个角色）`
      })
    }

    // 快照到达后，为尚未选择执行器的角色补默认值（取实际注册的第一个执行器，有什么显示什么，不强制 ZCode）。
    useEffect(() => {
      const firstExecutor = ((snapshot.data?.executors ?? [])[0] as ExecutorInfo | undefined)?.id ?? ''
      if (firstExecutor === '') return
      setRoles((current: RoleDraft[]) =>
        current.some((role: RoleDraft) => role.executor === '')
          ? current.map((role: RoleDraft) => (role.executor === '' ? { ...role, executor: firstExecutor } : role))
          : current,
      )
    }, [snapshot.data])

    const remover = useAction()
    const loader = useAction()
    const removeTeam = async (id: string) => {
      if (!askConfirm(`确认删除团队 ${id}？将同时移除其 YAML 配置文件，且不可恢复。`)) return
      await remover.run(async () => {
        await rpc('team/delete', { teamId: id })
        void snapshot.refresh()
        return `已删除：${id}`
      })
    }

    const roleToDraft = (role: Json): RoleDraft => ({
      id: String(role.id ?? ''),
      name: String(role.name ?? ''),
      bias: String(role.bias ?? ''),
      executor: String(role.executor ?? ''),
      stages: Array.isArray(role.stages) ? (role.stages as string[]).join(',') : String(role.stages ?? ''),
      maxConcurrent: String(role.max_concurrent_tasks ?? '1'),
      personality: String(role.personality ?? ''),
      provider: String(role.provider ?? ''),
      model: String(role.model ?? ''),
      thoughtLevel: String(role.thought_level ?? ''),
      mode: String(role.mode ?? ''),
      fallbackProvider: String(role.fallback_provider ?? ''),
      fallbackModel: String(role.fallback_model ?? ''),
    })

    const loadTeam = async (id: string) => {
      await loader.run(async () => {
        const team = (await rpc('team/get', { teamId: id })) as {
          team_id?: string
          name?: string
          roles?: Json[]
        }
        setTeamId(String(team.team_id ?? id))
        setName(String(team.name ?? ''))
        setEditingTeamId(String(team.team_id ?? id))
        setRoles(Array.isArray(team.roles) && team.roles.length > 0 ? team.roles.map(roleToDraft) : [blankRole()])
        setDetailTeamId(null)
        return `已载入团队：${String(team.team_id ?? id)}，可修改后保存覆盖。`
      })
    }

    const models = capabilities?.models ?? []
    const modes = (capabilities?.modes ?? []).map((option: SelectOption) => option.value)
    const thoughts = (capabilities?.thoughtLevels ?? []).map((option: SelectOption) => option.value)

    const roleField = (index: number, label: string, key: keyof RoleDraft, placeholder = '', type = 'text') =>
      React.createElement(
        'label',
        { className: 'weave-field' },
        React.createElement('span', null, label),
        type === 'textarea'
          ? React.createElement('textarea', {
              value: roles[index]?.[key] ?? '',
              onChange: (event: { target: { value: string } }) => updateRole(index, key, event.target.value),
              rows: 2,
            })
          : React.createElement('input', {
              type,
              value: roles[index]?.[key] ?? '',
              placeholder,
              onChange: (event: { target: { value: string } }) => updateRole(index, key, event.target.value),
            }),
      )

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
      const thoughtSupported = caps?.thoughtControl === true
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


    return React.createElement(
      'section',
      { className: 'weave-page', 'data-testid': 'page-teams' },
      React.createElement('h1', null, '团队'),
      Note({
        text: snapshot.loading
          ? '正在加载...'
          : snapshot.error || loader.note || creator.note || remover.note || '创建或编辑后会写入 ~/.dsh/teams 并通过完整校验。',
      }),
      snapshot.error ? Note({ text: snapshot.error, kind: 'error' }) : null,
      creator.ok === false || remover.ok === false ? Note({ text: creator.note || remover.note, kind: 'error' }) : null,
      React.createElement(
        'div',
        { className: 'weave-layout' },
        React.createElement(
          'form',
          { className: 'weave-form', onSubmit: submit },
          React.createElement(
            'label',
            { className: 'weave-field' },
            React.createElement('span', null, '团队 ID'),
            React.createElement('input', {
              'data-testid': 'team-id-input',
              value: teamId,
              placeholder: 'my-team',
              onChange: (event: { target: { value: string } }) => setTeamId(event.target.value),
            }),
          ),
          React.createElement(
            'label',
            { className: 'weave-field' },
            React.createElement('span', null, '名称'),
            React.createElement('input', {
              'data-testid': 'team-name-input',
              value: name,
              placeholder: '我的团队',
              onChange: (event: { target: { value: string } }) => setName(event.target.value),
            }),
          ),
          ...roles.map((_draft: RoleDraft, index: number) =>
            React.createElement(
              'fieldset',
              { className: 'weave-role', key: `role-${index}`, 'data-testid': `role-editor-${index}` },
              React.createElement(
                'div',
                { className: 'weave-role-head' },
                React.createElement('span', null, `角色 ${index + 1}`),
                roles.length > 1
                  ? React.createElement(
                      'button',
                      { className: 'weave-button weave-button-secondary weave-button-small', type: 'button', onClick: () => removeRole(index) },
                      '删除角色',
                    )
                  : null,
              ),
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
                roleField(index, '最大并发任务', 'maxConcurrent', '1', 'number'),
              ),
              roles[index]?.executor === 'zcode'
                ? React.createElement(
                    'div',
                    { className: 'weave-role-grid' },
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
                    { className: 'weave-role-grid' },
                    ...roleLinkedModelFields(index),
                    ...roleAdvancedFields(index),
                    ...roleFallbackLinkedFields(index),
                  ),
              roleField(index, '角色提示词', 'personality', '', 'textarea'),
            ),
          ),
          React.createElement(
            'button',
            { className: 'weave-button weave-button-secondary', type: 'button', onClick: addRole, 'data-testid': 'team-add-role' },
            '＋ 添加角色',
          ),
          React.createElement(
            'button',
            { className: 'weave-button', type: 'submit', disabled: creator.busy, 'data-testid': 'team-create-submit' },
            creator.busy ? '保存中' : `${editingTeamId ? '更新团队' : '创建团队'}（包含 ${roles.length} 个角色）`,
          ),
        ),
        React.createElement(
          'div',
          { className: 'weave-panel' },
          React.createElement(
            'button',
            { className: 'weave-button weave-button-secondary', type: 'button', onClick: () => void snapshot.refresh() },
            '刷新',
          ),
          ...(teams.length
            ? teams.map((team: TeamSummaryRow) => {
                const id = String(team.team_id ?? '')
                return React.createElement(
                  'article',
                  { className: 'weave-list-item', key: id },
                  React.createElement(
                    'div',
                    { className: 'weave-list-head' },
                    React.createElement('b', null, `${String(team.name ?? id)}${team.default ? '（默认）' : ''}`),
                    React.createElement(Pill, { label: id }),
                    React.createElement(
                      'button',
                      {
                        className: 'weave-button weave-button-secondary weave-button-small',
                        type: 'button',
                        'data-testid': `team-detail-${id}`,
                        onClick: () => setDetailTeamId(detailTeamId === id ? null : id),
                      },
                      detailTeamId === id ? '收起详情' : '详情',
                    ),
                    React.createElement(
                      'button',
                      {
                        className: 'weave-button weave-button-secondary weave-button-small',
                        type: 'button',
                        'data-testid': `team-edit-${id}`,
                        disabled: loader.busy,
                        onClick: () => void loadTeam(id),
                      },
                      '编辑',
                    ),
                    React.createElement(
                      'button',
                      {
                        className: 'weave-button weave-button-secondary weave-button-small',
                        type: 'button',
                        'data-testid': `team-delete-${id}`,
                        disabled: remover.busy,
                        onClick: () => void removeTeam(id),
                      },
                      '删除',
                    ),
                  ),
                  React.createElement(
                    'span',
                    { className: 'weave-muted' },
                    Array.isArray(team.roles)
                      ? team.roles.map((role: Json) => `${String(role.id ?? '?')}/${String(role.executor ?? '?')}`).join(', ')
                      : '',
                  ),
                  detailTeamId === id
                    ? React.createElement(
                        'div',
                        { className: 'weave-detail', 'data-testid': `team-detail-content-${id}` },
                        React.createElement('b', null, String(team.name ?? id)),
                        React.createElement('span', { className: 'weave-muted' }, `ID：${id}${team.default ? ' · 默认团队' : ''}`),
                        ...(Array.isArray(team.roles) && team.roles.length > 0
                          ? team.roles.map((role: Json, roleIndex: number) =>
                              React.createElement(
                                'div',
                                { className: 'weave-detail-role', key: `${id}-role-${roleIndex}` },
                                React.createElement(
                                  'b',
                                  null,
                                  `${String(role.name ?? role.id ?? '角色')}（${String(role.executor ?? '?')}）`,
                                ),
                                React.createElement(
                                  'span',
                                  { className: 'weave-muted' },
                                  `模型：${String(role.model ?? '继承默认')} · 思考：${String(role.thought_level ?? '继承默认')} · 模式：${String(role.mode ?? '继承默认')}`,
                                ),
                                React.createElement(
                                  'span',
                                  { className: 'weave-muted' },
                                  `阶段：${Array.isArray(role.stages) ? (role.stages as string[]).join(', ') : String(role.stages ?? '')}`,
                                ),
                                role.personality
                                  ? React.createElement('p', { className: 'weave-detail-personality' }, String(role.personality))
                                  : null,
                              ),
                            )
                          : [React.createElement('span', { key: 'no-roles', className: 'weave-muted' }, '该团队暂无角色')]),
                      )
                    : null,
                )
              })
            : [
                EmptyState({
                  title: '暂无可用团队',
                  reason: snapshot.error ? `加载失败：${snapshot.error}` : '请先创建一个团队，或检查执行器注册状态。',
                }),
              ]),
        ),
      ),
    )
  }

  /* ------------------------------ 任务依赖图（t9） ------------------------------ */

  const DAG_CELL_W = 170
  const DAG_CELL_H = 56
  const DAG_LEVEL_GAP = 56
  const DAG_ROW_GAP = 18

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
    onSelect: (taskId: string) => void
  }

  function DagGraph({ dag, selectedId, onSelect }: DagGraphProps) {
    const tasks = dag.tasks ?? []
    const edges = dag.edges ?? []
    const levels = computeDagLevels(tasks, edges)
    const byLevel = new Map<number, TaskRow[]>()
    for (const task of tasks) {
      const id = String(task.id ?? '')
      const lv = levels.get(id) ?? 0
      const group = byLevel.get(lv) ?? []
      group.push(task)
      byLevel.set(lv, group)
    }
    const layout: Array<{ task: TaskRow; id: string; x: number; y: number }> = []
    for (const [lv, group] of [...byLevel.entries()].sort((a, b) => a[0] - b[0])) {
      group.forEach((task, index) =>
        layout.push({
          task,
          id: String(task.id ?? ''),
          x: lv * (DAG_CELL_W + DAG_LEVEL_GAP),
          y: index * (DAG_CELL_H + DAG_ROW_GAP),
        }),
      )
    }
    const pos = new Map(layout.map((node) => [node.id, node]))
    const maxLevel = Math.max(0, ...[...byLevel.keys()])
    const maxRows = Math.max(1, ...[...byLevel.values()].map((group) => group.length))
    const width = (maxLevel + 1) * DAG_CELL_W + maxLevel * DAG_LEVEL_GAP
    const height = maxRows * DAG_CELL_H + Math.max(0, maxRows - 1) * DAG_ROW_GAP
    return React.createElement(
      'div',
      { className: 'weave-dag-wrap', 'data-testid': 'dag-panel' },
      React.createElement(
        'svg',
        { width, height, style: { position: 'absolute', inset: 0, pointerEvents: 'none' }, 'data-testid': 'dag-edges' },
        React.createElement(
          'defs',
          null,
          React.createElement(
            'marker',
            { id: 'weave-dag-arrow', markerWidth: 8, markerHeight: 8, refX: 8, refY: 4, orient: 'auto' },
            React.createElement('path', { d: 'M0,0 L8,4 L0,8 z', fill: '#999' }),
          ),
        ),
        ...edges.map((edge) => {
          const from = pos.get(String(edge.from))
          const to = pos.get(String(edge.to))
          if (!from || !to) return null
          return React.createElement('line', {
            key: String(edge.from) + '->' + String(edge.to),
            'data-edge': String(edge.from) + '->' + String(edge.to),
            x1: from.x + DAG_CELL_W,
            y1: from.y + DAG_CELL_H / 2,
            x2: to.x,
            y2: to.y + DAG_CELL_H / 2,
            stroke: '#999',
            strokeWidth: 1.5,
            markerEnd: 'url(#weave-dag-arrow)',
          })
        }),
      ),
      ...layout.map((node) =>
        React.createElement(
          'div',
          {
            key: node.id,
            className: 'weave-dag-node',
            'data-testid': 'dag-node-' + node.id,
            'data-selected': node.id === selectedId ? 'true' : 'false',
            onClick: () => onSelect(node.id),
            title: String(node.task.description ?? ''),
            style: {
              left: node.x,
              top: node.y,
              width: DAG_CELL_W,
              minHeight: DAG_CELL_H,
              borderLeft: '4px solid ' + (DAG_STATUS_COLORS[String(node.task.status ?? '')] ?? '#8c8c8c'),
            },
          },
          React.createElement('b', null, node.id),
          React.createElement('span', { className: 'weave-muted', 'data-status': String(node.task.status ?? ''), title: String(node.task.status ?? '') }, labelOf(TASK_STATUS_LABELS, node.task.status)),
          React.createElement('span', { className: 'weave-muted' }, String(node.task.assigned_agent ?? '未分配')),
        ),
      ),
    )
  }

  /* ============================== 任务中心 ============================== */

  const TASK_PAGE_SIZE = 20

  function TasksPage() {
    const [appliedSearch, setAppliedSearch] = useState('')
    const [searchDraft, setSearchDraft] = useState('')
    const [status, setStatus] = useState('')
    const [page, setPage] = useState(1)

    const list = useResource<{ total?: number; tasks?: TaskRow[] }>(async () => {
      const payload: Json = { page, pageSize: TASK_PAGE_SIZE }
      if (appliedSearch !== '') payload.search = appliedSearch
      if (status !== '') payload.status = status
      return (await rpc('task/list', payload)) as { total?: number; tasks?: TaskRow[] }
    }, [appliedSearch, status, page])
    const rows = list.data?.tasks ?? []
    const total = safeNum(list.data?.total) ?? 0

    const actor = useAction()
    const runAction = async (taskId: string, action: string, needsConfirm: boolean, label: string) => {
      if (needsConfirm && !askConfirm(`确认对任务 ${taskId} 执行「${label}」？`)) return
      await actor.run(async () => {
        await rpc('task/action', { action, taskId })
        void list.refresh()
        return `已${label}：${taskId}`
      })
    }

    const [detailId, setDetailId] = useState('')
    const detail = useResource<TaskDagDetail | undefined>(
      async () => {
        if (detailId === '') return undefined
        return (await rpc('task/get', { taskId: detailId })) as TaskDagDetail
      },
      [detailId],
    )

    const actionsFor = (row: TaskRow) => TASK_ACTIONS_BY_STATUS[String(row.status ?? '')] ?? []
    return React.createElement(
      'section',
      { className: 'weave-page', 'data-testid': 'page-tasks' },
      React.createElement('h1', null, '任务中心'),
      Note({
        text: list.loading
          ? '正在加载...'
          : list.error || actor.note || '任务由当前 DSH 会话发起；Web 控制台仅提供列表、详情与治理操作，不下发新任务。列表来自真实 tasks.db，操作经 14 态权威矩阵校验。',
      }),
      list.error ? Note({ text: list.error, kind: 'error' }) : null,
      actor.ok === false ? Note({ text: actor.note, kind: 'error' }) : null,
      React.createElement(
        'form',
        {
          className: 'weave-toolbar',
          onSubmit: (event: { preventDefault(): void }) => {
            event.preventDefault()
            setPage(1)
            setAppliedSearch(searchDraft.trim())
          },
        },
        React.createElement('input', {
          'data-testid': 'task-search',
          value: searchDraft,
          placeholder: '搜索描述 / 任务 ID',
          className: 'weave-control',
          style: { minWidth: 220 },
          onChange: (event: { target: { value: string } }) => setSearchDraft(event.target.value),
        }),
        React.createElement(
          'select',
          {
            'data-testid': 'task-status-filter',
            value: status,
            className: 'weave-control',
            onChange: (event: { target: { value: string } }) => {
              setStatus(event.target.value)
              setPage(1)
            },
          },
          React.createElement('option', { value: '' }, '全部状态'),
          ...TASK_STATUSES.map((value: string) => React.createElement(
            'option',
            { key: value, value },
            labelOf(TASK_STATUS_LABELS, value),
          )),
        ),
        React.createElement('button', { className: 'weave-button weave-button-secondary', type: 'submit' }, '查询'),
        React.createElement(
          'button',
          { className: 'weave-button weave-button-secondary', type: 'button', onClick: () => void list.refresh() },
          '刷新',
        ),
      ),
      React.createElement(
        'div',
        { className: 'weave-layout' },
        React.createElement(
          'div',
          { className: 'weave-list' },
          ...(list.error
            ? [
                EmptyState({
                  title: '任务列表不可用',
                  reason: `${list.error}（若提示 invalid_argument 或 configuration_error，说明 task 端点尚未接入 RPC）`,
                }),
              ]
            : rows.length
              ? rows.map((row: TaskRow) => {
                  const id = String(row.id ?? '')
                  return React.createElement(
                    'article',
                    { className: 'weave-list-item', key: id, 'data-testid': `task-row-${id}` },
                    React.createElement(
                      'div',
                      { className: 'weave-list-head' },
                      React.createElement(Pill, { label: labelOf(TASK_STATUS_LABELS, row.status), tone: toneOf(String(row.status ?? '')), title: String(row.status ?? '') }),
                      React.createElement('b', null, id),
                    ),
                    React.createElement('span', { className: 'weave-muted' }, String(row.description ?? '')),
                    React.createElement(
                      'span',
                      { className: 'weave-muted' },
                      `${String(row.team_id ?? '—')} · ${String(row.project_id ?? '—')} v${String(row.version ?? '—')} · 更新 ${fmtTime(row.updated_at)}`,
                    ),
                    React.createElement(
                      'div',
                      { className: 'weave-actions' },
                      React.createElement(
                        'button',
                        {
                          className: 'weave-button weave-button-secondary weave-button-small',
                          type: 'button',
                          'data-testid': `task-detail-toggle-${id}`,
                          onClick: () => setDetailId((current: string) => (current === id ? '' : id)),
                        },
                        detailId === id ? '收起详情' : '详情',
                      ),
                      ...actionsFor(row).map((entry) =>
                        React.createElement(
                          'button',
                          {
                            key: entry.action,
                            className: 'weave-button weave-button-secondary weave-button-small',
                            type: 'button',
                            disabled: actor.busy,
                            'data-testid': `task-action-${entry.action}-${id}`,
                            onClick: () => void runAction(id, entry.action, entry.confirm === true, entry.label),
                          },
                          entry.label,
                        ),
                      ),
                    ),
                  )
                })
              : [
                  EmptyState({
                    title: '暂无任务',
                    reason: list.loading ? '正在加载...' : '当前过滤条件下没有任务；任务由当前 DSH 会话发起。',
                  }),
                ]),
          rows.length > 0 ? Pager({ page, pageSize: TASK_PAGE_SIZE, total, onPage: setPage }) : null,
        ),
        React.createElement(
          'div',
          { style: { display: 'grid', gap: 16, alignContent: 'start' } },
          detailId !== ''
            ? React.createElement(
                'div',
                { className: 'weave-panel', 'data-testid': 'task-detail' },
                React.createElement('b', { className: 'weave-subh' }, `依赖图详情：${detailId}`),
                detail.loading || detail.error || !detail.data ? null : React.createElement(DagGraph, { dag: detail.data as TaskDagDetail, selectedId: detailId, onSelect: (next: string) => setDetailId(next) }),
                detail.loading
                  ? React.createElement('span', { className: 'weave-muted' }, '正在加载...')
                  : detail.error
                    ? React.createElement('span', { className: 'weave-muted' }, `加载失败：${detail.error}`)
                    : React.createElement(
                        React.Fragment,
                        null,
                        React.createElement(
                          'span',
                          { className: 'weave-muted' },
                          `依赖图 ID=${String(detail.data?.dag_id ?? '—')} · 状态 ${labelOf(TASK_STATUS_LABELS, detail.data?.status)}`,
                        ),
                        ...(detail.data?.edges ?? []).map((edge: { from: string; to: string }, index: number) =>
                          React.createElement('span', { className: 'weave-muted', key: `edge-${index}` }, `${edge.from} → ${edge.to}`),
                        ),
                        (detail.data?.edges ?? []).length === 0
                          ? React.createElement('span', { className: 'weave-muted' }, '无依赖边（单任务依赖图或早期记录）。')
                          : null,
                        ...(detail.data?.tasks ?? []).map((task: TaskRow) =>
                          React.createElement(
                            'div',
                            { className: 'weave-list-head', key: String(task.id ?? '') },
                            React.createElement(Pill, { label: labelOf(TASK_STATUS_LABELS, task.status), tone: toneOf(String(task.status ?? '')), title: String(task.status ?? '') }),
                            React.createElement('span', { className: 'weave-muted' }, String(task.id ?? '')),
                          ),
                        ),
                      ),
              )
            : null,
        ),
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
    const [selectedNodeId, setSelectedNodeId] = useState('')
    const [copiedPath, setCopiedPath] = useState(false)
    const [graphStatus, setGraphStatus] = useState('')
    const [graphLayer, setGraphLayer] = useState('')

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
        return (await rpc('knowledge/graph', payload)) as KnowledgeGraphData
      },
      [graphStatus, graphLayer],
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
    const reject = async (id: string) => {
      if (!askConfirm(`确认驳回知识条目 ${id}？其状态将置为 deprecated。`)) return
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

  function SessionsPage() {
    const bindings = useResource<{ bindings?: BindingRow[] }>(
      () => rpc('session/bindings') as Promise<{ bindings?: BindingRow[] }>,
      [],
    )
    const revisions = useResource<{ revisions?: RevisionRow[] }>(
      () => rpc('session/revisions', { limit: 20 }) as Promise<{ revisions?: RevisionRow[] }>,
      [],
    )

    const [sessionId, setSessionId] = useState('')
    const [teamId, setTeamId] = useState('')
    const setter = useAction()
    const setBinding = async (event: { preventDefault(): void }) => {
      event.preventDefault()
      await setter.run(async () => {
        await rpc('session/set-binding', { sessionId, teamId })
        void bindings.refresh()
        return `已绑定：${sessionId} → ${teamId}`
      })
    }

    const unbinder = useAction()
    const unbind = async (id: string) => {
      if (!askConfirm(`确认解除会话 ${id} 的团队绑定？`)) return
      await unbinder.run(async () => {
        await rpc('session/clear-binding', { sessionId: id })
        void bindings.refresh()
        return `已解绑：${id}`
      })
    }

    const rows = bindings.data?.bindings ?? []
    const revisionRows = revisions.data?.revisions ?? []

    return React.createElement(
      'section',
      { className: 'weave-page', 'data-testid': 'page-sessions' },
      React.createElement('h1', null, '会话管理'),
      Note({
        text: bindings.loading
          ? '正在加载...'
          : bindings.error || revisions.error || setter.note || unbinder.note || '绑定关系存储于 core.db 的 team_bindings 表。',
      }),
      bindings.error || revisions.error ? Note({ text: bindings.error || revisions.error, kind: 'error' }) : null,
      setter.ok === false || unbinder.ok === false ? Note({ text: setter.note || unbinder.note, kind: 'error' }) : null,
      React.createElement(
        'form',
        { className: 'weave-toolbar', onSubmit: setBinding },
        React.createElement('input', {
          className: 'weave-control',
          'data-testid': 'binding-session-input',
          value: sessionId,
          placeholder: '会话 ID',
          onChange: (event: { target: { value: string } }) => setSessionId(event.target.value),
        }),
        React.createElement('input', {
          className: 'weave-control',
          'data-testid': 'binding-team-input',
          value: teamId,
          placeholder: '团队 ID',
          onChange: (event: { target: { value: string } }) => setTeamId(event.target.value),
        }),
        React.createElement(
          'button',
          {
            className: 'weave-button',
            type: 'submit',
            disabled: setter.busy || sessionId === '' || teamId === '',
            'data-testid': 'binding-set',
          },
          setter.busy ? '绑定中' : '绑定会话到团队',
        ),
      ),
      React.createElement(
        'div',
        { className: 'weave-layout' },
        React.createElement(
          'div',
          { className: 'weave-list' },
          React.createElement('b', { className: 'weave-subh' }, '当前绑定'),
          bindings.error
            ? EmptyState({ title: '绑定列表不可用', reason: `${bindings.error}（session/bindings 尚未接入时会出现此提示）` })
            : rows.length
              ? rows.map((row: BindingRow) =>
                  React.createElement(
                    'article',
                    { className: 'weave-list-item', key: row.session_id, 'data-testid': `binding-row-${row.session_id}` },
                    React.createElement(
                      'div',
                      { className: 'weave-list-head' },
                      React.createElement('b', null, row.session_id),
                      React.createElement(Pill, { label: row.team_id }),
                      React.createElement(
                        'button',
                        {
                          className: 'weave-button weave-button-secondary weave-button-small',
                          type: 'button',
                          disabled: unbinder.busy,
                          'data-testid': `binding-unbind-${row.session_id}`,
                          onClick: () => void unbind(row.session_id),
                        },
                        '解绑',
                      ),
                    ),
                    React.createElement('span', { className: 'weave-muted' }, `更新于 ${fmtTime(row.updated_at)}`),
                  ),
                )
              : EmptyState({ title: '暂无会话绑定', reason: bindings.loading ? '正在加载...' : '还没有会话与团队建立绑定。' }),
        ),
        React.createElement(
          'div',
          { className: 'weave-list' },
          React.createElement('b', { className: 'weave-subh' }, '最近修订记录'),
          revisions.error
            ? EmptyState({ title: '修订记录不可用', reason: `${revisions.error}（session/revisions 尚未接入时会出现此提示）` })
            : revisionRows.length
              ? revisionRows.map((row: RevisionRow) =>
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
                )
              : EmptyState({ title: '暂无修订记录', reason: revisions.loading ? '正在加载...' : 'feedback.db 中尚无修订记录。' }),
        ),
      ),
    )
  }

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
        React.createElement('button', { className: 'weave-button weave-button-secondary', type: 'submit' }, '查询'),
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
    { cmd: '/weave team list', desc: '查看全部团队与角色' },
    { cmd: '/weave team switch <team_id>', desc: '切换当前会话团队' },
    { cmd: '/weave task submit <描述> --project <id> --version <v> [--team <id>]', desc: '提交任务（任务入口仍在当前 DSH 会话）' },
    { cmd: '/weave task status --dag <dag_id> | --task <task_id>', desc: '查看任务/依赖图状态' },
    { cmd: '/weave task revise <task_id> <反馈>', desc: '对保温期任务反馈返工' },
    { cmd: '/weave task accept <task_id>', desc: '验收任务' },
    { cmd: '/weave task retry|skip|cancel|reopen <task_id>', desc: '任务生命周期治理操作' },
    { cmd: '/weave executor list', desc: '列出当前实际注册的执行器' },
    { cmd: '/weave dag <dag_id>', desc: '查看任务依赖图' },
    { cmd: '/weave provider add <JSON|YAML|文件路径|紧凑配置>', desc: '注册一个或多个外部 ACP 执行器' },
    { cmd: '/weave provider list', desc: '列出已持久化的动态 Provider' },
    { cmd: '/weave provider remove <name>', desc: '移除并注销动态 Provider' },
    { cmd: '/weave knowledge review', desc: '知识候选队列' },
    { cmd: '/weave knowledge approve <id>', desc: '知识审核通过' },
    { cmd: '/weave knowledge reject <id> <原因>', desc: '知识驳回' },
    { cmd: '/weave ban list', desc: '查看熔断/冷却实体' },
    { cmd: '启用 <团队ID> / 切换 <团队> / 关闭团队', desc: '当前会话自然语言启停团队（无需前缀）' },
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
      tasks: React.createElement(TasksPage),
      knowledge: React.createElement(KnowledgePage),
      executors: React.createElement(ExecutorsPage),
      sessions: React.createElement(SessionsPage),
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

  function WeaveSessionDag() {
    const snapshot = useResource<SnapshotData>(() => rpc('snapshot') as Promise<SnapshotData>, [])
    const teams = snapshot.data?.teams ?? []
    const currentTeam = teams.find((team: TeamSummaryRow) => team.default) ?? teams[0]
    const latest = useResource<{ tasks?: TaskRow[] }>(
      () => rpc('task/list', { limit: 1 }) as Promise<{ tasks?: TaskRow[] }>,
      [],
    )
    const firstTaskId = latest.data?.tasks?.[0]?.id
    const detail = useResource<TaskDagDetail | undefined>(
      () => (firstTaskId ? rpc('task/get', { taskId: firstTaskId }) as Promise<TaskDagDetail> : Promise.resolve(undefined)),
      [firstTaskId],
    )
    const [selectedId, setSelectedId] = useState('')
    const dag = detail.data
    const refresh = () => {
      void snapshot.refresh()
      void latest.refresh()
      if (firstTaskId) void detail.refresh()
    }
    useEffect(() => {
      const timer = setInterval(refresh, 5000)
      return () => clearInterval(timer)
    }, [snapshot.refresh, latest.refresh, detail.refresh, firstTaskId])
    const memberRows = currentTeam?.roles ?? []
    return React.createElement(
      'div',
      { className: 'weave-session-dag', 'data-testid': 'weave-session-dag' },
      React.createElement(
        'div',
        { className: 'weave-session-section' },
        React.createElement('b', null, '队员状态'),
        React.createElement(
          'span',
          { className: 'weave-muted' },
          `团队：${String(currentTeam?.name ?? '未绑定')}（${String(currentTeam?.team_id ?? '—')}）`,
        ),
        ...(memberRows.length > 0
          ? memberRows.map((role: Json, index: number) =>
              React.createElement(
                'div',
                { className: 'weave-session-member', key: `member-${index}` },
                React.createElement('b', null, `${String(role.name ?? role.id ?? '成员')}（${String(role.executor ?? '?')}）`),
                React.createElement(
                  'span',
                  { className: 'weave-muted' },
                  `模型：${String(role.model ?? '继承默认')} · 思考：${String(role.thought_level ?? '继承默认')} · 模式：${String(role.mode ?? '继承默认')}`,
                ),
              ),
            )
          : [React.createElement('span', { key: 'no-team', className: 'weave-muted' }, '暂无团队')]),
      ),
      React.createElement(
        'div',
        { className: 'weave-session-section' },
        React.createElement('b', null, '任务 DAG'),
        React.createElement(
          'button',
          {
            className: 'weave-button weave-button-secondary weave-button-small',
            type: 'button',
            'data-testid': 'weave-session-dag-refresh',
            onClick: refresh,
          },
          '刷新',
        ),
        latest.loading || detail.loading
          ? React.createElement('span', { className: 'weave-muted' }, '加载中...')
          : latest.error || detail.error
            ? React.createElement('span', { className: 'weave-muted' }, String(latest.error || detail.error))
            : !dag
              ? React.createElement('span', { className: 'weave-muted' }, '暂无任务 DAG')
              : React.createElement(
                  'div',
                  { className: 'weave-session-dag-body' },
                  React.createElement(
                    'span',
                    { className: 'weave-muted' },
                    `DAG：${String(dag.dag_id ?? '')} · ${(dag.tasks ?? []).length} 个任务`,
                  ),
                  React.createElement(DagGraph, {
                    dag: dag as TaskDagDetail,
                    selectedId: selectedId || String((dag.tasks ?? [])[0]?.id ?? ''),
                    onSelect: (next: string) => setSelectedId(next),
                  }),
                ),
      ),
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

  return { WeaveSidebarAction, WeaveSessionDag }
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
        const result = await connection.rpc.call('/dsh-weave', endpoint, payload ?? {})
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

      const sessionDag = app.WeaveSessionDag
      ctx.effect(
        () =>
          ctx.slots.inject('conversation.view', () =>
            ctx.slots.register(
              {
                name: 'conversation.view',
                id: PLUGIN_ID,
                order: 70,
                label: () => 'Weave DAG',
              },
              sessionDag,
            ),
          ),
        'dsh-weave conversation dag view',
      )

    }

    const module = { exports: {} as Record<string, unknown> }
    module.exports.apply = localApply
    module.exports.inject = ['slots', 'connection']
    return module.exports
  },
})
