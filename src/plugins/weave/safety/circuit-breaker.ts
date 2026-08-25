import { WeaveError } from '../state/weave-error.js'

/** 断路器状态：ACTIVE → BANNED → COOLDOWN → ACTIVE（架构 10.1） */
export type BreakerState = 'ACTIVE' | 'BANNED' | 'COOLDOWN'

/** 检查顺序（最窄 scope 优先，架构 10.2） */
export const BREAKER_SCOPE_ORDER = [
  'task',
  'agent+project',
  'agent',
  'operation+project+version',
  'operation+project',
  'operation',
  'global',
] as const

export type BreakerScope = (typeof BREAKER_SCOPE_ORDER)[number]

export interface BreakerKey {
  scope: string
  entityKey: string
}

export interface BreakerRecord {
  scope: string
  entityKey: string
  state: BreakerState
  consecutiveFailures: number
  failCount: number
  successCount: number
  /** epoch ms */
  bannedAt: number | null
  banExpiresAt: number | null
  cooldownEndsAt: number | null
  resolvedAt: number | null
  updatedAt: number
}

export interface CircuitBreakerOptions {
  /** 连续失败触发阈值，默认 3（连续失败 ≥ 3 触发） */
  failureThreshold?: number
  /** BANNED 持续时长 ms，默认 1800_000（1800s，与保温期一致；文档未指定，可配置） */
  banDurationMs?: number
  /** COOLDOWN 持续时长 ms，默认 1800_000 */
  cooldownDurationMs?: number
  /** 可注入时钟（测试用），默认 Date.now */
  now?: () => number
}

const KEY_SEP = '\u0000'

/**
 * 断路器：ACTIVE → (连续失败 ≥ 3) → BANNED → (expiry/手动解除) → COOLDOWN → (冷却结束) → ACTIVE。
 * 检查会做惰性时间流转；BANNED/COOLDOWN 期间 check 抛 WeaveError（code=execution_failed）。
 * 纯内存实现；bans/failure_counters DDL 已在 t4 的 core.db 就绪，P1 可接持久化。
 */
export class CircuitBreaker {
  readonly failureThreshold: number
  readonly banDurationMs: number
  readonly cooldownDurationMs: number
  readonly #now: () => number
  readonly #records = new Map<string, BreakerRecord>()

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 3
    this.banDurationMs = options.banDurationMs ?? 1800_000
    this.cooldownDurationMs = options.cooldownDurationMs ?? 1800_000
    this.#now = options.now ?? Date.now
  }

  #key(scope: string, entityKey: string): string {
    return `${scope}${KEY_SEP}${entityKey}`
  }

  #getOrCreate(scope: string, entityKey: string): BreakerRecord {
    const key = this.#key(scope, entityKey)
    let rec = this.#records.get(key)
    if (!rec) {
      rec = {
        scope,
        entityKey,
        state: 'ACTIVE',
        consecutiveFailures: 0,
        failCount: 0,
        successCount: 0,
        bannedAt: null,
        banExpiresAt: null,
        cooldownEndsAt: null,
        resolvedAt: null,
        updatedAt: this.#now(),
      }
      this.#records.set(key, rec)
    }
    return rec
  }

  /** 惰性时间流转：BANNED→(到期)→COOLDOWN→(到期)→ACTIVE。 */
  #refresh(rec: BreakerRecord): void {
    const now = this.#now()
    if (rec.state === 'BANNED' && rec.banExpiresAt !== null && now >= rec.banExpiresAt) {
      rec.state = 'COOLDOWN'
      rec.cooldownEndsAt = now + this.cooldownDurationMs
      rec.updatedAt = now
    }
    if (rec.state === 'COOLDOWN' && rec.cooldownEndsAt !== null && now >= rec.cooldownEndsAt) {
      rec.state = 'ACTIVE'
      rec.consecutiveFailures = 0
      rec.updatedAt = now
    }
  }

  /** 检查指定 scope+entityKey；熔断中（BANNED/COOLDOWN 未到期）抛 WeaveError。 */
  async check(scope: string, entityKey: string): Promise<void> {
    const rec = this.#records.get(this.#key(scope, entityKey))
    if (!rec) return
    this.#refresh(rec)
    if (rec.state === 'ACTIVE') return
    throw new WeaveError('execution_failed', `断路器熔断: scope=${rec.scope} entityKey=${rec.entityKey} state=${rec.state}`, {
      scope: rec.scope,
      entityKey: rec.entityKey,
      state: rec.state,
      checkOrder: BREAKER_SCOPE_ORDER,
    })
  }

  /** 按最窄 scope 优先顺序检查（架构 10.2），在第一个熔断 key 处抛出。 */
  async checkChain(keys: BreakerKey[]): Promise<void> {
    for (const key of keys) {
      await this.check(key.scope, key.entityKey)
    }
  }

  /** 记录一次失败；连续失败 ≥ 阈值（默认 3）时 ACTIVE→BANNED。 */
  async recordFailure(scope: string, entityKey: string): Promise<void> {
    const rec = this.#getOrCreate(scope, entityKey)
    this.#refresh(rec)
    if (rec.state !== 'ACTIVE') return
    const now = this.#now()
    rec.consecutiveFailures++
    rec.failCount++
    rec.updatedAt = now
    if (rec.consecutiveFailures >= this.failureThreshold) {
      rec.state = 'BANNED'
      rec.bannedAt = now
      rec.banExpiresAt = now + this.banDurationMs
    }
  }

  /** 记录一次成功（清除连续失败计数；不会解除 BANNED/COOLDOWN）。 */
  async recordSuccess(scope: string, entityKey: string): Promise<void> {
    const rec = this.#getOrCreate(scope, entityKey)
    this.#refresh(rec)
    rec.successCount++
    if (rec.state === 'ACTIVE') {
      rec.consecutiveFailures = 0
    }
    rec.updatedAt = this.#now()
  }

  /** 手动解除：所有匹配 entityKey 的记录（任意 scope）→ ACTIVE。 */
  async resolve(entityKey: string): Promise<void> {
    const now = this.#now()
    for (const rec of this.#records.values()) {
      if (rec.entityKey !== entityKey) continue
      rec.state = 'ACTIVE'
      rec.consecutiveFailures = 0
      rec.resolvedAt = now
      rec.updatedAt = now
    }
  }

  status(scope: string, entityKey: string): BreakerRecord | undefined {
    const rec = this.#records.get(this.#key(scope, entityKey))
    if (!rec) return undefined
    this.#refresh(rec)
    return { ...rec }
  }

  snapshot(): BreakerRecord[] {
    return [...this.#records.values()].map((rec) => ({ ...rec }))
  }
}
