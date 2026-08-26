import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { WeaveError } from './state/weave-error.js'

export const DEFAULT_WEAVE_SETTINGS_FILE = join(homedir(), '.dsh', 'weave', 'settings.json')

export type WeaveSettingsKeys =
  | 'state_dir'
  | 'teams_dir'
  | 'audit_dir'
  | 'obsidian_dir'
  | 'knowledge_dir'
  | 'providers_file'

export type WeaveSettingsOverrides = Partial<Record<WeaveSettingsKeys, string>>

const KNOWN: readonly WeaveSettingsKeys[] = [
  'state_dir',
  'teams_dir',
  'audit_dir',
  'obsidian_dir',
  'knowledge_dir',
  'providers_file',
]

/** 加载持久化目录覆盖；文件缺失/损坏返回 {}（与新安装一致，绝不抛错导致主机无法启动）。 */
export function loadWeaveSettingsOverrides(file: string = DEFAULT_WEAVE_SETTINGS_FILE): WeaveSettingsOverrides {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
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
export function saveWeaveSettingsOverrides(
  file: string,
  patch: Record<string, unknown>,
): WeaveSettingsOverrides {
  const invalid = Object.keys(patch).filter((key) => !KNOWN.includes(key as WeaveSettingsKeys))
  if (invalid.length > 0) {
    throw new WeaveError('invalid_argument', `未知设置字段: ${invalid.join(', ')}`, { fields: invalid })
  }
  const current = loadWeaveSettingsOverrides(file)
  for (const key of KNOWN) {
    const incoming = patch[key]
    if (incoming === undefined || incoming === null || incoming === '') delete current[key]
    else if (typeof incoming === 'string') current[key] = incoming
    else throw new WeaveError('invalid_argument', `${key} 必须为字符串路径`, { field: key })
  }
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  writeFileSync(temp, JSON.stringify(current, null, 2), 'utf8')
  renameSync(temp, file)
  return current
}
