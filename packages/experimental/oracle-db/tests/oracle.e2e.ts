/**
 * The Oracle tools against a real database through node-oracledb Thin mode. Opt in with
 * DSH_ORACLE_E2E_CONNECT (an Easy Connect string), DSH_ORACLE_E2E_USER, and DSH_ORACLE_E2E_PASSWORD.
 * The user's schema holds DEPARTMENTS(DEPARTMENT_ID NUMBER PRIMARY KEY, NAME VARCHAR2) and
 * EMPLOYEES(EMPLOYEE_ID NUMBER PRIMARY KEY, NAME VARCHAR2, DEPARTMENT_ID NUMBER, SALARY NUMBER, HIRED DATE).
 */

import { createRequire } from 'node:module'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { OracleDriver } from '../src/driver.ts'
import * as Plugin from '../src/index.ts'

const connectString = process.env.DSH_ORACLE_E2E_CONNECT ?? ''
const user = process.env.DSH_ORACLE_E2E_USER ?? ''
const enabled = connectString !== ''

let ctx: Context

beforeAll(async () => {
  if (!enabled) return
  ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  // No credentials service is mounted, so the password comes from this process's environment.
  await ctx.plugin(Plugin, { connectString, user, passwordEnv: 'DSH_ORACLE_E2E_PASSWORD' })
})

afterAll(async () => {
  if (enabled) await ctx.fiber.dispose()
})

function call(name: string, args: unknown) {
  return executeToolFixture(ctx, { name, arguments: args, callId: brandString<ToolCallId>(`e2e-${name}`), signal: new AbortController().signal })
}

async function text(name: string, args: unknown): Promise<string> {
  const result = await call(name, args)
  expect(result.error).toBeUndefined()
  return result.content.map(block => ('text' in block ? block.text : '')).join('')
}

/** Count employees over a separate session, outside the plugin under test. */
async function countEmployees(): Promise<unknown> {
  // The ambient `oracledb` declaration belongs to the package source; the test loads the driver through require.
  const driver = createRequire(import.meta.url)('oracledb') as OracleDriver
  const pool = await driver.createPool({
    user, password: process.env.DSH_ORACLE_E2E_PASSWORD ?? '', connectString, poolMin: 0, poolMax: 1, poolIncrement: 1,
  })
  try {
    const connection = await pool.getConnection()
    try {
      return (await connection.execute('SELECT COUNT(*) FROM employees')).rows?.[0]?.[0]
    } finally {
      await connection.release()
    }
  } finally {
    await pool.close(0)
  }
}

it.skipIf(!enabled)('browses the schema, joins tables, refuses writes, and leaves the data unchanged', { timeout: 120_000 }, async () => {
  const before = await countEmployees()
  expect(typeof before).toBe('number')

  const listing = await text('oracle_schema', {})
  expect(listing).toMatch(/^DEPARTMENTS\tTABLE\t/mu)
  expect(listing).toMatch(/^EMPLOYEES\tTABLE\t/mu)
  expect(await text('oracle_schema', { name_filter: 'emp%' })).not.toMatch(/^DEPARTMENTS\t/mu)

  const columns = await text('oracle_schema', { table: 'employees' })
  expect(columns).toMatch(/^TABLE [^\n]+\.EMPLOYEES\n/u)
  expect(columns).toContain('\nPrimary key: EMPLOYEE_ID\n')
  expect(columns).toMatch(/^EMPLOYEE_ID\tNUMBER[^\t]*\tN\t/mu)
  expect(columns).toMatch(/^NAME\tVARCHAR2\(\d+( CHAR)?\)\t[YN]\t/mu)
  expect(columns).toMatch(/^DEPARTMENT_ID\tNUMBER/mu)
  expect(columns).toMatch(/^SALARY\tNUMBER/mu)
  expect(columns).toMatch(/^HIRED\tDATE\t/mu)
  expect(columns).toMatch(/\n\n5 columns\.$/u)

  const join = await text('oracle_query', {
    sql: 'SELECT d.name AS department, COUNT(e.employee_id) AS staff FROM departments d LEFT JOIN employees e ON e.department_id = d.department_id GROUP BY d.name ORDER BY d.name;',
  })
  expect(join.split('\n')[0]).toBe('DEPARTMENT\tSTAFF')
  expect(join).toMatch(/\n\n\d+ rows?\.$/u)
  const hired = await text('oracle_query', { sql: 'SELECT hired FROM employees WHERE hired IS NOT NULL FETCH FIRST 1 ROWS ONLY' })
  expect(hired).toMatch(/^HIRED\n\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\n\n1 row\.$/u)

  for (const sql of ['DELETE FROM employees', 'SELECT * FROM employees FOR UPDATE']) {
    expect((await call('oracle_query', { sql })).error?.info).toEqual({ name: 'OracleDbError', code: 'ORACLE_READ_ONLY' })
  }
  expect((await call('oracle_query', { sql: 'SELECT * FROM dsh_e2e_no_such_table' })).error?.info).toEqual({ name: 'OracleDbError', code: 'ORACLE_QUERY_FAILED' })
  expect(await countEmployees()).toBe(before)
})
