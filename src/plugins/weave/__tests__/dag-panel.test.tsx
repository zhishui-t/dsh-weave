/// <reference lib="dom" />
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// vitest 未开启 globals，RTL 不会自动清理；显式清理避免跨用例 DOM 污染
afterEach(cleanup)

import {
  DAG_BASE,
  DAG_FLOOR,
  DagPanel,
  computeLevels,
  dagFontSize,
  fitDagLayout,
  isCancelable,
} from '../dag/dag-panel'
import { DagRepository, type DagRepositoryOptions } from '../dag/repository'
import { WeavePersistence } from '../persistence/persistence'
import { SingleWriterQueue } from '../persistence/single-writer-queue'
import { TaskStatusNotifier } from '../task-status-notifier'
import { AuditLog } from '../audit/index'
import type { TaskDag, TaskRecord, TaskStatus } from '../state/types'

/* ------------------------------- 测试数据 ------------------------------- */

const NOW = '2026-08-25T00:00:00.000Z'

function task(
  id: string,
  status: TaskStatus,
  options: Partial<TaskRecord> = {},
): TaskRecord {
  return {
    id,
    session_id: 'sess-1',
    team_id: 'team-1',
    project_id: 'proj-1',
    version: 'v1',
    description: `任务 ${id}`,
    dependencies: options.dependencies ?? [],
    assigned_agent: null,
    executor: null,
    status,
    revision_count: 0,
    max_revisions: 5,
    feedback_timeout_seconds: 1800,
    feedback_expires_at: null,
    skip_override: false,
    skip_reason: null,
    fail_count: 0,
    result: null,
    error_type: null,
    created_at: NOW,
    updated_at: NOW,
  }
}

const DAG_ID = 'demo-v1-000001'

function sampleDag(): TaskDag {
  const design = task('t-design', 'COMPLETED')
  const implement = task('t-implement', 'RUNNING', { dependencies: ['t-design'] })
  const test = task('t-test', 'WAITING', { dependencies: ['t-implement'] })
  return {
    dag_id: DAG_ID,
    tasks: [design, implement, test],
    edges: [
      { from: 't-design', to: 't-implement' },
      { from: 't-implement', to: 't-test' },
    ],
    status: 'running',
  }
}

