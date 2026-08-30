import { randomUUID } from 'node:crypto'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'

import { AnyDocConverterAdapter, WHITELIST_EXTENSIONS, type AnyDocLikeConverter } from '../import-pipeline.js'
import { WeaveError } from '../weave-error.js'

/**
 * AnyDoc 独立文档转换服务（doc/08 §7 / doc/09 §2.1，T6）。
 *
 * 与知识导入解耦：本服务只负责「任意文档 → GFM Markdown」的独立 job 生命周期，
 * 不依赖 ImportMeta / KnowledgeStore / candidate 流程。知识导入可作为消费方，
 * 但本模块自身不感知团队、角色、任务调度。
 *
 * RPC 契约（doc/10 §6.2）：
 * - `document/convert`：`{ file?: string, filename?: string, data?: string, format?: string }`
 *   提交后立即返回 `{ jobId, status }`，转换在后台进行；
 * - `document/status`：`{ jobId }` → `{ jobId, status, progress?, title?, warnings?, error? }`；
 * - `document/preview`：`{ jobId }` → `{ jobId, markdown, title?, warnings? }`（仅 done 可用）。
 */

export type DocumentStatus = 'queued' | 'converting' | 'done' | 'failed'

export interface DocumentConvertInput {
  /** 服务端本地文件路径（CLI / MCP / 服务端模式）。 */
  file?: string
  /** 原始文件名；data 上传模式必填。 */
  filename?: string
  /** base64 文件内容（控制台浏览器上传模式）。 */
  data?: string
  /** 目标格式提示；AnyDoc 默认按扩展名/内容识别，保留给转换器扩展。 */
  format?: string
}

export interface DocumentConvertResult {
  jobId: string
  status: DocumentStatus
  filename: string
}

export interface DocumentStatusResult {
  jobId: string
  status: DocumentStatus
  filename: string
  progress?: number
  title?: string
  warnings: string[]
  error?: string
  /** 失败时稳定错误码（doc/09 P0-3）。 */
  error_code?: string
  markdown_path?: string
  created_at: string
  updated_at: string
}

export interface DocumentPreviewResult {
  jobId: string
  status: 'done'
  markdown: string
  title?: string
  warnings: string[]
}

export interface DocumentHistoryItem {
  jobId: string
  filename: string
  status: DocumentStatus
  title?: string
  error?: string
  created_at: string
  updated_at: string
}

export interface DocumentJobRecord extends DocumentStatusResult {
  id: string
  markdown?: string
  file_path?: string
}

export interface DocumentConverterOptions {
  /** 转换中间产物目录（Markdown 与 base64 临时文件落点）。 */
  outputDir: string
  /** 转换器；缺省使用 @firecrawl/anydoc 适配器。 */
  converter?: AnyDocLikeConverter
}

interface PreparedInput {
  filePath: string
  fileType: string
  filename: string
}

/** 独立文档转换服务。job 记录保存在内存中；转换结果 Markdown 写盘。 */
export class DocumentConverter {
  readonly #outputDir: string
  readonly #converter: AnyDocLikeConverter
  readonly #jobs = new Map<string, DocumentJobRecord>()

