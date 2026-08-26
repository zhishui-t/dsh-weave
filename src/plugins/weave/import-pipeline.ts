import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { IMPORT_JOBS_TABLE_DDL } from './persistence/schemas.js'
import type { WeaveDatabase } from './persistence/weave-database.js'
import { KnowledgeStore, validateVisibility } from './knowledge-model.js'
import type { KnowledgeType, KnowledgeLayer, Visibility } from './knowledge-model.js'

/**
 * P0-ANYDOC-010 AnyDoc 转换管线 — 对应 TDD 2.5（导入记录模型）、TDD 3.1（AnyDoc 转换契约）、
 * TDD 1.5.8（ImportPipeline 接口）、AC-IMPORT-001~006 / AC-CONVERT-001~003。
 *
 * 职责：白名单校验 → 上传（import_jobs 行，uploaded）→ 转换（converted/failed，失败不写
 * knowledge/_agent）→ 预览（previewing）→ 确认生成 candidate 卡片（reviewing，未确认不写
 * active）→ （P1）审核通过（confirmed → active）。
 *
 * AnyDoc 为可插拔转换器（默认适配 @firecrawl/anydoc，未安装时转换失败并给出可读原因）；
 * 本管线不通过 ctx.subagents.start 调用、不受执行器限流/熔断（TDD 3.1.1）。
 */

// ===== 白名单（TDD 3.1.2 / FDD 4.1.2；LO-6：Excel/PPT 显式扩展名）=====

export const WHITELIST_EXTENSIONS: readonly string[] = [
  'doc', 'docx', 'pdf', 'ppt', 'pptx', 'xls', 'xlsx', 'epub', 'csv', 'rtf', 'odt',
]

// ===== 类型（TDD 2.5.1）=====

export type ImportStatus =
  | 'uploaded'
  | 'converting'
  | 'converted'
  | 'previewing'
  | 'reviewing'
  | 'confirmed'
  | 'active'
  | 'cancelled'
  | 'failed'

/** TDD 2.5.1：导入归属（'global' 对应知识层 'shared'）。 */
export type ImportTarget = 'project' | 'role' | 'instance' | 'global'

export interface ImportMeta {
  target: ImportTarget
  project_id?: string
  version?: string
  role_id?: string
  instance_id?: string
  visibility: Visibility
  created_by?: string
}

export interface UploadedFile {
  original_filename: string
  local_path: string
}

export interface ImportJob {
  id: string
  original_filename: string
  file_type: string
  file_path: string
  status: ImportStatus
  anydoc_job_id: string | null
  markdown_path: string | null
  converted_title: string | null
  converted_body: string | null
  target_project_id: string | null
  target_version: string | null
  target_role_id: string | null
  target_instance_id: string | null
  visibility: Visibility
  candidate_id: string | null
  error_message: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface ConvertResult {
  job_id: string
  status: ImportStatus
  markdown: string
  title: string
  warnings: string[]
  output_path: string
}

export interface KnowledgeCandidate {
  title: string
  content: string
  type: KnowledgeType
  visibility: Visibility
  tags: string[]
  target_project_id?: string
  target_version?: string
  target_role_id?: string
  target_instance_id?: string
}

// ===== 转换器契约 =====

export interface ConvertInput {
  filePath: string
  /** 小写扩展名（如 'pdf'） */
  fileType: string
  originalFilename: string
}

export interface ConvertOutput {
  markdown: string
  title: string
  warnings: string[]
  outputPath?: string
}

/** AnyDoc 统一转换器接口（GFM 输出）。 */
export interface AnyDocLikeConverter {
  convert(input: ConvertInput): Promise<ConvertOutput>
}

/**
 * 默认转换器：@firecrawl/anydoc 0.2.3
 * 读取服务器本地文件，输出 GitHub-Flavored Markdown；标题取首个 H1/H2，否则取文件名。
 */
export class AnyDocConverterAdapter implements AnyDocLikeConverter {
  async convert(input: ConvertInput): Promise<ConvertOutput> {
    let anydoc: typeof import('@firecrawl/anydoc')
    try {
      anydoc = await import('@firecrawl/anydoc')
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new ImportPipelineError(
        'conversion_failed',
        `AnyDoc 转换器不可用：@firecrawl/anydoc 未安装（${reason}）`,
      )
    }
    const markdown = await anydoc.toMarkdown(input.filePath)
    const titleMatch = markdown.match(/^#s+(.+?)s*$/m) ?? markdown.match(/^##s+(.+?)s*$/m)
    const title = titleMatch?.[1]?.trim() || input.originalFilename.replace(/.[^.]+$/, '')
    return { markdown, title, warnings: [], outputPath: undefined }
  }
}

// ===== 错误（TDD 1.1.2 错误码）=====

export type ImportPipelineErrorCode =
  | 'unsupported_file_type'
  | 'conversion_failed'
  | 'import_cancelled'
  | 'invalid_status_transition'
  | 'job_not_found'
  | 'invalid_import_meta'

export class ImportPipelineError extends Error {
  readonly code: ImportPipelineErrorCode

