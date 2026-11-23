/** A real Loader and AgentLoop drive the bridge tools through a relay connected over a real WebSocket upgrade. */

import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import BrowserUseRegistry from '@deepseek-ai/dsh-browser-use'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import LlmRuntime, { LlmAdapter, type ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { type SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import * as Provider from '../src/index.ts'
import type { BridgeServerFrame } from '../src/protocol.ts'

/** Stands in for dsh-host-webserver: a real HTTP listener dispatching registered upgrade routes. */
class ListeningWebServer extends Service {
  static current: ListeningWebServer | undefined
  readonly http: Server = createServer()
  private readonly routes = new Map<string, WebUpgradeRoute>()
  constructor(ctx: Context) {
    super(ctx, 'webServer')
    ListeningWebServer.current = this
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
    }, 'test webServer upgrade')
  }
}

class BrowsingModel extends LlmAdapter {
  requests: GenerateOptions[] = []
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const calls = [
      { name: 'browser_open', arguments: '{"url":"https://intranet.test/tickets"}' },
      { name: 'browser_read', arguments: '{}' },
    ]
    const call = calls[this.requests.length - 1]
    if (call !== undefined) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: brandString<ToolCallId>(`call-${String(this.requests.length)}`), ...call } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'TICKET-2 is open.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

let ctx: Context | undefined
let root: string | undefined
let relay: WebSocket | undefined
afterEach(async () => {
  relay?.terminate()
  await ctx?.fiber.dispose()
  const http = ListeningWebServer.current?.http
  if (http?.listening === true) await new Promise<void>((resolve) => { http.close(() => { resolve() }) })
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  ctx = undefined
  root = undefined
  relay = undefined
})

it('loads the bridge from cordis.yml and logs browser results the model reads', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-browser-bridge-composition-'))
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-tool-executor-native', NativeToolExecutor],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-host-webserver', ListeningWebServer],
    ['@deepseek-ai/dsh-browser-use', BrowserUseRegistry],
    ['@deepseek-ai/dsh-browser-use-extension-bridge', Provider],
  ])
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...modules.keys()].map(name => `- name: '${name}'`).join('\n') + '\n')
  const context = ctx = new Context()
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

  const http = ListeningWebServer.current?.http
  if (http === undefined) throw new Error('the test web server did not load')
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')
  const address = http.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
  const client = relay = new WebSocket(`ws://127.0.0.1:${String(address.port)}/browser-bridge`)
  const commands: unknown[] = []
  client.on('message', (data: Buffer) => {
    const frame = JSON.parse(data.toString('utf8')) as BridgeServerFrame
    if (frame.type !== 'request') return
    commands.push(frame.command)
    const result = frame.command.op === 'read'
      ? { url: 'https://intranet.test/tickets', title: 'Tickets', html: '<h1>Tickets</h1><p>TICKET-2 VPN down</p>' }
      : { url: 'https://intranet.test/tickets', title: 'Tickets' }
    client.send(JSON.stringify({ type: 'response', id: frame.id, ok: true, result }))
  })
  await once(client, 'open')
  client.send(JSON.stringify({ type: 'hello', protocol: 1, extensionVersion: '0.2.3', allowedSites: ['intranet.test'] }))
  await new Promise(resolve => setTimeout(resolve, 20))

  const model = new BrowsingModel()
  context.llm.registerAdapter(['fixture'], model)
  const agent = await context.agentLoop.create(brandString<SessionId>('browser-bridge-loader'), { provider: 'fixture', model: 'fixture' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'What is open in the intranet tracker?' }], source: { kind: 'user' } }))
  await agent.whenIdle()

  expect(commands).toEqual([{ op: 'open', url: 'https://intranet.test/tickets' }, { op: 'read', maxHtmlChars: 2_000_000 }])
  expect(model.requests).toHaveLength(3)
  expect(model.requests[0]?.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining(['browser_open', 'browser_read', 'browser_click', 'browser_type']))
  const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
  expect(results.map(event => JSON.stringify(event.data))).toEqual([
    expect.stringContaining('Opened. The agent tab now shows Tickets at https://intranet.test/tickets.'),
    expect.stringContaining('# Tickets\\n\\nTICKET-2 VPN down'),
  ])
})