/** 用内存持久化 + 内置 DDL 建库，插入 DAG 数据。 */
async function seedRepository(options: DagRepositoryOptions = {}): Promise<DagRepository> {
  const persistence = new WeavePersistence({ inMemory: true })
  const repo = new DagRepository(persistence, options)
  const dag = sampleDag()
  await persistence.tasks.run((db) => {
    db.prepare(
      `INSERT INTO dags (dag_id, team_id, project_id, version, difficulty, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(DAG_ID, 'team-1', 'proj-1', 'v1', 'medium', 'running', NOW, NOW)
    const insertTask = db.prepare(
      `INSERT INTO tasks (id, dag_id, stage, session_id, team_id, project_id, version, description,
        dependencies, assigned_agent, executor, status, revision_count, max_revisions,
        feedback_timeout_seconds, feedback_expires_at, skip_override, skip_reason, fail_count,
        result, error_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 0, NULL, NULL, ?, ?)`,
    )
    for (const t of dag.tasks) {
      insertTask.run(
        t.id,
        DAG_ID,
        'stage',
        t.session_id,
        t.team_id,
        t.project_id,
        t.version,
        t.description,
        JSON.stringify(t.dependencies),
        null,
        null,
        t.status,
        0,
        5,
        1800,
        null,
        NOW,
        NOW,
      )
    }
    const insertEdge = db.prepare(
      `INSERT INTO edges (dag_id, from_task_id, to_task_id) VALUES (?, ?, ?)`,
    )
    for (const e of dag.edges) insertEdge.run(DAG_ID, e.from, e.to)
  })
  return repo
}

/* ------------------------------- 纯函数 ------------------------------- */

describe('DagPanel 纯函数', () => {
  it('computeLevels 按最长依赖路径分层（edges + dependencies 并集）', () => {
    const dag = sampleDag()
    const levels = computeLevels(dag)
    expect(levels.get('t-design')).toBe(0)
    expect(levels.get('t-implement')).toBe(1)
    expect(levels.get('t-test')).toBe(2)
  })

  it('isCancelable 与权威矩阵一致：RUNNING/WAITING/BLOCKED 可取消，COMPLETED 不可', () => {
    expect(isCancelable('RUNNING')).toBe(true)
    expect(isCancelable('WAITING')).toBe(true)
    expect(isCancelable('BLOCKED')).toBe(true)
    expect(isCancelable('COMPLETED')).toBe(false)
    expect(isCancelable('CLOSED')).toBe(false)
  })
})

describe('fitDagLayout（doc/05 §6.3 自适应布局）', () => {
  it('大视口：scale 封顶 1，返回 base 原尺寸且 overflow=false（只缩不放）', () => {
    expect(fitDagLayout({ w: 1000, h: 800 }, 1, 1)).toEqual({
      cellW: 200, cellH: 64, levelGap: 48, rowGap: 24, overflow: false,
    })
  })

  it('小视口：按 scale=min(vw/W, vh/H) 等比收缩，不触 floor 时 overflow=false', () => {
    // natural = 248×88；viewport 248×44 → scale=0.5
    expect(fitDagLayout({ w: 248, h: 44 }, 1, 1)).toEqual({
      cellW: 100, cellH: 32, levelGap: 24, rowGap: 12, overflow: false,
    })
  })

  it('极端小视口：低于 floor 钳制并置 overflow=true（回落滚动）', () => {
    // natural = 3×248=744 × 5×88=440；scale≈0.045 → 全部触底
    expect(fitDagLayout({ w: 50, h: 20 }, 3, 5)).toEqual({
      cellW: DAG_FLOOR.cellW, cellH: DAG_FLOOR.cellH,
      levelGap: DAG_FLOOR.levelGap, rowGap: DAG_FLOOR.rowGap, overflow: true,
    })
  })

  it('未测量/退化输入回落 base（与历史渲染一致）：视口 0 或行数为 0', () => {
    const base = { cellW: 200, cellH: 64, levelGap: 48, rowGap: 24, overflow: false }
    expect(fitDagLayout({ w: 0, h: 0 }, 3, 5)).toEqual(base)
    expect(fitDagLayout({ w: 100, h: 100 }, 1, 0)).toEqual(base)
    expect(DAG_BASE).toEqual({ cellW: 200, cellH: 64, levelGap: 48, rowGap: 24 })
  })

  it('自定义 base/floor 参与同一数学（client 同构对齐用）', () => {
    const base = { cellW: 100, cellH: 40, levelGap: 20, rowGap: 10 }
    const floor = { cellW: 40, cellH: 16, levelGap: 8, rowGap: 2 }
    // natural = 120×50；viewport 60×100 → scale=0.5，均高于 floor
    expect(fitDagLayout({ w: 60, h: 100 }, 1, 1, base, floor)).toEqual({
      cellW: 50, cellH: 20, levelGap: 10, rowGap: 5, overflow: false,
    })
  })

  it('dagFontSize 随 cellH 联动：base 64→10px，收缩触 8px 下限', () => {
    expect(dagFontSize(64)).toBe(10)
    expect(dagFontSize(32)).toBe(8) // round(10×32/64)=5 → 触下限
    expect(dagFontSize(18)).toBe(8)
  })
})

/* ------------------------------- 组件 ------------------------------- */

describe('DagPanel 轻量视图（P0-DAG-017）', () => {
  it('从持久化 DAG 数据加载并渲染任务/状态/边', async () => {
    const repo = await seedRepository()
    render(<DagPanel dagId={DAG_ID} repository={repo} />)
    await screen.findByText('任务 t-implement')
    expect(screen.getByTestId('dag-status').textContent).toContain('running')
    expect(screen.getByTestId('dag-task-status-t-implement').textContent).toBe('RUNNING')
    expect(screen.getByTestId('dag-task-status-t-design').textContent).toBe('COMPLETED')
    expect(screen.getByTestId('dag-edges').querySelectorAll('line').length).toBe(2)
    // 可取消任务显示取消按钮；已完成任务不显示
    expect(screen.getByLabelText('取消任务 t-implement')).toBeDefined()
    expect(screen.getByLabelText('取消任务 t-test')).toBeDefined()
    expect(screen.queryByLabelText('取消任务 t-design')).toBeNull()
  })

  it('快速取消：RUNNING 任务 → CANCELLED，下游 WAITING → SKIPPED（失败传播）', async () => {
    const repo = await seedRepository()
    render(<DagPanel dagId={DAG_ID} repository={repo} />)
    await screen.findByText('任务 t-implement')
    fireEvent.click(screen.getByLabelText('取消任务 t-implement'))
    await waitFor(() => {
      expect(screen.getByTestId('dag-task-status-t-implement').textContent).toBe('CANCELLED')
    })
    expect(screen.getByTestId('dag-task-status-t-test').textContent).toBe('SKIPPED')
    // 持久层已同步
    const dag = await repo.loadDag(DAG_ID)
    expect(dag.tasks.find((t) => t.id === 't-implement')?.status).toBe('CANCELLED')
    expect(dag.tasks.find((t) => t.id === 't-test')?.status).toBe('SKIPPED')
    expect(dag.status).toBe('failed')
  })

  it('打开完整视图回调携带 dagId', async () => {
    const repo = await seedRepository()
    const onOpenFull = vi.fn()
    render(<DagPanel dagId={DAG_ID} repository={repo} onOpenFull={onOpenFull} />)
    await screen.findByText('任务 t-implement')
    fireEvent.click(screen.getByTestId('dag-open-full'))
    expect(onOpenFull).toHaveBeenCalledWith(DAG_ID)
  })

  it('DAG 不存在时展示错误态并提供重试', async () => {
    const repo = await seedRepository()
    render(<DagPanel dagId="missing-dag" repository={repo} />)
    await screen.findByTestId('dag-panel-error')
    expect(screen.getByTestId('dag-panel-error').textContent).toContain('DAG 不存在')
  })

  it('未测量视口（无 ResizeObserver）回落 base 布局：body 744×88、字号 10px、不滚动', async () => {
    const repo = await seedRepository()
    render(<DagPanel dagId={DAG_ID} repository={repo} />)
    await screen.findByText('任务 t-implement')
    const viewport = screen.getByTestId('dag-viewport')
    expect(viewport.style.overflow).toBe('hidden') // fit 未触底 → hidden
    const body = viewport.querySelector('.weave-dag-panel__body') as HTMLElement
    // 3 层 × (200+48) = 744；1 行 × (64+24) = 88 —— 与历史常量渲染逐字节一致
    expect(body.style.width).toBe('744px')
    expect(body.style.height).toBe('88px')
    expect((screen.getByTestId('dag-task-t-design') as HTMLElement).style.fontSize).toBe('10px')
  })

  it('cancelTask 接线通知与审计（doc/05 §6.4 P1-D 接线点 4）', async () => {
    const notified: Array<{ sessionId: string; text: string }> = []
    const auditDir = mkdtempSync(join(tmpdir(), 'weave-audit-dagpanel-'))
    const audit = new AuditLog({ dir: auditDir, queue: new SingleWriterQueue() })
    // echoSelfActions=true 验证接线本身；缺省部署下面板取消（actor=user）不回声
    const repo = await seedRepository({
      statusNotifier: new TaskStatusNotifier({
        notify: (sessionId, text) => notified.push({ sessionId, text }),
        echoSelfActions: true,
      }),
      audit,
    })
    render(<DagPanel dagId={DAG_ID} repository={repo} />)
    await screen.findByText('任务 t-implement')
    fireEvent.click(screen.getByLabelText('取消任务 t-implement'))
    await waitFor(() => {
      expect(screen.getByTestId('dag-task-status-t-implement').textContent).toBe('CANCELLED')
    })
    await waitFor(() => {
      expect(screen.getByTestId('dag-task-status-t-test').textContent).toBe('SKIPPED')
    })

    // 主变更单条（RUNNING→CANCELLED）+ 传播批量（t-test WAITING→SKIPPED）
    expect(notified).toHaveLength(2)
    expect(notified[0]!.sessionId).toBe('sess-1')
    expect(notified[0]!.text).toContain('「任务 t-implement」RUNNING → CANCELLED（ui_cancel）')
    expect(notified[1]!.text).toContain(`任务图 ${DAG_ID} 状态变更 1 项：`)
    expect(notified[1]!.text).toContain('「任务 t-test」WAITING → SKIPPED（ui_cancel）')

    // 审计边界（AC-TASK-002）：矩阵内 RUNNING→CANCELLED 入账；WAITING→SKIPPED
    // 属派生规则（AC-TASK-003）被审计拒绝，不虚增账目。
    const records = await audit.query({ types: ['task.status_changed'] })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ task_id: 't-implement', from: 'RUNNING', to: 'CANCELLED', by: 'user' })
    rmSync(auditDir, { recursive: true, force: true })
  })
})
