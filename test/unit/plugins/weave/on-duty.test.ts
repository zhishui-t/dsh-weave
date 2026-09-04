import { describe, expect, it, vi } from 'vitest'
import { OnDutyController } from '../../../../src/plugins/weave/core/on-duty.js'

describe('OnDutyController', () => {
  it('allows turn end when no active work and no unread', async () => {
    const controller = new OnDutyController({
      hasActiveWork: async () => false,
      hasUnread: async () => false,
      notify: () => {},
    })
    expect(await controller.decideTurn('s1')).toBe('allow')
  })

  it('keeps turn when active work exists', async () => {
    const controller = new OnDutyController({
      hasActiveWork: async () => true,
      hasUnread: async () => false,
      notify: () => {},
    })
    expect(await controller.decideTurn('s1')).toBe('keep')
  })

  it('notifies and dedupes member events', () => {
    const notify = vi.fn()
    const controller = new OnDutyController({
      hasActiveWork: async () => false,
      hasUnread: async () => false,
      notify,
    })
    controller.onMemberEvent({ id: 'e1', sessionId: 's1', text: 'done' })
    controller.onMemberEvent({ id: 'e1', sessionId: 's1', text: 'done' })
    expect(notify).toHaveBeenCalledTimes(1)
  })
})
