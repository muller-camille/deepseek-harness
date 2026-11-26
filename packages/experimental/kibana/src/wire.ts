/**
 * Readers for the untrusted JSON that Kibana and Elasticsearch return. Every failure is a
 * `KIBANA_BAD_RESPONSE` that names the response and the JSON path that did not match.
 * @module
 */

import type { InferValue } from '@deepseek-ai/dsh-tools'
import { KibanaError } from './error.ts'

/** One lossless JSON value, as tool output schemas declare it. */
export type Json = InferValue<{ readonly type: 'json' }>

/** One JSON object whose members are not yet validated. */
export type JsonObject = { readonly [key: string]: unknown }

/**
 * Whether a value is a JSON object rather than an array or a scalar.
 * @param value - the candidate.
 * @returns true for a non-null, non-array object.
 */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse a response body without throwing.
 * @param text - the body text.
 * @returns the parsed value, or `undefined` when the text is not JSON.
 */
export function parseJsonText(text: string): { readonly value: unknown } | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return { value }
  } catch (_notJson) {
    return undefined
  }
}

/** Validating reader for one response; `source` names the response in failure messages. */
export class WireReader {
  /**
   * @param source - what the response answers, such as `the data view list`.
   */
  constructor(private readonly source: string) {}

  /**
   * Fail validation at one path.
   * @param path - JSON path of the mismatching value, such as `$.saved_objects[0].id`.
   * @param expected - what the value should have been.
   * @returns never; always throws.
   */
  fail(path: string, expected: string): never {
    throw new KibanaError(
      `Kibana returned an unexpected response for ${this.source}: ${path} is not ${expected}. Check that the kibana plugin's url points at Kibana 7.10 or later, including any base path.`,
      'KIBANA_BAD_RESPONSE',
    )
  }

  /**
   * Require a JSON object.
   * @param value - the candidate.
   * @param path - its JSON path.
   * @returns the value as an object.
   */
  object(value: unknown, path: string): JsonObject {
    return isJsonObject(value) ? value : this.fail(path, 'an object')
  }

  /**
   * Require a JSON object or its absence.
   * @param value - the candidate; absent and `null` read as undefined.
   * @param path - its JSON path.
   * @returns the object, or undefined when absent.
   */
  optionalObject(value: unknown, path: string): JsonObject | undefined {
    return value === undefined || value === null ? undefined : this.object(value, path)
  }

  /**
   * Require a JSON array.
   * @param value - the candidate.
   * @param path - its JSON path.
   * @returns the value as an array.
   */
  array(value: unknown, path: string): readonly unknown[] {
    return Array.isArray(value) ? value : this.fail(path, 'an array')
  }

  /**
   * Require a JSON array or its absence.
   * @param value - the candidate; absent and `null` read as an empty array.
   * @param path - its JSON path.
   * @returns the array, or an empty array when absent.
   */
  optionalArray(value: unknown, path: string): readonly unknown[] {
    return value === undefined || value === null ? [] : this.array(value, path)
  }

  /**
   * Require a string.
   * @param value - the candidate.
   * @param path - its JSON path.
   * @returns the value as a string.
   */
  string(value: unknown, path: string): string {
    return typeof value === 'string' ? value : this.fail(path, 'a string')
  }

  /**
   * Require a string or its absence.
   * @param value - the candidate; absent and `null` read as undefined.
   * @param path - its JSON path.
   * @returns the string, or undefined when absent.
   */
  optionalString(value: unknown, path: string): string | undefined {
    return value === undefined || value === null ? undefined : this.string(value, path)
  }

  /**
   * Require a count: a non-negative safe integer.
   * @param value - the candidate.
   * @param path - its JSON path.
   * @returns the value as a non-negative integer.
   */
  count(value: unknown, path: string): number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : this.fail(path, 'a non-negative integer')
  }

  /**
   * Require a boolean.
   * @param value - the candidate.
   * @param path - its JSON path.
   * @returns the value as a boolean.
   */
  boolean(value: unknown, path: string): boolean {
    return typeof value === 'boolean' ? value : this.fail(path, 'a boolean')
  }

  /**
   * Parse a JSON document that Kibana stores as a string attribute.
   * @param value - the attribute value.
   * @param path - its JSON path.
   * @returns the parsed value.
   */
  embedded(value: unknown, path: string): unknown {
    const parsed = parseJsonText(this.string(value, path))
    return parsed === undefined ? this.fail(path, 'a JSON document') : parsed.value
  }

  /**
   * Copy a parsed value as lossless JSON.
   * @param value - the candidate.
   * @param path - its JSON path.
   * @returns the JSON value.
   */
  json(value: unknown, path: string): Json {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (Array.isArray(value)) return value.map((item, index) => this.json(item, `${path}[${String(index)}]`))
    if (isJsonObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.json(item, `${path}.${key}`)]))
    return this.fail(path, 'JSON data')
  }
}
