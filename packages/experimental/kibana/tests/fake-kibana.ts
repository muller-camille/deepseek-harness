/**
 * A real HTTP server that answers like Kibana 8.15: saved-object `_find`, get, and `_bulk_get`,
 * and the Dev Tools console proxy passing Elasticsearch `_field_caps` and `_search` answers
 * through. It records every request it receives. Tests own one instance each and close it.
 */

import { once } from 'node:events'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'

/** One request as the server received it. */
export interface RecordedRequest {
  readonly method: string
  /** Path and query exactly as sent. */
  readonly url: string
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

/** One answer; `destroy` closes the socket without answering. */
export type Reply =
  | { readonly status?: number; readonly json?: unknown; readonly text?: string; readonly headers?: Readonly<Record<string, string>> }
  | 'destroy'

/** Routes one request to its answer. */
export type Handler = (request: RecordedRequest, url: URL) => Reply | Promise<Reply>

/** One stored saved object. */
export interface StoredObject {
  readonly type: string
  readonly id: string
  readonly attributes: Record<string, unknown>
  readonly references?: ReadonlyArray<{ readonly name: string; readonly type: string; readonly id: string }>
  readonly updated_at?: string
}

/** What the Kibana 8.15 routes serve. */
export interface KibanaFixture {
  readonly objects: readonly StoredObject[]
  /** Elasticsearch `_field_caps` answer per index. */
  readonly fieldCaps?: Readonly<Record<string, unknown>>
  /** Elasticsearch `_search` answer for an index and request body; undefined is `index_not_found_exception`. */
  readonly search?: (index: string, body: unknown) => unknown
  /** The only `Authorization` header Kibana accepts; omitted accepts any request. */
  readonly authorization?: string
}

/** The Elasticsearch error body for a missing index. */
export function indexNotFound(index: string) {
  return {
    error: {
      root_cause: [{ type: 'index_not_found_exception', reason: `no such index [${index}]`, 'resource.type': 'index_or_alias', 'resource.id': index, index_uuid: '_na_', index }],
      type: 'index_not_found_exception',
      reason: `no such index [${index}]`,
      'resource.type': 'index_or_alias',
      'resource.id': index,
      index_uuid: '_na_',
      index,
    },
    status: 404,
  }
}

function savedObject(object: StoredObject, fields: readonly string[]) {
  const attributes = fields.length === 0
    ? object.attributes
    : Object.fromEntries(Object.entries(object.attributes).filter(([key]) => fields.includes(key)))
  return {
    type: object.type,
    id: object.id,
    namespaces: ['default'],
    attributes,
    references: object.references ?? [],
    managed: false,
    ...object.updated_at === undefined ? {} : { updated_at: object.updated_at, created_at: object.updated_at },
    version: 'WzEsMV0=',
    coreMigrationVersion: '8.8.0',
    typeMigrationVersion: '8.0.0',
  }
}

function titleMatches(title: unknown, search: string | null): boolean {
  if (search === null) return true
  const words = String(title).toLowerCase().split(/[^\p{L}\p{N}]+/u)
  return search.split(' ').every(term => words.some(word => word.startsWith(term.replace(/\*$/u, ''))))
}

/**
 * Kibana 8.15 routes over a fixture, under any base path and space prefix.
 * @param fixture - stored objects, Elasticsearch answers, and the accepted credentials.
 * @returns the request handler.
 */
export function kibana815(fixture: KibanaFixture): Handler {
  return (request, url) => {
    if (fixture.authorization !== undefined && request.headers.authorization !== fixture.authorization) {
      return { status: 401, json: { statusCode: 401, error: 'Unauthorized', message: '[security_exception]: unable to authenticate user for REST request' } }
    }
    const path = url.pathname.replace(/^.*?(\/api\/)/u, '$1')
    if (request.method === 'GET' && path === '/api/saved_objects/_find') {
      const perPage = Number(url.searchParams.get('per_page') ?? '20')
      const page = Number(url.searchParams.get('page') ?? '1')
      const matches = fixture.objects.filter(object => object.type === url.searchParams.get('type') && titleMatches(object.attributes.title, url.searchParams.get('search')))
      return {
        json: {
          page,
          per_page: perPage,
          total: matches.length,
          saved_objects: matches.slice((page - 1) * perPage, page * perPage).map(object => ({ ...savedObject(object, url.searchParams.getAll('fields')), score: 0 })),
        },
      }
    }
    if (request.method === 'POST' && path === '/api/saved_objects/_bulk_get') {
      const wanted = JSON.parse(request.body) as Array<{ type: string; id: string; fields?: string[] }>
      return {
        json: {
          saved_objects: wanted.map((item) => {
            const object = fixture.objects.find(candidate => candidate.type === item.type && candidate.id === item.id)
            return object === undefined
              ? { id: item.id, type: item.type, error: { statusCode: 404, error: 'Not Found', message: `Saved object [${item.type}/${item.id}] not found` } }
              : savedObject(object, item.fields ?? [])
          }),
        },
      }
    }
    const get = /^\/api\/saved_objects\/([^/]+)\/([^/]+)$/u.exec(path)
    if (request.method === 'GET' && get !== null) {
      const [, type, id] = get.map(part => decodeURIComponent(part))
      const object = fixture.objects.find(candidate => candidate.type === type && candidate.id === id)
      return object === undefined
        ? { status: 404, json: { statusCode: 404, error: 'Not Found', message: `Saved object [${String(type)}/${String(id)}] not found` } }
        : { json: savedObject(object, []) }
    }
    if (request.method === 'POST' && path === '/api/console/proxy') {
      const esPath = url.searchParams.get('path') ?? ''
      const [index = ''] = esPath.split('/')
      const answer = esPath.endsWith('/_field_caps?fields=*')
        ? fixture.fieldCaps?.[index]
        : esPath.endsWith('/_search') && url.searchParams.get('method') === 'POST' ? fixture.search?.(index, JSON.parse(request.body)) : undefined
      return answer === undefined ? { status: 404, json: indexNotFound(index) } : { json: answer }
    }
    return { status: 404, json: { statusCode: 404, error: 'Not Found', message: 'Not Found' } }
  }
}

/** One fake Kibana listening on a loopback port. */
export class FakeKibana {
  readonly requests: RecordedRequest[] = []

