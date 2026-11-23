/** Listing and reading saved objects against a fake Kibana 8.15 over HTTP. */

import { describe, expect, it } from 'vitest'
import { kibana815, type StoredObject } from './fake-kibana.ts'
import { BASIC, failure, mount } from './harness.ts'

describe('kibana_saved_objects', () => {
  it('lists one page of a type ordered by last update', async () => {
    const { kibana, text } = await mount()
    expect(await text('kibana_saved_objects', { type: 'dashboard' })).toBe([
      '1 dashboards, page 1 of 1.',
      '- Service overview  id: overview  updated: 2024-05-05T10:00:00.000Z',
      '  Errors and latency per service',
    ].join('\n'))
    expect(kibana.requests.map(request => [request.method, request.url, request.headers.authorization, request.headers['kbn-xsrf']])).toEqual([
      ['GET', '/api/saved_objects/_find?type=dashboard&per_page=50&page=1&fields=title&fields=description&sort_field=updated_at', BASIC, 'true'],
    ])
    expect(await text('kibana_saved_objects', { type: 'search', search: 'err' })).toBe('1 saved searches matching "err", page 1 of 1.\n- Errors  id: errors-search  updated: 2024-05-02T10:00:00.000Z')
    expect(kibana.requests[1]?.url).toBe('/api/saved_objects/_find?type=search&per_page=50&page=1&fields=title&fields=description&search_fields=title&search=err*&default_search_operator=AND&sort_field=updated_at')
    expect(await text('kibana_saved_objects', { type: 'lens', search: 'missing' })).toBe('No Lens visualizations matching "missing" in this Kibana space.')
  })

  it('pages through many objects and reports an empty page past the end', async () => {
    const objects: StoredObject[] = Array.from({ length: 120 }, (_, index) => ({
      type: 'visualization',
      id: `vis-${String(index)}`,
      attributes: index === 0 ? { description: 'first line\nsecond line' } : { title: `Chart ${String(index)}` },
    }))
    const { kibana, run, text } = await mount({ handler: kibana815({ objects }) })
    const second = await text('kibana_saved_objects', { type: 'visualization', page: 2 })
    expect(second.split('\n').slice(0, 2)).toEqual(['120 visualizations, page 2 of 3. Pass page 3 for the next 50.', '- Chart 50  id: vis-50'])
    const first = await text('kibana_saved_objects', { type: 'visualization' })
    expect(first.split('\n').slice(1, 3)).toEqual(['- (untitled)  id: vis-0', '  first line\\nsecond line'])
    expect(await text('kibana_saved_objects', { type: 'visualization', page: 9 })).toBe('Page 9 is empty: 120 visualizations fill 3 pages.')
    expect(failure(await run('kibana_saved_objects', { type: 'visualization', page: 0 }))).toEqual({ code: 'INVALID_ARGS', message: 'invalid arguments: page must be 1 or greater' })
    expect(failure(await run('kibana_saved_objects', { type: 'config' }))).toMatchObject({ code: 'INVALID_ARGS' })
    expect(kibana.requests).toHaveLength(3)
  })

  it('keeps whole entries within maxOutputChars', async () => {
    const objects: StoredObject[] = Array.from({ length: 50 }, (_, index) => ({ type: 'dashboard', id: `d${String(index)}`, attributes: { title: `Dashboard ${'x'.repeat(30)} ${String(index)}` } }))
    const { text } = await mount({ config: { maxOutputChars: 1_000 }, handler: kibana815({ objects }) })
    const output = await text('kibana_saved_objects', { type: 'dashboard' })
    expect(output.length).toBeLessThanOrEqual(1_000)
    expect(output.split('\n').at(-1)).toMatch(/^\[\d+ more dashboards on this page not shown\. Pass search to narrow the list\.\]$/u)
  })
})