  constructor(code: ImportPipelineErrorCode, message: string) {
    super(message)
    this.name = 'ImportPipelineError'
    this.code = code
  }
}

// ===== 状态机（TDD 3.1.4）=====

const TRANSITIONS: Record<ImportStatus, readonly ImportStatus[]> = {
  uploaded: ['converting', 'cancelled'],
  converting: ['converted', 'failed', 'cancelled'],
  converted: ['previewing', 'failed', 'cancelled'],
  previewing: ['reviewing', 'cancelled'],
  reviewing: ['confirmed', 'cancelled', 'failed'],
  confirmed: ['active'], // P1
  active: [],
  cancelled: [],
  failed: [],
}

interface ImportJobRow {
  id: string
  original_filename: string
  file_type: string
  file_path: string
  status: string
  anydoc_job_id: string | null
  markdown_path: string | null
  converted_title: string | null
  converted_body: string | null
  target_project_id: string | null
  target_version: string | null
  target_role_id: string | null
  target_instance_id: string | null
  visibility: string
  candidate_id: string | null
  error_message: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface ImportPipelineOptions {
  /** imports.db 的 WeaveDatabase（P0-DB-004） */
  importsDb: WeaveDatabase
  /** 转换中间产物目录（如 ~/.dsh/imports；TDD 2.7 / 架构 9.1） */
  importsDir: string
  /** KnowledgeStore（t11）；提供后才能 confirm 生成 candidate */
  knowledgeStore?: KnowledgeStore
  /** 转换器；缺省使用 @firecrawl/anydoc 适配器 */
  converter?: AnyDocLikeConverter
}

const TARGET_REQUIRED: Record<ImportTarget, { field: keyof ImportMeta; label: string }[]> = {
  project: [
    { field: 'project_id', label: 'project_id' },
    { field: 'version', label: 'version' },
  ],
  role: [{ field: 'role_id', label: 'role_id' }],
  instance: [{ field: 'instance_id', label: 'instance_id' }],
  global: [],
}

/**
 * ImportPipeline — AnyDoc 导入管线（TDD 1.5.8）。
 * 所有 DB 写操作经 importsDb 单写者队列串行化。
 */
export class ImportPipeline {
  readonly #db: WeaveDatabase
  readonly #importsDir: string
  readonly #knowledge: KnowledgeStore | undefined
  readonly #converter: AnyDocLikeConverter
  #ready = false

