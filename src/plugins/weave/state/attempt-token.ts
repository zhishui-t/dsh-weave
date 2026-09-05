import { randomUUID } from 'node:crypto'

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

/** 签发新 attempt 句柄（UUID，一次一签；签发即轮换，旧 token 同步作废）。 */
export function newAttemptToken(): string {
  return randomUUID()
}

/** task_stale_revision 错误码（迟到回写/并发写冲突的统一拒绝语义）。 */
export const TASK_STALE_REVISION = 'task_stale_revision'
