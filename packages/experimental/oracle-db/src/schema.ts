/**
 * Data-dictionary queries behind `oracle_schema`. Every name the model passes travels as a bind value,
 * and a name matches either exactly or in uppercase, preferring the exact match, because Oracle stores
 * unquoted identifiers in uppercase.
 * @module
 */

import type { OracleClient } from './client.ts'
import { counted, fitText, textCell } from './format.ts'

/** Size limits owned by the plugin configuration. */
export interface SchemaLimits {
  /** Most tables and views one listing returns. */
  readonly maxRows: number
  /** Most characters one name, type, or comment cell takes. */
  readonly maxCellChars: number
  /** Most characters the complete result takes. */
  readonly maxOutputChars: number
}

/** The `oracle_schema` arguments. */
export interface SchemaRequest {
  /** Schema to inspect; the session's current schema when absent. */
  readonly owner?: string
  /** Table or view to describe; absent to list the schema's tables and views. */
  readonly table?: string
  /** Case-insensitive SQL LIKE pattern that limits a listing. */
  readonly nameFilter?: string
}

/** Oracle's largest column count for one table (23ai with `MAX_COLUMNS = EXTENDED`), so a description fetches every column. */
const MAX_TABLE_COLUMNS = 4096

const CURRENT_SCHEMA_SQL = 'SELECT username FROM all_users WHERE username = SYS_CONTEXT(\'USERENV\', \'CURRENT_SCHEMA\')'

const NAMED_SCHEMA_SQL = `SELECT username FROM all_users
WHERE username IN (:name, UPPER(:name))
ORDER BY CASE WHEN username = :name THEN 0 ELSE 1 END`

const OBJECTS_SQL = `SELECT o.name, o.kind, c.comments
FROM (
  SELECT table_name AS name, 'TABLE' AS kind FROM all_tables WHERE owner = :owner AND NVL(dropped, 'NO') = 'NO'
  UNION ALL
  SELECT view_name, 'VIEW' FROM all_views WHERE owner = :owner
) o
LEFT JOIN all_tab_comments c ON c.owner = :owner AND c.table_name = o.name`

const OBJECT_SQL = `SELECT table_name, table_type, comments FROM all_tab_comments
WHERE owner = :owner AND table_name IN (:name, UPPER(:name))
ORDER BY CASE WHEN table_name = :name THEN 0 ELSE 1 END`

const COLUMNS_SQL = `SELECT c.column_name, c.data_type, c.char_length, c.char_used, c.data_length, c.data_precision, c.data_scale, c.nullable, m.comments
FROM all_tab_columns c
LEFT JOIN all_col_comments m ON m.owner = c.owner AND m.table_name = c.table_name AND m.column_name = c.column_name
WHERE c.owner = :owner AND c.table_name = :name
ORDER BY c.column_id`

const PRIMARY_KEY_SQL = `SELECT k.column_name
FROM all_constraints p
JOIN all_cons_columns k ON k.owner = p.owner AND k.constraint_name = p.constraint_name AND k.table_name = p.table_name
WHERE p.owner = :owner AND p.table_name = :name AND p.constraint_type = 'P'
ORDER BY k.position`

/**
 * The text of one dictionary value; the plugin fetches NUMBER values as strings.
 * @param row - a fetched row, or `undefined` when the query returned none.
 * @param index - the column position.
 * @returns the value, or an empty string for NULL or a missing row.
 */
function text(row: readonly unknown[] | undefined, index: number): string {
  const value = row?.[index]
  return typeof value === 'string' ? value : ''
}

/**
 * A column's declared type as DDL writes it, such as `VARCHAR2(100 CHAR)` or `NUMBER(10,2)`.
 * @param row - one row of {@link COLUMNS_SQL}.
 * @returns the type text.
 */
function columnType(row: readonly unknown[]): string {
  const type = text(row, 1)
  const precision = text(row, 5)
  const scale = text(row, 6)
  switch (type) {
    case 'CHAR':
    case 'VARCHAR2':
      return `${type}(${text(row, 2)}${text(row, 3) === 'C' ? ' CHAR' : ''})`
    case 'NCHAR':
    case 'NVARCHAR2':
      return `${type}(${text(row, 2)})`
    case 'RAW':
      return `RAW(${text(row, 4)})`
    case 'NUMBER':
      if (precision === '') return scale === '' ? 'NUMBER' : `NUMBER(*,${scale})`
      return scale === '' || scale === '0' ? `NUMBER(${precision})` : `NUMBER(${precision},${scale})`
    case 'FLOAT':
      return precision === '' ? 'FLOAT' : `FLOAT(${precision})`
    default:
      return type
  }
}

/**
 * Resolve the schema to inspect.
 * @param client - the query runner.
 * @param owner - the requested schema, or `undefined` for the current schema.
 * @param signal - the tool call's cancellation.
 * @returns the schema name as stored, or an empty string when none matches.
 */
async function resolveOwner(client: OracleClient, owner: string | undefined, signal: AbortSignal): Promise<string> {
  const found = owner === undefined
    ? await client.select(CURRENT_SCHEMA_SQL, { maxRows: 1 }, signal)
    : await client.select(NAMED_SCHEMA_SQL, { binds: { name: owner }, maxRows: 1 }, signal)
  return text(found.rows[0], 0)
}

