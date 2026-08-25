/**
 * P0-KUI-011 —— 知识导入 UI 控制器（渲染器无关，可被 React/Vue/CLI 直接绑定）。
 *
 * 角色契约（评审与 TDD AC-IMPORT-003/004/006、FDD 4.1.5）：
 *  1. UI 侧只允许调用 pickFile / convert / preview / confirm / cancel 五个动作；
 *     **控制器从不直接写知识** —— 知识写入的唯一路径是
 *     `ImportPipeline.confirm → KnowledgeStore.createCandidate`（强制 status='candidate'，
 *     未确认前不写 active，见 knowledge-model 强制约束），KUI 层不接触 KnowledgeStore。
 *  2. `confirm` 必须先 `preview`（本地守卫 + pipeline 状态机双重保证）；
 *  3. `cancel` 幂等：重复取消/已取消为 no-op；已确认/已转正时给出可读错误（import_cancelled）；
 *  4. 上传/转换/预览错误转为 flow.error（可读），方法不抛异常（组件友好）；
 *  5. 归属选择（AC-IMPORT-006）在 pickFile 时经 pipeline.upload 校验，缺必填字段给出可读错误。
 *
 * 渲染绑定：subscribe(snapshot) + viewModelOf(flow)（纯可序列化 + 派生 canXxx 标志）。
 */
import { basename, extname } from 'node:path'

import {
  ImportPipeline,
  ImportPipelineError,
  type ImportJob,
  type ImportMeta,
  type ImportStatus,
  type KnowledgeCandidate,
  type UploadedFile,
} from './import-pipeline.js'
import type { KnowledgeType, Visibility } from './knowledge-model.js'

/** 用户可在确认前编辑的字段（candidate 子集）。 */
export interface EditableCandidate {
  title?: string
  content?: string
  type?: KnowledgeType
  visibility?: Visibility
  tags?: string[]
}

/** 单个导入流程的 UI 状态（渲染层可读；error 恒为可读文本）。 */
export interface ImportUiFlow {
  /** 导入任务 id；上传失败时为 ''（无任务）。 */
  jobId: string
  filename: string
  /** 与 ImportStatus 同词表；上传失败置 failed。 */
  phase: ImportStatus | 'failed'
  /** 最近一次从 pipeline 同步的任务快照。 */
  job?: ImportJob
  previewMarkdown?: string
  edited?: EditableCandidate
  candidateId?: string
  warnings: string[]
  error?: { code: string; message: string }
  updatedAt: string
}

/** 渲染层绑定用的纯视图（可 JSON 序列化）。 */
export interface ImportUiView {
  jobId: string
  filename: string
  phase: ImportUiFlow['phase']
  title: string | null
  previewMarkdown: string | null
  candidateId: string | null
  warnings: string[]
  error: ImportUiFlow['error'] | null
  canConvert: boolean
  canPreview: boolean
  canConfirm: boolean
  canCancel: boolean
}

export interface ImportUiSnapshot {
  flows: ImportUiFlow[]
}

export type ImportUiListener = (snapshot: ImportUiSnapshot) => void

export interface ImportUiControllerOptions {
  /** 保留的最大流程数（防无限累积，默认 50，按创建顺序淘汰最旧）。 */
  maxFlows?: number
}

const DEFAULT_MAX_FLOWS = 50

function stemOf(filename: string): string {
  const base = basename(filename)
  const ext = extname(base)
  return ext ? base.slice(0, -ext.length) : base
}

function errorOf(error: unknown): { code: string; message: string } {
  if (error instanceof ImportPipelineError) {
    return { code: error.code, message: error.message }
  }
  return {
    code: 'internal_error',
    message: error instanceof Error ? error.message : String(error),
  }
}

function phaseOf(status: ImportStatus): ImportUiFlow['phase'] {
  return status
}

export class ImportUiController {
  readonly #pipeline: ImportPipeline
  readonly #maxFlows: number
  readonly #flows = new Map<string, ImportUiFlow>()
  readonly #listeners = new Set<ImportUiListener>()