  constructor(options: ImportPipelineOptions) {
    this.#db = options.importsDb
    this.#importsDir = options.importsDir
    this.#knowledge = options.knowledgeStore
    this.#converter = options.converter ?? new AnyDocConverterAdapter()
    mkdirSync(this.#importsDir, { recursive: true })
  }

  /** 上传：白名单校验 + 元数据校验，创建 uploaded 状态的 import_job（TDD 3.1.5-1）。 */
  async upload(file: UploadedFile, meta: ImportMeta): Promise<ImportJob> {
    await this.#ensureTable()
    const fileType = this.#whitelistedFileType(file.original_filename)
    this.#validateMeta(meta)

    const now = new Date().toISOString()
    const row: ImportJobRow = {
      id: `imp_${randomUUID()}`,
      original_filename: basename(file.original_filename),
      file_type: fileType,
      file_path: file.local_path,
      status: 'uploaded',
      anydoc_job_id: null,
      markdown_path: null,
      converted_title: null,
      converted_body: null,
      target_project_id: meta.project_id ?? null,
      target_version: meta.version ?? null,
      target_role_id: meta.role_id ?? null,
      target_instance_id: meta.instance_id ?? null,
      visibility: meta.visibility,
      candidate_id: null,
      error_message: null,
      created_by: meta.created_by ?? null,
      created_at: now,
      updated_at: now,
    }
    await this.#insertRow(row)
    return this.#toJob(row)
  }

  /** 查询导入任务；不存在抛 job_not_found。 */
  async getJob(jobId: string): Promise<ImportJob> {
    await this.#ensureTable()
    const row = await this.#row(jobId)
    if (!row) {
      throw new ImportPipelineError('job_not_found', `导入任务不存在: ${jobId}`)
    }
    return this.#toJob(row)
  }

  /**
   * 转换：uploaded → converting → converted | failed（TDD 3.1.4/3.1.5-2）。
   * 失败时写入 error_message 并置 failed，不写 knowledge/_agent；转换成功不写 active。
   */
  async convert(jobId: string): Promise<ConvertResult> {
    await this.#ensureTable()
    const job = await this.getJob(jobId)
    await this.#transition(jobId, 'converting', {})

    let output: ConvertOutput
    try {
      output = await this.#converter.convert({
        filePath: job.file_path,
        fileType: job.file_type,
        originalFilename: job.original_filename,
      })
    } catch (error) {
      await this.#fail(jobId, error)
      throw error instanceof ImportPipelineError
        ? error
        : new ImportPipelineError('conversion_failed', error instanceof Error ? error.message : String(error))
    }

    const markdownFile = join(this.#importsDir, `${jobId}.md`)
    writeFileSync(markdownFile, output.markdown, 'utf8')
    const title = output.title.trim() !== '' ? output.title : stemOf(job.original_filename)
    const warnings = output.warnings ?? []

    try {
      await this.#transition(jobId, 'converted', {
        anydoc_job_id: null,
        markdown_path: markdownFile,
        converted_title: title,
        converted_body: output.markdown,
      })
    } catch {
      // 转换期间被取消：任务不可回退，按取消语义报错
      throw new ImportPipelineError('import_cancelled', `导入任务已被取消: ${jobId}`)
    }

    return {
      job_id: jobId,
      status: 'converted',
      markdown: output.markdown,
      title,
      warnings,
      output_path: markdownFile,
    }
  }

  /**
   * 预览：converted → previewing，返回用户可读 GFM（TDD 3.1.5-3）。
   * previewing/reviewing 状态下重复预览幂等；未转换时抛 invalid_status_transition。
   */
  async preview(jobId: string): Promise<string> {
    await this.#ensureTable()
    const job = await this.getJob(jobId)
    if (job.status === 'converted') {
      await this.#transition(jobId, 'previewing', {})
    } else if (job.status !== 'previewing' && job.status !== 'reviewing') {
      throw new ImportPipelineError(
        'invalid_status_transition',
        `状态 ${job.status} 不允许预览（需先 convert）: ${jobId}`,
      )
    }
    const markdown = job.converted_body ?? readMarkdown(job.markdown_path)
    if (markdown === null) {
      throw new ImportPipelineError('invalid_status_transition', `任务无转换结果，无法预览: ${jobId}`)
    }
    return markdown
  }

