/** Configuration, credentials, and every failure class, against a fake Kibana over HTTP. */

import { describe, expect, it } from 'vitest'
import * as Kibana from '../src/index.ts'
import { kibana815, OBJECTS } from './fake-kibana.ts'
import { failure, mount, registries } from './harness.ts'

describe('configuration', () => {
  it.each([
    [{ url: 'ftp://kibana:5601' }],
    [{ url: 'http://user:pass@kibana:5601' }],
    [{ url: 'http://kibana:5601/?x=1' }],
    [{ url: 'http://[' }],
    [{ url: 'http://kibana', space: 'Team A' }],
    [{ url: 'http://kibana', username: 'a:b' }],
    [{ url: 'http://kibana', passwordEnv: 'not-a-name' }],
    [{ url: 'http://kibana', apiKeyEnv: '1KEY' }],
    [{ url: 'http://kibana', maxHits: 501 }],
    [{ url: 'http://kibana', maxOutputChars: 999 }],
    [{ url: 'http://kibana', username: 'elastic', apiKeyEnv: 'KIBANA_API_KEY' }],
  ])('refuses %j at load', async (config) => {
    const ctx = await registries()
    await expect(ctx.plugin(Kibana, config as Kibana.Config)).rejects.toThrow()
    expect(ctx.tools.schemas()).toEqual([])
  })

  it('names the conflict between Basic and API key authentication', async () => {
    const ctx = await registries()
    await expect(ctx.plugin(Kibana, { url: 'http://kibana', username: 'elastic', apiKeyEnv: 'KIBANA_API_KEY' })).rejects
      .toThrow('kibana: set username (with passwordEnv) for Basic authentication or apiKeyEnv for an API key, not both')
  })

  it('prefixes every path with the base path and the space', async () => {
    const { kibana, text } = await mount({ basePath: '/kibana/', config: { space: 'team-a' } })
    await text('kibana_data_views', {})
    await text('kibana_fields', { index: 'app-logs-*' })
    expect(kibana.requests.map(request => request.url.split('?')[0])).toEqual(['/kibana/s/team-a/api/saved_objects/_find', '/kibana/s/team-a/api/console/proxy'])
  })
})

describe('credentials', () => {
  it('names the missing password reference', async () => {
    const { kibana, run } = await mount({ environment: {} })
    expect(failure(await run('kibana_data_views', {}))).toEqual({
      code: 'KIBANA_CREDENTIAL_MISSING',
      message: 'The Kibana password reference KIBANA_PASSWORD holds no value. Ask the user to store KIBANA_PASSWORD in the credential store or set it in the environment that starts dsh.',
    })
    expect(kibana.requests).toEqual([])
  })

  it('sends an API key from its reference and refuses a missing, blank, or unsendable key', async () => {
    const environments = [{ KIBANA_API_KEY: ' a2V5OnNlY3JldA== ' }, {}, { KIBANA_API_KEY: '   ' }, { KIBANA_API_KEY: 'key with spaces' }]
    const outcomes = []
    for (const environment of environments) {
      const { kibana, run } = await mount({ environment, anonymous: true, config: { apiKeyEnv: 'KIBANA_API_KEY' }, handler: kibana815({ objects: OBJECTS }) })
      const result = await run('kibana_data_views', {})
      outcomes.push(result.isError ? failure(result) : kibana.requests[0]?.headers.authorization)
    }
    expect(outcomes).toEqual([
      'ApiKey a2V5OnNlY3JldA==',
      {
        code: 'KIBANA_CREDENTIAL_MISSING',
        message: 'The Kibana API key reference KIBANA_API_KEY holds no value. Ask the user to store KIBANA_API_KEY in the credential store or set it in the environment that starts dsh.',
      },
      {
        code: 'KIBANA_CREDENTIAL_MISSING',
        message: 'The Kibana API key in KIBANA_API_KEY is not usable (it is blank). Ask the user to store the encoded API key that Kibana showed when the key was created.',
      },
      {
        code: 'KIBANA_CREDENTIAL_MISSING',
        message: 'The Kibana API key in KIBANA_API_KEY is not usable (it contains characters an HTTP header cannot carry). Ask the user to store the encoded API key that Kibana showed when the key was created.',
      },
    ])
  })

  it('reads the password from a mounted credentials service for every request', async () => {
    const values = ['first', 'rotated']
    const { kibana, ctx, text } = await mount({ handler: kibana815({ objects: OBJECTS }) })
    ctx.provide('credentials', { resolve: (ref: string) => Promise.resolve(ref === 'KIBANA_PASSWORD' ? { value: values.shift(), source: 'file' } : undefined) } as never)
    await text('kibana_data_views', {})
    await text('kibana_data_views', {})
    expect(kibana.requests.map(request => Buffer.from(request.headers.authorization?.slice('Basic '.length) ?? '', 'base64').toString('utf8'))).toEqual(['elastic:first', 'elastic:rotated'])
  })

  it('sends no credentials when none are configured', async () => {
    const { kibana, text } = await mount({ anonymous: true, handler: kibana815({ objects: OBJECTS }) })
    await text('kibana_data_views', {})
    expect(kibana.requests[0]?.headers.authorization).toBeUndefined()
  })
})

