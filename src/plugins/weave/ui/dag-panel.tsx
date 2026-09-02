/// <reference lib="dom" />
import { useCallback, useEffect, useMemo, useState } from 'react'

import { TaskStateMachine } from '../state/task-state-machine.js'
import type { TaskDag, TaskRecord, TaskStatus } from '../state/types.js'
import type { DagRepository } from '../dag/repository.js'

/** 布局基准常量（轻量 SVG 视图）。作为 fitDagLayout 的缺省 base，保留导出供 client 侧同构对齐。 */
export const CELL_W = 200
export const CELL_H = 64
export const LEVEL_GAP = 48
export const ROW_GAP = 24

/** 自适应布局的 base 基准与 floor 下限（doc/05 §6.3）。client 侧 floor 须与此对齐。 */
export const DAG_BASE = { cellW: CELL_W, cellH: CELL_H, levelGap: LEVEL_GAP, rowGap: ROW_GAP }
export const DAG_FLOOR = { cellW: 56, cellH: 18, levelGap: 14, rowGap: 4 }

export interface DagViewportSize {
  w: number
  h: number
}

export interface DagLayoutBase {
  cellW: number
  cellH: number
  levelGap: number
  rowGap: number
}

export interface DagFitLayout extends DagLayoutBase {
  /** true = 收缩触底（任一值被钳到 floor），容器应回落滚动行为。 */
  overflow: boolean
}

/**
 * 自适应布局（doc/05 §6.3）：按视口等比收缩 base 布局，scale=min(1, vw/W, vh/H)
 * ——只缩不放；任一值低于 floor 钳到 floor 并置 overflow（容器回落滚动）。
 * 视口未测量（w/h ≤ 0）或退化输入时返回 base 原尺寸（与历史渲染逐字节一致）。
 *
 * @deprecated 主渲染已改为紧凑固定几何（compactDagLayout）；本函数仅为兼容保留导出，
 * 内部不再使用。doc/05 §6.3 的视口适配语义由滚动容器承接。
 */
export function fitDagLayout(
  viewport: DagViewportSize,
  maxLevel: number,
  maxRows: number,
  base: DagLayoutBase = DAG_BASE,
  floor: DagLayoutBase = DAG_FLOOR,
): DagFitLayout {
  const naturalW = maxLevel * (base.cellW + base.levelGap)
  const naturalH = maxRows * (base.cellH + base.rowGap)
  // NaN/非有限视口（未测量/异常数据）回落 base，防止 NaN 尺寸污染布局。
  if (
    !Number.isFinite(viewport.w) || !Number.isFinite(viewport.h) ||
    viewport.w <= 0 || viewport.h <= 0 || naturalW <= 0 || naturalH <= 0
  ) {
    return { ...base, overflow: false }
  }
  // 上限 12 仅作 sanity 防呆（正常由视口/内容比触顶）：竖屏下 3 倍帽会先于高度比
  // 触顶导致下方留白（用户实测），放开后高度比直接决定缩放。
  const scale = Math.min(12, viewport.w / naturalW, viewport.h / naturalH)
  const shrink = (value: number, floorValue: number): number => Math.max(floorValue, Math.round(value))
  const cellW = shrink(base.cellW * scale, floor.cellW)
  const cellH = shrink(base.cellH * scale, floor.cellH)
  const levelGap = shrink(base.levelGap * scale, floor.levelGap)
  const rowGap = shrink(base.rowGap * scale, floor.rowGap)
  const overflow =
    base.cellW * scale < floor.cellW ||
    base.cellH * scale < floor.cellH ||
    base.levelGap * scale < floor.levelGap ||
    base.rowGap * scale < floor.rowGap
  return { cellW, cellH, levelGap, rowGap, overflow }
}

/** 节点字号随 cellH 联动（base 64 → 10px，下限 8px）。 */
export function dagFontSize(cellH: number): number {
  return Math.max(8, Math.round((10 * cellH) / 64))
}

