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
  COMPACT_DAG_COLUMN_GAP,
  COMPACT_DAG_NODE_HEIGHT,
  COMPACT_DAG_NODE_WIDTH,
  COMPACT_DAG_ROW_GAP,
  DAG_BASE,
  DAG_FLOOR,
  DagPanel,
  compactDagLayout,
  computeLevels,
  dagFontSize,
  effectiveDagEdges,
  fitDagLayout,
  isCancelable,
  relatedTaskIds,
} from '../../../../src/plugins/weave/ui/dag-panel'
import { DagRepository, type DagRepositoryOptions } from '../../../../src/plugins/weave/dag/repository'
import { WeavePersistence } from '../../../../src/plugins/weave/persistence/persistence'
import { SingleWriterQueue } from '../../../../src/plugins/weave/persistence/single-writer-queue'
import { TaskStatusNotifier } from '../../../../src/plugins/weave/scheduling/task-status-notifier'
import { AuditLog } from '../../../../src/plugins/weave/audit/index'
import type { TaskDag, TaskRecord, TaskStatus } from '../../../../src/plugins/weave/state/types'

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

/** 分支 DAG：t-design 分出 t-implement（→t-test）与 t-ui 两条链，用于聚焦/暗化断言。 */
function branchedDag(): TaskDag {
  return {
    dag_id: DAG_ID,
    tasks: [
      task('t-design', 'COMPLETED'),
      task('t-implement', 'RUNNING', { dependencies: ['t-design'] }),
      task('t-ui', 'WAITING', { dependencies: ['t-design'] }),
      task('t-test', 'WAITING', { dependencies: ['t-implement'] }),
    ],
    edges: [
      { from: 't-design', to: 't-implement' },
      { from: 't-design', to: 't-ui' },
      { from: 't-implement', to: 't-test' },
    ],
    status: 'running',
  }
}

