import { AuditLog } from '../audit/audit-log.js'
import type { PrismGateway } from '../prism/gateway.js'
import { PrismReflectionService } from '../prism/reflection.js'

export interface WeaveCapabilities {
  auditLog: AuditLog
  /** 反思沉淀（prism 版）：WEAVE_KNOWLEDGE 块 → 知识暂存区（先审后发，approve 落 prism）。 */
  reflection: PrismReflectionService
}

export interface CapabilitiesOptions {
  auditDir: string
  /** Prism 门面：知识/图谱/转换统一出口（prism 子项目承接）。 */
  prism: PrismGateway
}

/**
 * 能力层装配：审计、反思/记忆等独立能力集中创建。
 * 团队运行时只依赖这些能力接口，不负责具体 new。
 * 知识存储本体在 prism；weave 侧只保留"反思解析 + 暂存 + 审核编排"治理钩子。
 */
export function createCapabilities(options: CapabilitiesOptions): WeaveCapabilities {
  const auditLog = new AuditLog({ dir: options.auditDir })
  const reflection = new PrismReflectionService({
    gateway: options.prism,
    audit: auditLog,
  })
  return { auditLog, reflection }
}
