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
