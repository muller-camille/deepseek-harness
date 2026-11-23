/**
 * Browser tools that operate the user's own Chrome through the DeepSeek Harness extension. The
 * extension's relay, running in an authenticated Web UI tab, opens a WebSocket to this plugin's
 * upgrade route on the same origin, so the Web UI sign-in admits it and nothing listens on the
 * user's computer.
 * @module @deepseek-ai/dsh-browser-use-extension-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { BrowserUseProviderName } from '@deepseek-ai/dsh-browser-use/types'
import type {} from '@deepseek-ai/dsh-browser-use'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { WebSocketServer } from 'ws'
import { ExtensionBridge } from './bridge.ts'
import { BRIDGE_PATH } from './protocol.ts'
import { registerBrowserTools } from './tools.ts'

export { BrowserBridgeError, type BrowserBridgeErrorCode } from './error.ts'

/** Cordis identity for the extension bridge provider. */
export const name = 'browser-use-extension-bridge'

/** Services required before activation. */
export const inject = ['browserUse', 'tools', 'systemPrompt', 'webServer']

/** Time and size limits for browser commands. */
export interface Config {
  /** Budget for one browser command, including page loads and `wait_for`. */
  commandTimeoutMs?: number
  /** Cap on the Markdown that one `browser_read` returns. */
  maxContentChars?: number
  /** Cap on the sanitized HTML the extension sends for one read. */
  maxHtmlChars?: number
  /** Interval between WebSocket pings to each relay. */
  heartbeatIntervalMs?: number
}

type ResolvedConfig = Required<Config>

/** Loader defaults and validation. */
export const Config: Schema<Config, ResolvedConfig> = Schema.object({
  commandTimeoutMs: Schema.natural().min(1_000).max(600_000).default(30_000),
  maxContentChars: Schema.natural().min(1_000).max(1_000_000).default(50_000),
  maxHtmlChars: Schema.natural().min(10_000).max(8_000_000).default(2_000_000),
  heartbeatIntervalMs: Schema.natural().min(1_000).max(300_000).default(30_000),
})

/** Grace the tool budget adds over the command budget, matching the bridge's reply wait. */
const TOOL_GRACE_MS = 5_000

/**
 * Serve the relay WebSocket, reserve the browser-use slot, and register the browser tools.
 * @param ctx - context providing browser-use, tools, system prompt, and the Web server.
 * @param input - command limits.
 */
export function apply(ctx: Context, input: Config): void {
  const config = Config(input)
  ctx.effect(function* () {
    yield ctx.browserUse.register(brandString<BrowserUseProviderName>('extension-bridge'))
    const bridge = new ExtensionBridge({ commandTimeoutMs: config.commandTimeoutMs, heartbeatIntervalMs: config.heartbeatIntervalMs })
    yield () => { bridge.close() }
    // The bridge owns accepted sockets, so the acceptor does not track or wait for them on close.
    // One UTF-8 character can take three bytes, and JSON escaping can double them.
    const server = new WebSocketServer({
      noServer: true, clientTracking: false, perMessageDeflate: false, maxPayload: config.maxHtmlChars * 6 + 65_536,
    })
    yield () => new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    yield ctx.webServer.registerUpgrade({
      path: BRIDGE_PATH,
      auth: 'required',
      handler: (request, socket, head, peer) => {
        // Required admission always carries a Peer; refuse rather than serve an unidentified page.
        if (peer === undefined) {
          socket.destroy()
          return
        }
        server.handleUpgrade(request, socket, head, (websocket) => { bridge.attach(websocket, peer.signal) })
      },
    })
    const tools = ctx.plugin({
      name: 'browser-use-extension-bridge-tools',
      inject: ['tools', 'systemPrompt'],
      apply(inner) {
        registerBrowserTools(inner, bridge, {
          toolTimeoutMs: config.commandTimeoutMs + TOOL_GRACE_MS,
          maxContentChars: config.maxContentChars,
          maxHtmlChars: config.maxHtmlChars,
        })
      },
    })
    yield tools.dispose
  }, 'browser-use-extension-bridge.runtime')
}
