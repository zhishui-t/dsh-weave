import { describe, expect, it, vi } from 'vitest'

import {
  readSessionEventBoundary,
  readSessionEvents,
  sliceSessionEvents,
} from '../../../../src/plugins/weave/executors/session-events-adapter.js'

/**
 * rc1-adaptation 点 b：宿主 Session 事件读取的特性探测双兼容。
 * 两态 mock：新 API（snapshotEvents）存在 / 仅旧 API（.events）。
 */

const OLD_EVENTS = [
  { type: 'turn/start', seq: 0, data: {} },
  { type: 'assistant/message', seq: 1, data: {} },
]

const NEW_EVENTS = [
  { type: 'turn/start', seq: 7, data: {} },
  { type: 'assistant/message', seq: 8, data: {} },
]

describe('readSessionEvents（特性探测读全量）', () => {
  it('新 API 存在：走 snapshotEvents()，不读 .events（0.1.2 路径）', () => {
    const snapshot = vi.fn(() => NEW_EVENTS)
    const session = { snapshotEvents: snapshot, events: OLD_EVENTS }
    expect(readSessionEvents(session)).toBe(NEW_EVENTS)
    expect(snapshot).toHaveBeenCalledTimes(1)
  })

  it('旧宿主（仅 .events）：回落旧数组，行为与现状一致（0.1.1 路径）', () => {
    const session = { events: OLD_EVENTS }
    expect(readSessionEvents(session)).toBe(OLD_EVENTS)
  })

  it('两者皆缺 / session 为 null·undefined → undefined', () => {
    expect(readSessionEvents({})).toBeUndefined()
    expect(readSessionEvents(null)).toBeUndefined()
    expect(readSessionEvents(undefined)).toBeUndefined()
  })

  it('snapshotEvents 返回非数组（宿主实现异常）→ 回落 .events 兜底', () => {
    const session = { snapshotEvents: () => undefined as never, events: OLD_EVENTS }
    expect(readSessionEvents(session)).toBe(OLD_EVENTS)
  })
})

describe('readSessionEventBoundary / sliceSessionEvents（成对使用，同一探测分支）', () => {
  it('旧路径：boundary=events.length（下标语义），slice 按下标切——事件 seq≠下标也不受影响', () => {
    const events = [
      { type: 'a', seq: 100 },
      { type: 'b', seq: 200 },
    ]
    const session = { events }
    expect(readSessionEventBoundary(session)).toBe(2)
    events.push({ type: 'c', seq: 300 })
    expect(sliceSessionEvents(session, 2)).toEqual([{ type: 'c', seq: 300 }])
  })

  it('旧路径：无 events → boundary=0，slice=空数组（与旧 `?? 0` / `?? []` 语义一致）', () => {
    const session = {}
    expect(readSessionEventBoundary(session)).toBe(0)
    expect(sliceSessionEvents(session, 0)).toEqual([])
  })

  it('新路径：boundary=末事件 seq+1（seq 寻址），slice 取 seq>=boundary（物化窗口可为后缀）', () => {
    const before = { snapshotEvents: () => NEW_EVENTS }
    const boundary = readSessionEventBoundary(before)
    expect(boundary).toBe(9)

    const after = {
      snapshotEvents: () => [
        { type: 'turn/start', seq: 7, data: {} },
        { type: 'assistant/message', seq: 8, data: {} },
        { type: 'step/start', seq: 9, data: {} },
        { type: 'assistant/message', seq: 10, data: {} },
      ],
    }
    expect(sliceSessionEvents(after, boundary)).toEqual([
      { type: 'step/start', seq: 9, data: {} },
      { type: 'assistant/message', seq: 10, data: {} },
    ])
  })

  it('新路径：空物化 → boundary=0；事件缺 seq → boundary 退回物化长度', () => {
    expect(readSessionEventBoundary({ snapshotEvents: () => [] })).toBe(0)
    expect(readSessionEventBoundary({ snapshotEvents: () => [{ type: 'x' }, { type: 'y' }] })).toBe(2)
  })

  it('新路径切片：缺 seq 的事件不纳入（无法 seq 寻址，防把旧窗口误算进本轮）', () => {
    const session = {
      snapshotEvents: () => [{ type: 'legacy-no-seq' }, { type: 'new', seq: 9 }],
    }
    expect(sliceSessionEvents(session, 9)).toEqual([{ type: 'new', seq: 9 }])
  })
})
