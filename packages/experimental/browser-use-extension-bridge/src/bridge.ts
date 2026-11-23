/**
 * Connection and request ownership for the extension relays. Each Web UI tab with the extension
 * holds one WebSocket; the most recent connection that completed its hello serves commands, and
 * an older one takes over when it closes. Commands run one at a time across all Agents because
 * they share one agent tab in the user's browser.
 * @module
 */

import type { RawData, WebSocket } from 'ws'
import { BrowserBridgeError, extensionFailure } from './error.ts'
import { BRIDGE_PROTOCOL_VERSION, parseExtensionFrame } from './protocol.ts'
import type { BridgeCommand, BridgeServerFrame, PageResult } from './protocol.ts'

/** Timing owned by the plugin configuration. */
export interface ExtensionBridgeOptions {
  /** Budget the extension receives for each command; the bridge waits a short grace beyond it. */
  readonly commandTimeoutMs: number
  /** Interval between WebSocket pings; a connection that misses one interval is terminated. */
  readonly heartbeatIntervalMs: number
}

interface Connection {
  readonly socket: WebSocket
  allowedSites: readonly string[]
  ready: boolean
  alive: boolean
}

interface Pending {
  readonly connection: Connection
  readonly settle: (outcome: { result: PageResult } | { error: Error }) => void
}

/** Extra wait after the extension's own budget so its structured timeout arrives first. */
const REPLY_GRACE_MS = 2_000

const NOT_CONNECTED = 'No Chrome with the DeepSeek Harness extension is connected to this server. Ask the user to open the Web UI in Chrome with the extension enabled for this server, then retry.'

/** Owns relay sockets, the command queue, and in-flight requests. */
export class ExtensionBridge {
  private readonly connections: Connection[] = []
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private queue: Promise<unknown> = Promise.resolve()
  private readonly heartbeat: NodeJS.Timeout
  private closed = false

  /** @param options - command budget and heartbeat interval. */
  constructor(private readonly options: ExtensionBridgeOptions) {
    this.heartbeat = setInterval(() => { this.ping() }, options.heartbeatIntervalMs)
    this.heartbeat.unref()
  }

  /** Whether a relay has completed its hello and can receive commands. */
  get connected(): boolean {
    return this.active() !== undefined
  }

  /** Sites the active relay reported as allowed, in the extension's order. */
  get allowedSites(): readonly string[] {
    return this.active()?.allowedSites ?? []
  }

  /**
   * Adopt one upgraded relay socket until it closes or `signal` aborts.
   * @param socket - WebSocket accepted for an authenticated Web UI page.
   * @param signal - aborts when the page's sign-in ends; the socket then closes.
   */
  attach(socket: WebSocket, signal: AbortSignal): void {
    if (this.closed || signal.aborted) {
      socket.close(1001, 'bridge closed')
      return
    }
    const connection: Connection = { socket, allowedSites: [], ready: false, alive: true }
    this.connections.push(connection)
    const ended = (): void => { socket.close(1001, 'peer left') }
    signal.addEventListener('abort', ended, { once: true })
    socket.on('pong', () => { connection.alive = true })
    socket.on('message', (data, isBinary) => { this.receive(connection, data, isBinary) })
    socket.on('error', () => { socket.terminate() })
    socket.on('close', () => {
      signal.removeEventListener('abort', ended)
      this.detach(connection)
    })
  }

  /**
   * Run one command on the active relay after earlier commands settle.
   * @param command - the browser command.
   * @param signal - the tool call's cancellation; aborting sends a cancel frame.
   * @returns the page facts the extension reported.
   */
  run(command: BridgeCommand, signal: AbortSignal): Promise<PageResult> {
    const task = this.queue.then(() => this.send(command, signal))
    this.queue = task.catch(() => undefined)
    return task
  }

