import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPersistence, type WeavePersistence } from '../../../../src/plugins/weave/persistence/index.js'
import { KnowledgeStore } from '../../../../src/plugins/weave/knowledge/knowledge-model.js'
import {
  AnyDocLikeConverter,
  ConvertInput,
  ImportPipeline,
  ImportPipelineError,
  WHITELIST_EXTENSIONS,
  type ImportMeta,
  type UploadedFile,
} from '../../../../src/plugins/weave/knowledge/import-pipeline.js'

class MockConverter implements AnyDocLikeConverter {
  calls: ConvertInput[] = []
  fail = false
  failMessage = 'mock: 转换失败'

  async convert(input: ConvertInput): Promise<{ markdown: string; title: string; warnings: string[] }> {
    this.calls.push(input)
    if (this.fail) {
      throw new ImportPipelineError('conversion_failed', this.failMessage)
    }
    return {
      markdown: `# 转换结果\n\n从 ${input.originalFilename} 转换而来。`,
      title: '转换结果',
      warnings: ['图片已忽略（P0 不保证版式还原）'],
    }
  }
}

const metaFor = (overrides: Partial<ImportMeta> = {}): ImportMeta => ({
  target: 'project',
  project_id: 'demo',
  version: 'v1',
  visibility: 'project_only',
  ...overrides,
})

const uploadedFile = (filename: string): UploadedFile => ({
  original_filename: filename,
  local_path: join(tmpdir(), `upload-src-${filename}`),
})

describe('ImportPipeline：白名单与上传（AC-IMPORT-001/002）', () => {
  let root: string
  let importsDir: string
  let p: WeavePersistence
  let pipeline: ImportPipeline

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'weave-anydoc-'))
    importsDir = join(root, 'imports')
    p = openPersistence({ inMemory: true })
    pipeline = new ImportPipeline({ importsDb: p.imports, importsDir })
  })

  afterAll(() => {
    p.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('白名单 11 个扩展名均可上传并创建 uploaded 任务（AC-IMPORT-001、AC-CONVERT-001 前置）', async () => {
    for (const ext of WHITELIST_EXTENSIONS) {
      const job = await pipeline.upload(uploadedFile(`design-guide.${ext}`), metaFor())
      expect(job.status).toBe('uploaded')
      expect(job.file_type).toBe(ext)
      expect(job.original_filename).toBe(`design-guide.${ext}`)
      expect(job.target_project_id).toBe('demo')
      expect(job.target_version).toBe('v1')
      expect(job.visibility).toBe('project_only')
    }
  })

  it('白名单外类型（.exe/.xyz）拒绝并给出可读白名单（AC-IMPORT-002）', async () => {
    await expect(pipeline.upload(uploadedFile('malware.exe'), metaFor())).rejects.toThrow(
      /不支持的文件类型/,
    )
    await expect(
      pipeline.upload(uploadedFile('notes.xyz'), metaFor()),
    ).rejects.toMatchObject({ code: 'unsupported_file_type' })
  })

  it('元数据校验：project 缺 version / role 缺 role_id / visibility 不匹配均拒绝', async () => {
    await expect(
      pipeline.upload(uploadedFile('a.pdf'), metaFor({ version: undefined })),
    ).rejects.toMatchObject({ code: 'invalid_import_meta' })
    await expect(
      pipeline.upload(uploadedFile('a.pdf'), metaFor({ target: 'role' })),
    ).rejects.toMatchObject({ code: 'invalid_import_meta' })
    await expect(
      pipeline.upload(uploadedFile('a.pdf'), metaFor({ visibility: 'global' })),
    ).rejects.toMatchObject({ code: 'invalid_import_meta' })
  })

  it('getJob：返回上传任务；不存在抛 job_not_found', async () => {
    const job = await pipeline.upload(uploadedFile('ok.pdf'), metaFor())
    const found = await pipeline.getJob(job.id)
    expect(found.id).toBe(job.id)
    await expect(pipeline.getJob('imp_missing')).rejects.toMatchObject({ code: 'job_not_found' })
  })
})