  constructor(pipeline: ImportPipeline, options: ImportUiControllerOptions = {}) {
    this.#pipeline = pipeline
    this.#maxFlows = options.maxFlows ?? DEFAULT_MAX_FLOWS
  }

  /* ------------------------------ 订阅 / 查询 ------------------------------ */

  subscribe(listener: ImportUiListener): () => void {
    this.#listeners.add(listener)
    listener(this.snapshot())
    return () => {
      this.#listeners.delete(listener)
    }
  }

  snapshot(): ImportUiSnapshot {
    return { flows: [...this.#flows.values()].map((f) => ({ ...f })) }
  }

  getFlow(jobId: string): ImportUiFlow | undefined {
    const flow = this.#flows.get(jobId)
    return flow ? { ...flow } : undefined
  }

  /* ------------------------------ UI 动作契约 ------------------------------ */

  /** 选择文件（上传入口，拖拽/文件选择共用）：白名单 + 归属校验 → uploaded。 */
  async pickFile(file: UploadedFile, meta: ImportMeta): Promise<ImportUiFlow> {
    try {
      const job = await this.#pipeline.upload(file, meta)
      return this.#put({
        jobId: job.id,
        filename: job.original_filename,
        phase: phaseOf(job.status),
        job,
        warnings: [],
        edited: {},
        updatedAt: new Date().toISOString(),
      })
    } catch (error) {
      return this.#put({
        jobId: '',
        filename: file.original_filename,
        phase: 'failed',
        warnings: [],
        edited: {},
        error: errorOf(error),
        updatedAt: new Date().toISOString(),
      })
    }
  }

  /** 转换：uploaded → converted | failed | cancelled（cancel 竞态安全）。 */
  async convert(jobId: string): Promise<ImportUiFlow> {
    const flow = this.#require(jobId)
    try {
      const result = await this.#pipeline.convert(jobId)
      const job = await this.#pipeline.getJob(jobId)
      return this.#put({
        ...flow,
        phase: phaseOf(job.status),
        job,
        warnings: result.warnings,
        error: undefined,
        updatedAt: new Date().toISOString(),
      })
    } catch (error) {
      return this.#handleActionError(jobId, flow, error)
    }
  }

  /** 预览：converted → previewing，返回 GFM；重复预览幂等。 */
  async preview(jobId: string): Promise<ImportUiFlow> {
    const flow = this.#require(jobId)
    try {
      const markdown = await this.#pipeline.preview(jobId)
      const job = await this.#pipeline.getJob(jobId)
      return this.#put({
        ...flow,
        phase: phaseOf(job.status),
        job,
        previewMarkdown: markdown,
        error: undefined,
        updatedAt: new Date().toISOString(),
      })
    } catch (error) {
      return this.#handleActionError(jobId, flow, error)
    }
  }

  /**
   * 确认：previewing → reviewing，生成 candidate（status=candidate，不写 active）。
   * 本地守卫：未 preview 直接返回可读错误（不触达 pipeline 写入路径）。
   */
  async confirm(jobId: string, edited?: EditableCandidate): Promise<ImportUiFlow> {
    const flow = this.#require(jobId)
    if (flow.phase !== 'previewing' || !flow.job) {
      return this.#errorFlow(flow, 'invalid_status_transition', `状态 ${flow.phase} 不允许确认（需先预览）`)
    }
    try {
      const candidate = this.#buildCandidate(flow, edited)
      const candidateId = await this.#pipeline.confirm(jobId, candidate)
      const job = await this.#pipeline.getJob(jobId)
      return this.#put({
        ...flow,
        phase: phaseOf(job.status),
        job,
        edited,
        candidateId,
        error: undefined,
        updatedAt: new Date().toISOString(),
      })
    } catch (error) {
      return this.#handleActionError(jobId, flow, error)
    }
  }

  /** 取消：非终态 → cancelled；幂等（已取消/已失败 no-op；已确认/已转正给可读错误）。 */
  async cancel(jobId: string): Promise<ImportUiFlow> {
    const flow = this.#require(jobId)
    if (flow.phase === 'cancelled' || flow.phase === 'failed' || flow.phase === 'confirmed' || flow.phase === 'active') {
      return flow
    }
    try {
      await this.#pipeline.cancel(jobId)
      const job = await this.#pipeline.getJob(jobId)
      return this.#put({
        ...flow,
        phase: phaseOf(job.status),
        job,
        error: undefined,
        updatedAt: new Date().toISOString(),
      })
    } catch (error) {
      // import_cancelled：pipeline 侧已是 confirmed/active，无法回退 —— 同步真实状态并呈现可读错误
      const job = await this.#pipeline.getJob(jobId).catch(() => undefined)
      return this.#errorFlow(
        job ? { ...flow, phase: phaseOf(job.status), job } : flow,
        errorOf(error).code,
        errorOf(error).message,
      )
    }
  }

  /* ------------------------------ 视图绑定 ------------------------------ */

  /** 派生可序列化视图（组件 props 的稳定输入）。 */
  viewModelOf(flow: ImportUiFlow): ImportUiView {
    const phase = flow.phase
    return {
      jobId: flow.jobId,
      filename: flow.filename,
      phase,
      title: flow.edited?.title?.trim() || flow.job?.converted_title || null,
      previewMarkdown: flow.previewMarkdown ?? null,
      candidateId: flow.candidateId ?? null,
      warnings: [...flow.warnings],
      error: flow.error ?? null,
      canConvert: phase === 'uploaded',
      canPreview: phase === 'converted',
      canConfirm: phase === 'previewing',
      canCancel: !(phase === 'cancelled' || phase === 'failed' || phase === 'confirmed' || phase === 'active'),
    }
  }

  /* ------------------------------ 内部 ------------------------------ */

  #require(jobId: string): ImportUiFlow {
    const flow = this.#flows.get(jobId)
    if (!flow) {
      throw new ImportPipelineError('job_not_found', `控制器中没有该导入流程: ${jobId}`)
    }
    return flow
  }

  #buildCandidate(flow: ImportUiFlow, edited?: EditableCandidate): KnowledgeCandidate {
    const job = flow.job!
    const content = edited?.content ?? flow.previewMarkdown ?? job.converted_body ?? ''
    return {
      title: edited?.title?.trim() || job.converted_title || stemOf(flow.filename),
      content,
      type: edited?.type ?? 'doc',
      visibility: edited?.visibility ?? job.visibility,
      tags: edited?.tags ?? [],
      target_project_id: job.target_project_id ?? undefined,
      target_version: job.target_version ?? undefined,
      target_role_id: job.target_role_id ?? undefined,
      target_instance_id: job.target_instance_id ?? undefined,
    }
  }

  async #handleActionError(
    jobId: string,
    flow: ImportUiFlow,
    error: unknown,
  ): Promise<ImportUiFlow> {
    const { code, message } = errorOf(error)
    if (code === 'import_cancelled') {
      // 转换期间被取消：pipeline 不能回退，按取消语义呈现
      const job = await this.#pipeline.getJob(jobId).catch(() => undefined)
      const cancelled = job ? { ...flow, phase: phaseOf(job.status), job } : flow
      return this.#errorFlow(cancelled, code, message)
    }
    return this.#errorFlow(flow, code, message)
  }

  #errorFlow(flow: ImportUiFlow, code: string, message: string): ImportUiFlow {
    return this.#put({
      ...flow,
      error: { code, message },
      updatedAt: new Date().toISOString(),
    })
  }

  #put(flow: ImportUiFlow): ImportUiFlow {
    if (!flow.jobId) {
      // 上传失败的占位流程无任务可跟踪：组件直接消费返回的 flow，不进入快照
      return flow
    }
    this.#flows.set(flow.jobId, flow)
    for (const id of [...this.#flows.keys()].slice(0, Math.max(0, this.#flows.size - this.#maxFlows))) {
      this.#flows.delete(id)
    }
    this.#emit()
    return { ...flow }
  }

  #emit(): void {
    const snapshot = this.snapshot()
    for (const listener of this.#listeners) {
      listener(snapshot)
    }
  }
}
