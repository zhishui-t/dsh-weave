import { AuditLog } from '../audit/audit-log.js'
import { ReflectionService } from '../reflection-service.js'
import type { KnowledgeStore } from '../knowledge-model.js'

export interface WeaveCapabilities {
  auditLog: AuditLog
  reflection: ReflectionService
}

export interface CapabilitiesOptions {
  auditDir: string
  knowledgeStore: KnowledgeStore
}

/**
 * 能力层装配：审计、反思/记忆等独立能力集中创建。
 * 团队运行时只依赖这些能力接口，不负责具体 new。
 */
export function createCapabilities(options: CapabilitiesOptions): WeaveCapabilities {
  const auditLog = new AuditLog({ dir: options.auditDir })
  const reflection = new ReflectionService({
    knowledge: options.knowledgeStore,
    audit: auditLog,
  })
  return { auditLog, reflection }
}
