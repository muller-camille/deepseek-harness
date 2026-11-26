/**
 * The Kibana tools against a real Kibana. Opt in with DSH_KIBANA_E2E_URL; set DSH_KIBANA_E2E_USERNAME and
 * DSH_KIBANA_E2E_PASSWORD for Basic authentication. The Kibana must hold a data view titled `app-logs-*`
 * with time field `@timestamp` over documents with `level`, `service`, and `message`, a saved search
 * titled `Errors`, and a dashboard titled `Service overview`.
 */

import { afterAll, beforeAll, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as Kibana from '../src/index.ts'
import type { FieldsValue } from '../src/fields.ts'
import type { SavedObjectsValue } from '../src/saved-objects.ts'
import type { SearchValue } from '../src/search.ts'

const url = process.env.DSH_KIBANA_E2E_URL
const username = process.env.DSH_KIBANA_E2E_USERNAME
const enabled = url !== undefined && url !== ''

let ctx: Context

beforeAll(async () => {
  if (!enabled) return
  ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  // Without a launch snapshot, credential references read the process environment.
  await ctx.plugin(Kibana, { url, passwordEnv: 'DSH_KIBANA_E2E_PASSWORD', ...username === undefined || username === '' ? {} : { username } })
})

afterAll(async () => {
  if (enabled) await ctx.fiber.dispose()
})

async function run(name: string, args: unknown) {
  return executeToolFixture(ctx, { name, arguments: args, callId: brandString<ToolCallId>(`e2e-${name}`), signal: new AbortController().signal })
}

async function read(name: string, args: unknown) {
  const result = await run(name, args)
  if (result.isError) throw new Error(`${name} failed: ${result.error.message}`)
  return { text: result.content.map(block => block.type === 'text' ? block.text : '').join(''), value: result.value }
}

it.skipIf(!enabled)('lists data views and fields, searches with an aggregation, reads saved objects, and refuses system indices', { timeout: 120_000 }, async () => {
  const views = await read('kibana_data_views', { search: 'app logs' })
  expect(views.text).toMatch(/^- app-logs-\* {2}time field: @timestamp {2}id: /mu)

  const fields = await read('kibana_fields', { index: 'app-logs-*' })
  expect(fields.text).toMatch(/^- level: /mu)
  const service = (fields.value as FieldsValue).fields.find(field => field.name === 'service')
  const serviceField = service?.aggregatable === true ? 'service' : 'service.keyword'

  const search = await read('kibana_search', { index: 'app-logs-*', query: 'level:error', from: 'now-7d', size: 5, aggregations: { by_service: { terms: { field: serviceField } } } })
  const value = search.value as SearchValue
  expect(search.text).toMatch(/^\d+ hits in app-logs-\* from now-7d to now on @timestamp, the data view's time field\./u)
  expect(value.total).toBeGreaterThan(0)
  expect(value.hits.every(hit => hit.fields.some(field => field.name === 'level' && field.value === 'error'))).toBe(true)
  expect(value.aggregations).toMatchObject({ by_service: { buckets: expect.any(Array) as unknown[] } })

  const dashboards = await read('kibana_saved_objects', { type: 'dashboard', search: 'Service overview' })
  const dashboard = (dashboards.value as SavedObjectsValue).objects.find(object => object.title === 'Service overview')
  expect(dashboard).toBeDefined()
  const dashboardText = (await read('kibana_saved_object', { type: 'dashboard', id: dashboard?.id ?? '' })).text
  expect(dashboardText).toMatch(/^Dashboard: Service overview\n/u)
  expect(dashboardText).toMatch(/\nPanels \(\d+\):\n/u)

  const searches = await read('kibana_saved_objects', { type: 'search', search: 'Errors' })
  const saved = (searches.value as SavedObjectsValue).objects.find(object => object.title === 'Errors')
  expect(saved).toBeDefined()
  const savedText = (await read('kibana_saved_object', { type: 'search', id: saved?.id ?? '' })).text
  expect(savedText).toMatch(/^Saved search: Errors\n/u)
  expect(savedText).toContain('app-logs-*')

  const refused = await run('kibana_search', { index: '_cluster' })
  expect(refused.isError && refused.error.info).toEqual({ name: 'ToolArgsError', code: 'INVALID_ARGS' })
})