describe('kibana_saved_object', () => {
  it('reads a dashboard, resolves the titles of its references in one _bulk_get, and lists its panels', async () => {
    const { kibana, text } = await mount()
    expect(await text('kibana_saved_object', { type: 'dashboard', id: 'overview' })).toBe([
      'Dashboard: Service overview',
      'ID: overview',
      'Description: Errors and latency per service',
      'Updated: 2024-05-05T10:00:00.000Z',
      'Time range: now-7d to now',
      'Panels (5):',
      '1. lens: Errors by service (lens errors-by-service)',
      '2. search "Error log": Errors (search errors-search)',
      '3. visualization "Notes" (stored in the dashboard)',
      '4. lens "Latency" (stored in the dashboard)',
      '5. visualization: (title unavailable) (visualization deleted-vis)',
    ].join('\n'))
    expect(kibana.requests.map(request => [request.method, request.url, request.headers.authorization, request.headers['kbn-xsrf'], request.headers['content-type'], request.body])).toEqual([
      ['GET', '/api/saved_objects/dashboard/overview', BASIC, 'true', undefined, ''],
      ['POST', '/api/saved_objects/_bulk_get', BASIC, 'true', 'application/json', JSON.stringify([
        { type: 'lens', id: 'errors-by-service', fields: ['title'] },
        { type: 'search', id: 'errors-search', fields: ['title'] },
        { type: 'visualization', id: 'deleted-vis', fields: ['title'] },
        { type: 'tag', id: 'ops', fields: ['title'] },
      ])],
    ])
  })

  it('reads a saved search with its data view, columns, sort, query, and filters', async () => {
    const { kibana, text } = await mount()
    expect(await text('kibana_saved_object', { type: 'search', id: 'errors-search' })).toBe([
      'Saved search: Errors',
      'ID: errors-search',
      'Updated: 2024-05-02T10:00:00.000Z',
      'Data views: app-logs-* (index-pattern logs-dv)',
      'Query (KQL): level:error',
      'Filters:',
      '- NOT {"match_phrase":{"service":"healthcheck"}}',
      'Columns: level, service, message',
      'Sort: @timestamp desc',
    ].join('\n'))
    expect(JSON.parse(kibana.requests[1]?.body ?? '')).toEqual([{ type: 'index-pattern', id: 'logs-dv', fields: ['title'] }])
  })

  it('reads Lens and classic visualizations with what they show', async () => {
    const { text } = await mount()
    expect(await text('kibana_saved_object', { type: 'lens', id: 'errors-by-service' })).toBe([
      'Lens visualization: Errors by service',
      'ID: errors-by-service',
      'Updated: 2024-05-03T10:00:00.000Z',
      'Type: lnsXY',
      'Data views: app-logs-* (index-pattern logs-dv)',
      'Query (KQL): level:error',
      'Shows: Top 5 values of service; Count of records',
    ].join('\n'))
    expect(await text('kibana_saved_object', { type: 'visualization', id: 'request-rate' })).toBe([
      'Visualization: Request rate',
      'ID: request-rate',
      'Description: Requests per interval',
      'Updated: 2024-05-04T10:00:00.000Z',
      'Type: line',
      'Built on saved search: Errors (search errors-search)',
      'Query (Lucene): service:api',
      'Shows: count; date_histogram of @timestamp',
    ].join('\n'))
  })

  it('reads a data view without a reference lookup', async () => {
    const { kibana, text } = await mount()
    expect(await text('kibana_saved_object', { type: 'index-pattern', id: 'logs-dv' })).toBe([
      'Data view: app-logs-*',
      'ID: logs-dv',
      'Updated: 2024-05-01T10:00:00.000Z',
      'Name: App logs',
      'Time field: @timestamp',
    ].join('\n'))
    expect(await text('kibana_saved_object', { type: 'index-pattern', id: 'metrics-dv' })).toBe('Data view: metrics-*\nID: metrics-dv\nUpdated: 2024-04-01T10:00:00.000Z')
    expect(kibana.requests.map(request => request.url)).toEqual(['/api/saved_objects/index-pattern/logs-dv', '/api/saved_objects/index-pattern/metrics-dv'])
  })

  it('reads older and sparser object shapes', async () => {
    const objects: StoredObject[] = [
      {
        type: 'search',
        id: 'legacy',
        attributes: {
          title: 'Legacy',
          sort: ['@timestamp', 'asc'],
          kibanaSavedObjectMeta: {
            searchSourceJSON: JSON.stringify({
              query: { query: { query_string: { query: '*' } }, language: 'lucene' },
              filter: [
                { meta: { disabled: true, negate: false }, range: { bytes: { gte: 10 } } },
                { exists: { field: 'trace' } },
              ],
            }),
          },
        },
      },
      { type: 'search', id: 'bare', attributes: { title: 'Bare', sort: [], kibanaSavedObjectMeta: { searchSourceJSON: JSON.stringify({ query: { query: 'x' } }) } } },
      { type: 'dashboard', id: 'empty', attributes: { title: 'Empty', timeRestore: false, timeFrom: 'now-1d', timeTo: 'now' } },
      { type: 'visualization', id: 'vis-plain', attributes: { title: 'Plain', visState: JSON.stringify({ title: 'Plain' }) } },
      { type: 'visualization', id: 'vis-none', attributes: {} },
      { type: 'lens', id: 'lens-bare', attributes: { title: 'Bare lens' } },
      {
        type: 'lens',
        id: 'lens-odd',
        attributes: { title: 'Odd lens', state: { datasourceStates: { formBased: { layers: { l1: 'bad', l2: { columns: { c1: { label: 3 }, c2: 'x', c3: { label: 'Median of bytes' } } } } }, other: 'x' } } },
      },
      {
        type: 'dashboard',
        id: 'refs',
        attributes: { title: 'Refs', panelsJSON: JSON.stringify([{ type: 'lens', panelIndex: '1', panelRefName: 'panel_0', title: '' }, { type: 'lens', panelRefName: 'panel_1' }]) },
        references: [{ name: 'panel_0', type: 'lens', id: 'lens-bare' }],
      },
    ]
    const { kibana, text } = await mount({ handler: kibana815({ objects }) })
    expect(await text('kibana_saved_object', { type: 'search', id: 'legacy' })).toBe([
      'Saved search: Legacy',
      'ID: legacy',
      'Query (Lucene): {"query_string":{"query":"*"}}',
      'Filters:',
      '- (disabled) {"range":{"bytes":{"gte":10}}}',
      '- {"exists":{"field":"trace"}}',
      'Sort: @timestamp asc',
    ].join('\n'))
    expect(await text('kibana_saved_object', { type: 'search', id: 'bare' })).toBe('Saved search: Bare\nID: bare\nQuery: x')
    expect(await text('kibana_saved_object', { type: 'dashboard', id: 'empty' })).toBe('Dashboard: Empty\nID: empty')
    expect(await text('kibana_saved_object', { type: 'visualization', id: 'vis-plain' })).toBe('Visualization: Plain\nID: vis-plain')
    expect(await text('kibana_saved_object', { type: 'visualization', id: 'vis-none' })).toBe('Visualization: (untitled)\nID: vis-none')
    expect(await text('kibana_saved_object', { type: 'lens', id: 'lens-bare' })).toBe('Lens visualization: Bare lens\nID: lens-bare')
    expect(await text('kibana_saved_object', { type: 'lens', id: 'lens-odd' })).toBe('Lens visualization: Odd lens\nID: lens-odd\nShows: Median of bytes')
    expect(await text('kibana_saved_object', { type: 'dashboard', id: 'refs' })).toBe('Dashboard: Refs\nID: refs\nPanels (2):\n1. lens: Bare lens (lens lens-bare)\n2. lens (stored in the dashboard)')
    expect(kibana.requests.filter(request => request.method === 'POST')).toHaveLength(1)
  })

  it('encodes the id into one path segment and refuses dot segments', async () => {
    const { kibana, run } = await mount()
    expect(failure(await run('kibana_saved_object', { type: 'dashboard', id: 'a/b?c' }))).toEqual({
      code: 'KIBANA_NOT_FOUND',
      message: 'No dashboard with id a/b?c exists in this Kibana space. Find ids with kibana_saved_objects.',
    })
    expect(kibana.requests.map(request => request.url)).toEqual(['/api/saved_objects/dashboard/a%2Fb%3Fc'])
    for (const id of ['..', '.', ' ']) {
      expect(failure(await run('kibana_saved_object', { type: 'dashboard', id }))).toEqual({ code: 'INVALID_ARGS', message: 'invalid arguments: id must be a saved object id from kibana_saved_objects' })
    }
    expect(kibana.requests).toHaveLength(1)
  })

  it('rejects a stored JSON attribute that does not parse', async () => {
    const objects: StoredObject[] = [{ type: 'dashboard', id: 'broken', attributes: { title: 'Broken', panelsJSON: '[{' } }]
    const { run } = await mount({ handler: kibana815({ objects }) })
    expect(failure(await run('kibana_saved_object', { type: 'dashboard', id: 'broken' }))).toEqual({
      code: 'KIBANA_BAD_RESPONSE',
      message: 'Kibana returned an unexpected response for the dashboard broken: $.attributes.panelsJSON is not a JSON document. Check that the kibana plugin\'s url points at Kibana 7.10 or later, including any base path.',
    })
  })

  it('clips long titles, descriptions, and filters to maxFieldChars and the output to maxOutputChars', async () => {
    const filters = Array.from({ length: 40 }, (_, index) => ({ meta: {}, query: { match_phrase: { [`field_${String(index)}`]: 'v'.repeat(50) } } }))
    const objects: StoredObject[] = [{
      type: 'search',
      id: 'long',
      attributes: { title: 'T'.repeat(100), description: 'D'.repeat(100), kibanaSavedObjectMeta: { searchSourceJSON: JSON.stringify({ query: { query: 'q'.repeat(100), language: 'esql' }, filter: filters }) } },
    }]
    const { text } = await mount({ config: { maxFieldChars: 40, maxOutputChars: 1_000 }, handler: kibana815({ objects }) })
    const output = await text('kibana_saved_object', { type: 'search', id: 'long' })
    expect(output.split('\n').slice(0, 6)).toEqual([
      `Saved search: ${'T'.repeat(39)}…`,
      'ID: long',
      `Description: ${'D'.repeat(39)}…`,
      `Query (esql): ${'q'.repeat(39)}…`,
      'Filters:',
      `- {"match_phrase":{"field_0":"${'v'.repeat(11)}…`,
    ])
    expect(output).toHaveLength(1_000)
  })
})