  /**
   * 确认：previewing → reviewing，用（可能被用户编辑过的）KnowledgeCandidate
   * 生成 candidate 知识卡片（KnowledgeStore.createCandidate，强制 status=candidate，
   * 未确认前不写 active），返回 candidate id（TDD 1.5.8/3.1.5-4、AC-IMPORT-003/004）。
   * 已取消/终态任务不可确认（import_cancelled）。
   */
  async confirm(jobId: string, edited: KnowledgeCandidate): Promise<string> {
    await this.#ensureTable()
    const job = await this.getJob(jobId)
    if (job.status === 'cancelled' || job.status === 'failed' || job.status === 'confirmed' || job.status === 'active') {
      throw new ImportPipelineError(
        'import_cancelled',
        `导入任务已是终态（${job.status}），不可确认: ${jobId}`,
      )
    }
    if (job.status !== 'previewing') {
      throw new ImportPipelineError(
        'invalid_status_transition',
        `状态 ${job.status} 不允许确认（需先 preview）: ${jobId}`,
      )
    }
    if (!this.#knowledge) {
      throw new ImportPipelineError(
        'invalid_status_transition',
        `KnowledgeStore 未注入，无法生成 candidate: ${jobId}`,
      )
    }

    const layer = metaTargetLayer(job)
    const scope = scopeForJob(job)
    const collision = validateVisibility(layer, edited.visibility)
    if (collision.length > 0) {
      throw new ImportPipelineError('invalid_import_meta', collision.join('；'))
    }

    const filename = `${sanitizeStem(job.original_filename)}-${jobId.slice(-8)}.md`
    const meta = await this.#knowledge.createCandidate({
      layer,
      scope,
      filename,
      frontmatter: {
        title: edited.title.trim() !== '' ? edited.title : (job.converted_title ?? stemOf(job.original_filename)),
        type: edited.type,
        visibility: edited.visibility,
        tags: edited.tags,
      },
      body: edited.content,
    })