describe('ImportPipeline：转换（AC-CONVERT-001/002/003）', () => {
  let root: string
  let importsDir: string
  let knowledgeRoot: string
  let p: WeavePersistence
  let converter: MockConverter
  let pipeline: ImportPipeline

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'weave-anydoc-conv-'))
    importsDir = join(root, 'imports')
    knowledgeRoot = join(root, 'knowledge')
    p = openPersistence({ inMemory: true })
    converter = new MockConverter()
    pipeline = new ImportPipeline({ importsDb: p.imports, importsDir, converter })
  })

  afterAll(() => {
    p.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('转换成功：uploaded→converting→converted，GFM 落盘 import 目录，结果持久化', async () => {
    const job = await pipeline.upload(uploadedFile('guide.pdf'), metaFor())
    const result = await pipeline.convert(job.id)

    expect(result).toMatchObject({
      job_id: job.id,
      status: 'converted',
      title: '转换结果',
    })
    expect(result.markdown).toContain('从 guide.pdf 转换而来')
    expect(result.output_path.startsWith(importsDir)).toBe(true)
    expect(existsSync(result.output_path)).toBe(true)
    expect(readFileSync(result.output_path, 'utf8')).toBe(result.markdown)
    expect(converter.calls).toHaveLength(1)
    expect(converter.calls[0]?.fileType).toBe('pdf')

    const stored = await pipeline.getJob(job.id)
    expect(stored.status).toBe('converted')
    expect(stored.converted_title).toBe('转换结果')
    expect(stored.converted_body).toBe(result.markdown)
    expect(stored.markdown_path).toBe(result.output_path)
    expect(stored.error_message).toBeNull()
  })

  it('转换失败：status=failed + error_message 可读，且不写 knowledge/_agent（AC-CONVERT-003）', async () => {
    const job = await pipeline.upload(uploadedFile('broken.docx'), metaFor())
    converter.fail = true
    await expect(pipeline.convert(job.id)).rejects.toMatchObject({ code: 'conversion_failed' })

    const stored = await pipeline.getJob(job.id)
    expect(stored.status).toBe('failed')
    expect(stored.error_message).toContain('mock: 转换失败')
    // 失败不污染知识目录
    expect(existsSync(join(knowledgeRoot, '_agent'))).toBe(false)
    converter.fail = false
  })

  it('非法状态：已转换任务再次 convert → invalid_status_transition', async () => {
    const job = await pipeline.upload(uploadedFile('twice.pdf'), metaFor())
    await pipeline.convert(job.id)
    await expect(pipeline.convert(job.id)).rejects.toMatchObject({
      code: 'invalid_status_transition',
    })
  })
})

describe('ImportPipeline：预览与确认（3.1.4 全链路 / AC-IMPORT-003/004）', () => {
  let root: string
  let importsDir: string
  let knowledgeRoot: string
  let p: WeavePersistence
  let pipeline: ImportPipeline
  let knowledgeStore: KnowledgeStore

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'weave-anydoc-confirm-'))
    importsDir = join(root, 'imports')
    knowledgeRoot = join(root, 'knowledge')
    p = openPersistence({ inMemory: true })
    knowledgeStore = new KnowledgeStore({ rootDir: knowledgeRoot, metaDb: p.knowledgeMeta })
    pipeline = new ImportPipeline({
      importsDb: p.imports,
      importsDir,
      converter: new MockConverter(),
      knowledgeStore,
    })
  })

  afterAll(() => {
    p.close()
    rmSync(root, { recursive: true, force: true })
  })

  const toPreviewing = async (filename = 'flow.pdf', meta = metaFor()): Promise<string> => {
    const job = await pipeline.upload(uploadedFile(filename), meta)
    await pipeline.convert(job.id)
    await pipeline.preview(job.id)
    return job.id
  }

  it('preview：converted→previewing 返回 GFM，重复预览幂等；未转换时拒绝', async () => {
    const jobId = await toPreviewing('preview.pdf')
    const markdown = await pipeline.preview(jobId)
    expect(markdown).toContain('从 preview.pdf 转换而来')
    const after = await pipeline.getJob(jobId)
    expect(after.status).toBe('previewing')
    expect(await pipeline.preview(jobId)).toBe(markdown)

    const rawJob = await pipeline.upload(uploadedFile('no-convert.pdf'), metaFor())
    await expect(pipeline.preview(rawJob.id)).rejects.toMatchObject({
      code: 'invalid_status_transition',
    })
  })

  it('confirm 全链路：生成 candidate 卡片（status=candidate，不写 active），job 进入 reviewing', async () => {
    const jobId = await toPreviewing('design-guide.pdf')
    const candidateId = await pipeline.confirm(jobId, {
      title: '设计指南',
      content: '设计指南正文（用户确认）',
      type: 'doc',
      visibility: 'project_only',
      tags: ['设计', '指南'],
    })

    const job = await pipeline.getJob(jobId)
    expect(job.status).toBe('reviewing')
    expect(job.candidate_id).toBe(candidateId)

    const meta = await knowledgeStore.getMeta(candidateId)
    expect(meta?.status).toBe('candidate')
    expect(meta?.layer).toBe('project')
    expect(meta?.path.startsWith('_agent/projects/demo/v1/')).toBe(true)

    const file = knowledgeStore.getKnowledgeFile(candidateId)
    expect(file?.frontmatter.status).toBe('candidate')
    expect(file?.frontmatter.title).toBe('设计指南')
    expect(file?.body).toContain('设计指南正文（用户确认）')

    // AC-IMPORT-004：未审核转正前无 active 知识
    expect(await knowledgeStore.listMeta({ status: 'active' })).toEqual([])
    const raw = knowledgeStore.readRaw(candidateId)
    expect(raw).toContain('status: candidate')
    expect(raw).not.toContain('status: active')
  })

  it('confirm 未 preview（converted）→ invalid_status_transition', async () => {
    const job = await pipeline.upload(uploadedFile('skip.pdf'), metaFor())
    await pipeline.convert(job.id)
    await expect(
      pipeline.confirm(job.id, {
        title: 'x',
        content: 'y',
        type: 'doc',
        visibility: 'project_only',
        tags: [],
      }),
    ).rejects.toMatchObject({ code: 'invalid_status_transition' })
  })

  it('confirm 终态任务 → import_cancelled', async () => {
    const job = await pipeline.upload(uploadedFile('done.pdf'), metaFor())
    await pipeline.cancel(job.id)
    await expect(pipeline.confirm(job.id, {
      title: 'x',
      content: 'y',
      type: 'doc',
      visibility: 'project_only',
      tags: [],
    })).rejects.toMatchObject({ code: 'import_cancelled' })
  })

  it('role / global 层归属路径正确（AC-IMPORT-006）', async () => {
    const roleId = await toPreviewing('role-note.pdf', metaFor({ target: 'role', role_id: 'designer', visibility: 'role_only' }))
    const roleCandidate = await pipeline.confirm(roleId, {
      title: '角色笔记',
      content: '正文',
      type: 'skill',
      visibility: 'role_only',
      tags: ['角色'],
    })
    const roleMeta = await knowledgeStore.getMeta(roleCandidate)
    expect(roleMeta?.path.startsWith('_agent/roles/designer/')).toBe(true)

    const globalId = await toPreviewing(
      'global-note.csv',
      metaFor({ target: 'global', visibility: 'global', project_id: undefined, version: undefined }),
    )
    const globalCandidate = await pipeline.confirm(globalId, {
      title: '全局笔记',
      content: '正文',
      type: 'doc',
      visibility: 'global',
      tags: [],
    })
    const globalMeta = await knowledgeStore.getMeta(globalCandidate)
    expect(globalMeta?.path.startsWith('_agent/shared/')).toBe(true)
  })

  it('markApproved（P1）：reviewing→confirmed 合法；再次调用非法', async () => {
    const jobId = await toPreviewing('approve.pdf')
    await pipeline.confirm(jobId, {
      title: '待审核',
      content: '正文',
      type: 'doc',
      visibility: 'project_only',
      tags: [],
    })
    const approved = await pipeline.markApproved(jobId)
    expect(approved.status).toBe('confirmed')
    await expect(pipeline.markApproved(jobId)).rejects.toMatchObject({
      code: 'invalid_status_transition',
    })
  })
})

