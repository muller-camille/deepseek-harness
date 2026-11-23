/** Relay connection ownership over real WebSockets; the test client plays the extension relay. */

import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { ExtensionBridge } from '../src/bridge.ts'
import type { BridgeServerFrame } from '../src/protocol.ts'

interface Relay {
  client: WebSocket
  server: WebSocket
  frames: BridgeServerFrame[]
  next: () => Promise<BridgeServerFrame>
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

async function setup(options: { commandTimeoutMs?: number; heartbeatIntervalMs?: number } = {}) {
  const bridge = new ExtensionBridge({
    commandTimeoutMs: options.commandTimeoutMs ?? 5_000,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 60_000,
  })
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await once(wss, 'listening')
  const address = wss.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
  cleanups.push(() => new Promise<void>((resolve) => {
    bridge.close()
    for (const socket of wss.clients) socket.terminate()
    wss.close(() => { resolve() })
  }))
  const connect = async (
    setupServer: (socket: WebSocket) => AbortSignal = () => new AbortController().signal,
    clientOptions: { autoPong?: boolean } = {},
  ): Promise<Relay> => {
    const accepted = once(wss, 'connection') as Promise<[WebSocket]>
    const client = new WebSocket(`ws://127.0.0.1:${String(address.port)}`, clientOptions)
    const frames: BridgeServerFrame[] = []
    const waiters: Array<(frame: BridgeServerFrame) => void> = []
    client.on('message', (data: Buffer) => {
      const frame = JSON.parse(data.toString('utf8')) as BridgeServerFrame
      const waiter = waiters.shift()
      if (waiter === undefined) frames.push(frame)
      else waiter(frame)
    })
    const [server] = await accepted
    bridge.attach(server, setupServer(server))
    await once(client, 'open')
    return {
      client,
      server,
      frames,
      next: () => {
        const queued = frames.shift()
        return queued === undefined ? new Promise((resolve) => { waiters.push(resolve) }) : Promise.resolve(queued)
      },
    }
  }
  const hello = (relay: Relay, allowedSites: string[] = []) => {
    relay.client.send(JSON.stringify({ type: 'hello', protocol: 1, extensionVersion: '0.2.3', allowedSites }))
  }
  const until = async (condition: () => boolean) => {
    for (let attempt = 0; attempt < 200 && !condition(); attempt++) await new Promise(resolve => setTimeout(resolve, 5))
    expect(condition()).toBe(true)
  }
  return { bridge, connect, hello, until }
}

const signal = () => new AbortController().signal

describe('ExtensionBridge', () => {
  it('reports no browser until a relay completes its hello', async () => {
    const { bridge, connect, hello, until } = await setup()
    await expect(bridge.run({ op: 'open', url: 'https://a.test' }, signal())).rejects.toMatchObject({ code: 'BROWSER_NOT_CONNECTED' })
    const relay = await connect()
    expect(bridge.connected).toBe(false)
    expect(bridge.allowedSites).toEqual([])
    hello(relay, ['example.com'])
    await until(() => bridge.connected)
    expect(bridge.allowedSites).toEqual(['example.com'])
    relay.client.send(JSON.stringify({ type: 'sites', allowedSites: ['a.test', 'b.test'] }))
    await until(() => bridge.allowedSites.length === 2)
  })

  it('correlates replies, serializes commands, and maps extension failures', async () => {
    const { bridge, connect, hello, until } = await setup()
    const relay = await connect()
    hello(relay, ['a.test'])
    await until(() => bridge.connected)
    const first = bridge.run({ op: 'open', url: 'https://a.test' }, signal())
    const second = bridge.run({ op: 'read', maxHtmlChars: 100 }, signal())
    const request = await relay.next()
    expect(request).toEqual({ type: 'request', id: 1, timeoutMs: 5_000, command: { op: 'open', url: 'https://a.test' } })
    expect(relay.frames).toEqual([])
    relay.client.send(JSON.stringify({ type: 'response', id: 99, ok: true, result: { url: 'x', title: 'stale' } }))
    relay.client.send(JSON.stringify({ type: 'response', id: 1, ok: true, result: { url: 'https://a.test/', title: 'A' } }))
    await expect(first).resolves.toEqual({ url: 'https://a.test/', title: 'A' })
    const read = await relay.next()
    expect(read).toMatchObject({ type: 'request', id: 2, command: { op: 'read' } })
    relay.client.send(JSON.stringify({ type: 'response', id: 2, ok: false, error: { code: 'SITE_NOT_ALLOWED', message: 'b.test is not allowed.' } }))
    await expect(second).rejects.toMatchObject({ code: 'BROWSER_SITE_NOT_ALLOWED' })
    await expect(second).rejects.toThrow('Allowed sites: a.test.')

    const cases = [
      ['ELEMENT_NOT_FOUND', 'BROWSER_ELEMENT_NOT_FOUND', 'browser_read again'],
      ['PAUSED', 'BROWSER_PAUSED', 'resume browser control'],
      ['TIMEOUT', 'BROWSER_TIMEOUT', 'slow'],
      ['NAVIGATION_FAILED', 'BROWSER_NAVIGATION_FAILED', 'slow'],
      ['FAILED', 'BROWSER_COMMAND_FAILED', 'slow'],
    ] as const
    for (const [code, mapped, text] of cases) {
      const run = bridge.run({ op: 'click', target: { ref: 1 } }, signal())
      const frame = await relay.next()
      if (frame.type !== 'request') throw new Error('expected a request')
      relay.client.send(JSON.stringify({ type: 'response', id: frame.id, ok: false, error: { code, message: 'slow' } }))
      await expect(run).rejects.toMatchObject({ code: mapped })
      await expect(run).rejects.toThrow(text)
    }
  })

  it('lists no allowed sites when the extension granted none', async () => {
    const { bridge, connect, hello, until } = await setup()
    const relay = await connect()
    hello(relay)
    await until(() => bridge.connected)
    const run = bridge.run({ op: 'open', url: 'https://a.test' }, signal())
    await relay.next()
    relay.client.send(JSON.stringify({ type: 'response', id: 1, ok: false, error: { code: 'SITE_NOT_ALLOWED', message: 'a.test is not allowed.' } }))
    await expect(run).rejects.toThrow('Allowed sites: none.')
  })

  it('sends a cancel frame and rejects with the abort reason', async () => {
    const { bridge, connect, hello, until } = await setup()
    const relay = await connect()
    hello(relay)
    await until(() => bridge.connected)
    const controller = new AbortController()
    const run = bridge.run({ op: 'open', url: 'https://a.test' }, controller.signal)
    await relay.next()
    const reason = new Error('tool canceled')
    controller.abort(reason)
    await expect(run).rejects.toBe(reason)
    expect(await relay.next()).toEqual({ type: 'cancel', id: 1 })
    const other = new AbortController()
    const second = bridge.run({ op: 'open', url: 'https://a.test' }, other.signal)
    await relay.next()
    other.abort('plain reason')
    await expect(second).rejects.toMatchObject({ name: 'AbortError' })
    const aborted = new AbortController()
    aborted.abort()
    await expect(bridge.run({ op: 'open', url: 'https://a.test' }, aborted.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('times out after the command budget and its grace', async () => {
    const { bridge, connect, hello, until } = await setup({ commandTimeoutMs: 10 })
    const relay = await connect()
    hello(relay)
    await until(() => bridge.connected)
    const run = bridge.run({ op: 'open', url: 'https://a.test' }, signal())
    await expect(run).rejects.toMatchObject({ code: 'BROWSER_TIMEOUT', message: 'The browser did not finish open within 10 ms.' })
    expect((await relay.next()).type).toBe('request')
    expect(await relay.next()).toEqual({ type: 'cancel', id: 1 })
  }, 10_000)

  it('serves the latest hello and falls back when it closes', async () => {
    const { bridge, connect, hello, until } = await setup()
    const older = await connect()
    hello(older, ['older.test'])
    const newer = await connect()
    hello(newer, ['newer.test'])
    await until(() => bridge.allowedSites[0] === 'newer.test')
    const run = bridge.run({ op: 'open', url: 'https://a.test' }, signal())
    const frame = await newer.next()
    older.client.send(JSON.stringify({ type: 'response', id: 1, ok: true, result: { url: 'wrong', title: 'wrong' } }))
    newer.client.close()
    await expect(run).rejects.toMatchObject({ code: 'BROWSER_DISCONNECTED' })
    expect(frame.type).toBe('request')
    await until(() => bridge.allowedSites[0] === 'older.test')
  })

  it('closes a relay that breaks the protocol', async () => {
    const { bridge, connect, hello, until } = await setup()
    const versioned = await connect()
    versioned.client.send(JSON.stringify({ type: 'hello', protocol: 2, extensionVersion: '9', allowedSites: [] }))
    const [versionCode] = await once(versioned.client, 'close') as [number]
    expect(versionCode).toBe(1008)
    const binary = await connect()
    binary.client.send(Buffer.from('{}'), { binary: true })
    expect((await once(binary.client, 'close') as [number])[0]).toBe(1008)
    const invalid = await connect()
    hello(invalid)
    await until(() => bridge.connected)
    const run = bridge.run({ op: 'open', url: 'https://a.test' }, signal())
    await invalid.next()
    invalid.client.send('not json')
    await expect(run).rejects.toMatchObject({ code: 'BROWSER_DISCONNECTED' })
  })

  it('keeps a command running when another relay disconnects', async () => {
    const { bridge, connect, hello, until } = await setup()
    const older = await connect()
    hello(older, ['older.test'])
    const newer = await connect()
    hello(newer, ['newer.test'])
    await until(() => bridge.allowedSites[0] === 'newer.test')
    const run = bridge.run({ op: 'open', url: 'https://a.test' }, signal())
    await newer.next()
    older.client.close()
    await once(older.client, 'close')
    newer.client.send(JSON.stringify({ type: 'response', id: 1, ok: true, result: { url: 'https://a.test/', title: 'A' } }))
    await expect(run).resolves.toEqual({ url: 'https://a.test/', title: 'A' })
  })

  it('closes relays when their sign-in ends, on errors, and when the bridge closes', async () => {
    const { bridge, connect, hello, until } = await setup()
    const ended = new AbortController()
    const relay = await connect(() => ended.signal)
    ended.abort()
    expect((await once(relay.client, 'close') as [number])[0]).toBe(1001)
    const preEnded = new AbortController()
    preEnded.abort()
    const refused = await connect(() => preEnded.signal)
    expect((await once(refused.client, 'close') as [number])[0]).toBe(1001)
    const failing = await connect()
    failing.server.emit('error', new Error('socket failure'))
    await once(failing.client, 'close')
    const open = await connect()
    hello(open)
    await until(() => bridge.connected)
    const run = bridge.run({ op: 'open', url: 'https://a.test' }, signal())
    await open.next()
    bridge.close()
    await expect(run).rejects.toMatchObject({ code: 'BROWSER_DISCONNECTED' })
    await expect(run).rejects.toThrow('stopped')
    expect((await once(open.client, 'close') as [number])[0]).toBe(1001)
    const late = await connect()
    expect((await once(late.client, 'close') as [number])[0]).toBe(1001)
  })

  it('terminates a relay that stops answering pings', async () => {
    const { connect } = await setup({ heartbeatIntervalMs: 20 })
    const silent = await connect(undefined, { autoPong: false })
    const responsive = await connect()
    await once(silent.client, 'close')
    expect(responsive.client.readyState).toBe(WebSocket.OPEN)
  })
})
