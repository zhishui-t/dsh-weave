import { WeaveError } from './weave-error.js'

/**
 * 任务写域（write scope）规范化与重叠判定。
 *
 * 移植自官方 deepseek-harness agent-team 参照实现（validation.ts writeScope /
 * task-board.ts scopesOverlap）：写域是工作区相对路径前缀，仅做提示性冲突
 * 提醒（advisory），不构成锁——调度器对重叠只警告不阻断。
 */

/**
 * 规范化一个用户手写的写域前缀。
 * 规则（与官方一致）：反斜杠归一为斜杠；剥离前导 `./` 与尾部 `/`；
 * 拒绝空串/绝对路径（前导 `/`）/盘符（`C:` 等）/空段/`.`/`..` 段。
 *
 * @throws WeaveError('invalid_argument') 非法写域。
 */
export function writeScope(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '')
  const segments = normalized.split('/')
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    /^[a-z]:/iu.test(normalized) ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new WeaveError('invalid_argument', `非法的工作区相对写域: ${JSON.stringify(value)}`, {
      value,
    })
  }
  return normalized
}

/**
 * 规范化并去重一组写域（ TeamTaskBoard.writeScopes 同款）。
 * 单个非法写域抛 WeaveError；调用方（规划/导入管线）据此向用户报错。
 */
export function normalizeWriteScopes(values: readonly string[]): string[] {
  return [...new Set(values.map(writeScope))]
}

/** 两个已规范化写域是否在路径分量上重叠（相等或互为前缀）。 */
export function scopesOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

/** 两组写域是否存在任一重叠（任一左 × 任一右）。 */
export function scopeSetsOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some((l) => right.some((r) => scopesOverlap(l, r)))
}

/** 解析 tasks.write_scopes 列（JSON 数组文本）；损坏/缺省一律回退空数组。 */
export function parseWriteScopes(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined || raw === '') return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}
