/// <reference lib="dom" />
import { useCallback, useEffect, useMemo, useState } from 'react'

import { TaskStateMachine } from '../state/task-state-machine.js'
import type { TaskDag, TaskRecord, TaskStatus } from '../state/types.js'
import type { DagRepository } from './repository.js'

/** 布局常量（轻量 SVG 视图）。 */
export const CELL_W = 200
export const CELL_H = 64
export const LEVEL_GAP = 48
export const ROW_GAP = 24

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

export interface DagNodeLayout {
  task: TaskRecord
  level: number
  index: number
  x: number
  y: number
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

export interface DagPanelProps {
  dagId: string
  repository: DagRepository
  /** 打开完整视图（Dashboard）回调；由宿主页面注入。 */
  onOpenFull?: (dagId: string) => void
  title?: string
}

/**
 * 会话右侧面板轻量 DAG 视图（P0-DAG-017）：
 * 从持久化 DAG 数据（dag-repository）加载；支持快速取消与打开完整视图。
 */
export function DagPanel({ dagId, repository, onOpenFull, title = '任务 DAG' }: DagPanelProps) {
  const [dag, setDag] = useState<TaskDag | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cancellingId, setCancellingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setDag(await repository.loadDag(dagId))
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [dagId, repository])

  useEffect(() => {
    void load()
  }, [load])

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

  const nodes: DagNodeLayout[] = useMemo(() => {
    if (!dag) return []
    const levels = computeLevels(dag)
    const byLevel = new Map<number, TaskRecord[]>()
    for (const task of dag.tasks) {
      const lv = levels.get(task.id) ?? 0
      const arr = byLevel.get(lv) ?? []
      arr.push(task)
      byLevel.set(lv, arr)
    }
    const layout: DagNodeLayout[] = []
    for (const [level, tasks] of [...byLevel.entries()].sort((a, b) => a[0] - b[0])) {
      tasks.forEach((task, index) => {
        layout.push({
          task,
          level,
          index,
          x: level * (CELL_W + LEVEL_GAP),
          y: index * (CELL_H + ROW_GAP),
        })
      })
    }
    return layout
  }, [dag])

  if (error && !dag) {
    return (
      <div className="weave-dag-panel" data-testid="dag-panel-error">
        <p>DAG 加载失败：{error}</p>
        <button onClick={() => void load()}>重试</button>
      </div>
    )
  }
  if (!dag) {
    return (
      <div className="weave-dag-panel" data-testid="dag-panel-loading">
        加载中…
      </div>
    )
  }

  const maxLevels = Math.max(1, ...nodes.map((n) => n.level + 1))
  const width = maxLevels * (CELL_W + LEVEL_GAP)
  const rowsPerLevel = new Map<number, number>()
  for (const n of nodes) rowsPerLevel.set(n.level, (rowsPerLevel.get(n.level) ?? 0) + 1)
  const maxRows = Math.max(1, ...[...rowsPerLevel.values()])
  const height = maxRows * (CELL_H + ROW_GAP)
  const pos = new Map(nodes.map((n) => [n.task.id, n]))

  return (
    <div className="weave-dag-panel" data-testid="dag-panel">
      <header className="weave-dag-panel__header">
        <strong>{title}</strong>
        <span data-testid="dag-status">状态：{dag.status}</span>
      </header>
      <div className="weave-dag-panel__body" style={{ position: 'relative', width, height }}>
        <svg
          width={width}
          height={height}
          style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
          data-testid="dag-edges"
        >
          <defs>
            <marker id="dag-arrow" markerWidth="8" markerHeight="8" refX="8" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill="#999" />
            </marker>
          </defs>
          {dag.edges.map((edge) => {
            const from = pos.get(edge.from)
            const to = pos.get(edge.to)
            if (!from || !to) return null
            return (
              <line
                key={`${edge.from}->${edge.to}`}
                x1={from.x + CELL_W}
                y1={from.y + CELL_H / 2}
                x2={to.x}
                y2={to.y + CELL_H / 2}
                stroke="#999"
                strokeWidth={1.5}
                markerEnd="url(#dag-arrow)"
              />
            )
          })}
        </svg>
        {nodes.map((node) => {
          const { task } = node
          const cancelable = isCancelable(task.status) && cancellingId !== task.id
          return (
            <div
              key={task.id}
              data-testid={`dag-task-${task.id}`}
              title={task.description}
              style={{
                position: 'absolute',
                left: node.x,
                top: node.y,
                width: CELL_W,
                minHeight: CELL_H,
                borderLeft: `4px solid ${STATUS_COLORS[task.status]}`,
                padding: 6,
                boxSizing: 'border-box',
                fontSize: 12,
              }}
            >
              <div>{task.id}</div>
              <div data-testid={`dag-task-status-${task.id}`}>{task.status}</div>
              <div>{task.description.slice(0, 24)}</div>
              {cancelable && (
                <button
                  onClick={() => void cancel(task.id)}
                  aria-label={`取消任务 ${task.id}`}
                  disabled={cancellingId === task.id}
                >
                  取消
                </button>
              )}
            </div>
          )
        })}
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
