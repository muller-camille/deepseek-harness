/** The `kibana_search` request, its value, and its text. @module */

import type { InferValue } from '@deepseek-ai/dsh-tools'
import { elasticsearchCause, type KibanaCall } from './client.ts'
import { findSavedObjects } from './find.ts'
import { capOutput, clip, flattenFields, oneLine } from './format.ts'
import type { KibanaLimits } from './limits.ts'
import { isJsonObject, WireReader, type Json } from './wire.ts'

/** Time field of a search whose index has no data view naming one; the Elastic Common Schema's event time. */
const DEFAULT_TIME_FIELD = '@timestamp'

/** Data views one time-field lookup reads. */
const LOOKUP_PAGE = 100

/** Output schema of `kibana_search`. */
export const SEARCH_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    index: { type: 'string', required: true },
    timeField: { type: 'string', required: true },
    timeFieldSource: { type: 'string', required: true, enum: ['argument', 'data view', 'default'] },
    from: { type: 'string', required: true },
    to: { type: 'string', required: true },
    total: { type: 'integer', required: true },
    totalIsLowerBound: { type: 'boolean', required: true },
    hits: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          index: { type: 'string', required: true },
          id: { type: 'string', required: true },
          timestamp: { type: 'string' },
          fields: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { name: { type: 'string', required: true }, value: { type: 'string', required: true } },
            },
          },
        },
      },
    },
    aggregations: { type: 'json' },
    shardFailures: {
      type: 'object',
      additionalProperties: false,
      properties: {
        failed: { type: 'integer', required: true },
        total: { type: 'integer', required: true },
        reason: { type: 'string' },
      },
    },
  },
} as const

/** Canonical value of `kibana_search`. */
export type SearchValue = InferValue<typeof SEARCH_OUTPUT>

/** One validated search request. */
export interface SearchRequest {
  /** Validated index pattern. */
  readonly index: string
  /** Lucene `query_string` query; `undefined` matches every document. */
  readonly query?: string
  /** Range start: Elasticsearch date math or an ISO time. */
  readonly from: string
  /** Range end: Elasticsearch date math or an ISO time. */
  readonly to: string
  /** Time field named by the call, if any. */
  readonly timeField?: string
  /** Hits to return, at most `maxHits`. */
  readonly size: number
  /** `_source` fields to return; `undefined` returns whole documents. */
  readonly fields?: readonly string[]
  /** Time order of the hits. */
  readonly sort: 'asc' | 'desc'
  /** Elasticsearch aggregations, sent unchanged. */
  readonly aggregations?: Readonly<Record<string, Json>>
}

/**
 * Choose the time field: the call's, else the `timeFieldName` of the data view whose title equals
 * the index, else `@timestamp`.
 */
async function timeFieldOf(call: KibanaCall, request: SearchRequest): Promise<Pick<SearchValue, 'timeField' | 'timeFieldSource'>> {
  if (request.timeField !== undefined) return { timeField: request.timeField, timeFieldSource: 'argument' }
  const purpose = `the data view for ${request.index}`
  const page = await findSavedObjects(call, { type: 'index-pattern', search: request.index, fields: ['title', 'timeFieldName'], perPage: LOOKUP_PAGE, purpose })
  const wire = new WireReader(purpose)
  for (const [index, object] of page.objects.entries()) {
    const path = `$.saved_objects[${String(index)}].attributes`
    if (wire.string(object.attributes.title, `${path}.title`) !== request.index) continue
    const timeField = wire.optionalString(object.attributes.timeFieldName, `${path}.timeFieldName`)
    if (timeField !== undefined && timeField !== '') return { timeField, timeFieldSource: 'data view' }
  }
  return { timeField: DEFAULT_TIME_FIELD, timeFieldSource: 'default' }
}

/** Time of a hit from its sort value, which Elasticsearch reports in epoch milliseconds for a date field. */
function sortTime(value: unknown): string | undefined {
  if (typeof value !== 'number') return undefined
  const time = new Date(value)
  return Number.isNaN(time.getTime()) ? undefined : time.toISOString()
}

/**
 * Search an index pattern through Kibana's Dev Tools console.
 * @param call - the tool call's requests.
 * @param request - the validated search.
 * @param limits - the field-value cap applied to every hit.
 * @returns the hits, totals, and aggregations.
 */
