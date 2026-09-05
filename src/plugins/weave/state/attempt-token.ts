import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

/**
 * 任务 attempt 句柄（参照 dsh-agent-teams state.ts activateTaskAttempt/invalidateTaskAttempt）：
 * - claim（→RUNNING）时签发新 UUID 并落 tasks.attempt_token——旧 attempt 的句柄随即作废；
 * - 重派/取消/恢复时置 NULL（invalidateTaskAttempt：清 attemptId 使迟到写入 stale）；
 * - attempt 侧回写必须携带 { token, expectedRevision } 双验证：token 不符（句柄已轮换/
 *   作废）或 revision 过期（并发写已推进）→ WeaveError('task_stale_revision')。
 */

/** attempt 侧回写的乐观并发守卫：claim 时签发的句柄 + 签发时的版本号。 */
export interface AttemptGuard {
  token: string
  expectedRevision: number
}

/** 守卫回写允许的列（status/result/error_type；updated_at 由本函数统一维护）。 */
export interface AttemptWritePatch {
  status?: string
  result?: string | null
  error_type?: string | null
}

/** task_stale_revision 错误码（迟到回写/并发写冲突的统一拒绝语义）。 */
export const TASK_STALE_REVISION = 'task_stale_revision'

/** 签发新 attempt 句柄（UUID，一次一签；签发即轮换，旧 token 同步作废）。 */
export function newAttemptToken(): string {
  return randomUUID()
}

/**
 * attempt 守卫回写的唯一协议形态（scheduler #updateTask 与测试共用）：
 * `UPDATE ... WHERE id = ? AND attempt_token = ? AND revision = ?`，成功即原子推进
 * revision——同 token 的并发双写只有携带最新 revision 的一方胜出（changes=1），
 * 另一方 changes=0 由调用方折算成 task_stale_revision。返回受影响行数。
 */
export function applyAttemptGuardedWrite(
  db: DatabaseSync,
  taskId: string,
  patch: AttemptWritePatch,
  guard: AttemptGuard,
  updatedAt: string,
): number {
  const sets: string[] = ['updated_at = ?', 'revision = revision + 1']
  const params: Array<string | number | null> = [updatedAt]
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue
    sets.push(`${field} = ?`)
    params.push(value)
  }
  const info = db
    .prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ? AND attempt_token = ? AND revision = ?`)
    .run(...params, taskId, guard.token, guard.expectedRevision)
  return Number(info.changes)
}
