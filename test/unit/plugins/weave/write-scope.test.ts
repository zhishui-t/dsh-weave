import { describe, expect, it } from 'vitest'

import {
  normalizeWriteScopes,
  parseWriteScopes,
  scopesOverlap,
  scopeSetsOverlap,
  writeScope,
} from '../../../../src/plugins/weave/state/write-scope.js'
import { WeaveError } from '../../../../src/plugins/weave/state/weave-error.js'

describe('writeScope 规范化', () => {
  it('反斜杠归一为斜杠；剥离前导 ./ 与尾部 /', () => {
    expect(writeScope('src\\shared\\ui')).toBe('src/shared/ui')
    expect(writeScope('./src/shared')).toBe('src/shared')
    expect(writeScope('src/shared/')).toBe('src/shared')
    expect(writeScope('.\\docs\\')).toBe('docs')
    expect(writeScope('a/b/c')).toBe('a/b/c')
  })

  it('拒绝绝对路径、盘符、空段、点段与空串', () => {
    for (const bad of [
      '',
      '/abs/path',
      '\\abs',
      'C:/dev/repo',
      'd:\\work',
      'a//b',
      './',
      '.',
      'a/./b',
      'a/../b',
      '..',
    ]) {
      expect(() => writeScope(bad), `expected reject ${JSON.stringify(bad)}`).toThrow(WeaveError)
    }
    try {
      writeScope('../escape')
      expect.unreachable('must throw')
    } catch (error) {
      expect((error as WeaveError).code).toBe('invalid_argument')
    }
  })

  it('与官方一致不做 trim：空白段按原样保留（advisory 域无害）', () => {
    expect(writeScope('   ')).toBe('   ')
  })
})

describe('normalizeWriteScopes 去重', () => {
  it('规范化后按 Set 去重，保持首现顺序', () => {
    expect(normalizeWriteScopes(['src/a/', './src/a', 'docs', 'src\\a'])).toEqual(['src/a', 'docs'])
    expect(normalizeWriteScopes([])).toEqual([])
  })
})

describe('scopesOverlap 前缀重叠判定', () => {
  it('相等或互为路径前缀即重叠', () => {
    expect(scopesOverlap('src', 'src')).toBe(true)
    expect(scopesOverlap('src/a', 'src')).toBe(true)
    expect(scopesOverlap('src', 'src/a')).toBe(true)
  })

  it('仅公共前缀字符串但非路径分量不算重叠', () => {
    expect(scopesOverlap('src/ab', 'src/a')).toBe(false)
    expect(scopesOverlap('docs', 'doxygen')).toBe(false)
    expect(scopesOverlap('src/a', 'lib/a')).toBe(false)
  })

  it('scopeSetsOverlap：任一交叉重叠即真', () => {
    expect(scopeSetsOverlap(['docs'], ['src', 'docs/api'])).toBe(true)
    expect(scopeSetsOverlap(['docs'], ['src', 'lib'])).toBe(false)
    expect(scopeSetsOverlap([], ['src'])).toBe(false)
  })
})

describe('parseWriteScopes 列解析', () => {
  it('合法 JSON 数组原样解析；损坏/缺省回退空数组', () => {
    expect(parseWriteScopes('["src/a","docs"]')).toEqual(['src/a', 'docs'])
    expect(parseWriteScopes('[]')).toEqual([])
    expect(parseWriteScopes(null)).toEqual([])
    expect(parseWriteScopes(undefined)).toEqual([])
    expect(parseWriteScopes('')).toEqual([])
    expect(parseWriteScopes('not-json')).toEqual([])
    expect(parseWriteScopes('{"a":1}')).toEqual([])
    expect(parseWriteScopes('[1,2]')).toEqual([])
  })
})
