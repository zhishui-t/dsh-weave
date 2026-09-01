import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { GraphService } from '../graph/graph-service.js'
import { openPersistence } from '../persistence/index.js'
import { listDirectories, listGraphProjects, WeaveQueryService } from '../web/query-service.js'

const tmpDirs: string[] = []

function makeTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

describe('code graph port: GraphService sourceDir', () => {
  it('auto-detects src before falling back to root', () => {
    const dir = makeTmp('weave-graph-src-')
    mkdirSync(join(dir, 'src'))
    const service = new GraphService({ projectRoot: dir })
    expect(service.sourceDir).toBe('src')
  })

  it('falls back to project root when no conventional source dir exists', () => {
    const dir = makeTmp('weave-graph-root-')
    writeFileSync(join(dir, 'package.json'), '{}')
    const service = new GraphService({ projectRoot: dir })
    expect(service.sourceDir).toBe('.')
  })

  it('honors an explicit sourceDir', () => {
    const dir = makeTmp('weave-graph-explicit-')
    mkdirSync(join(dir, 'app'))
    const service = new GraphService({ projectRoot: dir, sourceDir: 'app' })
    expect(service.sourceDir).toBe('app')
  })
})

describe('code graph port: directory listing', () => {
  it('returns child directories for a given path', () => {
    const dir = makeTmp('weave-dirs-')
    mkdirSync(join(dir, 'src'))
    mkdirSync(join(dir, 'docs'))
    const listing = listDirectories(dir)
    expect(listing.path).toBe(dir)
    expect(listing.dirs.map((d) => basename(d))).toEqual(['docs', 'src'])
    expect(listing.parent).toBeDefined()
  })

  it('returns path and empty dirs for a missing path without throwing', () => {
    const missing = join(makeTmp('weave-dirs-missing-'), 'nope')
    const listing = listDirectories(missing)
    expect(listing.path).toBe(missing)
    expect(listing.dirs).toEqual([])
  })
})

describe('code graph port: project listing', () => {
  it('includes cwd project and detects source dir', () => {
    const dir = makeTmp('weave-projects-')
    mkdirSync(join(dir, 'src'))
    const projects = listGraphProjects(dir)
    const current = projects.find((p) => p.current)
    expect(current).toBeDefined()
    expect(current?.root).toBe(dir)
    expect(current?.sourceDir).toBe('src')
  })
})

describe('code graph port: RPC dispatch', () => {
  it('dispatches code/projects, code/dirs, code/status without a pre-built graph', async () => {
    const persistence = openPersistence({ inMemory: true })
    const service = new WeaveQueryService({
      persistence,
    } as never)
    try {
      const projects = await service.dispatch('code/projects', {}) as { projects: unknown[] }
      expect(Array.isArray(projects.projects)).toBe(true)

      const dir = makeTmp('weave-rpc-dir-')
      mkdirSync(join(dir, 'src'))
      const dirs = await service.dispatch('code/dirs', { path: dir }) as { dirs: string[] }
      expect(dirs.dirs.length).toBe(1)

      const status = await service.dispatch('code/status', { projectRoot: dir }) as { hasGraph: boolean; sourceDir: string }
      expect(status.hasGraph).toBe(false)
      expect(status.sourceDir).toBe('src')
    } finally {
      persistence.close()
    }
  })
})