  constructor(options: DocumentConverterOptions) {
    this.#outputDir = options.outputDir
    this.#converter = options.converter ?? new AnyDocConverterAdapter()
    mkdirSync(this.#outputDir, { recursive: true })
  }

  /**
   * 提交转换任务：创建 job 后立即触发后台转换并返回 jobId。
   * 调用方通过 status/preview 轮询或 waitFor 获取结果。
   */
  async convert(input: DocumentConvertInput): Promise<DocumentConvertResult> {
    const jobId = `doc_${randomUUID()}`
    const prepared = this.#prepareInput(input, jobId)
    const now = new Date().toISOString()
    const job: DocumentJobRecord = {
      id: jobId,
      jobId,
      status: 'queued',
      filename: prepared.filename,
      file_path: prepared.filePath,
      warnings: [],
      created_at: now,
      updated_at: now,
    }
    this.#jobs.set(jobId, job)
    // 后台执行；异常已在 #run 内收敛为 failed，这里仅避免未处理 rejection。
    void this.#run(jobId, prepared).catch(() => {
      // #run 内部已 catch；此 catch 仅作为最后防线。
    })
    return { jobId, status: 'queued', filename: prepared.filename }
  }

  /** 提交并等待转换完成（CLI / MCP 需要最终结果时使用）。 */
  async convertAndWait(input: DocumentConvertInput, timeoutMs = 60_000): Promise<DocumentJobRecord> {
    const { jobId } = await this.convert(input)
    return this.waitFor(jobId, timeoutMs)
  }

  /** 查询任务状态。 */
  async status(jobId: string): Promise<DocumentStatusResult> {
    const job = this.#mustGet(jobId)
    return this.#toStatus(job)
  }

  /** 获取已转换的 Markdown；未完成/失败时拒绝。 */
  async preview(jobId: string): Promise<DocumentPreviewResult> {
    const job = this.#mustGet(jobId)
    if (job.status !== 'done' || job.markdown === undefined) {
      throw new WeaveError(
        'invalid_status_transition',
        job.status === 'failed'
          ? `文档转换失败: ${job.error ?? '未知错误'}`
          : `文档尚未转换完成（当前状态 ${job.status}），请先轮询 document/status`,
        { jobId, status: job.status },
      )
    }
    return {
      jobId,
      status: 'done',
      markdown: job.markdown,
      ...(job.title !== undefined ? { title: job.title } : {}),
      warnings: job.warnings,
    }
  }

  /** 最近转换历史（按创建时间倒序）。 */
  async history(limit = 20): Promise<DocumentHistoryItem[]> {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)))
    return [...this.#jobs.values()]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, safeLimit)
      .map((job) => ({
        jobId: job.id,
        filename: job.filename,
        status: job.status,
        ...(job.title !== undefined ? { title: job.title } : {}),
        ...(job.error !== undefined ? { error: job.error } : {}),
      ...(job.error_code !== undefined ? { error_code: job.error_code } : {}),
        created_at: job.created_at,
        updated_at: job.updated_at,
      }))
  }

  /** 等待任务到达终态（done/failed）；超时抛 timeout。 */
  async waitFor(jobId: string, timeoutMs = 60_000, intervalMs = 50): Promise<DocumentJobRecord> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const job = this.#mustGet(jobId)
      if (job.status === 'done' || job.status === 'failed') {
        return job
      }
      if (Date.now() >= deadline) {
        throw new WeaveError('timeout', `文档转换超时（${timeoutMs}ms）: ${jobId}`, { jobId, status: job.status })
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }

  /* ------------------------------ 内部实现 ------------------------------ */

  async #run(jobId: string, prepared: PreparedInput): Promise<void> {
    const job = this.#mustGet(jobId)
    job.status = 'converting'
    job.updated_at = new Date().toISOString()
    try {
      const output = await this.#converter.convert({
        filePath: prepared.filePath,
        fileType: prepared.fileType,
        originalFilename: prepared.filename,
      })
      const markdown = output.markdown ?? ''
      const markdownPath = join(this.#outputDir, `${jobId}.md`)
      writeFileSync(markdownPath, markdown, 'utf8')
      job.status = 'done'
      job.progress = 1
      job.title = output.title.trim() !== '' ? output.title : stemOf(prepared.filename)
      job.warnings = output.warnings ?? []
      job.markdown = markdown
      job.markdown_path = markdownPath
      job.updated_at = new Date().toISOString()
    } catch (error) {
      job.status = 'failed'
      job.progress = 0
      job.error = error instanceof Error ? error.message : String(error)
      job.error_code = 'document_conversion_failed'
      job.updated_at = new Date().toISOString()
    }
  }

  #prepareInput(input: DocumentConvertInput, jobId: string): PreparedInput {
    const hasData = typeof input.data === 'string' && input.data !== ''
    const file = typeof input.file === 'string' ? input.file.trim() : ''

    if (hasData) {
      const filename = typeof input.filename === 'string' ? input.filename.trim() : ''
      if (filename === '') {
        throw new WeaveError('invalid_argument', 'base64 上传模式必须提供 filename', { field: 'filename' })
      }
      const fileType = this.#whitelistedFileType(filename)
      const raw = Buffer.from(input.data ?? '', 'base64')
      if (raw.byteLength > MAX_INPUT_BYTES) {
        throw new WeaveError('invalid_argument', `文件超过大小上限（${MAX_INPUT_BYTES} bytes）`, { field: 'data', bytes: raw.byteLength })
      }
      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_')
      const filePath = join(this.#outputDir, `src-${jobId}-${safeName}`)
      writeFileSync(filePath, raw)
      return { filePath, fileType, filename }
    }

    if (file === '') {
      throw new WeaveError('invalid_argument', 'document/convert 需要 file（服务端路径）或 data（base64 上传）', {
        provided: { file: !!file, data: hasData },
      })
    }

    const filename = typeof input.filename === 'string' && input.filename.trim() !== ''
      ? input.filename.trim()
      : basename(file)
    const fileType = this.#whitelistedFileType(filename)
    const bytes = statSync(file).size
    if (bytes > MAX_INPUT_BYTES) {
      throw new WeaveError('invalid_argument', `文件超过大小上限（${MAX_INPUT_BYTES} bytes）`, { field: 'file', bytes })
    }
    return {
      filePath: file,
      fileType,
      filename,
    }
  }

  #whitelistedFileType(filename: string): string {
    const ext = extname(filename).slice(1).toLowerCase()
    if (!WHITELIST_EXTENSIONS.includes(ext)) {
      throw new WeaveError(
        'invalid_argument',
        `不支持的文件类型: ${extname(filename) || filename}（白名单: ${WHITELIST_EXTENSIONS.join('/')}）`,
        { filename, allowed: [...WHITELIST_EXTENSIONS] },
      )
    }
    return ext
  }

  #mustGet(jobId: string): DocumentJobRecord {
    const job = this.#jobs.get(jobId)
    if (!job) {
      throw new WeaveError('configuration_error', `文档转换任务不存在: ${jobId}`, { jobId })
    }
    return job
  }

  #toStatus(job: DocumentJobRecord): DocumentStatusResult {
    return {
      jobId: job.id,
      status: job.status,
      filename: job.filename,
      ...(job.progress !== undefined ? { progress: job.progress } : {}),
      ...(job.title !== undefined ? { title: job.title } : {}),
      warnings: job.warnings,
      ...(job.error !== undefined ? { error: job.error } : {}),
      ...(job.error_code !== undefined ? { error_code: job.error_code } : {}),
      ...(job.markdown_path !== undefined ? { markdown_path: job.markdown_path } : {}),
      created_at: job.created_at,
      updated_at: job.updated_at,
    }
  }
}

const MAX_INPUT_BYTES = 50 * 1024 * 1024

const stemOf = (filename: string): string => {
  const base = basename(filename)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}