/** 用内存持久化 + 内置 DDL 建库，插入 DAG 数据。 */
async function seedRepository(options: DagRepositoryOptions = {}, dag: TaskDag = sampleDag()): Promise<DagRepository> {
  const persistence = new WeavePersistence({ inMemory: true })
  const repo = new DagRepository(persistence, options)
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

/* ------------------------------ 紧凑布局纯函数 ------------------------------ */

describe('compactDagLayout（参照物紧凑几何：节点 92×30，列距 26、行距 8）', () => {
  it('画布=内容精确尺寸：3 任务链 → 328×30，stage 分列', () => {
    const layout = compactDagLayout(sampleDag())
    expect(layout.width).toBe(3 * COMPACT_DAG_NODE_WIDTH + 2 * COMPACT_DAG_COLUMN_GAP)
    expect(layout.width).toBe(328)
    expect(layout.height).toBe(COMPACT_DAG_NODE_HEIGHT)
    expect(layout.height).toBe(30)
    const byId = new Map(layout.nodes.map((node) => [node.id, node]))
    expect(byId.get('t-design')).toMatchObject({ x: 0, y: 0 })
    expect(byId.get('t-implement')).toMatchObject({ x: COMPACT_DAG_NODE_WIDTH + COMPACT_DAG_COLUMN_GAP, y: 0 })
    expect(byId.get('t-test')).toMatchObject({ x: 2 * (COMPACT_DAG_NODE_WIDTH + COMPACT_DAG_COLUMN_GAP), y: 0 })
  })

  it('边为水平出入节点中线的短柄三次贝塞尔（C 控制柄 14px）', () => {
    const layout = compactDagLayout(sampleDag())
    expect(layout.edges.map((edge) => edge.path)).toEqual([
      'M92 15C106 15,104 15,118 15',
      'M210 15C224 15,222 15,236 15',
    ])
  })

  it('stage 内按任务 id 稳定排序，多行时行距 8', () => {
    const layout = compactDagLayout(branchedDag())
    const implement = layout.nodes.find((node) => node.id === 't-implement')!
    const ui = layout.nodes.find((node) => node.id === 't-ui')!
    expect(implement.y).toBe(0)
    expect(ui.y).toBe(COMPACT_DAG_NODE_HEIGHT + COMPACT_DAG_ROW_GAP)
    expect(ui.x).toBe(implement.x)
    expect(layout.height).toBe(2 * COMPACT_DAG_NODE_HEIGHT + COMPACT_DAG_ROW_GAP)
  })

  it('effectiveDagEdges：edges 优先；缺失时由 dependencies 推导', () => {
    const dag = sampleDag()
    expect(effectiveDagEdges(dag)).toEqual([
      { from: 't-design', to: 't-implement' },
      { from: 't-implement', to: 't-test' },
    ])
    expect(effectiveDagEdges({ ...dag, edges: [] })).toEqual([
      { from: 't-design', to: 't-implement' },
      { from: 't-implement', to: 't-test' },
    ])
  })
})

describe('relatedTaskIds（dependencyFocus 聚焦上下游链）', () => {
  it('返回聚焦任务的完整上下游链，分支上的无关任务不在链内', () => {
    const related = relatedTaskIds('t-implement', branchedDag())
    expect([...related].sort()).toEqual(['t-design', 't-implement', 't-test'])
    expect(related.has('t-ui')).toBe(false)
    expect(relatedTaskIds('missing', branchedDag()).size).toBe(0)
  })

  it('持久化数据含环时遍历仍终止', () => {
    const cyclic: TaskDag = {
      dag_id: 'cyc',
      status: 'running',
      tasks: [
        task('a', 'RUNNING', { dependencies: ['b'] }),
        task('b', 'WAITING', { dependencies: ['a'] }),
      ],
      edges: [],
    }
    expect(relatedTaskIds('a', cyclic).size).toBe(2)
  })
})

describe('fitDagLayout（doc/05 §6.3 自适应布局，已退役仅保留导出兼容）', () => {
  it('大视口小图：放大铺满视口，cellW 明显大于 base 且 overflow=false（用户实测修复）', () => {
    // natural = 3×248=744 × 5×88=440；viewport 1600×900 → scale=min(3, 2.15, 2.05)≈2.05
    const fit = fitDagLayout({ w: 1600, h: 900 }, 3, 5)
    expect(fit.cellW).toBeGreaterThan(DAG_BASE.cellW)
    expect(fit.cellH).toBeGreaterThan(DAG_BASE.cellH)
    expect(fit.overflow).toBe(false)
  })

  it('超大视口：scale 封顶 12（sanity 上限），防无界放大', () => {
    // natural = 248×88；viewport 极大 → scale=min(12, 403, 1136)=12
    expect(fitDagLayout({ w: 99999, h: 99999 }, 1, 1)).toEqual({
      cellW: 2400, cellH: 768, levelGap: 576, rowGap: 288, overflow: false,
    })
  })

  it('竖屏大视口小图：3 倍帽放开后缩放比突破 3，宽度铺满视口（留白修复）', () => {
    // levels=2/rows=2：natural = 496×176；viewport 1600×900 → scale=min(12, 3.23, 5.11)=3.23>3
    const fit = fitDagLayout({ w: 1600, h: 900 }, 2, 2)
    expect(fit.cellW).toBe(645) // round(200×3.2258)，> base×3 证明帽已放开
    expect(fit.overflow).toBe(false)
    // 宽度铺满：(levels+1)×cellW + levels×levelGap = 2×645 + 2×155 = 1600 = 视口宽
    const totalW = 2 * fit.cellW + 2 * fit.levelGap
    expect(totalW).toBe(1600)
  })

  it('非法视口（NaN/Infinity）回落 base，不产生 NaN 尺寸', () => {
    const base = { cellW: 200, cellH: 64, levelGap: 48, rowGap: 24, overflow: false }
    expect(fitDagLayout({ w: Number.NaN, h: 900 }, 3, 5)).toEqual(base)
    expect(fitDagLayout({ w: Number.POSITIVE_INFINITY, h: 900 }, 3, 5)).toEqual(base)
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
    expect(screen.getByTestId('dag-edges').querySelectorAll('path').length).toBe(2)
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

  it('紧凑布局：画布=内容精确尺寸（3 链 328×30），视口只做横向滚动', async () => {
    const repo = await seedRepository()
    render(<DagPanel dagId={DAG_ID} repository={repo} />)
    await screen.findByText('任务 t-implement')
    const viewport = screen.getByTestId('dag-viewport')
    expect(viewport.style.overflowX).toBe('auto')
    const body = viewport.querySelector('.weave-dag-panel__body') as HTMLElement
    // 3 列 × (92+26) - 26 = 328；1 行 × 30 —— 不缩放不铺满，溢出走滚动
    expect(body.style.width).toBe('328px')
    expect(body.style.height).toBe('30px')
  })

  it('点节点聚焦上下游链：关联边 data-active、无关边/节点暗化；Esc 解除', async () => {
    const repo = await seedRepository({}, branchedDag())
    render(<DagPanel dagId={DAG_ID} repository={repo} />)
    await screen.findByText('任务 t-implement')

    fireEvent.click(screen.getByTestId('dag-task-t-implement'))
    const paths = screen.getByTestId('dag-edges').querySelectorAll('path')
    expect(paths).toHaveLength(3)
    // t-design→t-implement、t-implement→t-test 在聚焦链上；t-design→t-ui 无关暗化
    expect(paths[0]!.getAttribute('data-active')).toBe('true')
    expect(paths[1]!.getAttribute('data-dimmed')).toBe('true')
    expect(paths[2]!.getAttribute('data-active')).toBe('true')
    expect((screen.getByTestId('dag-task-t-ui') as HTMLElement).style.opacity).toBe('0.3')
    expect((screen.getByTestId('dag-task-t-design') as HTMLElement).style.opacity).toBe('1')

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByTestId('dag-edges').querySelectorAll('path')[0]!.getAttribute('data-active')).toBe('false')
    expect((screen.getByTestId('dag-task-t-ui') as HTMLElement).style.opacity).toBe('1')
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

describe('DagPanel 紧凑节点几何（参照物观感：节点固定 92×30）', () => {
  it('节点固定 92×30 按 stage 定位；SVG 边为水平出入中线的贝塞尔路径', async () => {
    const repo = await seedRepository()
    render(<DagPanel dagId={DAG_ID} repository={repo} />)
    await screen.findByText('任务 t-implement')

    const node = screen.getByTestId('dag-task-t-implement') as HTMLElement
    expect(node.style.width).toBe('92px')
    expect(node.style.height).toBe('30px')
    // lv1 列 x = 92+26 = 118；单行 y = 0
    expect(node.style.left).toBe('118px')
    expect(node.style.top).toBe('0px')

    // 首条边 t-design(lv0, x=0) → t-implement(lv1, x=118)：从右缘 92 到左缘 118，中线 y=15
    const path = screen.getByTestId('dag-edges').querySelector('path')!
    expect(path.getAttribute('d')).toBe('M92 15C106 15,104 15,118 15')
  })
})
