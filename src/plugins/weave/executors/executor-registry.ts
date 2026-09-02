import type { Context } from '@deepseek-ai/cordis'
import type { SubagentCapabilities } from '@deepseek-ai/dsh-subagent'

/**
 * P0-REG-002 —— ExecutorRegistry：执行器发现与四类分类。
 *
 * 数据源（唯一）：`ctx.subagents.list()`（DSH 0.1.1-rc.2，同步方法，含 `await` 亦可但无需）；
 * 能力数据源：`ctx.subagents.getProvider(name).capabilities`（真实 SubagentCapabilities）。
 *
 * 分类依据（TDD 1.5.4 / SDD 2.4.3）：
 *   spawn / fork            → dsh_subagent
 *   codex                   → codex
 *   claude-code             → claude_code
 *   其它（ACP 工具）        → acp
 *
 * 说明：DSH API 未给 provider 提供"是否 DSH 内置/ACP 注册"标记，自定义 DSH provider
 * 目前与 ACP 工具无法区分，按上表规则落入 acp；P0-EXEC-021 实证后如需细分再引入配置映射。
 */

/** 执行器四类分类（TDD 1.5.4）。 */
export type ExecutorKind = 'dsh_subagent' | 'codex' | 'claude_code' | 'acp'

/** 单个执行器的注册信息与分类结果。 */
export interface ExecutorInfo {
  /** 执行器 id（= DSH provider 注册名，如 spawn / codex）。 */
  id: string
  /** 展示名（P0 与 id 一致）。 */
  name: string
  /** 四类分类。 */
  kind: ExecutorKind
  /** 真实 DSH SubagentCapabilities（outputSchema / depthLimit / toolFilter / persona）。 */
  capabilities: SubagentCapabilities
}

/** provider 名 → 分类 的规则表（可测试、可扩展）。 */
export const EXECUTOR_KIND_RULES: Readonly<Record<string, ExecutorKind>> = {
  spawn: 'dsh_subagent',
  fork: 'dsh_subagent',
  codex: 'codex',
  'claude-code': 'claude_code',
}

/** 按规则表对单个 provider 名分类（未命中 → acp）。 */
export function classifyProvider(provider: string): ExecutorKind {
  return EXECUTOR_KIND_RULES[provider] ?? 'acp'
}

const NO_CAPABILITIES: SubagentCapabilities = {
  outputSchema: false,
  depthLimit: false,
  toolFilter: false,
  persona: false,
}

/**
 * 基于 `ctx.subagents` 的执行器发现与分类注册表。
 * 为 TeamManager（存在性校验）、DelegationService（执行器信息查询）、Web/CLI（列表展示）
 * 提供统一视图；对外只读（load 后通过 get/list/kindOf 访问）。
 */
export class ExecutorRegistry {
  private executors = new Map<string, ExecutorInfo>()

  /**
   * 从 `ctx.subagents` 重新发现并分类全部 provider。
   * 每次调用整体重建（list() 返回的是完整注册表快照，不存在"增量"语义）。
   * @throws 当 ctx.subagents 缺失时（无 DSH 运行环境），由调用方决定处理方式。
   */
  load(ctx: Context): void {
    const subagents = ctx.subagents
    const providers = subagents.list()
    const next = new Map<string, ExecutorInfo>()
    for (const provider of providers) {
      const providerInfo = subagents.getProvider?.(provider)
      next.set(provider, {
        id: provider,
        name: provider,
        kind: classifyProvider(provider),
        capabilities: providerInfo?.capabilities ?? NO_CAPABILITIES,
      })
    }
    this.executors = next
  }

  /** 按 id 查询执行器信息；未注册返回 undefined。 */
  get(id: string): ExecutorInfo | undefined {
    return this.executors.get(id)
  }

  /** 全部执行器信息（按 provider 注册顺序）。 */
  list(): ExecutorInfo[] {
    return [...this.executors.values()]
  }

  /** 查询执行器分类；未注册返回 undefined。 */
  kindOf(id: string): ExecutorKind | undefined {
    return this.executors.get(id)?.kind
  }

  /** 当前已注册执行器数量。 */
  get size(): number {
    return this.executors.size
  }
}
