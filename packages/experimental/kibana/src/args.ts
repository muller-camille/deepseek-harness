/** Argument checks that keep every Elasticsearch request on the path the tool chose. @module */

import { ToolArgsError } from '@deepseek-ai/dsh-tools'

/** Index refusals in check order: each test and the violation it reports. */
const INDEX_RULES: ReadonlyArray<readonly [(index: string) => boolean, string]> = [
  [index => index === '', 'index must not be empty'],
  [index => /[\s\p{Cc}/\\?#"<>|%]/u.test(index), 'index must not contain whitespace or any of / \\ ? # " < > | %'],
  [index => /^[_+-]/u.test(index), 'index must not start with _, -, or +'],
  [index => index.split(',').some(item => item === '' || /^[_+]/u.test(item)), 'each comma-separated index must be non-empty and must not start with _ or +'],
  [index => index.includes('..'), 'index must not contain ..'],
]

/**
 * Validate an index argument, which becomes the first segment of an Elasticsearch path. Wildcards
 * `*`, comma-separated lists, `cluster:index` names, and `.` are allowed. Path, query, and URL
 * escape syntax, a leading `_`, `-`, or `+`, an empty list item, an item starting with `_` or
 * `+`, and `..` are refused, so the path cannot leave `<index>/_search` or `<index>/_field_caps`.
 * @param index - the model's index pattern, such as `logs-*` or `logs-*,metrics-*`.
 * @returns the index unchanged.
 * @throws ToolArgsError when the index is refused.
 */
export function checkIndex(index: string): string {
  const refusal = INDEX_RULES.find(([refuses]) => refuses(index))?.[1]
  if (refusal !== undefined) throw new ToolArgsError([`${refusal}; pass an index pattern such as logs-* from kibana_data_views`])
  return index
}

/**
 * Require a non-blank string argument.
 * @param name - the argument name.
 * @param value - the argument, when given.
 * @returns the argument, or `undefined` when absent.
 * @throws ToolArgsError when the argument is blank.
 */
export function optionalText(name: string, value: string | undefined): string | undefined {
  if (value !== undefined && value.trim() === '') throw new ToolArgsError([`${name} must not be blank; omit it instead`])
  return value
}

/**
 * Treat a blank optional text argument as omitted.
 * @param value - the argument, when given.
 * @returns the argument, or `undefined` when absent or blank.
 */
export function nonBlank(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value
}
