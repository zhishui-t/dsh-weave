import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { DocumentConverter } from '../../../../src/plugins/weave/convert/document-converter'
import type { AnyDocLikeConverter, ConvertInput } from '../../../../src/plugins/weave/knowledge/import-pipeline'
import { WeaveCli, WeaveMcp } from '../../../../src/plugins/weave/host/cli-mcp'
import type { CliMcpDeps } from '../../../../src/plugins/weave/host/cli-mcp'
import { createWeaveRpcHandler } from '../../../../src/plugins/weave/host/rpc'
import { WeaveQueryService } from '../../../../src/plugins/weave/web/query-service'
import { WeavePersistence } from '../../../../src/plugins/weave/persistence/persistence'

class MockConverter implements AnyDocLikeConverter {
  calls: ConvertInput[] = []
  fail = false
  failMessage = 'mock: 转换失败'
  gate: Promise<void> | null = null

  async convert(input: ConvertInput): Promise<{ markdown: string; title: string; warnings: string[] }> {
    if (this.gate) await this.gate
    this.calls.push(input)
    if (this.fail) {
      throw new Error(this.failMessage)
    }
    return {
      markdown: `# 转换结果\n\n从 ${input.originalFilename} 转换而来。`,
      title: '转换结果',
      warnings: ['图片已忽略'],
    }
  }
}

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function newConverter(overrides: { converter?: AnyDocLikeConverter } = {}): {
  outputDir: string
  converter: DocumentConverter
  mock: MockConverter
} {
  const root = mkdtempSync(join(tmpdir(), 'weave-doc-conv-'))
  roots.push(root)
  const outputDir = join(root, 'imports')
  const mock = new MockConverter()
  const converter = new DocumentConverter({ outputDir, converter: overrides.converter ?? mock })
  return { outputDir, converter, mock }
}

