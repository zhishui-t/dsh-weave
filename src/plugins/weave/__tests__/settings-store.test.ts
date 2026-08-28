import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadExecutionIdleTimeoutMs, loadExecutionStreamSettings, loadWeaveSettingsOverrides, saveWeaveSettingsOverrides } from '../settings-store'

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

describe('loadExecutionStreamSettings（doc/05 §6.2 P1-B 配置键）', () => {
  it('缺失文件/缺失键/非对象值 → 返回 {}（节流器全默认）', () => {
    const file = tmpFile()
    expect(loadExecutionStreamSettings(file)).toEqual({})
    writeFileSync(file, JSON.stringify({ teams_dir: '/tmp/teams' }), 'utf8')
    expect(loadExecutionStreamSettings(file)).toEqual({})
    writeFileSync(file, JSON.stringify({ execution_stream: 'enabled' }), 'utf8')
    expect(loadExecutionStreamSettings(file)).toEqual({})
  })

  it('合法字段解析；events 过滤非法项；非法类型字段逐项忽略', () => {
    const file = tmpFile()
    writeFileSync(file, JSON.stringify({
      execution_stream: { enabled: false, minIntervalMs: 1000, maxChars: 50, events: ['output', 'bogus'] },
    }), 'utf8')
    expect(loadExecutionStreamSettings(file)).toEqual({
      enabled: false,
      minIntervalMs: 1000,
      maxChars: 50,
      events: ['output'],
    })
    writeFileSync(file, JSON.stringify({
      execution_stream: { enabled: 'yes', minIntervalMs: -5, maxChars: 'long', events: 'all' },
    }), 'utf8')
    expect(loadExecutionStreamSettings(file)).toEqual({})
  })

  it('events 空数组是合法显式配置（处理全部类型但不产生正文）；损坏文件降级 {}', () => {
    const file = tmpFile()
    writeFileSync(file, JSON.stringify({ execution_stream: { events: [] } }), 'utf8')
    expect(loadExecutionStreamSettings(file)).toEqual({ events: [] })
    writeFileSync(file, '{broken', 'utf8')
    expect(loadExecutionStreamSettings(file)).toEqual({})
  })
})

describe('loadExecutionIdleTimeoutMs（idle_timeout 误杀修复覆盖键）', () => {
  it('缺失文件/缺失键 → 缺省 1_200_000', () => {
    const file = tmpFile()
    expect(loadExecutionIdleTimeoutMs(file)).toBe(1_200_000)
    writeFileSync(file, JSON.stringify({ teams_dir: '/tmp/teams' }), 'utf8')
    expect(loadExecutionIdleTimeoutMs(file)).toBe(1_200_000)
  })

  it('合法正数覆盖；0/负数/非法类型忽略回落缺省；小数取整', () => {
    const file = tmpFile()
    writeFileSync(file, JSON.stringify({ execution_idle_timeout_ms: 900_000 }), 'utf8')
    expect(loadExecutionIdleTimeoutMs(file)).toBe(900_000)
    writeFileSync(file, JSON.stringify({ execution_idle_timeout_ms: 1500.7 }), 'utf8')
    expect(loadExecutionIdleTimeoutMs(file)).toBe(1501)
    writeFileSync(file, JSON.stringify({ execution_idle_timeout_ms: 0 }), 'utf8')
    expect(loadExecutionIdleTimeoutMs(file)).toBe(1_200_000)
    writeFileSync(file, JSON.stringify({ execution_idle_timeout_ms: -100 }), 'utf8')
    expect(loadExecutionIdleTimeoutMs(file)).toBe(1_200_000)
    writeFileSync(file, JSON.stringify({ execution_idle_timeout_ms: 'long' }), 'utf8')
    expect(loadExecutionIdleTimeoutMs(file)).toBe(1_200_000)
  })

  it('损坏文件 → 缺省降级', () => {
    const file = tmpFile()
    writeFileSync(file, '{broken', 'utf8')
    expect(loadExecutionIdleTimeoutMs(file)).toBe(1_200_000)
  })
})