  private constructor(private readonly server: Server, public handler: Handler) {}

  /**
   * Listen on an ephemeral loopback port.
   * @param handler - the initial routes.
   * @returns the listening server.
   */
  static async start(handler: Handler): Promise<FakeKibana> {
    const fake: FakeKibana = new FakeKibana(createServer((incoming, response) => {
      const chunks: Buffer[] = []
      incoming.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      incoming.on('end', () => {
        const request: RecordedRequest = { method: incoming.method ?? '', url: incoming.url ?? '', headers: incoming.headers, body: Buffer.concat(chunks).toString('utf8') }
        fake.requests.push(request)
        void Promise.resolve(fake.handler(request, new URL(request.url, 'http://kibana.test'))).then((reply) => {
          if (reply === 'destroy') {
            response.socket?.destroy()
            return
          }
          const body = reply.text ?? (reply.json === undefined ? '' : JSON.stringify(reply.json))
          response.writeHead(reply.status ?? 200, { 'content-type': reply.text === undefined ? 'application/json' : 'text/html', ...reply.headers })
          response.end(body)
        })
      })
    }), handler)
    fake.server.listen(0, '127.0.0.1')
    await once(fake.server, 'listening')
    return fake
  }

  /** Base URL of the server, without a trailing slash. */
  get url(): string {
    const address = this.server.address()
    if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
    return `http://127.0.0.1:${String(address.port)}`
  }

  /** Stop listening and drop open connections. */
  async close(): Promise<void> {
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => { this.server.close(() => { resolve() }) })
  }
}

