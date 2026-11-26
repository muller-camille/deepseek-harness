/** Wiki requests use the global `fetch`, so the installed process-wide proxy policy routes them. */

import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import { MediaWikiClient } from '../src/client.ts'

let proxy: Server
let proxyUrl: string
const seen: string[] = []

beforeAll(async () => {
  proxy = createServer((request, response) => {
    seen.push(`${request.method ?? ''} ${request.url ?? ''}`)
    response.writeHead(502)
    response.end('fake-proxy')
  })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  const address = proxy.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
  proxyUrl = `http://127.0.0.1:${String(address.port)}`
})

afterAll(async () => {
  proxy.closeAllConnections()
  await new Promise<void>((resolve) => { proxy.close(() => { resolve() }) })
})

it('sends wiki requests through the proxy the user exported', async () => {
  const dispose = await installProxyFromEnvironment({ get: name => (name === 'HTTP_PROXY' ? { value: proxyUrl } : undefined) }, () => undefined)
  try {
    const client = new MediaWikiClient({ apiUrl: 'http://wiki-probe.invalid/w/api.php', timeoutMs: 5_000 })
    await expect(client.search('probe', 1, new AbortController().signal)).rejects.toMatchObject({ code: 'WIKI_UNREACHABLE' })
  } finally {
    await dispose()
  }
  expect(seen).toEqual([expect.stringMatching(/^GET http:\/\/wiki-probe\.invalid\/w\/api\.php\?action=query&list=search&srsearch=probe&/u)])
})
