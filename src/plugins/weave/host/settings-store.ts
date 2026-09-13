import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { WeaveError } from '../state/weave-error.js'
import type { ExecutorRunEventType } from '../scheduling/delegation-service.js'
import type { StreamOptions } from '../scheduling/session-stream.js'

export const DEFAULT_WEAVE_SETTINGS_FILE = join(homedir(), '.dsh', 'weave', 'settings.json')

export type WeaveSettingsKeys =
  | 'state_dir'
  | 'teams_dir'
  | 'audit_dir'
  | 'providers_file'
  | 'prism_base_url'
  | 'prism_home'
  | 'prism_default_executor'

export type WeaveSettingsOverrides = Partial<Record<WeaveSettingsKeys, string>>

const KNOWN: readonly WeaveSettingsKeys[] = [
  'state_dir',
  'teams_dir',
  'audit_dir',
  'providers_file',
  'prism_base_url',
  'prism_home',
  'prism_default_executor',
]

/** 加载持久化目录/Prism 接入覆盖；文件缺失/损坏返回 {}（与新安装一致，绝不抛错导致主机无法启动）。 */
export async function loadWeaveSettingsOverrides(file: string = DEFAULT_WEAVE_SETTINGS_FILE): Promise<WeaveSettingsOverrides> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    const out: WeaveSettingsOverrides = {}
    for (const key of KNOWN) {
      const value = raw[key]
      if (typeof value === 'string' && value !== '') out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

/** 合并并原子写入；''、undefined、null 表示恢复默认（移除该覆盖）。返回保存后的覆盖。 */
export async function saveWeaveSettingsOverrides(
  file: string,
  patch: Record<string, unknown>,
): Promise<WeaveSettingsOverrides> {
  const invalid = Object.keys(patch).filter((key) => !KNOWN.includes(key as WeaveSettingsKeys))
  if (invalid.length > 0) {
    throw new WeaveError('invalid_argument', `未知设置字段: ${invalid.join(', ')}`, { fields: invalid })
  }
  // prism_base_url 校验（SSRF 防线）：weave 会把反思沉淀全文/任务 payload/检索
  // query POST 到该地址——只允许 http(s) 且 host 为 loopback（127.0.0.1/localhost/[::1]）。
  const rawUrl = patch['prism_base_url']
  if (typeof rawUrl === 'string' && rawUrl !== '') {
    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      throw new WeaveError('invalid_argument', `prism_base_url 不是合法 URL: ${rawUrl}`, { field: 'prism_base_url' })
    }
    const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(parsed.hostname)
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !loopback) {
      throw new WeaveError(
        'invalid_argument',
        `prism_base_url 只允许 http(s) 且指向本机（127.0.0.1/localhost），收到: ${rawUrl}`,
        { field: 'prism_base_url', hostname: parsed.hostname },
      )
    }
  }
  const current = await loadWeaveSettingsOverrides(file)
  for (const key of KNOWN) {
    const incoming = patch[key]
    if (incoming === undefined || incoming === null || incoming === '') delete current[key]
    else if (typeof incoming === 'string') current[key] = incoming
    else throw new WeaveError('invalid_argument', `${key} 必须为字符串路径`, { field: key })
  }
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  await writeFile(temp, JSON.stringify(current, null, 2), 'utf8')
  await rename(temp, file)
  return current
}

const EXECUTION_STREAM_EVENTS: readonly ExecutorRunEventType[] = ['status', 'output', 'reasoning', 'tool_call', 'tool_result']

/**
 * 执行实时流回灌配置（doc/05 §6.2 P1-B）：settings.json 顶层 `execution_stream` 键，
 * 结构同 StreamOptions（enabled/minIntervalMs/maxChars/events）；键缺失 → 返回 {}
 * （即 T9 节流器全默认）；字段类型非法的逐项忽略；文件缺失/损坏 → {} 全默认降级，
 * 绝不抛错影响插件装配。
 */
export async function loadExecutionStreamSettings(file: string = DEFAULT_WEAVE_SETTINGS_FILE): Promise<StreamOptions> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    const value = raw['execution_stream']
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
    const source = value as Record<string, unknown>
    const out: StreamOptions = {}
    if (typeof source['enabled'] === 'boolean') out.enabled = source['enabled']
    if (typeof source['minIntervalMs'] === 'number' && Number.isFinite(source['minIntervalMs']) && source['minIntervalMs'] >= 0) {
      out.minIntervalMs = source['minIntervalMs']
    }
    if (typeof source['maxChars'] === 'number' && Number.isFinite(source['maxChars']) && source['maxChars'] >= 1) {
      out.maxChars = source['maxChars']
    }
    if (Array.isArray(source['events'])) {
      out.events = (source['events'] as unknown[]).filter(
        (item): item is ExecutorRunEventType =>
          typeof item === 'string' && (EXECUTION_STREAM_EVENTS as readonly string[]).includes(item),
      )
    }
    return out
  } catch {
    return {}
  }
}

/**
 * 执行空闲超时缺省（idle_timeout 误杀修复，2026-08-28）：zcode 长工具执行/长思考段
 * 实测可超 10 分钟，600s 阈值已 4 次误杀健康任务；提升到 20 分钟，绝对墙钟
 * （delegationMaxWallClockMs=60min）仍是挂死兜底，长任务仍可被队长人工取消。
 */
export const DEFAULT_EXECUTION_IDLE_TIMEOUT_MS = 1_200_000

/**
 * settings.json 顶层 `execution_idle_timeout_ms` 键：正数毫秒覆盖缺省；
 * 键缺失/类型非法/文件损坏 → 返回缺省值，绝不抛错影响插件装配。
 */
export async function loadExecutionIdleTimeoutMs(file: string = DEFAULT_WEAVE_SETTINGS_FILE): Promise<number> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    const value = raw['execution_idle_timeout_ms']
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.round(value)
    return DEFAULT_EXECUTION_IDLE_TIMEOUT_MS
  } catch {
    return DEFAULT_EXECUTION_IDLE_TIMEOUT_MS
  }
}