/** Saved objects shaped like Kibana 8.15 exports: a data view, a saved search, a Lens chart, a classic chart, and a dashboard. */
export const OBJECTS: readonly StoredObject[] = [
  {
    type: 'index-pattern',
    id: 'logs-dv',
    attributes: { title: 'app-logs-*', timeFieldName: '@timestamp', name: 'App logs', fields: '[]', runtimeFieldMap: '{}', sourceFilters: '[]', allowNoIndex: false },
    updated_at: '2024-05-01T10:00:00.000Z',
  },
  {
    type: 'index-pattern',
    id: 'metrics-dv',
    attributes: { title: 'metrics-*', fields: '[]' },
    updated_at: '2024-04-01T10:00:00.000Z',
  },
  {
    type: 'search',
    id: 'errors-search',
    attributes: {
      title: 'Errors',
      description: '',
      columns: ['level', 'service', 'message'],
      sort: [['@timestamp', 'desc']],
      kibanaSavedObjectMeta: {
        searchSourceJSON: JSON.stringify({
          query: { query: 'level:error', language: 'kuery' },
          filter: [{
            meta: { disabled: false, negate: true, alias: null, key: 'service', params: { query: 'healthcheck' }, type: 'phrase', indexRefName: 'kibanaSavedObjectMeta.searchSourceJSON.filter[0].meta.index' },
            query: { match_phrase: { service: 'healthcheck' } },
            $state: { store: 'appState' },
          }],
          indexRefName: 'kibanaSavedObjectMeta.searchSourceJSON.index',
        }),
      },
    },
    references: [
      { name: 'kibanaSavedObjectMeta.searchSourceJSON.index', type: 'index-pattern', id: 'logs-dv' },
      { name: 'kibanaSavedObjectMeta.searchSourceJSON.filter[0].meta.index', type: 'index-pattern', id: 'logs-dv' },
    ],
    updated_at: '2024-05-02T10:00:00.000Z',
  },
  {
    type: 'lens',
    id: 'errors-by-service',
    attributes: {
      title: 'Errors by service',
      description: '',
      visualizationType: 'lnsXY',
      state: {
        datasourceStates: {
          formBased: {
            layers: {
              l1: {
                columns: { c1: { label: 'Top 5 values of service', operationType: 'terms', sourceField: 'service' }, c2: { label: 'Count of records', operationType: 'count' } },
                columnOrder: ['c1', 'c2'],
              },
            },
          },
          textBased: { layers: {} },
        },
        visualization: { preferredSeriesType: 'bar_stacked' },
        query: { query: 'level:error', language: 'kuery' },
        filters: [],
      },
    },
    references: [{ type: 'index-pattern', id: 'logs-dv', name: 'indexpattern-datasource-layer-l1' }],
    updated_at: '2024-05-03T10:00:00.000Z',
  },
  {
    type: 'visualization',
    id: 'request-rate',
    attributes: {
      title: 'Request rate',
      description: 'Requests per interval',
      uiStateJSON: '{}',
      visState: JSON.stringify({
        title: 'Request rate',
        type: 'line',
        aggs: [
          { id: '1', enabled: true, type: 'count', params: {}, schema: 'metric' },
          { id: '2', enabled: true, type: 'date_histogram', params: { field: '@timestamp', interval: 'auto' }, schema: 'segment' },
        ],
        params: {},
      }),
      kibanaSavedObjectMeta: { searchSourceJSON: JSON.stringify({ query: { query: 'service:api', language: 'lucene' }, filter: [] }) },
      savedSearchRefName: 'search_0',
    },
    references: [{ name: 'search_0', type: 'search', id: 'errors-search' }],
    updated_at: '2024-05-04T10:00:00.000Z',
  },
  {
    type: 'dashboard',
    id: 'overview',
    attributes: {
      title: 'Service overview',
      description: 'Errors and latency per service',
      timeRestore: true,
      timeFrom: 'now-7d',
      timeTo: 'now',
      optionsJSON: '{"useMargins":true,"hidePanelTitles":false}',
      panelsJSON: JSON.stringify([
        { type: 'lens', gridData: { x: 0, y: 0, w: 24, h: 15, i: 'p1' }, panelIndex: 'p1', embeddableConfig: { enhancements: {} }, panelRefName: 'panel_p1' },
        { type: 'search', gridData: { x: 24, y: 0, w: 24, h: 15, i: 'p2' }, panelIndex: 'p2', embeddableConfig: {}, title: 'Error log', panelRefName: 'panel_p2' },
        { type: 'visualization', gridData: { x: 0, y: 15, w: 24, h: 15, i: 'p3' }, panelIndex: 'p3', embeddableConfig: { title: 'Notes', savedVis: { type: 'markdown' } } },
        { type: 'lens', gridData: { x: 24, y: 15, w: 24, h: 15, i: 'p4' }, panelIndex: 'p4', embeddableConfig: { attributes: { title: 'Latency', visualizationType: 'lnsXY' } } },
        { type: 'visualization', gridData: { x: 0, y: 30, w: 24, h: 15, i: 'p5' }, panelIndex: 'p5', embeddableConfig: {}, panelRefName: 'panel_p5' },
      ]),
      kibanaSavedObjectMeta: { searchSourceJSON: JSON.stringify({ query: { query: '', language: 'kuery' }, filter: [] }) },
    },
    references: [
      { name: 'p1:panel_p1', type: 'lens', id: 'errors-by-service' },
      { name: 'p2:panel_p2', type: 'search', id: 'errors-search' },
      { name: 'p5:panel_p5', type: 'visualization', id: 'deleted-vis' },
      { name: 'tag-ref-ops', type: 'tag', id: 'ops' },
    ],
    updated_at: '2024-05-05T10:00:00.000Z',
  },
]

