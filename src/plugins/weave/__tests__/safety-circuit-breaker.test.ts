import { describe, expect, it } from 'vitest'
import {
  CircuitBreaker,
  BREAKER_SCOPE_ORDER,
  ProcessLimiter,
  LoopGuard,
  DelegationChain,
  MAX_DELEGATION_DEPTH,
  WAIT_TIMEOUT_MS,
} from '../safety/index.js'
import { WeaveError } from '../state/weave-error.js'

const HOUR_MS = 3600_000

describe('CircuitBreaker：ACTIVE → BANNED → COOLDOWN → ACTIVE', () => {
  it('连续失败 ≥ 3 触发 BANNED', async () => {
    const cb = new CircuitBreaker()
    for (let i = 0; i < 2; i++) {
      await cb.recordFailure('agent', 'deepseek')
      expect(cb.status('agent', 'deepseek')?.state).toBe('ACTIVE')
    }
    await cb.recordFailure('agent', 'deepseek')
    expect(cb.status('agent', 'deepseek')?.state).toBe('BANNED')
    expect(cb.status('agent', 'deepseek')?.consecutiveFailures).toBe(3)
    expect(cb.status('agent', 'deepseek')?.bannedAt).not.toBeNull()
  })

  it('失败之间穿插成功会重置连续计数，不触发熔断', async () => {
    const cb = new CircuitBreaker()
    await cb.recordFailure('agent', 'codex')
    await cb.recordSuccess('agent', 'codex')
    await cb.recordFailure('agent', 'codex')
    await cb.recordSuccess('agent', 'codex')
    await cb.recordFailure('agent', 'codex')
    expect(cb.status('agent', 'codex')?.state).toBe('ACTIVE')
    expect(cb.status('agent', 'codex')?.consecutiveFailures).toBe(1)
  })

  it('BANNED 期间 check 抛 WeaveError(execution_failed, state=BANNED)', async () => {
    const cb = new CircuitBreaker()
    await cb.recordFailure('agent+project', 'deepseek:p1')
    await cb.recordFailure('agent+project', 'deepseek:p1')
    await cb.recordFailure('agent+project', 'deepseek:p1')
    let caught: WeaveError | undefined
    try {
      await cb.check('agent+project', 'deepseek:p1')
    } catch (e) {
      caught = e as WeaveError
    }
    expect(caught).toBeInstanceOf(WeaveError)
    expect(caught?.code).toBe('execution_failed')
    expect(caught?.details).toMatchObject({ state: 'BANNED', scope: 'agent+project', entityKey: 'deepseek:p1' })
  })

  it('BANNED 到期（惰性）→ COOLDOWN（check 仍拒绝）；COOLDOWN 到期 → ACTIVE 放行', async () => {
    let t = 1_000_000
    const cb = new CircuitBreaker({ now: () => t, banDurationMs: 1000, cooldownDurationMs: 1000 })
    for (let i = 0; i < 3; i++) await cb.recordFailure('operation', 'op:p:v')
    expect(cb.status('operation', 'op:p:v')?.state).toBe('BANNED')

    t += 1001 // BANNED 到期
    await expect(cb.check('operation', 'op:p:v')).rejects.toMatchObject({ code: 'execution_failed', details: { state: 'COOLDOWN' } })

    t += 1001 // COOLDOWN 到期
    await expect(cb.check('operation', 'op:p:v')).resolves.toBeUndefined()
    expect(cb.status('operation', 'op:p:v')?.state).toBe('ACTIVE')
  })

  it('resolve（手动解除）立即恢复 ACTIVE，且清除连续失败', async () => {
    const cb = new CircuitBreaker()
    await cb.recordFailure('global', 'g')
    await cb.recordFailure('global', 'g')
    await cb.recordFailure('global', 'g')
    expect(cb.status('global', 'g')?.state).toBe('BANNED')
    await cb.resolve('g')
    expect(cb.status('global', 'g')?.state).toBe('ACTIVE')
    expect(cb.status('global', 'g')?.consecutiveFailures).toBe(0)
  })

  it('resolve 解除所有 scope 下相同 entityKey 的记录', async () => {
    const cb = new CircuitBreaker()
    for (const scope of ['agent', 'operation']) {
      for (let i = 0; i < 3; i++) await cb.recordFailure(scope, 'same-entity')
    }
    expect(cb.status('agent', 'same-entity')?.state).toBe('BANNED')
    expect(cb.status('operation', 'same-entity')?.state).toBe('BANNED')
    await cb.resolve('same-entity')
    expect(cb.status('agent', 'same-entity')?.state).toBe('ACTIVE')
    expect(cb.status('operation', 'same-entity')?.state).toBe('ACTIVE')
  })

  it('最窄 scope 优先：checkChain 在第一个熔断 key 处抛出', async () => {
    const cb = new CircuitBreaker()
    for (let i = 0; i < 3; i++) await cb.recordFailure('operation', 'op:p:v')
    // 更窄的 task/agent scope 未熔断 → 单独 check 放行
    await expect(cb.check('task', 't-1')).resolves.toBeUndefined()
    await expect(cb.check('agent', 'deepseek')).resolves.toBeUndefined()
    // 按最窄→最宽顺序检查 → 在 operation 抛出
    const chain = [
      { scope: 'task', entityKey: 't-1' },
      { scope: 'agent+project', entityKey: 'deepseek:p1' },
      { scope: 'agent', entityKey: 'deepseek' },
      { scope: 'operation+project+version', entityKey: 'op:p:v1' },
      { scope: 'operation+project', entityKey: 'op:p' },
      { scope: 'operation', entityKey: 'op:p:v' },
      { scope: 'global', entityKey: '*' },
    ]
    await expect(cb.checkChain(chain)).rejects.toMatchObject({
      code: 'execution_failed',
      details: { scope: 'operation', entityKey: 'op:p:v', state: 'BANNED' },
    })
    // 若跳过 operation（已 resolve），则通过
    await cb.resolve('op:p:v')
    await expect(cb.checkChain(chain)).resolves.toBeUndefined()
  })

  it('不同 entityKey 互不影响（隔离）', async () => {
    const cb = new CircuitBreaker()
    for (let i = 0; i < 3; i++) await cb.recordFailure('agent', 'codex')
    await expect(cb.check('agent', 'codex')).rejects.toThrow()
    await expect(cb.check('agent', 'deepseek')).resolves.toBeUndefined()
  })

  it('recordSuccess 不解除 BANNED（只重置统计，解除靠时间/手动）', async () => {
    const cb = new CircuitBreaker()
    for (let i = 0; i < 3; i++) await cb.recordFailure('agent', 'claude_code')
    await cb.recordSuccess('agent', 'claude_code')
    expect(cb.status('agent', 'claude_code')?.state).toBe('BANNED')
  })

  it('BANNED/COOLDOWN 期间 recordFailure 不再累计', async () => {
    const t = 0
    const cb = new CircuitBreaker({ now: () => t, banDurationMs: 1000, cooldownDurationMs: 1000 })
    for (let i = 0; i < 3; i++) await cb.recordFailure('global', 'x')
    const before = cb.status('global', 'x')?.failCount ?? 0
    await cb.recordFailure('global', 'x')
    expect(cb.status('global', 'x')?.failCount).toBe(before)
  })

  it('阈值可配置；status 未记录返回 undefined，保留 SCOPE 检查顺序常量', async () => {
    expect(BREAKER_SCOPE_ORDER).toEqual([
      'task', 'agent+project', 'agent',
      'operation+project+version', 'operation+project', 'operation', 'global',
    ])
    const cb = new CircuitBreaker({ failureThreshold: 2 })
    expect(cb.status('agent', 'nope')).toBeUndefined()
    await cb.recordFailure('agent', 'nope')
    await cb.recordFailure('agent', 'nope')
    expect(cb.status('agent', 'nope')?.state).toBe('BANNED')
  })
})

