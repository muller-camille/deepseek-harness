/** Bounded text rendering shared by the Kibana tools. @module */

import { isJsonObject, type JsonObject } from './wire.ts'

/** Note that ends an output cut at `maxOutputChars`. */
export const OUTPUT_TRUNCATED = '\n\n[Output truncated. Narrow the request to see the rest.]'

/** Move a cut before a high surrogate so that it never splits a surrogate pair. */
function cutPoint(text: string, at: number): number {
  const code = text.charCodeAt(at - 1)
  return code >= 0xD800 && code <= 0xDBFF ? at - 1 : at
}

/**
 * Bound one value to `max` UTF-16 code units, ending a shortened value with `…`.
 * @param text - the value.
 * @param max - the bound, at least 1.
 * @returns the value, or its prefix and `…` within `max` code units.
 */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, cutPoint(text, max - 1))}…`
}

/**
 * Bound a complete output to `max` UTF-16 code units, replacing its tail with `note`.
 * @param text - the complete output.
 * @param max - the bound; callers guarantee it exceeds the note's length.
 * @param note - the text that ends a shortened output.
 * @returns the output, or its prefix and `note` within `max` code units.
 */
export function capOutput(text: string, max: number, note: string = OUTPUT_TRUNCATED): string {
  return text.length <= max ? text : `${text.slice(0, cutPoint(text, max - note.length))}${note}`
}

/**
 * Join a heading and list lines, keeping as many whole lines as fit beside a footer that names
 * what was left out.
 * @param head - the first line.
 * @param lines - the list lines in display order.
 * @param max - the bound on the complete output.
 * @param footer - the closing line for a list cut after `shown` lines.
 * @returns the bounded output.
 */
export function fitLines(head: string, lines: readonly string[], max: number, footer: (shown: number) => string): string {
  const full = [head, ...lines].join('\n')
  if (full.length <= max) return full
  let length = head.length
  let shown = 0
  for (const line of lines) {
    if (length + line.length + footer(shown + 1).length + 2 > max) break
    length += line.length + 1
    shown += 1
  }
  return capOutput([head, ...lines.slice(0, shown), footer(shown)].join('\n'), max)
}

/**
 * Put a value on one line by writing its line breaks as `\n`.
 * @param text - the value.
 * @returns the single-line value.
 */
export function oneLine(text: string): string {
  return text.replace(/\r\n?|\n/gu, '\\n')
}

function scalarText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(item => typeof item === 'string' ? item : JSON.stringify(item)).join(', ')
  return JSON.stringify(value)
}

/**
 * Flatten a document into dotted field names and display values: nested objects become dotted
 * names and arrays join their items with `, `.
 * @param document - a document `_source`.
 * @param prefix - the dotted name of `document` inside its parent.
 * @returns the fields in document order.
 */
export function flattenFields(document: JsonObject, prefix = ''): Array<readonly [string, string]> {
  const fields: Array<readonly [string, string]> = []
  for (const [key, value] of Object.entries(document)) {
    const name = prefix === '' ? key : `${prefix}.${key}`
    if (isJsonObject(value) && Object.keys(value).length > 0) fields.push(...flattenFields(value, name))
    else fields.push([name, scalarText(value)])
  }
  return fields
}
