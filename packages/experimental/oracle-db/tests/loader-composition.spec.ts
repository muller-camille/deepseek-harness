/**
 * A real Loader and AgentLoop drive the Oracle tools from cordis.yml. Only node-oracledb, the external
 * database client, is replaced by the scripted fake; the plugin entry, its configuration, and the
 * credential lookup run as shipped.
 */

import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import LlmRuntime, { LlmAdapter, type ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { type SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as Plugin from '../src/index.ts'
import { table } from './fake-oracle.ts'

const oracle = await vi.hoisted(async () => {
  const { FakeOracle } = await import('./fake-oracle.ts')
  return new FakeOracle()
})
vi.mock('oracledb', () => ({ default: oracle }))

/** Lists the schema, runs a join, tries a DELETE, then answers. */
class AnalystModel extends LlmAdapter {
  requests: GenerateOptions[] = []
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const calls = [
      { name: 'oracle_schema', arguments: '{}' },
      { name: 'oracle_query', arguments: JSON.stringify({ sql: 'SELECT d.name, COUNT(*) AS staff FROM employees e JOIN departments d ON d.department_id = e.department_id GROUP BY d.name ORDER BY d.name' }) },
      { name: 'oracle_query', arguments: JSON.stringify({ sql: 'DELETE FROM employees' }) },
    ]
    const call = calls[this.requests.length - 1]
    if (call !== undefined) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: brandString<ToolCallId>(`call-${String(this.requests.length)}`), ...call } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Sales has 2 people and Support has 1.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

let ctx: Context | undefined
let root: string | undefined
afterEach(async () => {
  await ctx?.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  ctx = undefined
  root = undefined
  oracle.reset()
})

it('loads the Oracle tools from cordis.yml and logs read-only results the model reads', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-oracle-db-composition-'))
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-tool-executor-native', NativeToolExecutor],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-oracle-db', Plugin],
  ])
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    ...[...modules.keys()].filter(name => name !== '@deepseek-ai/dsh-oracle-db').map(name => `- name: '${name}'`),
    '- name: \'@deepseek-ai/dsh-oracle-db\'',
    '  config:',
    '    connectString: dbhost:1521/ORCLPDB1',
    '    user: reporter',
    '    passwordEnv: ORACLE_REPORTER_PASSWORD',
    '    queryTimeoutMs: 15000',
  ].join('\n') + '\n')
  const context = ctx = new Context()
  context.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([{ source: 'process', values: { ORACLE_REPORTER_PASSWORD: 'from-launch-env' } }]))
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected fixture module: ${specifier}`)
      return modules.get(specifier)
    },
  } as never
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  for (const entry of context.loader.entries()) await entry.fiber?.await()

  oracle.respond = ({ sql }) => {
    if (sql.includes('FROM all_users')) return table(['USERNAME'], [['HR']])
    if (sql.includes('FROM all_tables')) return table(['NAME', 'KIND', 'COMMENTS'], [['DEPARTMENTS', 'TABLE', 'Company departments'], ['EMPLOYEES', 'TABLE', null]])
    return table(['NAME', 'STAFF:NUMBER'], [['Sales', '2'], ['Support', '1']])
  }
  const model = new AnalystModel()
  context.llm.registerAdapter(['fixture'], model)
  const agent = await context.agentLoop.create(brandString<SessionId>('oracle-db-loader'), { provider: 'fixture', model: 'fixture' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'How many people work in each department?' }], source: { kind: 'user' } }))
  await agent.whenIdle()

  expect(model.requests).toHaveLength(4)
  expect(model.requests[0]?.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining(['oracle_schema', 'oracle_query']))
  expect(JSON.stringify(model.requests[0]?.messages)).toContain('oracle_schema and oracle_query give read-only access to the user\'s Oracle database.')
  const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result').map(event => JSON.stringify(event.data))
  expect(results).toEqual([
    expect.stringContaining(JSON.stringify('Tables and views in schema HR:\nNAME\tTYPE\tCOMMENT\nDEPARTMENTS\tTABLE\tCompany departments\nEMPLOYEES\tTABLE\t\n\n2 objects.')),
    expect.stringContaining(JSON.stringify('NAME\tSTAFF\nSales\t2\nSupport\t1\n\n2 rows.')),
    expect.stringMatching(/"name":"OracleDbError","code":"ORACLE_READ_ONLY"/u),
  ])
  expect(JSON.stringify(model.requests[3]?.messages)).toContain('oracle_query refused the SQL: it starts with DELETE, not SELECT or WITH.')

  expect(oracle.pools.map(pool => pool.attributes)).toEqual([{
    user: 'reporter', password: 'from-launch-env', connectString: 'dbhost:1521/ORCLPDB1', poolMin: 0, poolMax: 2, poolIncrement: 1,
  }])
  expect(oracle.statements.some(sql => sql.startsWith('DELETE'))).toBe(false)
  for (const connection of oracle.connections) {
    expect(connection.log[0]).toBe('SET TRANSACTION READ ONLY')
    expect(connection.log.slice(-2)).toEqual(['ROLLBACK', 'RELEASE'])
    expect(connection.callTimeout).toBe(15_000)
  }

  await context.fiber.dispose()
  ctx = undefined
  expect(oracle.pools[0]?.closedWith).toBe(0)
})
