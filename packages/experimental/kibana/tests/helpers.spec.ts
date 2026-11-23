/** Text bounds, wire validation, and Elasticsearch error reading, exercised directly. */

import { describe, expect, it } from 'vitest'
import { elasticsearchCause, elasticsearchReason, failureDetail } from '../src/client.ts'
import { titleSearch } from '../src/find.ts'
import { capOutput, clip, fitLines, flattenFields, OUTPUT_TRUNCATED } from '../src/format.ts'
import { WireReader } from '../src/wire.ts'

describe('text bounds', () => {
  it('clips to the exact bound without splitting a surrogate pair', () => {
    expect(clip('abc', 3)).toBe('abc')
    expect(clip('abcd', 3)).toBe('ab…')
    expect(clip('a😀b', 3)).toBe('a…')
    expect(clip('abcd', 1)).toBe('…')
  })

  it('caps a complete output at exactly its bound, note included', () => {
    const text = 'x'.repeat(200)
    expect(capOutput(text, 200)).toBe(text)
    const capped = capOutput(text, 199)
    expect(capped).toHaveLength(199)
    expect(capped.endsWith(OUTPUT_TRUNCATED)).toBe(true)
    expect(capOutput(`${'x'.repeat(10)}😀${'y'.repeat(100)}`, 10 + 1 + OUTPUT_TRUNCATED.length)).toBe(`${'x'.repeat(10)}${OUTPUT_TRUNCATED}`)
  })

  it('keeps whole lines beside a footer and caps a heading that leaves no room', () => {
    const footer = (shown: number) => `[${String(3 - shown)} more]`
    expect(fitLines('head', ['a', 'b', 'c'], 100, footer)).toBe('head\na\nb\nc')
    expect(fitLines('head', ['aaaa', 'bbbb', 'cccc'], 'head\naaaa\n[2 more]'.length, footer)).toBe('head\naaaa\n[2 more]')
    const capped = fitLines('h'.repeat(200), ['a'], 100, footer)
    expect(capped).toHaveLength(100)
    expect(capped.endsWith(OUTPUT_TRUNCATED)).toBe(true)
  })

  it('flattens nested documents into dotted names and joins arrays', () => {
    expect(flattenFields({ a: { b: { c: 1 } }, empty: {}, list: ['x', 2, null, { k: 'v' }, ['n']], flag: true, none: null, text: 's' })).toEqual([
      ['a.b.c', '1'],
      ['empty', '{}'],
      ['list', 'x, 2, null, {"k":"v"}, ["n"]'],
      ['flag', 'true'],
      ['none', 'null'],
      ['text', 's'],
    ])
  })

  it('turns free text into prefix words', () => {
    expect(titleSearch(undefined)).toBeUndefined()
    expect(titleSearch(' *-* ')).toBeUndefined()
    expect(titleSearch('App-Logs 2024')).toBe('app* logs* 2024*')
  })
})

describe('wire validation', () => {
  const wire = new WireReader('the test answer')
  const failed = (read: () => unknown) => {
    try {
      read()
    } catch (error) {
      return error instanceof Error ? error.message.split(': ')[1] : String(error)
    }
    return 'accepted'
  }

  it('names the path and the expected value of a mismatch', () => {
    expect(failed(() => wire.object([], '$.a'))).toBe('$.a is not an object. Check that the kibana plugin\'s url points at Kibana 7.10 or later, including any base path.')
    expect(failed(() => wire.optionalObject('x', '$.b'))).toMatch(/^\$\.b is not an object\./u)
    expect(failed(() => wire.array({}, '$.c'))).toMatch(/^\$\.c is not an array\./u)
    expect(failed(() => wire.optionalArray(1, '$.d'))).toMatch(/^\$\.d is not an array\./u)
    expect(failed(() => wire.string(1, '$.e'))).toMatch(/^\$\.e is not a string\./u)
    expect(failed(() => wire.count(-1, '$.f'))).toMatch(/^\$\.f is not a non-negative integer\./u)
    expect(failed(() => wire.count(1.5, '$.f'))).toMatch(/^\$\.f is not a non-negative integer\./u)
    expect(failed(() => wire.boolean('true', '$.g'))).toMatch(/^\$\.g is not a boolean\./u)
    expect(failed(() => wire.embedded('{', '$.h'))).toMatch(/^\$\.h is not a JSON document\./u)
    expect(failed(() => wire.json({ a: [1, undefined] }, '$'))).toMatch(/^\$\.a\[1\] is not JSON data\./u)
    expect(failed(() => wire.json(Number.NaN, '$'))).toMatch(/^\$ is not JSON data\./u)
  })

  it('reads absent optional members as absent and copies JSON', () => {
    expect(wire.optionalObject(null, '$')).toBeUndefined()
    expect(wire.optionalArray(undefined, '$')).toEqual([])
    expect(wire.optionalString(null, '$')).toBeUndefined()
    expect(wire.embedded('{"a":1}', '$')).toEqual({ a: 1 })
    expect(wire.json({ a: [1, 'b', true, null, { c: 2 }] }, '$')).toEqual({ a: [1, 'b', true, null, { c: 2 }] })
  })
})

describe('Elasticsearch errors', () => {
  it('reads a cause with or without its type', () => {
    expect(elasticsearchCause({ type: 'parse_exception', reason: 'bad' })).toBe('parse_exception: bad')
    expect(elasticsearchCause({ reason: 'bad' })).toBe('bad')
    expect(elasticsearchCause({ type: 'x' })).toBeUndefined()
    expect(elasticsearchCause('bad')).toBeUndefined()
  })

  it('reads the root cause and the first caused_by, falling back to the error itself', () => {
    expect(elasticsearchReason({ error: { type: 'x_content_parse_exception', reason: '[1:30] [terms] unknown field [fild]', caused_by: { type: 'illegal_argument_exception', reason: 'unknown field' } }, status: 400 }))
      .toBe('x_content_parse_exception: [1:30] [terms] unknown field [fild]; caused by illegal_argument_exception: unknown field')
    expect(elasticsearchReason({ error: { root_cause: [], type: 'illegal_argument_exception', reason: 'bad' }, failed_shards: 'none' })).toBe('illegal_argument_exception: bad')
    expect(elasticsearchReason({ error: { root_cause: [{ type: 'a', reason: 'b' }], failed_shards: [{ reason: 'flat' }], caused_by: { reason: 'outer' } } })).toBe('a: b; caused by outer')
    expect(elasticsearchReason({ error: { type: 'no_reason' } })).toBeUndefined()
    expect(elasticsearchReason({ error: 'Not Found' })).toBeUndefined()
    expect(elasticsearchReason('text')).toBeUndefined()
  })

  it('describes a transport failure by its innermost cause', () => {
    expect(failureDetail(new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 10.0.0.1:5601') }))).toBe('connect ECONNREFUSED 10.0.0.1:5601')
    expect(failureDetail(new Error('terminated'))).toBe('terminated')
    expect(failureDetail(new Error('outer', { cause: 'socket hang up' }))).toBe('socket hang up')
  })
})