/** 状态 → 展示颜色（P0 面板用）。 */
export const STATUS_COLORS: Record<TaskStatus, string> = {
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
 * 层级布局：level = 最长依赖路径深度（dag.edges 与 task.dependencies 取并集）。
 * 纯函数，便于单测。
 */
export function computeLevels(dag: TaskDag): Map<string, number> {
  const deps = new Map<string, string[]>()
  const addDep = (from: string, to: string) => {
    const arr = deps.get(to) ?? []
    arr.push(from)
    deps.set(to, arr)
  }
  for (const task of dag.tasks) {
    for (const dep of task.dependencies) addDep(dep, task.id)
  }
  for (const edge of dag.edges) addDep(edge.from, edge.to)

  const level = new Map<string, number>()
  const visit = (id: string): number => {
    const cached = level.get(id)
    if (cached !== undefined) return cached
    level.set(id, 0)
    const upstream = deps.get(id) ?? []
    const lv = upstream.length === 0 ? 0 : Math.max(...upstream.map(visit)) + 1
    level.set(id, lv)
    return lv
  }
  for (const task of dag.tasks) visit(task.id)
  return level
}

/** 取消合法性按权威矩阵（TDD §2.1.5）：所有 → CANCELLED 的入边状态均可取消。 */
export function isCancelable(status: TaskStatus): boolean {
  return TaskStateMachine.canTransition(status, 'CANCELLED')
}

/* -------------------- 紧凑 DAG 布局（对齐参照物 ActivityPanel） -------------------- */

/** 参照物几何：节点固定 92×30，列间距 26、行间距 8；画布=内容精确尺寸，不缩放不铺满。 */
export const COMPACT_DAG_NODE_WIDTH = 92
export const COMPACT_DAG_NODE_HEIGHT = 30
export const COMPACT_DAG_COLUMN_GAP = 26
export const COMPACT_DAG_ROW_GAP = 8

/** 紧凑布局中的一个已定位节点。 */
export interface CompactDagNodeLayout {
  task: TaskRecord
  id: string
  x: number
  y: number
}

/** 一条短柄三次贝塞尔边：水平出入节点中线（M x1 y1 C x1+14 y1, x2-14 y2, x2 y2）。 */
export interface CompactDagEdgeLayout {
  from: string
  to: string
  path: string
}

/** 完整紧凑投影：width/height 即画布精确尺寸（放入滚动容器，不做视口适配）。 */
export interface CompactDagLayout {
  width: number
  height: number
  nodes: CompactDagNodeLayout[]
  edges: CompactDagEdgeLayout[]
}

/** 有效关系边：dag.edges 优先；缺失时回退由 task.dependencies 推导（并去重）。 */
export function effectiveDagEdges(dag: TaskDag): Array<{ from: string; to: string }> {
  const direct = dag.edges.filter((edge) => edge.from !== '' && edge.to !== '')
  if (direct.length > 0) return direct
  const seen = new Set<string>()
  const derived: Array<{ from: string; to: string }> = []
  for (const task of dag.tasks) {
    for (const dep of task.dependencies) {
      const key = `${dep}->${task.id}`
      if (dep === '' || task.id === '' || seen.has(key)) continue
      seen.add(key)
      derived.push({ from: dep, to: task.id })
    }
  }
  return derived
}

/**
 * 紧凑左→右 DAG：列 = 依赖深度 stage（computeLevels，edges 与 dependencies 取并集），
 * 行 = stage 内任务 id 稳定排序。边为水平出入节点中线的短柄三次贝塞尔。
 * 纯函数，与 client 侧 DagGraph 单文件同构实现保持同一数学。
 */
export function compactDagLayout(dag: TaskDag): CompactDagLayout {
  const levels = computeLevels(dag)
  const byLevel = new Map<number, TaskRecord[]>()
  for (const task of dag.tasks) {
    const lv = levels.get(task.id) ?? 0
    const group = byLevel.get(lv) ?? []
    group.push(task)
    byLevel.set(lv, group)
  }
  const stages = [...byLevel.entries()].sort((a, b) => a[0] - b[0])
  const positions = new Map<string, { x: number; y: number }>()
  const nodes: CompactDagNodeLayout[] = []
  for (const [column, [, group]] of stages.entries()) {
    const ordered = group.slice().sort((left, right) => left.id.localeCompare(right.id, 'en', { numeric: true }))
    for (const [row, task] of ordered.entries()) {
      const x = column * (COMPACT_DAG_NODE_WIDTH + COMPACT_DAG_COLUMN_GAP)
      const y = row * (COMPACT_DAG_NODE_HEIGHT + COMPACT_DAG_ROW_GAP)
      positions.set(task.id, { x, y })
      nodes.push({ task, id: task.id, x, y })
    }
  }
  const rows = Math.max(1, ...stages.map(([, group]) => group.length))
  const width = stages.length === 0
    ? 0
    : stages.length * COMPACT_DAG_NODE_WIDTH + (stages.length - 1) * COMPACT_DAG_COLUMN_GAP
  const height = stages.length === 0
    ? 0
    : rows * COMPACT_DAG_NODE_HEIGHT + (rows - 1) * COMPACT_DAG_ROW_GAP
  const edges: CompactDagEdgeLayout[] = []
  for (const edge of effectiveDagEdges(dag)) {
    const source = positions.get(edge.from)
    const target = positions.get(edge.to)
    if (!source || !target) continue
    const x1 = source.x + COMPACT_DAG_NODE_WIDTH
    const y1 = source.y + COMPACT_DAG_NODE_HEIGHT / 2
    const x2 = target.x
    const y2 = target.y + COMPACT_DAG_NODE_HEIGHT / 2
    edges.push({
      from: edge.from,
      to: edge.to,
      path: `M${x1} ${y1}C${x1 + 14} ${y1},${x2 - 14} ${y2},${x2} ${y2}`,
    })
  }
  return { width, height, nodes, edges }
}

/**
 * 聚焦任务的完整上下游链（dependencyFocus）。
 * 沿依赖两个方向遍历且环安全：即使持久化数据含环也能终止。
 */
export function relatedTaskIds(taskId: string, dag: TaskDag): ReadonlySet<string> {
  const byId = new Map(dag.tasks.map((task) => [task.id, task]))
  if (!byId.has(taskId)) return new Set()
  const upstream = new Map<string, string[]>()
  const addUpstream = (from: string, to: string) => {
    const arr = upstream.get(to) ?? []
    arr.push(from)
    upstream.set(to, arr)
  }
  for (const task of dag.tasks) {
    for (const dep of task.dependencies) addUpstream(dep, task.id)
  }
  for (const edge of dag.edges) addUpstream(edge.from, edge.to)
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

export interface DagPanelProps {
  dagId: string
  repository: DagRepository
  /** 打开完整视图（Dashboard）回调；由宿主页面注入。 */
  onOpenFull?: (dagId: string) => void
  title?: string
}

/**
 * 会话右侧面板轻量 DAG 视图（P0-DAG-017）：
 * 从持久化 DAG 数据（dag-repository）加载；支持快速取消、点击节点聚焦上下游链
 * （Esc 取消聚焦）与打开完整视图。布局为紧凑固定几何（compactDagLayout），
 * 画布=内容精确尺寸，横向溢出走滚动；fitDagLayout 缩放方案已退役（保留导出兼容）。
 */
export function DagPanel({ dagId, repository, onOpenFull, title = '任务 DAG' }: DagPanelProps) {
  const [dag, setDag] = useState<TaskDag | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cancellingId, setCancellingId] = useState<string | null>(null)
  const [pinnedId, setPinnedId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setDag(await repository.loadDag(dagId))
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [dagId, repository])

  useEffect(() => {
    setPinnedId(null)
    void load()
  }, [load])

  // 聚焦链（dependencyFocus）：点节点固定其上下游链，Esc 解除。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPinnedId(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const cancel = useCallback(
    async (taskId: string) => {
      setCancellingId(taskId)
      try {
        setDag(await repository.cancelTask(dagId, taskId))
        setError(null)
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught))
      } finally {
        setCancellingId(null)
      }
    },
    [dagId, repository],
  )

  const layout = useMemo(() => (dag ? compactDagLayout(dag) : null), [dag])
  const related = useMemo(
    () => (dag === null || pinnedId === null ? null : relatedTaskIds(pinnedId, dag)),
    [dag, pinnedId],
  )

  if (error && !dag) {
    return (
      <div className="weave-dag-panel" data-testid="dag-panel-error">
        <p>DAG 加载失败：{error}</p>
        <button onClick={() => void load()}>重试</button>
      </div>
    )
  }
  if (!dag || !layout) {
    return (
      <div className="weave-dag-panel" data-testid="dag-panel-loading">
        加载中…
      </div>
    )
  }

  return (
    <div className="weave-dag-panel" data-testid="dag-panel">
      <header className="weave-dag-panel__header">
        <strong>{title}</strong>
        <span data-testid="dag-status">状态：{dag.status}</span>
      </header>
      <div className="weave-dag-panel__viewport" data-testid="dag-viewport" style={{ overflowX: 'auto' }}>
        <div
          className="weave-dag-panel__body"
          style={{ position: 'relative', width: layout.width, height: layout.height, minWidth: '100%' }}
        >
          <svg
            width={layout.width}
            height={layout.height}
            style={{ position: 'absolute', inset: 0, overflow: 'visible', pointerEvents: 'none' }}
            data-testid="dag-edges"
          >
            {layout.edges.map((edge) => {
              const active = related !== null && related.has(edge.from) && related.has(edge.to)
              const dimmed = related !== null && !active
              return (
                <path
                  key={`${edge.from}->${edge.to}`}
                  d={edge.path}
                  fill="none"
                  stroke={active ? '#1677ff' : '#999999'}
                  strokeWidth={active ? 1.6 : 1}
                  opacity={dimmed ? 0.24 : 1}
                  data-active={active}
                  data-dimmed={dimmed}
                />
              )
            })}
          </svg>
          {layout.nodes.map((node) => {
            const { task } = node
            const focused = related?.has(node.id) === true
            const dimmed = related !== null && !focused
            const cancelable = isCancelable(task.status) && cancellingId !== task.id
            return (
              <div
                key={task.id}
                data-testid={`dag-task-${task.id}`}
                title={task.description}
                onClick={() => setPinnedId((current) => (current === task.id ? null : task.id))}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    setPinnedId((current) => (current === task.id ? null : task.id))
                  }
                }}
                style={{
                  position: 'absolute',
                  left: node.x,
                  top: node.y,
                  width: COMPACT_DAG_NODE_WIDTH,
                  height: COMPACT_DAG_NODE_HEIGHT,
                  boxSizing: 'border-box',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                  gap: 1,
                  padding: cancelable ? '0 20px 0 6px' : '0 6px',
                  border: '1px solid #d9d9d9',
                  borderLeft: `3px solid ${STATUS_COLORS[task.status]}`,
                  borderRadius: 6,
                  background: focused ? 'rgba(22,119,255,0.06)' : '#ffffff',
                  color: '#262626',
                  cursor: 'pointer',
                  opacity: dimmed ? 0.3 : 1,
                  overflow: 'hidden',
                  userSelect: 'none',
                }}
              >
                <span
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    fontSize: 9.5,
                    fontWeight: 700,
                    lineHeight: '12px',
                  }}
                >
                  <i
                    style={{
                      flex: 'none',
                      width: 5,
                      height: 5,
                      borderRadius: 1.5,
                      background: STATUS_COLORS[task.status],
                    }}
                  />
                  {task.id}
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, fontSize: 8.5, lineHeight: '11px' }}>
                  <span
                    data-testid={`dag-task-status-${task.id}`}
                    style={{ flex: 'none', color: STATUS_COLORS[task.status], fontWeight: 600 }}
                  >
                    {task.status}
                  </span>
                  <span style={{ minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', color: '#8c8c8c' }}>
                    {task.description.slice(0, 24)}
                  </span>
                </span>
                {cancelable && (
                  <button
                    onClick={(event) => {
                      event.stopPropagation()
                      void cancel(task.id)
                    }}
                    aria-label={`取消任务 ${task.id}`}
                    disabled={cancellingId === task.id}
                    style={{
                      position: 'absolute',
                      top: 3,
                      right: 3,
                      height: 13,
                      padding: '0 4px',
                      border: '1px solid #d9d9d9',
                      borderRadius: 4,
                      background: '#ffffff',
                      color: '#595959',
                      fontSize: 8,
                      lineHeight: '11px',
                      cursor: 'pointer',
                    }}
                  >
                    取消
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </div>
      <footer className="weave-dag-panel__footer">
        <button onClick={() => void load()}>刷新</button>
        <button
          data-testid="dag-open-full"
          onClick={() => onOpenFull?.(dagId)}
          disabled={!onOpenFull}
        >
          打开完整视图
        </button>
      </footer>
    </div>
  )
}
