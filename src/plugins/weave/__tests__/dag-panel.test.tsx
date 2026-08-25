/// <reference lib="dom" />
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// vitest 未开启 globals，RTL 不会自动清理；显式清理避免跨用例 DOM 污染
afterEach(cleanup)

import { DagPanel, computeLevels, isCancelable } from '../dag/dag-panel'
import { DagRepository } from '../dag/repository'
import { WeavePersistence } from '../persistence/persistence'
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
async function seedRepository(): Promise<DagRepository> {
  const persistence = new WeavePersistence({ inMemory: true })
  const repo = new DagRepository(persistence)
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
})
