// GapStyle tokenizing: each construct gets its kind, and block comments carry across lines.
import { describe, expect, test } from 'vitest'

import { commentStarts, langOf, startState, tokenize } from '../hooks/gapstyle'

const kinds = (line: string, lang = 'ts') =>
  tokenize(line, lang, { block: null, template: false })
    .filter(p => p.text.trim())
    .map(p => `${p.kind}:${p.text.trim()}`)

describe('tokenize', () => {
  test('keywords, calls, types, strings, numbers and constants', () => {
    expect(kinds("const x = await load(Foo, 'a', 42, null)")).toEqual([
      'keyword:const', 'local:x', 'plain:=', 'keyword:await', 'function:load', 'plain:(', 'type:Foo', 'plain:,',
      "string:'a'", 'plain:,', 'number:42', 'plain:,', 'constant:null', 'plain:)',
    ])
  })

  test('members and ALL_CAPS constants', () => {
    expect(kinds('a.b = MAX_LINES')).toEqual(['plain:a.', 'member:b', 'plain:=', 'constant:MAX_LINES'])
  })

  test('a doc comment carries to the next line, with tags picked out', () => {
    const st = { block: null, template: false } as const
    const s = { ...st } as { block: null | 'comment' | 'doc'; template: boolean }
    expect(tokenize('/** Reads {@link x}', 'ts', s).map(p => p.kind)).toEqual(['doc', 'docLink'])
    expect(s.block).toBe('doc')
    expect(tokenize(' * @param job */ run()', 'ts', s).map(p => p.kind)).toEqual(['doc', 'docTag', 'doc', 'plain', 'function', 'plain'])
    expect(s.block).toBeNull()
  })

  test('a regex after an operator is a regex, a division is not', () => {
    expect(kinds('const r = /^a+$/.test(s)')).toContain('regex:/^a+$/')
    expect(kinds('a / b / c').some(k => k.startsWith('regex'))).toBe(false)
  })

  test('template strings colour their interpolation', () => {
    expect(kinds('`a ${b} c`')).toEqual(['string:`a', 'interp:${', 'plain:b', 'interp:}', 'string:c`'])
  })
})

describe('languages and excerpts', () => {
  test('comment markers follow the language', () => {
    expect(commentStarts('ts')).toEqual(['//'])
    expect(commentStarts('py')).toEqual(['#'])
    expect(commentStarts('sql')).toEqual(['--'])
    expect(langOf('pipeline/src/runner.ts')).toBe('ts')
  })

  test('an excerpt starting inside a doc comment starts in doc state', () => {
    expect(startState(' * the middle of a doc').block).toBe('doc')
    expect(startState(' */').block).toBeNull()
    expect(startState('const a = 1').block).toBeNull()
  })
})
