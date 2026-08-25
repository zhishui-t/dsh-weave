import { describe, expect, it } from 'vitest'
import { Context, type Plugin } from '@deepseek-ai/cordis'
import * as weavePlugin from '../index.js'
import { WEAVE_VERSION } from '../index.js'

// 模块命名空间对象即 cordis 对象插件形态（{ name, inject, apply }），
// 与 cordis-plugin-loader 从包名加载后的产物一致。
const plugin = weavePlugin as unknown as Plugin

describe('P0-BOOTSTRAP｜weave 插件加载冒烟测试', () => {
  it('导出 cordis 插件入口元数据（name/inject/apply）', () => {
    expect(weavePlugin.name).toBe('dsh-weave')
    expect(weavePlugin.apply).toBeTypeOf('function')
    expect(weavePlugin.inject).toEqual({})
  })

  it('通过 ctx.plugin() 加载后，ctx.weave 服务可用', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(plugin)
    await fiber
    expect(ctx.weave).toBeDefined()
    expect(ctx.weave.version()).toBe(WEAVE_VERSION)
    expect(ctx.weave.describe()).toContain('weave')
    ctx.registry.delete(plugin)
  })
})