    await this.#transition(jobId, 'reviewing', { candidate_id: meta.id })
    return meta.id
  }

  /** 取消（TDD 3.1.5-5）：非终态 → cancelled，幂等；已确认/已转正不可回退。 */
  async cancel(jobId: string): Promise<void> {
    await this.#ensureTable()
    const job = await this.getJob(jobId)
    if (job.status === 'cancelled' || job.status === 'failed') {
      return
    }
    if (job.status === 'confirmed' || job.status === 'active') {
      throw new ImportPipelineError(
        'import_cancelled',
        `导入任务已确认/已转正，不可回退取消: ${jobId}`,
      )
    }
    await this.#transition(jobId, 'cancelled', {})
  }

  /** 审核通过（P1）：reviewing → confirmed（状态机 TDD 3.1.4）。 */
  async markApproved(jobId: string): Promise<ImportJob> {
    await this.#ensureTable()
    await this.#transition(jobId, 'confirmed', {})
    return this.getJob(jobId)
  }

  // ===== 内部 =====

  #whitelistedFileType(originalFilename: string): string {
    const ext = extname(originalFilename).slice(1).toLowerCase()
    if (!WHITELIST_EXTENSIONS.includes(ext)) {
      throw new ImportPipelineError(
        'unsupported_file_type',
        `不支持的文件类型: ${extname(originalFilename) || originalFilename}（白名单: ${WHITELIST_EXTENSIONS.join('/')}）`,
      )
    }
    return ext
  }

  #validateMeta(meta: ImportMeta): void {
    const errors: string[] = []
    for (const { field, label } of TARGET_REQUIRED[meta.target] ?? []) {
      if (!meta[field]) {
        errors.push(`target='${meta.target}' 缺少必填 ${label}`)
      }
    }
    const layer: KnowledgeLayer = meta.target === 'global' ? 'shared' : meta.target
    errors.push(...validateVisibility(layer, meta.visibility))
    if (errors.length > 0) {
      throw new ImportPipelineError('invalid_import_meta', errors.join('；'))
    }
  }

  async #insertRow(row: ImportJobRow): Promise<void> {
    await this.#db.run((raw) => {
      raw
        .prepare(
          `INSERT INTO import_jobs (
            id, original_filename, file_type, file_path, status, anydoc_job_id, markdown_path,
            converted_title, converted_body, target_project_id, target_version, target_role_id,
            target_instance_id, visibility, candidate_id, error_message, created_by, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          row.original_filename,
          row.file_type,
          row.file_path,
          row.status,
          row.anydoc_job_id,
          row.markdown_path,
          row.converted_title,
          row.converted_body,
          row.target_project_id,
          row.target_version,
          row.target_role_id,
          row.target_instance_id,
          row.visibility,
          row.candidate_id,
          row.error_message,
          row.created_by,
          row.created_at,
          row.updated_at,
        )
    })
  }

  async #transition(
    jobId: string,
    next: ImportStatus,
    fields: Partial<Pick<ImportJobRow, 'anydoc_job_id' | 'markdown_path' | 'converted_title' | 'converted_body' | 'candidate_id' | 'error_message'>>,
  ): Promise<void> {
    const row = await this.#row(jobId)
    if (!row) {
      throw new ImportPipelineError('job_not_found', `导入任务不存在: ${jobId}`)
    }
    const from = row.status as ImportStatus
    if (!TRANSITIONS[from]?.includes(next)) {
      throw new ImportPipelineError(
        'invalid_status_transition',
        `非法状态转移: ${from} → ${next}（任务 ${jobId}）`,
      )
    }
    await this.#db.run((raw) => {
      const sets: string[] = ['status = ?', 'updated_at = ?']
      const params: (string | null)[] = [next, new Date().toISOString()]
      for (const key of [
        'anydoc_job_id',
        'markdown_path',
        'converted_title',
        'converted_body',
        'candidate_id',
        'error_message',
      ] as const) {
        if (fields[key] !== undefined) {
          sets.push(`${key} = ?`)
          params.push(fields[key])
        }
      }
      params.push(jobId)
      raw.prepare(`UPDATE import_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    })
  }

  /** 转换失败：converting → failed 并记录可读错误；若期间已被取消则保持 cancelled 语义。 */
  async #fail(jobId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error)
    const row = await this.#row(jobId)
    if (!row) {
      return
    }
    if (row.status === 'cancelled') {
      throw new ImportPipelineError('import_cancelled', `导入任务已被取消: ${jobId}`)
    }
    try {
      await this.#transition(jobId, 'failed', { error_message: message })
    } catch {
      // 并发取消等竞态：任务已是终态，取消语义优先
      throw new ImportPipelineError('import_cancelled', `导入任务已被取消: ${jobId}`)
    }
  }

  async #row(jobId: string): Promise<ImportJobRow | null> {
    return this.#db.run((raw) => {
      const row = raw
        .prepare(
          `SELECT id, original_filename, file_type, file_path, status, anydoc_job_id, markdown_path,
             converted_title, converted_body, target_project_id, target_version, target_role_id,
             target_instance_id, visibility, candidate_id, error_message, created_by, created_at, updated_at
           FROM import_jobs WHERE id = ?`,
        )
        .get(jobId) as ImportJobRow | undefined
      return row ?? null
    })
  }

  #toJob(row: ImportJobRow): ImportJob {
    return {
      id: row.id,
      original_filename: row.original_filename,
      file_type: row.file_type,
      file_path: row.file_path,
      status: row.status as ImportStatus,
      anydoc_job_id: row.anydoc_job_id,
      markdown_path: row.markdown_path,
      converted_title: row.converted_title,
      converted_body: row.converted_body,
      target_project_id: row.target_project_id,
      target_version: row.target_version,
      target_role_id: row.target_role_id,
      target_instance_id: row.target_instance_id,
      visibility: row.visibility as Visibility,
      candidate_id: row.candidate_id,
      error_message: row.error_message,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
  }

  async #ensureTable(): Promise<void> {
    if (this.#ready) {
      return
    }
    await this.#db.run((raw) => {
      raw.exec(IMPORT_JOBS_TABLE_DDL)
    })
    this.#ready = true
  }
}

// ===== 工具 =====

const stemOf = (filename: string): string => {
  const base = basename(filename)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

const sanitizeStem = (filename: string): string => {
  const stem = stemOf(filename).replace(/[^A-Za-z0-9_\u4e00-\u9fff-]+/g, '-')
  return stem.length > 0 ? stem : 'knowledge'
}

const metaTargetLayer = (job: ImportJob): KnowledgeLayer =>
  job.target_role_id ? 'role' : job.target_instance_id ? 'instance' : job.target_project_id ? 'project' : 'shared'

const scopeForJob = (job: ImportJob): { projectId?: string; version?: string; roleId?: string; instanceId?: string } => ({
  projectId: job.target_project_id ?? undefined,
  version: job.target_version ?? undefined,
  roleId: job.target_role_id ?? undefined,
  instanceId: job.target_instance_id ?? undefined,
})

const readMarkdown = (markdownPath: string | null): string | null => {
  if (!markdownPath) {
    return null
  }
  try {
    return readFileSync(markdownPath, 'utf8')
  } catch {
    return null
  }
}