describe('ProcessLimiter：per-executor 并发 + 小时频率，超限排队不熔断', () => {
  it('acquire 占用并发槽位；超限返回 false；release 后恢复', () => {
    const pl = new ProcessLimiter({ defaultLimits: { maxConcurrent: 1, maxPerHour: 100 } })
    expect(pl.acquire('codex')).toBe(true)
    expect(pl.acquire('codex')).toBe(false)
    pl.release('codex')
    expect(pl.acquire('codex')).toBe(true)
  })

  it('per-executor 隔离：A 占满不影响 B', () => {
    const pl = new ProcessLimiter({ defaultLimits: { maxConcurrent: 1, maxPerHour: 100 } })
    expect(pl.acquire('codex')).toBe(true)
    expect(pl.acquire('claude_code')).toBe(true)
    expect(pl.acquire('codex')).toBe(false)
    expect(pl.acquire('claude_code')).toBe(false)
  })

  it('小时频率：窗口内超限拒绝，窗口滑移后恢复', () => {
    let t = 0
    const pl = new ProcessLimiter({
      defaultLimits: { maxConcurrent: 10, maxPerHour: 3 },
      now: () => t,
    })
    expect(pl.acquire('a')).toBe(true)
    expect(pl.acquire('a')).toBe(true)
    expect(pl.acquire('a')).toBe(true)
    expect(pl.acquire('a')).toBe(false) // 3 次/小时已满
    t += HOUR_MS + 1
    expect(pl.acquire('a')).toBe(true) // 窗口滑移
  })

  it('waitForProcessSlot 排队等待，释放后自动继续（AC-EXEC-005，不熔断）', async () => {
    const pl = new ProcessLimiter({ defaultLimits: { maxConcurrent: 1, maxPerHour: 100 }, pollIntervalMs: 5 })
    expect(pl.acquire('spawn')).toBe(true)
    const waiter = pl.waitForProcessSlot('spawn')
    setTimeout(() => pl.release('spawn'), 20)
    await waiter // 释放后自动获得槽位
    expect(pl.status('spawn').active).toBe(1)
    pl.release('spawn')
  })

  it('AbortSignal 中止等待', async () => {
    const pl = new ProcessLimiter({ defaultLimits: { maxConcurrent: 1, maxPerHour: 100 }, pollIntervalMs: 5 })
    pl.acquire('spawn')
    const ac = new AbortController()
    const p = pl.waitForProcessSlot('spawn', ac.signal)
    setTimeout(() => ac.abort(), 10)
    await expect(p).rejects.toThrow(/abort/i)
  })

  it('status() 快照反映并发与窗口内频率', () => {
    let t = 0
    const pl = new ProcessLimiter({
      defaultLimits: { maxConcurrent: 2, maxPerHour: 5 },
      now: () => t,
    })
    pl.acquire('x')
    pl.acquire('x')
    expect(pl.status('x')).toMatchObject({ active: 2, maxConcurrent: 2, usedInHour: 2, maxPerHour: 5, waiting: 0 })
    t += HOUR_MS + 1
    expect(pl.status('x')).toMatchObject({ usedInHour: 0 })
  })
})

