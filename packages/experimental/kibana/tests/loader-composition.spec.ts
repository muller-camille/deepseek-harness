/** A real Loader and AgentLoop drive the Kibana tools against a fake Kibana 8.15 over HTTP, with a scripted model. */

import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
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
import * as Kibana from '../src/index.ts'
import { GUIDANCE, KIBANA_TOOL_NAMES } from '../src/tools.ts'
import { FakeKibana } from './fake-kibana.ts'
import { BASIC, defaultRoutes } from './harness.ts'

class LogReadingModel extends LlmAdapter {
  requests: GenerateOptions[] = []
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const calls = [
      { name: 'kibana_data_views', arguments: '{"search":"app logs"}' },
      { name: 'kibana_search', arguments: '{"index":"app-logs-*","query":"level:error","from":"now-7d","size":0,"aggregations":{"by_service":{"terms":{"field":"service"}}}}' },
    ]
    const call = calls[this.requests.length - 1]
    if (call !== undefined) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: brandString<ToolCallId>(`call-${String(this.requests.length)}`), ...call } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'api and billing each logged one error.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

let ctx: Context | undefined
let root: string | undefined
let kibana: FakeKibana | undefined
afterEach(async () => {
  await ctx?.fiber.dispose()
  await kibana?.close()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  ctx = undefined
  root = undefined
  kibana = undefined
})

it('loads the plugin from cordis.yml and logs the Kibana results the model reads', async () => {
  const server = kibana = await FakeKibana.start(defaultRoutes())
  root = await mkdtemp(join(tmpdir(), 'dsh-kibana-composition-'))
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-tool-executor-native', NativeToolExecutor],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-kibana', Kibana],
  ])
  const configPath = join(root, 'cordis.yml')
  const entries = [...modules.keys()].map(name => name === '@deepseek-ai/dsh-kibana'
    ? `- name: '${name}'\n  config:\n    url: '${server.url}'\n    username: elastic`
    : `- name: '${name}'`)
  await writeFile(configPath, `${entries.join('\n')}\n`)
  const context = ctx = new Context()
  context.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([{ source: 'process', values: { KIBANA_PASSWORD: 'changeme' } }]))
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

  const model = new LogReadingModel()
  context.llm.registerAdapter(['fixture'], model)
  const agent = await context.agentLoop.create(brandString<SessionId>('kibana-loader'), { provider: 'fixture', model: 'fixture' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Which services logged errors this week?' }], source: { kind: 'user' } }))
  await agent.whenIdle()

  expect(model.requests).toHaveLength(3)
  expect(model.requests[0]?.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining([...KIBANA_TOOL_NAMES]))
  expect(JSON.stringify(model.requests[0]?.messages[0])).toContain(JSON.stringify(GUIDANCE).slice(1, -1))
  expect(server.requests.map(request => [request.method, request.url, request.headers.authorization, request.headers['kbn-xsrf']])).toEqual([
    ['GET', '/api/saved_objects/_find?type=index-pattern&per_page=100&fields=title&fields=name&fields=timeFieldName&search_fields=title&search=app*+logs*&default_search_operator=AND', BASIC, 'true'],
    ['GET', '/api/saved_objects/_find?type=index-pattern&per_page=100&fields=title&fields=timeFieldName&search_fields=title&search=app*+logs*&default_search_operator=AND', BASIC, 'true'],
    ['POST', '/api/console/proxy?path=app-logs-*%2F_search&method=POST', BASIC, 'true'],
  ])
  expect(JSON.parse(server.requests[2]?.body ?? '')).toEqual({
    size: 0,
    track_total_hits: true,
    query: { bool: { filter: [{ range: { '@timestamp': { gte: 'now-7d', lte: 'now' } } }, { query_string: { query: 'level:error' } }] } },
    sort: [{ '@timestamp': { order: 'desc' } }],
    aggs: { by_service: { terms: { field: 'service' } } },
  })
  const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
  expect(results.map(event => JSON.stringify(event.data))).toEqual([
    expect.stringContaining(JSON.stringify('1 data views matching "app logs":\n- app-logs-*  time field: @timestamp  id: logs-dv  name: App logs').slice(1, -1)),
    expect.stringContaining(JSON.stringify([
      '2 hits in app-logs-* from now-7d to now on @timestamp, the data view\'s time field.',
      '',
      'Aggregations:',
      '{"by_service":{"doc_count_error_upper_bound":0,"sum_other_doc_count":0,"buckets":[{"key":"api","doc_count":1},{"key":"billing","doc_count":1}]}}',
    ].join('\n')).slice(1, -1)),
  ])
})