/** `_field_caps` answer for `app-logs-*`, as Elasticsearch 8.15 reports it. */
export const APP_LOGS_FIELD_CAPS = {
  indices: ['app-logs-2024.05.01', 'app-logs-2024.05.02'],
  fields: {
    '_id': { _id: { type: '_id', metadata_field: true, searchable: true, aggregatable: false } },
    '_index': { _index: { type: '_index', metadata_field: true, searchable: true, aggregatable: true } },
    '@timestamp': { date: { type: 'date', metadata_field: false, searchable: true, aggregatable: true } },
    'level': { keyword: { type: 'keyword', metadata_field: false, searchable: true, aggregatable: true } },
    'message': { text: { type: 'text', metadata_field: false, searchable: true, aggregatable: false } },
    'host': { object: { type: 'object', metadata_field: false, searchable: false, aggregatable: false } },
    'host.name': { keyword: { type: 'keyword', metadata_field: false, searchable: true, aggregatable: true } },
    'service': { keyword: { type: 'keyword', metadata_field: false, searchable: true, aggregatable: true } },
    'status': {
      long: { type: 'long', metadata_field: false, searchable: true, aggregatable: true, indices: ['app-logs-2024.05.01'] },
      keyword: { type: 'keyword', metadata_field: false, searchable: true, aggregatable: true, indices: ['app-logs-2024.05.02'] },
    },
    'trace': { binary: { type: 'binary', metadata_field: false, searchable: false, aggregatable: false } },
  },
}

/** `_search` answer with two hits and a `terms` aggregation, as Elasticsearch 8.15 reports it. */
export const APP_LOGS_SEARCH = {
  took: 3,
  timed_out: false,
  _shards: { total: 2, successful: 2, skipped: 0, failed: 0 },
  hits: {
    total: { value: 2, relation: 'eq' },
    max_score: null,
    hits: [
      {
        _index: 'app-logs-2024.05.02',
        _id: 'b2',
        _score: null,
        _source: { '@timestamp': '2024-05-02T08:30:00.000Z', 'level': 'error', 'service': 'api', 'message': 'upstream timeout\n  at db.query', 'host': { name: 'web-1' }, 'tags': ['prod', 'eu'] },
        sort: [1714638600000],
      },
      {
        _index: 'app-logs-2024.05.01',
        _id: 'a1',
        _score: null,
        _source: { '@timestamp': '2024-05-01T12:00:00.000Z', 'level': 'error', 'service': 'billing', 'message': 'card declined' },
        sort: [1714564800000],
      },
    ],
  },
  aggregations: { by_service: { doc_count_error_upper_bound: 0, sum_other_doc_count: 0, buckets: [{ key: 'api', doc_count: 1 }, { key: 'billing', doc_count: 1 }] } },
}
