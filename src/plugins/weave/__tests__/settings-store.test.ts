import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadWeaveSettingsOverrides, saveWeaveSettingsOverrides } from '../settings-store'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const tmpFile = () => {
  const root = mkdtempSync(join(tmpdir(), 'weave-settings-'))
  roots.push(root)
  return join(root, 'settings.json')
}

describe('settings-store 目录覆盖', () => {
  it('缺失文件返回空 overrides；保存后可读回；空串恢复默认', () => {
    const file = tmpFile()
    expect(loadWeaveSettingsOverrides(file)).toEqual({})
    const saved = saveWeaveSettingsOverrides(file, { teams_dir: '/tmp/teams', audit_dir: '' })
    expect(saved).toEqual({ teams_dir: '/tmp/teams' })
    expect(loadWeaveSettingsOverrides(file)).toEqual({ teams_dir: '/tmp/teams' })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ teams_dir: '/tmp/teams' })
    expect(saveWeaveSettingsOverrides(file, { teams_dir: '' })).toEqual({})
  })

  it('未知字段拒绝；损坏文件按空覆盖降级', () => {
    const file = tmpFile()
    expect(() => saveWeaveSettingsOverrides(file, { hack: '/x' })).toThrow(/未知设置字段/)
    expect(() => saveWeaveSettingsOverrides(file, { teams_dir: 42 })).toThrow(/必须为字符串路径/)
  })
})