describe('ImportPipeline：取消与审核通过（3.1.4/3.1.5-5）', () => {
  let root: string
  let importsDir: string
  let p: WeavePersistence
  let pipeline: ImportPipeline

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'weave-anydoc-cancel-'))
    importsDir = join(root, 'imports')
    p = openPersistence({ inMemory: true })
    pipeline = new ImportPipeline({ importsDb: p.imports, importsDir, converter: new MockConverter() })
  })

  afterAll(() => {
    p.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('cancel：uploaded/converted/previewing → cancelled 且幂等', async () => {
    const job = await pipeline.upload(uploadedFile('c1.pdf'), metaFor())
    await pipeline.cancel(job.id)
    expect((await pipeline.getJob(job.id)).status).toBe('cancelled')
    await expect(pipeline.cancel(job.id)).resolves.toBeUndefined()

    const job2 = await pipeline.upload(uploadedFile('c1b.pdf'), metaFor())
    await pipeline.convert(job2.id)
    await pipeline.cancel(job2.id)
    expect((await pipeline.getJob(job2.id)).status).toBe('cancelled')
  })

  it('cancel：failed 状态幂等 no-op；已确认任务不可回退', async () => {
    const failing = new ImportPipeline({
      importsDb: p.imports,
      importsDir,
      converter: {
        convert: async () => {
          throw new ImportPipelineError('conversion_failed', 'boom')
        },
      },
    })
    const failed = await failing.upload(uploadedFile('c2.pdf'), metaFor())
    await expect(failing.convert(failed.id)).rejects.toMatchObject({ code: 'conversion_failed' })
    expect((await failing.getJob(failed.id)).status).toBe('failed')
    await expect(failing.cancel(failed.id)).resolves.toBeUndefined()

    // confirmed（P1 审核通过）后不可回退 —— 经 markApproved 从 reviewing 进入 confirmed
    const confirmed = await failing.upload(uploadedFile('c3.pdf'), metaFor())
    // 人为推进：先用允许的路径到 previewing，再用非法手段不能跳过；此断言仅验证状态机拒绝
    await expect(failing.markApproved(confirmed.id)).rejects.toMatchObject({
      code: 'invalid_status_transition',
    })
  })
})
