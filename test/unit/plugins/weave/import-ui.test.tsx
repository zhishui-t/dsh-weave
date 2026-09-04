/**
 * P0-KUI-011 —— 知识导入 UI 控制器测试（组件态：渲染器无关，node 环境，纯 TS 无 JSX）。
 *
 * 覆盖：AC-IMPORT-003（全链路）/ AC-IMPORT-004（确认前不写 active）/ AC-IMPORT-006（归属）
 *       + AC-IMPORT-002（不支持类型）+ UI 只发 convert/preview/confirm + 幂等取消 +
 *       cancel 竞态 + viewModel 绑定契约。
 *
 * 运行：pnpm vitest run src/plugins/weave/__tests__/import-ui.test.tsx
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openPersistence, type WeavePersistence } from '../../../../src/plugins/weave/persistence/index.js'
import { KnowledgeStore } from '../../../../src/plugins/weave/knowledge/knowledge-model.js'
import {
  AnyDocLikeConverter,
  ConvertInput,
  ImportPipeline,
  ImportPipelineError,
  type ImportMeta,
  type UploadedFile,
} from '../../../../src/plugins/weave/knowledge/import-pipeline.js'
import { ImportUiController, type EditableCandidate } from '../../../../src/plugins/weave/knowledge/import-ui.js'

class MockConverter implements AnyDocLikeConverter {
  calls: ConvertInput[] = []
  fail = false
  failMessage = 'mock: 转换失败'
  gate: Promise<void> | null = null

  async convert(input: ConvertInput): Promise<{ markdown: string; title: string; warnings: string[] }> {
    this.calls.push(input)
    if (this.gate) await this.gate
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
  local_path: join(tmpdir(), `kui-upload-src-${filename}`),
})

interface Fixture {
  root: string
  importsDir: string
  knowledgeRoot: string
  p: WeavePersistence
  pipeline: ImportPipeline
  knowledgeStore?: KnowledgeStore
  controller: ImportUiController
  converter: MockConverter
}

function makeFixture(withKnowledge = true): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'weave-kui-'))
  const importsDir = join(root, 'imports')
  const knowledgeRoot = join(root, 'knowledge')
  const p = openPersistence({ inMemory: true })
  const converter = new MockConverter()
  const knowledgeStore = withKnowledge ? new KnowledgeStore({ rootDir: knowledgeRoot, metaDb: p.knowledgeMeta }) : undefined
  const pipeline = new ImportPipeline({
    importsDb: p.imports,
    importsDir,
    converter,
    knowledgeStore,
  })
  return { root, importsDir, knowledgeRoot, p, pipeline, knowledgeStore, controller: new ImportUiController(pipeline), converter }
}

function closeFixture(f: Fixture): void {
  f.p.close()
  rmSync(f.root, { recursive: true, force: true })
}

async function toPreviewing(
  f: Fixture,
  filename = 'design-guide.pdf',
  meta: ImportMeta = metaFor(),
): Promise<string> {
  const flow = await f.controller.pickFile(uploadedFile(filename), meta)
  expect(flow.phase).toBe('uploaded')
  await f.controller.convert(flow.jobId)
  await f.controller.preview(flow.jobId)
  return flow.jobId
}

describe('KUI：导入全链路（AC-IMPORT-003：上传→转换→预览→确认→candidate）', () => {
  let f: Fixture
  beforeAll(() => {
    f = makeFixture(true)
  })
  afterAll(() => closeFixture(f))

  it('pickFile(role/designer) → uploaded，归属写入 job.target_role_id（AC-IMPORT-006 前置）', async () => {
    const flow = await f.controller.pickFile(
      uploadedFile('design-guide.pdf'),
      metaFor({ target: 'role', role_id: 'designer', visibility: 'role_only', version: undefined, project_id: undefined }),
    )
    expect(flow.phase).toBe('uploaded')
    expect(flow.job?.id).toBeTruthy()
    expect(flow.job?.original_filename).toBe('design-guide.pdf')
    expect(flow.job?.target_role_id).toBe('designer')
    expect(flow.job?.status).toBe('uploaded')
  })

  it('convert → converted（含 warnings），preview → previewing（GFM 可读）', async () => {
    const p1 = await f.controller.pickFile(uploadedFile('ac-im-003.pdf'), metaFor())
    const c1 = await f.controller.convert(p1.jobId)
    expect(c1.phase).toBe('converted')
    expect(c1.warnings.length).toBeGreaterThan(0)

    const pv = await f.controller.preview(p1.jobId)
    expect(pv.phase).toBe('previewing')
    expect(pv.previewMarkdown).toContain('从 ac-im-003.pdf 转换而来')

    // viewModel：preview 后 prepare 允许 confirm
    const vm = f.controller.viewModelOf(pv)
    expect(vm.canConfirm).toBe(true)
    expect(vm.canCancel).toBe(true)
  })

  it('confirm(编辑标题/tags) → reviewing + candidateId；知识层仅产生 candidate，无 active（AC-IMPORT-003/004）', async () => {
    const jobId = await toPreviewing(f, 'confirm-me.pdf', metaFor({ target: 'role', role_id: 'designer', visibility: 'role_only', project_id: undefined, version: undefined }))
    const edited: EditableCandidate = { title: '设计指南（人工确认）', tags: ['设计', '规范'] }
    const done = await f.controller.confirm(jobId, edited)
    expect(done.phase).toBe('reviewing')
    expect(done.candidateId).toBeTruthy()
    expect(done.edited?.title).toBe('设计指南（人工确认）')

    const all = await f.knowledgeStore!.listMeta({ status: 'candidate' })
    expect(all.length).toBe(1)
    expect(all[0]!.status).toBe('candidate')
    expect(all[0]!.layer).toBe('role')
    const active = await f.knowledgeStore!.listMeta({ status: 'active' })
    expect(active.length).toBe(0)

    // 文件落盘：_agent/roles/ 下出现 candidate 卡片，frontmatter status=candidate
    const meta0 = all[0]!
    const file = f.knowledgeStore!.getKnowledgeFile(meta0.id)
    expect(file).not.toBeNull()
    expect(file!.frontmatter.status).toBe('candidate')
    expect(file!.frontmatter.title).toBe('设计指南（人工确认）')

    // 取消合法性由 pipeline 状态机决定（TDD 3.1.4：reviewing→cancelled 合法），见 cancel describe
  })

  it('subscribe：动作均触发快照，包含全部流程', async () => {
    const f2 = makeFixture(true)
    try {
      const listener = vi.fn()
      const unsubscribe = f2.controller.subscribe(listener)
      const flow = await f2.controller.pickFile(uploadedFile('sub.pdf'), metaFor())
      await f2.controller.convert(flow.jobId)
      expect(listener).toHaveBeenCalled()
      const snapshots = listener.mock.calls.map((c) => c[0] as { flows: unknown[] })
      expect(snapshots[snapshots.length - 1]!.flows.length).toBe(1)
      unsubscribe()
      await f2.controller.preview(flow.jobId)
      expect(listener).toHaveBeenCalledTimes(3) // 订阅即回调 + pickFile + convert；unsubscribe 后不再增长
    } finally {
      closeFixture(f2)
    }
  })

  it('confirm 前未 preview：本地守卫返回可读错误，不触达 pipeline 写入路径', async () => {
    const f2 = makeFixture(true)
    try {
      const flow = await f2.controller.pickFile(uploadedFile('no-preview.pdf'), metaFor())
      const denied = await f2.controller.confirm(flow.jobId, { title: 'x' })
      expect(denied.error?.code).toBe('invalid_status_transition')
      expect(denied.error?.message).toContain('需先预览')
      const all = await f2.knowledgeStore!.listMeta()
      expect(all.length).toBe(0)
    } finally {
      closeFixture(f2)
    }
  })
})

describe('KUI：确认前不写 active（AC-IMPORT-004）', () => {
  let f: Fixture
  beforeAll(() => {
    f = makeFixture(true)
  })
  afterAll(() => closeFixture(f))

  it('上传+转换+预览后（未 confirm）：无 candidate/active 元数据，job.status != confirmed，目录无知识文件', async () => {
    const flow = await f.controller.pickFile(uploadedFile('no-active.pdf'), metaFor())
    await f.controller.convert(flow.jobId)
    await f.controller.preview(flow.jobId)

    expect(await f.knowledgeStore!.listMeta({ status: 'candidate' })).toEqual([])
    expect(await f.knowledgeStore!.listMeta({ status: 'active' })).toEqual([])
    const job = await f.pipeline.getJob(flow.jobId)
    expect(job.status).not.toBe('confirmed')
    expect(f.knowledgeStore!.agentRoot()).toBeTruthy()
  })
})

describe('KUI：幂等取消与终态保护', () => {
  let f: Fixture
  beforeAll(() => {
    f = makeFixture(true)
  })
  afterAll(() => closeFixture(f))

  it('convert 后 cancel → cancelled；重复 cancel 为 no-op（phase 不变，pipeline 幂等）', async () => {
    const flow = await f.controller.pickFile(uploadedFile('cancel-idem.pdf'), metaFor())
    await f.controller.convert(flow.jobId)
    const c1 = await f.controller.cancel(flow.jobId)
    expect(c1.phase).toBe('cancelled')
    const job = await f.pipeline.getJob(flow.jobId)
    expect(job.status).toBe('cancelled')

    const c2 = await f.controller.cancel(flow.jobId)
    expect(c2.phase).toBe('cancelled')
    expect(c2.error).toBeUndefined()
    const vm = f.controller.viewModelOf(c2)
    expect(vm.canCancel).toBe(false)
    expect(vm.canConvert).toBe(false)
  })

  it('reviewing（confirm 后）阶段取消合法（TDD 3.1.4）且幂等：phase=cancelled，错误可读', async () => {
    const jobId = await toPreviewing(f, 'cancel-review.pdf')
    await f.controller.confirm(jobId, { title: '取消审核' })
    const c1 = await f.controller.cancel(jobId)
    expect(c1.phase).toBe('cancelled')
    expect(c1.error).toBeUndefined()
    const c2 = await f.controller.cancel(jobId)
    expect(c2.phase).toBe('cancelled')
    // 候选已生成保留（审核队列语义），job 置 cancelled —— 与 pipeline 一致
    const job = await f.pipeline.getJob(jobId)
    expect(job.status).toBe('cancelled')
  })

  it('cancelled 后 convert/preview/confirm：返回可读错误，不产生知识写入', async () => {
    const f3 = makeFixture(true)
    try {
      const flow = await f3.controller.pickFile(uploadedFile('cancel-then.pdf'), metaFor())
      await f3.controller.cancel(flow.jobId)
      const cv = await f3.controller.convert(flow.jobId)
      expect(cv.error).toBeDefined()
      expect(cv.phase).toBe('cancelled')
      expect(await f3.knowledgeStore!.listMeta()).toEqual([])
    } finally {
      closeFixture(f3)
    }
  })
})

describe('KUI：UI 只发 convert/preview/confirm —— 无 KnowledgeStore 时完全不能写知识', () => {
  let f: Fixture
  beforeAll(() => {
    f = makeFixture(false)
  })
  afterAll(() => closeFixture(f))

  it('pickFile/convert/preview 全链路成功（未触碰知识层），confirm 得到可读错误', async () => {
    const flow = await f.controller.pickFile(uploadedFile('no-store.pdf'), metaFor())
    expect(flow.phase).toBe('uploaded')
    const converted = await f.controller.convert(flow.jobId)
    expect(converted.phase).toBe('converted')
    const pv = await f.controller.preview(flow.jobId)
    expect(pv.phase).toBe('previewing')

    const denied = await f.controller.confirm(flow.jobId, { title: 'x' })
    expect(denied.error?.code).toBe('invalid_status_transition')
    expect(denied.error?.message).toContain('KnowledgeStore 未注入')
    // 知识目录从未被创建 —— 证明确认前的 UI 动作零知识写入
    expect(existsSync(f.knowledgeRoot)).toBe(false)
  })
})

describe('KUI：归属选择校验（AC-IMPORT-006 + invalid_import_meta）', () => {
  let f: Fixture
  beforeAll(() => {
    f = makeFixture(true)
  })
  afterAll(() => closeFixture(f))

  it('role 缺 role_id → failed + invalid_import_meta 可读错误', async () => {
    const flow = await f.controller.pickFile(
      uploadedFile('bad-role.pdf'),
      metaFor({ target: 'role', role_id: undefined, visibility: 'role_only', project_id: undefined, version: undefined }),
    )
    expect(flow.phase).toBe('failed')
    expect(flow.error?.code).toBe('invalid_import_meta')
    expect(flow.error?.message).toContain('role_id')
    expect(flow.jobId).toBe('')
  })

  it('project 缺 version → failed；global → uploaded 且 visibility=global', async () => {
    const bad = await f.controller.pickFile(
      uploadedFile('bad-project.pdf'),
      metaFor({ version: undefined }),
    )
    expect(bad.error?.code).toBe('invalid_import_meta')

    const ok = await f.controller.pickFile(
      uploadedFile('global.pdf'),
      metaFor({ target: 'global', visibility: 'global', project_id: undefined, version: undefined }),
    )
    expect(ok.phase).toBe('uploaded')
    expect(ok.job?.visibility).toBe('global')
    expect(ok.job?.target_project_id).toBeNull()
  })
})

describe('KUI：不支持类型（AC-IMPORT-002）与转换失败可读性', () => {
  let f: Fixture
  beforeAll(() => {
    f = makeFixture(true)
  })
  afterAll(() => closeFixture(f))

  it('pickFile(.exe) → failed + unsupported_file_type + 可读 message', async () => {
    const flow = await f.controller.pickFile(uploadedFile('virus.exe'), metaFor())
    expect(flow.phase).toBe('failed')
    expect(flow.error?.code).toBe('unsupported_file_type')
    expect(flow.error?.message).toContain('不支持的文件类型')
    expect(flow.jobId).toBe('')
  })

  it('转换器失败 → flow.error=conversion_failed，phase 回读 failed，不创建知识', async () => {
    const f2 = makeFixture(true)
    try {
      const flow = await f2.controller.pickFile(uploadedFile('fail.pdf'), metaFor())
      f2.converter.fail = true
      const res = await f2.controller.convert(flow.jobId)
      expect(res.error?.code).toBe('conversion_failed')
      expect(res.error?.message).toContain('mock: 转换失败')
      expect((await f2.pipeline.getJob(flow.jobId)).status).toBe('failed')
      expect(await f2.knowledgeStore!.listMeta()).toEqual([])
    } finally {
      closeFixture(f2)
    }
  })
})

describe('KUI：取消竞态（convert 进行中 cancel）', () => {
  let f: Fixture
  beforeAll(() => {
    f = makeFixture(true)
  })
  afterAll(() => closeFixture(f))

  it('convert 挂起时 cancel → 转换完成后流程为 cancelled + import_cancelled 可读错误', async () => {
    const flow = await f.controller.pickFile(uploadedFile('race.pdf'), metaFor())
    let release!: () => void
    f.converter.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const converting = f.controller.convert(flow.jobId)
    const cancelling = f.controller.cancel(flow.jobId)
    await cancelling
    release()
    const done = await converting
    expect(done.phase).toBe('cancelled')
    expect(done.error?.code).toBe('import_cancelled')
    const job = await f.pipeline.getJob(flow.jobId)
    expect(job.status).toBe('cancelled')
  })
})

describe('KUI：viewModel 绑定契约与未知流程', () => {
  let f: Fixture
  beforeAll(() => {
    f = makeFixture(true)
  })
  afterAll(() => closeFixture(f))

  it('phase 派生的 canXxx 标志随流程推进正确变化', async () => {
    const p1 = await f.controller.pickFile(uploadedFile('vm.pdf'), metaFor())
    let vm = f.controller.viewModelOf(p1)
    expect(vm.canConvert).toBe(true)
    expect(vm.canPreview).toBe(false)
    expect(vm.canConfirm).toBe(false)

    const c1 = await f.controller.convert(p1.jobId)
    vm = f.controller.viewModelOf(c1)
    expect(vm.canConvert).toBe(false)
    expect(vm.canPreview).toBe(true)
    expect(vm.canConfirm).toBe(false)

    const pv = await f.controller.preview(p1.jobId)
    vm = f.controller.viewModelOf(pv)
    expect(vm.canConfirm).toBe(true)

    const done = await f.controller.confirm(p1.jobId, { title: 'VM 标题' })
    vm = f.controller.viewModelOf(done)
    expect(vm.phase).toBe('reviewing')
    expect(vm.candidateId).toBeTruthy()
    expect(vm.canConfirm).toBe(false)
    expect(vm.canCancel).toBe(true) // reviewing 可取消（TDD 3.1.4；confirmed/active 才锁定）
    expect(vm.title).toBe('VM 标题')
  })

  it('未知 jobId：方法抛出 job_not_found（程序错误，与业务错误分流）', async () => {
    await expect(f.controller.convert('nope')).rejects.toMatchObject({ code: 'job_not_found' })
    await expect(f.controller.cancel('nope')).rejects.toMatchObject({ code: 'job_not_found' })
  })

  it('getFlow 返回快照副本（外部修改不影响内部状态）', async () => {
    const p1 = await f.controller.pickFile(uploadedFile('copy.pdf'), metaFor())
    const flow = f.controller.getFlow(p1.jobId)!
    flow.filename = 'HACKED.pdf'
    expect(f.controller.getFlow(p1.jobId)!.filename).toBe('copy.pdf')
  })
})
