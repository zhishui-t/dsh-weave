import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_WORKBUDDY_PERMISSION_MODE,
  workbuddyAcpProviderConfigFromEnvironment,
} from '../../../../src/plugins/weave/acp/workbuddy-provider'
import { createDefaultExecutorProviderRegistry } from '../../../../src/plugins/weave/host/host-wiring'
import { classifyProvider } from '../../../../src/plugins/weave/executors/executor-registry'

const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fakeCli(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weave-wb-'))
  tmpDirs.push(dir)
  const file = join(dir, 'codebuddy')
  writeFileSync(file, '#!/usr/bin/env node\n')
  return file
}

/** 最小宿主 ctx：reflect 暴露 subagents/subprocess，其余置空。 */
function fakeCtx(options: { spawn?: (spec: unknown) => unknown } = {}): never {
  const registered: unknown[] = []
  const ctx = {
    reflect: {
      get(name: string) {
        if (name === 'subagents') {
          return { registerProvider: (provider: unknown) => { registered.push(provider); return () => undefined } }
        }
        return undefined
      },
    },
    subprocess: { spawn: options.spawn ?? (() => undefined) },
  }
  ;(ctx as unknown as { __registered: unknown[] }).__registered = registered
  return ctx as never
}

describe('workbuddyAcpProviderConfigFromEnvironment（WorkBuddy 引擎发现）', () => {
  it('WEAVE_WORKBUDDY_CLI 指向存在的 CLI → 标准ACP 配置（--acp + permission-mode）', () => {
    const cli = fakeCli()
    const config = workbuddyAcpProviderConfigFromEnvironment({
      WEAVE_WORKBUDDY_CLI: cli,
    } as unknown as NodeJS.ProcessEnv)
    expect(config).toBeDefined()
    expect(config).toMatchObject({
      name: 'workbuddy',
      command: process.execPath,
      args: [cli, '--acp', '--permission-mode', 'fullAccess'],
      permission: 'allow',
      declaredExtensions: [],
    })
    expect(config!.env!['WEAVE_WORKBUDDY_CLI']).toBe(cli)
  })

  it('CLI 不存在 → undefined（不注册执行器）', () => {
    const config = workbuddyAcpProviderConfigFromEnvironment({
      WEAVE_WORKBUDDY_CLI: '/nonexistent/codebuddy',
    } as unknown as NodeJS.ProcessEnv)
    expect(config).toBeUndefined()
  })

  it('WORKBUDDY_CLI（无 WEAVE 前缀）与权限模式 env 均生效', () => {
    const cli = fakeCli()
    const config = workbuddyAcpProviderConfigFromEnvironment({
      WORKBUDDY_CLI: cli,
      WORKBUDDY_PERMISSION_MODE: 'default',
    } as unknown as NodeJS.ProcessEnv)
    expect(config?.args).toEqual([cli, '--acp', '--permission-mode', 'default'])
    expect(DEFAULT_WORKBUDDY_PERMISSION_MODE).toBe('fullAccess')
  })
})

describe('WorkBuddy 执行器注册（createDefaultExecutorProviderRegistry）', () => {
  it('CLI 存在 → workbuddy 注册进 registry 与 subagents；kind=acp', () => {
    const cli = fakeCli()
    const ctx = fakeCtx()
    // 显式指向 fake CLI：本机不一定装有 WorkBuddy.app（默认探测路径是 macOS-only）
    const saved = process.env.WEAVE_WORKBUDDY_CLI
    process.env.WEAVE_WORKBUDDY_CLI = cli
    try {
      const registry = createDefaultExecutorProviderRegistry(ctx, {
        zcode: undefined,
        includeDsh: false,
      })
      expect(registry.get('workbuddy')).toBeDefined()
      expect(registry.get('workbuddy')?.kind).toBe('acp')
      expect(registry.get('workbuddy')?.supports('workbuddy')).toBe(true)
      expect(registry.get('workbuddy')?.supports('zcode')).toBe(false)
      expect(classifyProvider('workbuddy')).toBe('acp')
    } finally {
      if (saved === undefined) delete process.env.WEAVE_WORKBUDDY_CLI
      else process.env.WEAVE_WORKBUDDY_CLI = saved
    }
  })

  it('CLI 不存在 → 不注册（zcode 缺省、DSH fallback 关闭时 registry 为空）', () => {
    // 本机可能真实装有 WorkBuddy.app：显式指向不存在路径隔离环境差异
    const saved = process.env.WEAVE_WORKBUDDY_CLI
    process.env.WEAVE_WORKBUDDY_CLI = '/nonexistent/codebuddy'
    try {
      const registry = createDefaultExecutorProviderRegistry(fakeCtx(), {
        zcode: undefined,
        includeDsh: false,
      })
      expect(registry.get('workbuddy')).toBeUndefined()
    } finally {
      if (saved === undefined) delete process.env.WEAVE_WORKBUDDY_CLI
      else process.env.WEAVE_WORKBUDDY_CLI = saved
    }
  })
})
