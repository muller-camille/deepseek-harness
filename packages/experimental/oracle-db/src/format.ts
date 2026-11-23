/** Model-facing text for fetched values, and the character bound applied to each complete tool result. @module */

import type { OracleColumn } from './driver.ts'

/** Oracle types whose values node-oracledb returns as UTC instants rather than wall-clock times. */
const ZONED_TYPES: ReadonlySet<string> = new Set(['TIMESTAMP WITH TIME ZONE', 'TIMESTAMP WITH LOCAL TIME ZONE'])

/**
 * The first `length` UTF-16 units of `text`, one shorter when the cut would split a surrogate pair.
 * @param text - the text to shorten.
 * @param length - the most units to keep.
 * @returns `text` itself when it already fits, otherwise its prefix.
 */
export function cut(text: string, length: number): string {
  if (text.length <= length) return text
  const last = text.charCodeAt(length - 1)
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? length - 1 : length)
}

/**
 * Keep a value on one line: line breaks become `\n` and tabs become `\t`, so cells stay tab-separated.
 * @param text - the value's text.
 * @returns the text without line breaks or tabs.
 */
function singleLine(text: string): string {
  return text.replace(/\r\n|\r|\n/gu, '\\n').replace(/\t/gu, '\\t')
}

/**
 * Bound one cell, ending a shortened cell with a marker that states the original size.
 * @param text - the single-line cell text.
 * @param maxChars - the most characters the cell may take, marker included.
 * @param size - the original size for the marker, such as `5000 chars`.
 * @returns the cell, at most `maxChars` long.
 */
function boundCell(text: string, maxChars: number, size: string): string {
  if (text.length <= maxChars) return text
  const marker = `…[${size}]`
  return cut(text, Math.max(0, maxChars - marker.length)) + marker
}

/**
 * Two-digit (or wider) zero-padded number.
 * @param value - the number.
 * @param width - the minimum digit count.
 * @returns the padded digits.
 */
function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

/**
 * ISO 8601 text of a date. node-oracledb builds DATE and TIMESTAMP values in the process's local time
 * zone, so their local fields are the stored wall-clock time; zoned types are instants and print in UTC.
 * @param date - the fetched value.
 * @param column - the column it came from.
 * @returns `YYYY-MM-DDTHH:MM:SS[.mmm]`, with `Z` for zoned types.
 */
function dateText(date: Date, column: OracleColumn): string {
  if (ZONED_TYPES.has(column.dbTypeName)) return date.toISOString()
  const text = `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  return date.getMilliseconds() === 0 ? text : `${text}.${pad(date.getMilliseconds(), 3)}`
}

/**
 * Uppercase hexadecimal of binary data, the form `RAWTOHEX` prints, bounded without encoding more than needed.
 * @param bytes - RAW, LONG RAW, or BLOB data.
 * @param maxChars - the most characters the cell may take.
 * @returns the bounded hex text.
 */
function hexText(bytes: Uint8Array, maxChars: number): string {
  const encoded = Buffer.from(bytes.subarray(0, Math.floor(maxChars / 2) + 1)).toString('hex').toUpperCase()
  return bytes.length * 2 <= maxChars ? encoded : boundCell(encoded, maxChars, `${String(bytes.length)} bytes`)
}

/**
 * JSON text of a structured value such as JSON, INTERVAL, or object-type data.
 * @param value - the fetched value.
 * @returns its JSON text, or a placeholder when it has none.
 */
function objectText(value: object): string {
  try {
    return JSON.stringify(value)
  } catch (_unserializable) {
    // Cyclic driver objects have no JSON form; the placeholder keeps the row readable.
    return '(value has no text form)'
  }
}

/**
 * A text value as a single-line, bounded table cell.
 * @param text - the value's text.
 * @param maxChars - the most characters the cell may take.
 * @returns the cell text, at most `maxChars` long.
 */
export function textCell(text: string, maxChars: number): string {
  return boundCell(singleLine(text), maxChars, `${String(text.length)} chars`)
}

/**
 * A count with its noun, such as `1 row` or `3 rows`.
 * @param count - the number of items.
 * @param singular - the noun for one item.
 * @param plural - the noun for any other count.
 * @returns the count and noun.
 */
export function counted(count: number, singular: string, plural: string): string {
  return `${String(count)} ${count === 1 ? singular : plural}`
}

/**
 * One fetched value as a single-line table cell. SQL NULL prints as `NULL`.
 * @param value - the value node-oracledb returned, after the plugin's fetch conversions.
 * @param column - the column it came from.
 * @param maxChars - the most characters the cell may take.
 * @returns the cell text, at most `maxChars` long.
 */
export function formatCell(value: unknown, column: OracleColumn, maxChars: number): string {
  if (value === null || value === undefined) return 'NULL'
  if (value instanceof Uint8Array) return hexText(value, maxChars)
  if (value instanceof Date) return dateText(value, column)
  const text = typeof value === 'string' ? value
    : typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean' ? String(value)
      : typeof value === 'object' ? objectText(value) : `(${typeof value} value)`
  return textCell(text, maxChars)
}

/**
 * Join a heading, body lines, and a closing note so the whole text fits `maxChars`. When it does not,
 * the text keeps as many leading body lines as fit beside the closing note for that count, and a
 * heading that alone is too long is cut.
 * @param head - text before the body, possibly several lines.
 * @param body - lines that may be dropped from the end.
 * @param tail - the closing note for the number of body lines kept.
 * @param maxChars - the most characters the complete text may take.
 * @returns the bounded text.
 */
export function fitText(head: string, body: readonly string[], tail: (shown: number) => string, maxChars: number): string {
  const complete = [head, ...body, tail(body.length)].join('\n')
  if (complete.length <= maxChars) return complete
  let shown = 0
  let used = head.length
  for (const line of body.slice(0, -1)) {
    if (used + line.length + 1 + 1 + tail(shown + 1).length > maxChars) break
    used += line.length + 1
    shown += 1
  }
  const closing = tail(shown)
  const top = cut(head, Math.max(0, maxChars - (used - head.length) - 1 - closing.length))
  return cut([top, ...body.slice(0, shown), closing].join('\n'), maxChars)
}
