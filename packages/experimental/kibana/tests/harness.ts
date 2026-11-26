/** Mounts the plugin on real tool and prompt registries against a fake Kibana owned by the calling test. */

import { onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as Kibana from '../src/index.ts'
import { APP_LOGS_FIELD_CAPS, APP_LOGS_SEARCH, FakeKibana, kibana815, OBJECTS, type Handler } from './fake-kibana.ts'

/** The default fake: Kibana 8.15 over the shared fixture, accepting user `elastic` with password `changeme`. */
export const BASIC = `Basic ${Buffer.from('elastic:changeme').toString('base64')}`

/**
 * The default routes: the shared saved objects, `app-logs-*` field caps, a search answer that
 * returns at most `size` of its hits, and Basic credentials `elastic:changeme`.
 * @returns the handler.
 */
export function defaultRoutes(): Handler {
  return kibana815({
    objects: OBJECTS,
    fieldCaps: { 'app-logs-*': APP_LOGS_FIELD_CAPS },
    search: (_index, body) => {
      const hits = APP_LOGS_SEARCH.hits.hits.slice(0, (body as { size: number }).size)
      return { ...APP_LOGS_SEARCH, hits: { ...APP_LOGS_SEARCH.hits, hits } }
    },
    authorization: BASIC,
  })
}

/** What one mounted plugin offers a test. */
export interface Mounted {
  readonly ctx: Context
  readonly kibana: FakeKibana
  readonly fiber: ReturnType<Context['plugin']>
  /** Run one tool through the production pipeline. */
  readonly run: (name: string, args: unknown, signal?: AbortSignal) => ReturnType<typeof executeToolFixture>
  /** Run one tool and return its text, failing on a tool error. */
  readonly text: (name: string, args: unknown) => Promise<string>
}

/**
 * Create a context with the tool and prompt registries the plugin injects; it is disposed when the test ends.
 * @param environment - the launch environment credential references resolve against.
 * @returns the context.
 */
export async function registries(environment: Record<string, string> = {}): Promise<Context> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([{ source: 'process', values: environment }]))
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  return ctx
}

/**
 * Start a fake Kibana and mount the plugin against it as user `elastic`, or without credentials
 * when `anonymous`; both are released when the test ends.
 * @param options - plugin configuration beyond `url`, the launch environment, the routes, and a path appended to the URL.
 * @returns the mounted plugin.
 */
export async function mount(options: {
  config?: Partial<Kibana.Config>
  anonymous?: true
  environment?: Record<string, string>
  handler?: Handler
  basePath?: string
} = {}): Promise<Mounted> {
  const kibana = await FakeKibana.start(options.handler ?? defaultRoutes())
  onTestFinished(() => kibana.close())
  const ctx = await registries(options.environment ?? { KIBANA_PASSWORD: 'changeme' })
  const fiber = ctx.plugin(Kibana, { url: `${kibana.url}${options.basePath ?? ''}`, ...options.anonymous === true ? {} : { username: 'elastic' }, ...options.config })
  await fiber
  const run = (name: string, args: unknown, signal = new AbortController().signal) =>
    executeToolFixture(ctx, { name, arguments: args, callId: brandString<ToolCallId>(`call-${name}`), signal })
  const text = async (name: string, args: unknown) => {
    const result = await run(name, args)
    if (result.isError) throw new Error(`${name} failed: ${result.error.message}`)
    return result.content.map(block => block.type === 'text' ? block.text : '').join('')
  }
  return { ctx, kibana, fiber, run, text }
}

/**
 * The failure of one tool call.
 * @param result - the settled call.
 * @returns its code and message.
 */
export function failure(result: Awaited<ReturnType<typeof executeToolFixture>>): { code: string | undefined; message: string } {
  if (!result.isError) throw new Error('expected the tool call to fail')
  return { code: result.error.info?.code, message: result.error.message }
}
