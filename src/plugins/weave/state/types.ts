/** TDD 2.1.1 任务状态枚举（14 态） */
export type TaskStatus =
  | 'WAITING'
  | 'BLOCKED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'AWAITING_FEEDBACK'
  | 'REVISION_RUNNING'
  | 'CLOSED'
  | 'FAILED'
  | 'BANNED'
  | 'LOOP_TERMINATED'
  | 'INTERRUPTED'
  | 'CANCELLED'
  | 'SKIPPED'
  | 'COOLDOWN'

export const TASK_STATUSES: readonly TaskStatus[] = [
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
]

/** TDD 2.1.2 任务记录 */
export interface TaskRecord {
  id: string
  session_id: string
  team_id: string
  project_id: string
  version: string
  description: string
  dependencies: string[]
  /**
   * 写域前缀（tasks.write_scopes JSON 数组，v3 起默认 []）。
   * advisory 语义：与执行中任务重叠时调度器只发警告不阻断（官方 agent-team 对齐）。
   */
  write_scopes: string[]
  /**
   * 乐观并发版本号（tasks.revision，v3 起默认 0）：治理写入与 attempt 写回每次 +1；
   * 带 attempt 守卫的回写按 (attempt_token, expectedRevision) 双验证，不符即拒绝。
   */
  revision: number
  /**
   * attempt 句柄（tasks.attempt_token，v3 起）：claim(RUNNING) 时签发 UUID，
   * 重派/取消/恢复时作废（NULL）——旧 attempt 的迟到回写因 token 失效被拒。
   */
  attempt_token: string | null
  assigned_agent: string | null
  executor: string | null
  status: TaskStatus
  revision_count: number
  max_revisions: number
  feedback_timeout_seconds: number
  feedback_expires_at: string | null
  skip_override: boolean
  skip_reason: string | null
  fail_count: number
  result: string | null
  error_type: string | null
  created_at: string
  updated_at: string
}

/** TDD 2.1.3 DAG 与边 */
export interface TaskEdge {
  from: string
  to: string
}

export interface TaskDag {
  dag_id: string
  tasks: TaskRecord[]
  edges: TaskEdge[]
  status: 'created' | 'running' | 'completed' | 'failed'
}