  /** Close every relay socket and fail in-flight commands. */
  close(): void {
    this.closed = true
    clearInterval(this.heartbeat)
    for (const connection of [...this.connections]) connection.socket.close(1001, 'bridge closed')
    for (const [, pending] of this.pending) {
      pending.settle({ error: new BrowserBridgeError('The browser bridge stopped before the command finished.', 'BROWSER_DISCONNECTED') })
    }
  }

  private active(): Connection | undefined {
    return this.connections.findLast(connection => connection.ready)
  }

  private send(command: BridgeCommand, signal: AbortSignal): Promise<PageResult> {
    signal.throwIfAborted()
    const connection = this.active()
    if (connection === undefined) return Promise.reject(new BrowserBridgeError(NOT_CONNECTED, 'BROWSER_NOT_CONNECTED'))
    const id = this.nextId++
    const { promise, resolve, reject } = Promise.withResolvers<PageResult>()
    const timer = setTimeout(() => {
      this.transmit(connection, { type: 'cancel', id })
      settle({ error: new BrowserBridgeError(`The browser did not finish ${command.op} within ${String(this.options.commandTimeoutMs)} ms.`, 'BROWSER_TIMEOUT') })
    }, this.options.commandTimeoutMs + REPLY_GRACE_MS)
    const aborted = (): void => {
      this.transmit(connection, { type: 'cancel', id })
      settle({ error: signal.reason instanceof Error ? signal.reason : new DOMException('browser command canceled', 'AbortError') })
    }
    const settle = (outcome: { result: PageResult } | { error: Error }): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', aborted)
      this.pending.delete(id)
      if ('result' in outcome) resolve(outcome.result)
      else reject(outcome.error)
    }
    signal.addEventListener('abort', aborted, { once: true })
    this.pending.set(id, { connection, settle })
    this.transmit(connection, { type: 'request', id, timeoutMs: this.options.commandTimeoutMs, command })
    return promise
  }

  private transmit(connection: Connection, frame: BridgeServerFrame): void {
    connection.socket.send(JSON.stringify(frame))
  }

  private receive(connection: Connection, data: RawData, isBinary: boolean): void {
    // ws delivers every text frame as one Buffer; binary frames are outside the protocol.
    const frame = isBinary ? undefined : parseExtensionFrame((data as Buffer).toString('utf8'))
    if (frame === undefined) {
      connection.socket.close(1008, 'invalid frame')
      return
    }
    switch (frame.type) {
      case 'hello':
        if (frame.protocol !== BRIDGE_PROTOCOL_VERSION) {
          connection.socket.close(1008, `unsupported protocol ${String(frame.protocol)}; expected ${String(BRIDGE_PROTOCOL_VERSION)}`)
          return
        }
        connection.allowedSites = frame.allowedSites
        connection.ready = true
        // The latest hello becomes active: move it behind every other connection.
        this.connections.splice(this.connections.indexOf(connection), 1)
        this.connections.push(connection)
        return
      case 'sites':
        connection.allowedSites = frame.allowedSites
        return
      case 'response': {
        const pending = this.pending.get(frame.id)
        // A reply after cancellation or from another relay has no waiting caller.
        if (pending?.connection !== connection) return
        if (frame.ok) pending.settle({ result: frame.result })
        else pending.settle({ error: extensionFailure(frame.error.code, frame.error.message, connection.allowedSites) })
        return
      }
    }
  }

  private detach(connection: Connection): void {
    // attach() added the connection, and ws emits close exactly once per socket.
    this.connections.splice(this.connections.indexOf(connection), 1)
    for (const [, pending] of this.pending) {
      if (pending.connection === connection) {
        pending.settle({ error: new BrowserBridgeError('The browser extension disconnected while the command ran. Retry after the user reconnects the Web UI tab.', 'BROWSER_DISCONNECTED') })
      }
    }
  }

  private ping(): void {
    for (const connection of this.connections) {
      if (!connection.alive) {
        connection.socket.terminate()
        continue
      }
      connection.alive = false
      connection.socket.ping()
    }
  }
}