describe('failures', () => {
  it('names the credentials Kibana rejected', async () => {
    const basic = await mount({ environment: { KIBANA_PASSWORD: 'wrong' } })
    expect(failure(await basic.run('kibana_data_views', {}))).toEqual({
      code: 'KIBANA_AUTH_FAILED',
      message: 'Kibana rejected the credentials for the data view list (HTTP 401: [security_exception]: unable to authenticate user for REST request); the request carried user "elastic" with the password from KIBANA_PASSWORD. Ask the user to check the kibana plugin\'s credentials.',
    })
    const anonymous = await mount({ anonymous: true })
    expect(failure(await anonymous.run('kibana_data_views', {})).message).toContain('the request carried no credentials, because the kibana plugin configures neither username nor apiKeyEnv.')
    const apiKey = await mount({ anonymous: true, config: { apiKeyEnv: 'KIBANA_API_KEY' }, environment: { KIBANA_API_KEY: 'abc' } })
    expect(failure(await apiKey.run('kibana_data_views', {})).message).toContain('the request carried the API key from KIBANA_API_KEY.')
  })

  it('explains a refused privilege for saved objects and for Dev Tools', async () => {
    const forbidden = { status: 403, json: { statusCode: 403, error: 'Forbidden', message: 'Forbidden' } }
    const { run } = await mount({ handler: () => forbidden })
    expect(failure(await run('kibana_saved_objects', { type: 'dashboard' }))).toEqual({
      code: 'KIBANA_AUTH_FAILED',
      message: 'Kibana refused the dashboard list for user "elastic" with the password from KIBANA_PASSWORD (HTTP 403: Forbidden). The account needs read access to saved objects in this Kibana space.',
    })
    expect(failure(await run('kibana_fields', { index: 'logs' }))).toEqual({
      code: 'KIBANA_AUTH_FAILED',
      message: 'Kibana refused the fields of logs for user "elastic" with the password from KIBANA_PASSWORD (HTTP 403: Forbidden). kibana_fields and kibana_search run through Kibana Dev Tools, so the account needs the Dev Tools privilege and read access to the index.',
    })
  })

  it('reports an Elasticsearch privilege refusal with its reason', async () => {
    const reason = 'action [indices:data/read/search] is unauthorized for user [elastic] with effective roles [viewer] on indices [secret]'
    const { run } = await mount({ handler: () => ({ status: 403, json: { error: { root_cause: [{ type: 'security_exception', reason }], type: 'security_exception', reason }, status: 403 } }) })
    expect(failure(await run('kibana_search', { index: 'secret', time_field: 't' }))).toEqual({
      code: 'KIBANA_AUTH_FAILED',
      message: `Elasticsearch refused the search of secret for user "elastic" with the password from KIBANA_PASSWORD (HTTP 403): security_exception: ${reason}. Ask the user to grant the account read access to the index.`,
    })
  })

  it('reports redirects, server errors, unknown paths, and non-JSON success as Kibana answers', async () => {
    const replies = [
      { status: 302, json: {}, headers: { location: '/login?next=%2Fapi' } },
      { status: 307 },
      { status: 502, text: '<html><body>Bad Gateway</body></html>' },
      { status: 503 },
      { status: 404, json: { statusCode: 404, error: 'Not Found', message: 'Not Found' } },
      { status: 200, text: '<html>Kibana</html>' },
      { status: 200, json: { page: 1, per_page: 100, total: 1, saved_objects: [{ id: 7 }] } },
    ]
    const { run } = await mount({ handler: () => replies.shift() ?? 'destroy' })
    const outcomes = []
    for (let index = 0; index < 7; index++) outcomes.push(failure(await run('kibana_data_views', {})))
    expect(outcomes).toEqual([
      { code: 'KIBANA_UNREACHABLE', message: 'Kibana answered the data view list with a redirect (HTTP 302) to /login?next=%2Fapi. Ask the user to check the kibana plugin\'s url, including any base path; the tools do not follow redirects.' },
      { code: 'KIBANA_UNREACHABLE', message: 'Kibana answered the data view list with a redirect (HTTP 307). Ask the user to check the kibana plugin\'s url, including any base path; the tools do not follow redirects.' },
      { code: 'KIBANA_UNREACHABLE', message: 'Kibana answered the data view list with HTTP 502: <html><body>Bad Gateway</body></html>. Ask the user to check that the kibana plugin\'s url points at a healthy Kibana, including any base path.' },
      { code: 'KIBANA_UNREACHABLE', message: 'Kibana answered the data view list with HTTP 503. Ask the user to check that the kibana plugin\'s url points at a healthy Kibana, including any base path.' },
      { code: 'KIBANA_UNREACHABLE', message: 'Kibana answered the data view list with HTTP 404: Not Found. Ask the user to check that the kibana plugin\'s url points at a healthy Kibana, including any base path.' },
      { code: 'KIBANA_BAD_RESPONSE', message: 'Kibana answered the data view list with a body that is not JSON. Ask the user to check that the kibana plugin\'s url points at Kibana, including any base path.' },
      { code: 'KIBANA_BAD_RESPONSE', message: 'Kibana returned an unexpected response for the data view list: $.saved_objects[0].id is not a string. Check that the kibana plugin\'s url points at Kibana 7.10 or later, including any base path.' },
    ])
  })

  it('reports a dropped connection and a closed port as unreachable', async () => {
    const { kibana, run } = await mount({ handler: () => 'destroy' })
    const dropped = failure(await run('kibana_data_views', {}))
    expect(dropped.code).toBe('KIBANA_UNREACHABLE')
    expect(dropped.message).toMatch(/^Could not reach Kibana for the data view list: .+\. Ask the user to check /u)
    expect(dropped.message.endsWith('. Ask the user to check the kibana plugin\'s url and the network path to Kibana; an intranet Kibana behind a proxy must be listed in no_proxy.')).toBe(true)
    await kibana.close()
    expect(failure(await run('kibana_data_views', {})).message).toContain(': connect ECONNREFUSED 127.0.0.1:')
  })

  it('times out after timeoutMs with the plugin\'s own failure', async () => {
    const { run } = await mount({ config: { timeoutMs: 1_000 }, handler: () => new Promise(() => undefined) })
    expect(failure(await run('kibana_data_views', {}))).toEqual({
      code: 'KIBANA_TIMEOUT',
      message: 'Kibana did not answer the data view list within 1000 ms. Narrow the time range or the request, or ask the user to raise the kibana plugin\'s timeoutMs.',
    })
  })

  it('propagates the tool call\'s cancellation unchanged', async () => {
    const controller = new AbortController()
    const { run } = await mount({ handler: () => { controller.abort(); return new Promise(() => undefined) } })
    const result = await run('kibana_data_views', {}, controller.signal)
    expect(result.isError && result.error.info).toMatchObject({ code: 'ABORTED' })
  })

  it('bounds a failure message to maxOutputChars', async () => {
    const { run } = await mount({ config: { maxOutputChars: 1_000 }, handler: () => ({ status: 500, json: { statusCode: 500, message: 'x'.repeat(5_000) } }) })
    const { code, message } = failure(await run('kibana_search', { index: 'x', time_field: 't' }))
    expect(code).toBe('KIBANA_UNREACHABLE')
    expect(message).toHaveLength(1_000)
    expect(message.endsWith('x…')).toBe(true)
  })
})
