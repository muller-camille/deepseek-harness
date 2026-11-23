/** Cell text and the character bound on complete results. */

import { describe, expect, it } from 'vitest'
import { counted, cut, fitText, formatCell, textCell } from '../src/format.ts'

const VARCHAR = { name: 'NAME', dbTypeName: 'VARCHAR2' }

describe('formatCell', () => {
  it('prints NULL, strings, numbers, booleans, and bigints', () => {
    expect(formatCell(null, VARCHAR, 100)).toBe('NULL')
    expect(formatCell(undefined, VARCHAR, 100)).toBe('NULL')
    expect(formatCell('Alice', VARCHAR, 100)).toBe('Alice')
    expect(formatCell('12345678901234567890.25', { name: 'N', dbTypeName: 'NUMBER' }, 100)).toBe('12345678901234567890.25')
    expect(formatCell(1.5, { name: 'D', dbTypeName: 'BINARY_DOUBLE' }, 100)).toBe('1.5')
    expect(formatCell(true, { name: 'B', dbTypeName: 'BOOLEAN' }, 100)).toBe('true')
    expect(formatCell(12n, VARCHAR, 100)).toBe('12')
  })

  it('keeps cells on one line', () => {
    expect(formatCell('a\r\nb\nc\rd\te', VARCHAR, 100)).toBe('a\\nb\\nc\\nd\\te')
  })

  it('bounds long text with a marker that states the original length', () => {
    const cell = formatCell('x'.repeat(5000), VARCHAR, 100)
    expect(cell).toBe(`${'x'.repeat(87)}…[5000 chars]`)
    expect(cell).toHaveLength(100)
    expect(formatCell('x'.repeat(100), VARCHAR, 100)).toBe('x'.repeat(100))
  })

  it('does not split a surrogate pair when it shortens a cell', () => {
    const cell = formatCell(`${'x'.repeat(87)}😀${'y'.repeat(50)}`, VARCHAR, 100)
    expect(cell).toBe(`${'x'.repeat(87)}…[139 chars]`)
  })

  it('prints DATE and TIMESTAMP values as their stored wall-clock time and zoned values in UTC', () => {
    expect(formatCell(new Date(2024, 0, 15, 9, 30, 5), { name: 'HIRED', dbTypeName: 'DATE' }, 100)).toBe('2024-01-15T09:30:05')
    expect(formatCell(new Date(2024, 11, 31, 23, 59, 59, 7), { name: 'AT', dbTypeName: 'TIMESTAMP' }, 100)).toBe('2024-12-31T23:59:59.007')
    expect(formatCell(new Date(Date.UTC(2024, 5, 1, 12, 0, 0)), { name: 'AT', dbTypeName: 'TIMESTAMP WITH TIME ZONE' }, 100)).toBe('2024-06-01T12:00:00.000Z')
    expect(formatCell(new Date(Date.UTC(2024, 5, 1, 12, 0, 0)), { name: 'AT', dbTypeName: 'TIMESTAMP WITH LOCAL TIME ZONE' }, 100)).toBe('2024-06-01T12:00:00.000Z')
  })

  it('prints binary values as uppercase hexadecimal and bounds long ones by their byte length', () => {
    const raw = { name: 'ID', dbTypeName: 'RAW' }
    expect(formatCell(Buffer.from([0x00, 0xab, 0x10]), raw, 100)).toBe('00AB10')
    expect(formatCell(new Uint8Array(50).fill(0xff), raw, 100)).toBe('FF'.repeat(50))
    const long = formatCell(Buffer.alloc(1000, 0x0f), { name: 'DOC', dbTypeName: 'BLOB' }, 100)
    expect(long).toBe(`${'0F'.repeat(43)}0…[1000 bytes]`)
    expect(long).toHaveLength(100)
    expect(formatCell(Buffer.alloc(51, 0x0f), raw, 101)).toBe(`${'0F'.repeat(45)}…[51 bytes]`)
  })

  it('prints structured values as JSON and values without a text form as a placeholder', () => {
    expect(formatCell({ years: 1, months: 2 }, { name: 'I', dbTypeName: 'INTERVAL YEAR TO MONTH' }, 100)).toBe('{"years":1,"months":2}')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(formatCell(cyclic, { name: 'O', dbTypeName: 'OBJECT' }, 100)).toBe('(value has no text form)')
    expect(formatCell(Symbol('s'), VARCHAR, 100)).toBe('(symbol value)')
  })
})

describe('textCell and counted', () => {
  it('bounds text the same way as fetched strings', () => {
    expect(textCell('line\nbreak', 100)).toBe('line\\nbreak')
    expect(textCell('y'.repeat(40), 32)).toBe(`${'y'.repeat(21)}…[40 chars]`)
  })

  it('chooses the noun by count', () => {
    expect(counted(0, 'row', 'rows')).toBe('0 rows')
    expect(counted(1, 'row', 'rows')).toBe('1 row')
    expect(counted(2, 'row', 'rows')).toBe('2 rows')
  })
})

describe('cut', () => {
  it('keeps short text and backs off a high surrogate at the cut', () => {
    expect(cut('abc', 3)).toBe('abc')
    expect(cut('abc', 2)).toBe('ab')
    expect(cut('a😀b', 2)).toBe('a')
    expect(cut('abc', 0)).toBe('')
  })
})

describe('fitText', () => {
  const tail = (total: number) => (shown: number) => (shown === total ? `${String(shown)} rows.` : `Showing ${String(shown)} of ${String(total)}.`)

  it('returns the complete text when it fits, including at the exact limit', () => {
    const text = fitText('H', ['a', 'b'], tail(2), 100)
    expect(text).toBe('H\na\nb\n2 rows.')
    expect(fitText('H', ['a', 'b'], tail(2), text.length)).toBe(text)
  })

  it('keeps the leading lines that fit beside the note for that count', () => {
    const body = ['1111', '2222', '3333', '4444']
    const text = fitText('HEAD', body, tail(4), 30)
    expect(text).toBe('HEAD\n1111\n2222\nShowing 2 of 4.')
    expect(text.length).toBeLessThanOrEqual(30)
    expect(fitText('HEAD', body, tail(4), 29)).toBe('HEAD\n1111\nShowing 1 of 4.')
  })

  it('drops an oversized single line and cuts a heading that alone is too long', () => {
    expect(fitText('HEAD', ['x'.repeat(100)], tail(1), 30)).toBe('HEAD\nShowing 0 of 1.')
    const text = fitText('H'.repeat(100), ['a'], tail(1), 30)
    expect(text).toBe(`${'H'.repeat(14)}\nShowing 0 of 1.`)
    expect(text).toHaveLength(30)
  })

  it('never exceeds the limit, even when the note alone is longer', () => {
    expect(fitText('H', ['a'], () => 'n'.repeat(50), 10)).toBe(`\n${'n'.repeat(9)}`)
  })
})