/**
 * List the tables and views of one schema.
 * @param client - the query runner.
 * @param owner - the resolved schema.
 * @param nameFilter - optional case-insensitive LIKE pattern.
 * @param limits - row, cell, and output limits.
 * @param signal - the tool call's cancellation.
 * @returns the listing text.
 */
async function listObjects(
  client: OracleClient, owner: string, nameFilter: string | undefined, limits: SchemaLimits, signal: AbortSignal,
): Promise<string> {
  const sql = nameFilter === undefined
    ? `${OBJECTS_SQL}\nORDER BY o.name`
    : `${OBJECTS_SQL}\nWHERE UPPER(o.name) LIKE UPPER(:filter)\nORDER BY o.name`
  const binds = nameFilter === undefined ? { owner } : { owner, filter: nameFilter }
  const found = await client.select(sql, { binds, maxRows: limits.maxRows + 1 }, signal)
  const objects = found.rows.slice(0, limits.maxRows)
  if (objects.length === 0) {
    return nameFilter === undefined
      ? `Schema ${owner} has no tables or views visible to this account.`
      : `No table or view in schema ${owner} matches ${nameFilter}.`
  }
  const head = `Tables and views in schema ${owner}${nameFilter === undefined ? '' : ` matching ${nameFilter}`}:\nNAME\tTYPE\tCOMMENT`
  const body = objects.map(row => [textCell(text(row, 0), limits.maxCellChars), text(row, 1), textCell(text(row, 2), limits.maxCellChars)].join('\t'))
  const more = found.rows.length > limits.maxRows
  return fitText(head, body, (shown) => {
    const count = shown === body.length
      ? `${counted(shown, 'object', 'objects')}.`
      : `Output truncated to ${String(shown)} of ${String(body.length)} objects at ${String(limits.maxOutputChars)} characters; pass name_filter to narrow the list.`
    return more ? `\n${count} More tables and views exist; pass name_filter to narrow the list (limit ${String(limits.maxRows)}).` : `\n${count}`
  }, limits.maxOutputChars)
}

/**
 * Describe one table or view: its comment, primary key, and columns.
 * @param client - the query runner.
 * @param owner - the resolved schema.
 * @param table - the requested table or view name.
 * @param limits - cell and output limits.
 * @param signal - the tool call's cancellation.
 * @returns the description text.
 */
async function describeObject(
  client: OracleClient, owner: string, table: string, limits: SchemaLimits, signal: AbortSignal,
): Promise<string> {
  const found = await client.select(OBJECT_SQL, { binds: { owner, name: table }, maxRows: 1 }, signal)
  const object = found.rows[0]
  if (object === undefined) return `No table or view named ${table} in schema ${owner}. Call oracle_schema without table to list them.`
  const binds = { owner, name: text(object, 0) }
  const columns = await client.select(COLUMNS_SQL, { binds, maxRows: MAX_TABLE_COLUMNS }, signal)
  const keys = await client.select(PRIMARY_KEY_SQL, { binds, maxRows: MAX_TABLE_COLUMNS }, signal)
  const comment = text(object, 2)
  const head = [
    `${text(object, 1)} ${owner}.${binds.name}`,
    ...comment === '' ? [] : [`Comment: ${textCell(comment, limits.maxCellChars)}`],
    `Primary key: ${keys.rows.length === 0 ? 'none' : keys.rows.map(row => text(row, 0)).join(', ')}`,
    'COLUMN\tTYPE\tNULLABLE\tCOMMENT',
  ].join('\n')
  const body = columns.rows.map(row => [
    textCell(text(row, 0), limits.maxCellChars), columnType(row), text(row, 7), textCell(text(row, 8), limits.maxCellChars),
  ].join('\t'))
  return fitText(head, body, shown => (shown === body.length
    ? `\n${counted(shown, 'column', 'columns')}.`
    : `\nOutput truncated to ${String(shown)} of ${String(body.length)} columns at ${String(limits.maxOutputChars)} characters.`), limits.maxOutputChars)
}

/**
 * Answer one `oracle_schema` request: list a schema's tables and views, or describe one of them.
 * A schema or object that does not exist yields an explanatory text rather than an error.
 * @param client - the query runner.
 * @param request - the tool arguments.
 * @param limits - row, cell, and output limits.
 * @param signal - the tool call's cancellation.
 * @returns the model-facing text.
 */
export async function inspectSchema(
  client: OracleClient, request: SchemaRequest, limits: SchemaLimits, signal: AbortSignal,
): Promise<string> {
  const owner = await resolveOwner(client, request.owner, signal)
  if (owner === '') {
    return request.owner === undefined
      ? 'The current schema is not visible to this account. Pass owner to choose a schema.'
      : `No schema named ${request.owner} is visible to this account.`
  }
  return request.table === undefined
    ? listObjects(client, owner, request.nameFilter, limits, signal)
    : describeObject(client, owner, request.table, limits, signal)
}