describe('LoopGuard：步数/工具重复/输出零增长/时间', () => {
  it('步数上限 30：第 31 步抛 loop_detected(max_steps)', () => {
    const lg = new LoopGuard()
    for (let i = 0; i < 30; i++) {
      // 输出严格增长（避免误触发零增长检测）
      expect(() => lg.step({ action: `step-${i}`, output: 'x'.repeat(30 + i * 10) })).not.toThrow()
    }
    expect(() => lg.step({ action: 'step-30', output: 'y'.repeat(30 + 30 * 10) })).toThrow(
      expect.objectContaining({ code: 'loop_detected', details: expect.objectContaining({ kind: 'max_steps' }) }),
    )
  })

  it('动作连续 3 次相同 → same_action', () => {
    const lg = new LoopGuard()
    lg.step({ action: 'build', output: 'x'.repeat(50) })
    lg.step({ action: 'build', output: 'y'.repeat(50) })
    expect(() => lg.step({ action: 'build', output: 'z'.repeat(50) })).toThrow(
      expect.objectContaining({ code: 'loop_detected', details: expect.objectContaining({ kind: 'same_action', action: 'build' }) }),
    )
  })

  it('输出零增长（连续 3 次增量 < 10 字符）→ zero_growth', () => {
    const lg = new LoopGuard()
    lg.step({ action: 'a', output: 'short1' })
    lg.step({ action: 'b', output: 'short2' })
    expect(() => lg.step({ action: 'c', output: 'short3' })).toThrow(
      expect.objectContaining({ code: 'loop_detected', details: expect.objectContaining({ kind: 'zero_growth' }) }),
    )
  })

  it('输出有实质增长时不触发零增长', () => {
    const lg = new LoopGuard()
    for (let i = 0; i < 10; i++) {
      expect(() => lg.step({ action: `a${i}`, output: 'x'.repeat(20 + i * 10) })).not.toThrow()
    }
  })

  it('时间上限 300s：超时后抛 max_duration', () => {
    let t = 0
    const lg = new LoopGuard({ now: () => t })
    lg.step({ action: 'a', output: 'x'.repeat(50) })
    t = WAIT_TIMEOUT_MS + 1
    expect(() => lg.step({ action: 'b', output: 'y'.repeat(50) })).toThrow(
      expect.objectContaining({ code: 'loop_detected', details: expect.objectContaining({ kind: 'max_duration' }) }),
    )
  })

  it('reset() 清空状态；steps 计数正确', () => {
    const lg = new LoopGuard()
    lg.step({ action: 'a', output: 'x'.repeat(50) })
    lg.step({ action: 'b', output: 'y'.repeat(50) })
    expect(lg.steps).toBe(2)
    lg.reset()
    expect(lg.steps).toBe(0)
    expect(() => lg.step({ action: 'a', output: 'z'.repeat(50) })).not.toThrow()
  })
})

describe('DelegationChain：委托链防循环（架构 10.4）', () => {
  it('深度 ≤ 3；第 4 层抛 chain_depth', () => {
    const chain = new DelegationChain()
    chain.push('a')
    chain.push('b')
    chain.push('c')
    expect(chain.depth).toBe(MAX_DELEGATION_DEPTH)
    expect(() => chain.push('d')).toThrow(
      expect.objectContaining({ code: 'loop_detected', details: expect.objectContaining({ kind: 'chain_depth' }) }),
    )
  })

  it('执行器重复且未完成 → 拒绝；pop 后恢复', () => {
    const chain = new DelegationChain()
    chain.push('codex')
    chain.push('deepseek')
    expect(() => chain.push('codex')).toThrow(
      expect.objectContaining({ code: 'loop_detected', details: expect.objectContaining({ kind: 'executor_repeat', executorId: 'codex' }) }),
    )
    chain.pop() // 退出 deepseek
    chain.pop() // 退出 codex
    expect(() => chain.push('codex')).not.toThrow()
    expect(chain.snapshot()).toEqual(['codex'])
  })
})