export async function search(call: KibanaCall, request: SearchRequest, limits: KibanaLimits): Promise<SearchValue> {
  const { timeField, timeFieldSource } = await timeFieldOf(call, request)
  const filter: Json[] = [{ range: { [timeField]: { gte: request.from, lte: request.to } } }]
  if (request.query !== undefined) filter.push({ query_string: { query: request.query } })
  const purpose = `the search of ${request.index}`
  const raw = await call.elasticsearch('POST', `${request.index}/_search`, purpose, {
    size: request.size,
    track_total_hits: true,
    query: { bool: { filter } },
    sort: [{ [timeField]: { order: request.sort } }],
    ...request.fields === undefined ? {} : { _source: [...request.fields] },
    ...request.aggregations === undefined ? {} : { aggs: request.aggregations },
  })
  const wire = new WireReader(purpose)
  const body = wire.object(raw, '$')
  const hits = wire.object(body.hits, '$.hits')
  const total = typeof hits.total === 'number' ? { value: hits.total, relation: 'eq' } : wire.object(hits.total, '$.hits.total')
  const shards = wire.optionalObject(body._shards, '$._shards')
  const failed = shards === undefined ? 0 : wire.count(shards.failed, '$._shards.failed')
  const aggregations = body.aggregations === undefined ? undefined : wire.json(body.aggregations, '$.aggregations')
  return {
    index: request.index,
    timeField,
    timeFieldSource,
    from: request.from,
    to: request.to,
    total: wire.count(total.value, '$.hits.total.value'),
    totalIsLowerBound: wire.string(total.relation, '$.hits.total.relation') === 'gte',
    hits: wire.array(hits.hits, '$.hits.hits').map((item, position) => {
      const path = `$.hits.hits[${String(position)}]`
      const hit = wire.object(item, path)
      const fields = flattenFields(wire.optionalObject(hit._source, `${path}._source`) ?? {})
      const time = fields.find(([name]) => name === timeField)
      const timestamp = time?.[1] ?? sortTime(Array.isArray(hit.sort) ? hit.sort[0] : undefined)
      return {
        index: wire.string(hit._index, `${path}._index`),
        id: wire.string(hit._id, `${path}._id`),
        ...timestamp === undefined ? {} : { timestamp },
        fields: fields
          .filter(field => field !== time)
          .map(([name, value]) => ({ name, value: clip(oneLine(value), limits.maxFieldChars) })),
      }
    }),
    ...aggregations === undefined ? {} : { aggregations },
    ...shards === undefined || failed === 0 ? {} : {
      shardFailures: {
        failed,
        total: wire.count(shards.total, '$._shards.total'),
        ...shardReason(shards.failures, limits.maxFieldChars),
      },
    },
  }
}

function shardReason(failures: unknown, max: number): { reason?: string } {
  const first: unknown = Array.isArray(failures) ? failures[0] : undefined
  const reason = elasticsearchCause(isJsonObject(first) ? first.reason : undefined)
  return reason === undefined ? {} : { reason: clip(oneLine(reason), max) }
}

const SOURCE_NOTES: Readonly<Record<SearchValue['timeFieldSource'], (index: string) => string>> = {
  'argument': () => '',
  'data view': () => ', the data view\'s time field',
  'default': index => `, the default time field; pass time_field if ${index} uses another`,
}

/**
 * Render a search: totals and range, each hit as `<timestamp> <index> <id>` with indented
 * `field: value` lines, then the aggregations as compact JSON.
 * @param value - the search value.
 * @param sort - the time order the call asked for.
 * @param limits - output caps.
 * @returns the bounded text.
 */
export function renderSearch(value: SearchValue, sort: 'asc' | 'desc', limits: KibanaLimits): string {
  const index = clip(value.index, limits.maxFieldChars)
  const head = [
    `${String(value.total)}${value.totalIsLowerBound ? ' or more' : ''} hits in ${index} from ${clip(value.from, limits.maxFieldChars)} to ${clip(value.to, limits.maxFieldChars)} on ${clip(value.timeField, limits.maxFieldChars)}${SOURCE_NOTES[value.timeFieldSource](index)}.`,
  ]
  if (value.hits.length > 0) head.push(`Showing ${String(value.hits.length)}, ${sort === 'desc' ? 'newest' : 'oldest'} first.`)
  if (value.shardFailures !== undefined) {
    const reason = value.shardFailures.reason === undefined ? '' : `: ${value.shardFailures.reason}`
    head.push(`Warning: ${String(value.shardFailures.failed)} of ${String(value.shardFailures.total)} shards failed${reason}. Results may be incomplete.`)
  }
  const blocks = [head.join('\n')]
  for (const hit of value.hits) {
    blocks.push([`${hit.timestamp ?? '-'} ${hit.index} ${hit.id}`, ...hit.fields.map(field => `  ${field.name}: ${field.value}`)].join('\n'))
  }
  if (value.aggregations !== undefined) blocks.push(`Aggregations:\n${JSON.stringify(value.aggregations)}`)
  return capOutput(blocks.join('\n\n'), limits.maxOutputChars)
}