describe('DocumentConverter（AnyDoc 独立转换）', () => {
  it('文件路径提交：convertAndWait 完成，status/preview/history 可用', async () => {
    const { outputDir, converter, mock } = newConverter()
    const source = join(outputDir, 'guide.pdf')
    writeFileSync(source, 'fake pdf')

    const started = await converter.convert({ file: source, filename: 'guide.pdf' })
    expect(started.jobId).toMatch(/^doc_/)
    expect(started.status).toBe('queued')

    const job = await converter.waitFor(started.jobId)
    expect(job.status).toBe('done')
    expect(job.title).toBe('转换结果')
    expect(job.markdown).toContain('从 guide.pdf 转换而来')
    expect(mock.calls).toHaveLength(1)
    expect(mock.calls[0]).toMatchObject({ filePath: source, fileType: 'pdf', originalFilename: 'guide.pdf' })
    expect(existsSync(job.markdown_path!)).toBe(true)
    expect(readFileSync(job.markdown_path!, 'utf8')).toBe(job.markdown)

    const status = await converter.status(started.jobId)
    expect(status).toMatchObject({ jobId: started.jobId, status: 'done', filename: 'guide.pdf', title: '转换结果' })
    expect(status.warnings).toEqual(['图片已忽略'])

    const preview = await converter.preview(started.jobId)
    expect(preview).toMatchObject({ jobId: started.jobId, status: 'done', title: '转换结果' })
    expect(preview.markdown).toContain('从 guide.pdf 转换而来')

    const history = await converter.history()
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ jobId: started.jobId, status: 'done', filename: 'guide.pdf' })
  })

  it('base64 上传模式：写入临时文件后交给转换器，filename 必填', async () => {
    const { outputDir, converter, mock } = newConverter()
    const data = Buffer.from('fake xlsx').toString('base64')
    const result = await converter.convertAndWait({ filename: 'data.xlsx', data })
    expect(result.status).toBe('done')
    expect(mock.calls[0]).toMatchObject({ fileType: 'xlsx', originalFilename: 'data.xlsx' })
    expect(mock.calls[0]!.filePath).toContain('src-')
    expect(existsSync(mock.calls[0]!.filePath)).toBe(true)
    expect(outputDir).toBeTruthy()

    await expect(converter.convert({ data })).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('白名单外类型/缺少输入拒绝', async () => {
    const { converter } = newConverter()
    await expect(converter.convert({ file: 'malware.exe', filename: 'malware.exe' })).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(converter.convert({ file: 'a.xyz', filename: 'a.xyz' })).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(converter.convert({})).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('转换失败：status failed + error；preview 报 invalid_status_transition；job_not_found', async () => {
    const { converter, mock } = newConverter()
    mock.fail = true
    const source = join(tmpdir(), 'broken.docx')
    writeFileSync(source, 'fake')
    const result = await converter.convertAndWait({ file: source, filename: 'broken.docx' })
    expect(result.status).toBe('failed')
    expect(result.error).toContain('mock: 转换失败')
    await expect(converter.preview(result.id)).rejects.toMatchObject({ code: 'invalid_status_transition' })
    await expect(converter.status('doc_missing')).rejects.toMatchObject({ code: 'configuration_error' })
  })

  it('后台进行中：waitFor 等待转换完成', async () => {
    const { converter, mock } = newConverter()
    let release!: () => void
    mock.gate = new Promise<void>((resolve) => { release = resolve })
    const source = join(tmpdir(), 'slow.pdf')
    writeFileSync(source, 'slow')
    const started = await converter.convert({ file: source, filename: 'slow.pdf' })
    const early = await converter.status(started.jobId)
    expect(['queued', 'converting']).toContain(early.status)
    release()
    const finished = await converter.waitFor(started.jobId)
    expect(finished.status).toBe('done')
  })

  it('配置缺失/未知 job 的错误语义由上层映射', async () => {
    const query = new WeaveQueryService({ persistence: new WeavePersistence({ inMemory: true }) })
    await expect(query.documentConvert({ file: 'a.pdf' })).rejects.toMatchObject({ code: 'configuration_error' })
    await expect(query.documentStatus({ jobId: 'x' })).rejects.toMatchObject({ code: 'configuration_error' })
  })
})

describe('WeaveQueryService document/* RPC', () => {
  function makeQuery(): { query: WeaveQueryService; converter: DocumentConverter } {
    const { converter } = newConverter()
    return {
      query: new WeaveQueryService({ persistence: new WeavePersistence({ inMemory: true }), documentConverter: converter }),
      converter,
    }
  }

  it('document/convert 提交并返回 jobId/status；status/preview/history 可查', async () => {
    const { query, converter } = makeQuery()
    const source = join(tmpdir(), 'rpc.pdf')
    writeFileSync(source, 'fake')
    const submitted = await query.documentConvert({ file: source, filename: 'rpc.pdf' }) as { jobId: string; status: string }
    expect(submitted.status).toBe('queued')
    const job = await converter.waitFor(submitted.jobId)
    expect(job.status).toBe('done')

    const status = await query.documentStatus({ jobId: submitted.jobId }) as { status: string; title?: string }
    expect(status.status).toBe('done')

    const preview = await query.documentPreview({ jobId: submitted.jobId }) as { markdown: string }
    expect(preview.markdown).toContain('从 rpc.pdf 转换而来')

    const history = await query.documentHistory({}) as { jobs: Array<{ jobId: string }> }
    expect(history.jobs).toHaveLength(1)
  })

  it('缺 jobId / 未知 job / 未注入配置错误均返回 WeaveError', async () => {
    const { query } = makeQuery()
    await expect(query.documentStatus({})).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(query.documentPreview({ jobId: 'doc_nope' })).rejects.toMatchObject({ code: 'configuration_error' })
  })

  it('createWeaveRpcHandler 将 document/* 路由到 queryService 并返回信封', async () => {
    const { query } = makeQuery()
    const call = createWeaveRpcHandler({ queryService: query } as never)
    const source = join(tmpdir(), 'route.pdf')
    writeFileSync(source, 'fake')
    const result = await call('document/convert', { file: source, filename: 'route.pdf' })
    expect(result).toMatchObject({ ok: true, value: expect.objectContaining({ status: 'queued' }) })
    const missing = await call('document/status', {})
    expect(missing).toMatchObject({ ok: false, error: { code: 'bad-request', details: { original_code: 'invalid_argument' } } })
  })
})

describe('WeaveMcp / WeaveCli document 入口', () => {
  function makeCli(): { cli: WeaveCli; converter: DocumentConverter } {
    const { converter } = newConverter()
    const mcp = new WeaveMcp({ documentConverter: converter } as unknown as CliMcpDeps)
    return { cli: new WeaveCli(mcp), converter }
  }

  it('WeaveMcp.documentConvert 等待并返回最终结果', async () => {
    const { converter } = newConverter()
    const mcp = new WeaveMcp({ documentConverter: converter } as unknown as CliMcpDeps)
    const source = join(tmpdir(), 'mcp.pdf')
    writeFileSync(source, 'fake')
    const result = await mcp.documentConvert({ file: source, filename: 'mcp.pdf' })
    expect(result.status).toBe('done')
    expect(result.title).toBe('转换结果')
    expect(result.markdown).toContain('从 mcp.pdf 转换而来')
  })

  it('CLI document convert/status/preview/history 输出', async () => {
    const { cli } = makeCli()
    const source = join(tmpdir(), 'cli.docx')
    writeFileSync(source, 'fake')
    const converted = await cli.run(['document', 'convert', source])
    expect(converted.exitCode).toBe(0)
    const parsed = JSON.parse(converted.json) as { ok: boolean; data: { jobId: string; status: string; markdown?: string } }
    expect(parsed.ok).toBe(true)
    const jobId = parsed.data.jobId
    expect(parsed.data.status).toBe('done')

    const status = await cli.run(['document', 'status', jobId])
    expect(status.exitCode).toBe(0)
    expect(status.text).toContain('[done]')

    const preview = await cli.run(['document', 'preview', jobId])
    expect(preview.exitCode).toBe(0)
    expect(preview.text).toContain('从 cli.docx 转换而来')

    const history = await cli.run(['document', 'history'])
    expect(history.exitCode).toBe(0)
    expect(history.text).toContain(jobId)
  })

  it('CLI document convert 缺参数/失败任务返回错误', async () => {
    const { cli } = makeCli()
    const missing = await cli.run(['document', 'convert'])
    expect(missing.exitCode).toBe(1)
    expect(missing.text).toContain('invalid_argument')

    const failedConverter = newConverter()
    failedConverter.mock.fail = true
    const mcp = new WeaveMcp({ documentConverter: failedConverter.converter } as unknown as CliMcpDeps)
    const failCli = new WeaveCli(mcp)
    const source = join(tmpdir(), 'fail.pdf')
    writeFileSync(source, 'fake')
    const failed = await failCli.run(['document', 'convert', source])
    expect(failed.exitCode).toBe(1)
    expect(failed.text).toContain('conversion_failed')
    expect((JSON.parse(failed.json) as { error: { code: string } }).error.code).toBe('conversion_failed')
  })
})
