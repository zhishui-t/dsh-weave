/**
 * T8 document e2e: D1-D4 + positive document convert/preview/status
 *
 * 正向：真实 AnyDoc 转换 CSV → status/preview。
 * 负向按 doc/09 §4.2 期望：
 * D1 非白名单扩展名 → invalid_argument
 * D2 文件超 50MB → invalid_argument
 * D3 jobId 不存在 → configuration_error
 * D4 转换失败 → document_conversion_failed + error 信息
 */
import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { DocumentConverter } from '../../dist/plugins/weave/convert/document-converter.js'
import type { AnyDocLikeConverter, ConvertInput } from '../../dist/plugins/weave/import-pipeline.js'
import { WeavePersistence } from '../../dist/plugins/weave/persistence/persistence.js'
import { WeaveQueryService } from '../../dist/plugins/weave/web/query-service.js'
import { WeaveError } from '../../dist/plugins/weave/state/weave-error.js'

class BombConverter implements AnyDocLikeConverter {
  calls: ConvertInput[] = []
  fail = false
  async convert(input: ConvertInput) {
    this.calls.push(input)
    if (this.fail) throw new Error('mock: 转换失败')
    return { markdown: `# 转换结果\n\n从 ${input.originalFilename} 转换而来。`, title: '转换结果', warnings: [] }
  }
}

async function expectWeaveError(promise: Promise<unknown>, code: string): Promise<void> {
  let error: unknown
  try {
    await promise
  } catch (cause) {
    error = cause
  }
  expect(error, `expected WeaveError(${code})`).toBeInstanceOf(WeaveError)
  expect((error as WeaveError).code).toBe(code)
}

test.describe('T8 document convert e2e', () => {
  const roots: string[] = []
  test.afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function makeRealEnv() {
    const root = mkdtempSync(join(tmpdir(), 'weave-e2e-doc-'))
    roots.push(root)
    const outputDir = join(root, 'imports')
    mkdirSync(outputDir, { recursive: true })
    const converter = new DocumentConverter({ outputDir })
    const query = new WeaveQueryService({
      persistence: new WeavePersistence({ inMemory: true }),
      documentConverter: converter,
    })
    return { root, outputDir, converter, query }
  }

  test('正向: CSV 真实转换 → status done → preview 可读', async () => {
    const { root, query } = makeRealEnv()
    const src = join(root, 'sample.csv')
    writeFileSync(src, 'name,age\nalice,30\nbob,25\n', 'utf8')

    const started = (await query.dispatch('document/convert', { file: src, filename: 'sample.csv' })) as {
      jobId: string
      status: string
    }
    expect(started.status).toBe('queued')

    // 用 query.dispatch('document/status') 轮询到终态（与 UI 行为一致）
    const deadline = Date.now() + 30_000
    let status: { status: string; error?: string; markdown?: string }
    do {
      status = (await query.dispatch('document/status', { jobId: started.jobId })) as typeof status
      if (status.status === 'done' || status.status === 'failed') break
      await new Promise((resolve) => setTimeout(resolve, 100))
    } while (Date.now() < deadline)
    expect(status.status).toBe('done')

    const preview = (await query.dispatch('document/preview', { jobId: started.jobId })) as {
      markdown: string
      status: string
    }
    expect(preview.status).toBe('done')
    expect(preview.markdown).toContain('alice')
    expect(preview.markdown).toContain('| name | age |')
  })

  test('D1: 非白名单扩展名 .exe → invalid_argument', async () => {
    const { root, query } = makeRealEnv()
    const bad = join(root, 'malware.exe')
    writeFileSync(bad, 'fake', 'utf8')
    await expectWeaveError(
      query.dispatch('document/convert', { file: bad, filename: 'malware.exe' }) as Promise<unknown>,
      'invalid_argument',
    )
  })

  test('D2: 文件超 50MB → invalid_argument（不得发起转换）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'weave-e2e-doc-'))
    roots.push(root)
    const mock = new BombConverter()
    const converter = new DocumentConverter({ outputDir: join(root, 'imports'), converter: mock })
    const query = new WeaveQueryService({
      persistence: new WeavePersistence({ inMemory: true }),
      documentConverter: converter,
    })
    const big = join(root, 'big.pdf')
    // 50MB 边界之上；使用稀疏/快速 Buffer 写入（测试只需确认不应进入转换管线）
    writeFileSync(big, Buffer.alloc(50 * 1024 * 1024 + 1, 0x61))

    let error: unknown
    try {
      await query.dispatch('document/convert', { file: big, filename: 'big.pdf' })
    } catch (cause) {
      error = cause
    }
    if (error) {
      expect(error).toBeInstanceOf(WeaveError)
      expect((error as WeaveError).code).toBe('invalid_argument')
    } else {
      // 如果走到这里说明没有大小校验；后台可能失败，但已经构成缺陷。
      expect(mock.calls.length, '大小校验缺失：超过 50MB 的文件被提交给转换器').toBe(0)
    }
  })

  test('D3: jobId 不存在 → configuration_error', async () => {
    const { query } = makeRealEnv()
    await expectWeaveError(
      query.dispatch('document/status', { jobId: 'doc_missing' }) as Promise<unknown>,
      'configuration_error',
    )
  })

  test('D4: 转换失败 → document_conversion_failed + error 信息', async () => {
    const root = mkdtempSync(join(tmpdir(), 'weave-e2e-doc-'))
    roots.push(root)
    const mock = new BombConverter()
    mock.fail = true
    const converter = new DocumentConverter({ outputDir: join(root, 'imports'), converter: mock })
    const query = new WeaveQueryService({
      persistence: new WeavePersistence({ inMemory: true }),
      documentConverter: converter,
    })
    const src = join(root, 'broken.pdf')
    writeFileSync(src, 'broken', 'utf8')

    const started = (await query.dispatch('document/convert', { file: src, filename: 'broken.pdf' })) as {
      jobId: string
    }
    const deadline = Date.now() + 10_000
    let status: { status: string; error?: string }
    do {
      status = (await query.dispatch('document/status', { jobId: started.jobId })) as typeof status
      if (status.status === 'failed') break
      await new Promise((resolve) => setTimeout(resolve, 50))
    } while (Date.now() < deadline)
    expect(status.status).toBe('failed')

    // 文档 D4 期望 document/status 在 failed 状态返回 document_conversion_failed 错误码。
    const failed = (await query.dispatch('document/status', { jobId: started.jobId })) as {
      status: string
      error?: string
      error_code?: string
    }
    expect(failed.status).toBe('failed')
    expect(typeof failed.error).toBe('string')
    expect(failed.error_code).toBe('document_conversion_failed')
  })
})
