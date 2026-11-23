/**
 * The shipped extension in real Chromium, driven through the provider's tools. Opt in with
 * DSH_BROWSER_BRIDGE_E2E=1; DSH_BROWSER_BRIDGE_CHROMIUM may name a full Chromium build, because
 * extensions do not load in the headless shell.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { chromium, type BrowserContext } from 'playwright'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import BrowserUseRegistry from '@deepseek-ai/dsh-browser-use'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { LlmAdapter, type StreamChunk, type ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import * as Provider from '../src/index.ts'

const enabled = process.env.DSH_BROWSER_BRIDGE_E2E === '1'

/** Serves a placeholder Web UI page and the provider's upgrade route on one origin. */
class OriginWebServer extends Service {
  static current: OriginWebServer | undefined
  readonly http: Server
  private readonly routes = new Map<string, WebUpgradeRoute>()
  constructor(ctx: Context) {
    super(ctx, 'webServer')
    OriginWebServer.current = this
    this.http = createServer((_request, response) => { response.end('<title>Web UI</title><p>DeepSeek Harness</p>') })
    const peer = { signal: new AbortController().signal } as PeerScope
    this.http.on('upgrade', (request, socket, head) => {
      const route = this.routes.get(new URL(request.url ?? '/', 'http://x').pathname)
      if (route === undefined) socket.destroy()
      else void route.handler(request, socket, head, peer)
    })
  }
  registerUpgrade(route: WebUpgradeRoute) {
    return this.ctx.effect(() => {
      this.routes.set(route.path, route)
      return () => { this.routes.delete(route.path) }
    }, 'e2e webServer upgrade')
  }
}

class UnusedModel extends LlmAdapter {
  async * stream(): AsyncIterable<StreamChunk> { throw new Error('the e2e calls tools directly') }
}

/** A signed-in site that renders its content with JavaScript. */
function intranet(): Server {
  return createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    response.setHeader('content-type', 'text/html; charset=utf-8')
    if (!/(?:^|; )session=alice/u.test(request.headers.cookie ?? '')) return response.end('<h1>Please sign in</h1>')
    if (url.pathname === '/') return response.end(`<title>Tickets</title><div id="app">Loading</div><script>setTimeout(() => {
      document.getElementById('app').innerHTML = '<h1>Tickets for alice</h1><p style="display:none">hidden secret</p><a href="/search">Search tickets</a>'
    }, 300)</script>`)
    if (url.pathname === '/search') return response.end('<title>Search</title><form action="/results"><label>Ticket search <input name="q"></label><button>Go</button></form>')
    return response.end(`<title>Results</title><h1>Results for ${url.searchParams.get('q') ?? ''}</h1>`)
  })
}

const port = (server: Server) => {
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
  return address.port
}

let ctx: Context
let agent: Agent
let site: Server
let browser: BrowserContext | undefined
const temporary: string[] = []

