/**
 * 宿主 Session 事件读取适配（rc1-adaptation 点 b，特性探测双兼容）。
 *
 * 背景：DSH 0.1.2-rc.1 把 `Session.events` 常驻数组改为按需 API
 * （`seq` / `eventAt()` / `snapshotEvents()`）。weave 侧所有「读宿主会话事件」
 * 的代码点统一收敛到本文件，运行时探测：
 * - 新 API 存在（`typeof session.snapshotEvents === 'function'`）→ 走新路径；
 * - 否则回落 `session.events` 数组（0.1.1-rc.2 现行为；旧路径禁止删除）。
 *
 * 边界语义（记录「本轮开始前」的切点，随后取本轮增量；boundary 与 slice
 * 必须成对使用，且落在同一探测分支——不得交叉混用）：
 * - 旧路径：数组下标语义——boundary = `events.length`，slice 按同数组下标切；
 * - 新路径：seq 寻址语义——boundary = 末事件 `seq + 1`（seq 单调；物化窗口
 *   可能只是事件流后缀，数组 length 不可作下标使用），slice 取 `seq >= boundary`。
 *
 * 消费库输入形状不变：`foldConsumedWork` / `finalAssistantOutput` /
 * `hasPendingToolCall` 仍吃事件数组，0.1.2 下由 `snapshotEvents()` 物化。
 */

/** 宿主会话事件的最小视面（seq 为 0.1.2 的寻址键；0.1.1 事件亦自带 seq 字段但不作寻址用）。 */
export interface HostSessionEventLike {
  readonly type: string
  readonly seq?: number
  readonly data?: unknown
}

interface SessionEventsViewLike {
  snapshotEvents?: () => readonly HostSessionEventLike[]
  events?: readonly HostSessionEventLike[]
}

/** 探测并调用 snapshotEvents()；返回非数组（宿主实现异常）视为「新 API 不可用」。 */
function snapshotOf(session: unknown): readonly HostSessionEventLike[] | undefined {
  const s = session as SessionEventsViewLike | null | undefined
  if (s === null || s === undefined) return undefined
  if (typeof s.snapshotEvents !== 'function') return undefined
  const snapshot = s.snapshotEvents()
  return Array.isArray(snapshot) ? snapshot : undefined
}

/**
 * 特性探测读全量事件：`snapshotEvents()` 优先，`.events` 数组兜底；
 * 两者皆缺（或新 API 实现异常且无旧数组）返回 undefined。
 */
export function readSessionEvents(session: unknown): readonly HostSessionEventLike[] | undefined {
  return snapshotOf(session) ?? (session as SessionEventsViewLike | null | undefined)?.events
}

/**
 * 记录「本轮开始前」的事件边界（与 `sliceSessionEvents` 成对使用）。
 * 旧路径 = `events.length`（下标语义）；新路径 = 末事件 `seq + 1`
 * （seq 寻址语义；空物化为 0，事件缺 seq 时退回物化长度）。
 */
export function readSessionEventBoundary(session: unknown): number {
  const snapshot = snapshotOf(session)
  if (snapshot !== undefined) {
    if (snapshot.length === 0) return 0
    const last = snapshot[snapshot.length - 1]!
    return typeof last.seq === 'number' ? last.seq + 1 : snapshot.length
  }
  const s = session as SessionEventsViewLike | null | undefined
  return s?.events?.length ?? 0
}

/**
 * 取 boundary 之后的本轮增量事件（与 `readSessionEventBoundary` 成对使用）。
 * 旧路径按数组下标切（与 0.1.1 现行为逐字节一致）；新路径按 `seq >= boundary`
 * 过滤——新路径下缺 seq 的事件不纳入（无法 seq 寻址，防止把旧窗口误算进本轮）。
 */
export function sliceSessionEvents(session: unknown, boundary: number): readonly HostSessionEventLike[] {
  const snapshot = snapshotOf(session)
  if (snapshot !== undefined) {
    return snapshot.filter((event) => typeof event.seq === 'number' && event.seq >= boundary)
  }
  const s = session as SessionEventsViewLike | null | undefined
  return (s?.events ?? []).slice(boundary)
}
