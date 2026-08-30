import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ExecutorSessionStore } from '../executor-session-store'

let dir = ''
let file = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weave-session-store-'))
  file = join(dir, 'acp-session-index.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('ExecutorSessionStore', () => {
  it('sessionKeyOf includes workspace fingerprint, team and role', () => {
    const store = new ExecutorSessionStore(file)
    const a = store.sessionKeyOf({ workspace: 'C:/proj/a', teamId: 't', roleId: 'r' })
    const b = store.sessionKeyOf({ workspace: 'C:/proj/b', teamId: 't', roleId: 'r' })
    expect(a).not.toBe(b)
    expect(a).toContain(':t:r')
  })

  it('remember/resolve roundtrips v2 record', () => {
    const store = new ExecutorSessionStore(file)
    const key = store.sessionKeyOf({ workspace: 'p', teamId: 'changan-1', roleId: 'dev' })
    store.remember(key, { type: 'zcode', acpSid: 'acp-123', updatedAt: 100 })
    expect(store.resolve(key)).toEqual({ resumeSessionId: 'acp-123' })
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    expect(raw.version).toBe(2)
    expect(raw.keys[key]).toMatchObject({ type: 'zcode', acpSid: 'acp-123' })
    expect(raw.keys[key]).not.toHaveProperty('cwd')
  })

  it('treats old record without type as zcode', () => {
    const store = new ExecutorSessionStore(file)
    const key = 'legacy'
    store.remember(key, { type: 'zcode', acpSid: 'old', updatedAt: 1 })
    // Simulate v1 missing type by rewriting compact record.
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    writeFileSync(file, JSON.stringify({ version: 1, keys: { [key]: { acpSid: 'old' } } }))
    expect(store.resolve(key)).toEqual({ resumeSessionId: 'old' })
  })
})