beforeAll(async () => {
  if (!enabled) return
  ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(BrowserUseRegistry)
  await ctx.plugin(OriginWebServer)
  ctx.llm.registerAdapter(['fixture'], new UnusedModel())
  agent = await (await mountAgentLoopTestHarness(ctx)).create(brandString<SessionId>('bridge-e2e'), { provider: 'fixture', model: 'fixture' })
  await ctx.plugin(Provider, { commandTimeoutMs: 15_000 })
  const server = OriginWebServer.current?.http
  if (server === undefined) throw new Error('the e2e web server did not load')
  server.listen(0, '127.0.0.1')
  site = intranet().listen(0, 'localhost')
  await Promise.all([once(server, 'listening'), once(site, 'listening')])

  // A test copy pre-grants the hosts that the options page requests from the user.
  const extension = mkdtempSync(join(tmpdir(), 'dsh-bridge-extension-'))
  temporary.push(extension)
  cpSync(resolve(import.meta.dirname, '../extension'), extension, { recursive: true })
  const manifest = JSON.parse(readFileSync(join(extension, 'manifest.json'), 'utf8')) as Record<string, unknown>
  writeFileSync(join(extension, 'manifest.json'), JSON.stringify({ ...manifest, host_permissions: ['http://127.0.0.1/*', '*://localhost/*'] }))
  const profile = mkdtempSync(join(tmpdir(), 'dsh-bridge-profile-'))
  temporary.push(profile)
  browser = await chromium.launchPersistentContext(profile, {
    headless: true,
    ...process.env.DSH_BROWSER_BRIDGE_CHROMIUM === undefined ? { channel: 'chromium' } : { executablePath: process.env.DSH_BROWSER_BRIDGE_CHROMIUM },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  })
  await browser.addCookies([{ name: 'session', value: 'alice', domain: 'localhost', path: '/' }])
  const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker')
  // String expressions run in the service worker, where the chrome namespace exists.
  await worker.evaluate(`chrome.storage.local.set({ servers: [${JSON.stringify(`http://127.0.0.1:${String(port(server))}`)}] })`)
  const page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${String(port(server))}/`)
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await tool('browser_read', {})).error?.info?.code !== 'BROWSER_NOT_CONNECTED') break
    await new Promise(done => setTimeout(done, 100))
  }
}, 60_000)

afterAll(async () => {
  if (!enabled) return
  await browser?.close()
  await ctx.fiber.dispose()
  await new Promise<void>((done) => { site.close(() => { done() }) })
  const server = OriginWebServer.current?.http
  if (server !== undefined) await new Promise<void>((done) => { server.close(() => { done() }) })
  for (const path of temporary) rmSync(path, { recursive: true, force: true })
})

function tool(name: string, args: unknown) {
  return executeToolFixture(ctx, { agent, name, arguments: args, callId: brandString<ToolCallId>(`e2e-${name}`), signal: new AbortController().signal })
}

const text = async (name: string, args: unknown) => {
  const result = await tool(name, args)
  return result.content.map(block => ('text' in block ? block.text : '')).join('')
}

it.skipIf(!enabled)('reads a signed-in JavaScript page, follows refs, submits a form, and refuses other sites', { timeout: 120_000 }, async () => {
  const origin = `http://localhost:${String(port(site))}`
  expect(await text('browser_open', { url: `${origin}/`, wait_for: '#app h1' })).toBe(`Opened. The agent tab now shows Tickets at ${origin}/.`)
  const tickets = await text('browser_read', {})
  expect(tickets).toContain('# Tickets for alice')
  expect(tickets).not.toContain('hidden secret')
  const link = /Search tickets \[ref=(\d+)\]/u.exec(tickets)?.[1]
  expect(await text('browser_click', { ref: Number(link) })).toContain(`${origin}/search`)
  const form = await text('browser_read', {})
  const field = /\[ref=(\d+) text "Ticket search"\]/u.exec(form)?.[1]
  expect(await text('browser_type', { ref: Number(field), text: 'VPN', submit: true })).toContain(`${origin}/results?q=VPN`)
  expect(await text('browser_read', {})).toContain('# Results for VPN')
  expect((await tool('browser_click', { ref: 99 })).error?.info).toEqual({ name: 'BrowserBridgeError', code: 'BROWSER_ELEMENT_NOT_FOUND' })
  const server = OriginWebServer.current?.http
  expect((await tool('browser_open', { url: `http://127.0.0.1:${String(port(server ?? site))}/` })).error?.info).toEqual({ name: 'BrowserBridgeError', code: 'BROWSER_SITE_NOT_ALLOWED' })
  expect((await tool('browser_open', { url: 'http://example.org/' })).error?.info).toEqual({ name: 'BrowserBridgeError', code: 'BROWSER_SITE_NOT_ALLOWED' })
  const worker = browser?.serviceWorkers()[0]
  await worker?.evaluate('chrome.storage.local.set({ paused: true })')
  expect((await tool('browser_read', {})).error?.info).toEqual({ name: 'BrowserBridgeError', code: 'BROWSER_PAUSED' })
})
