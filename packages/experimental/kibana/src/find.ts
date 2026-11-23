/** Kibana's saved-object search, shared by data view listing, time-field lookup, and object listing. @module */

import type { KibanaCall } from './client.ts'
import { WireReader, type JsonObject } from './wire.ts'

/** Saved-object types the tools read; `lens` is Kibana's Lens visualization type. */
export const SAVED_OBJECT_TYPES = ['dashboard', 'visualization', 'lens', 'search', 'index-pattern'] as const

/** One type from {@link SAVED_OBJECT_TYPES}. */
export type SavedObjectType = typeof SAVED_OBJECT_TYPES[number]

/** One saved object from a search, with the attributes the search asked for. */
export interface FoundObject {
  /** Saved object id. */
  readonly id: string
  /** Saved object type. */
  readonly type: string
  /** The requested attributes; members are not yet validated. */
  readonly attributes: JsonObject
  /** Last update time, when Kibana reports it. */
  readonly updatedAt?: string
}

/** One page of a saved-object search. */
export interface FoundPage {
  /** Objects matching the search across all pages. */
  readonly total: number
  /** The 1-based page number. */
  readonly page: number
  /** Objects per page. */
  readonly perPage: number
  /** This page's objects. */
  readonly objects: readonly FoundObject[]
}

/** What one saved-object search asks for. */
export interface FindOptions {
  /** The object type. */
  readonly type: SavedObjectType
  /** Words that must each begin a word of the title; see {@link titleSearch}. */
  readonly search?: string
  /** Attributes returned for each object. */
  readonly fields: readonly string[]
  /** Objects per page. */
  readonly perPage: number
  /** The 1-based page number; Kibana's default is the first page. */
  readonly page?: number
  /** Attribute that orders the results. */
  readonly sortField?: string
  /** What the search reads, as failure messages name it. */
  readonly purpose: string
}

/**
 * Turn free text into Kibana's title search: each word of letters and digits, lowercased, matches
 * as a prefix, and every word must match.
 * @param search - free text, such as `app-logs`.
 * @returns the search expression, such as `app* logs*`, or `undefined` when the text has no words.
 */
export function titleSearch(search: string | undefined): string | undefined {
  const words = (search ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word !== '')
  return words.length === 0 ? undefined : words.map(word => `${word}*`).join(' ')
}

/**
 * Search saved objects of one type with `GET /api/saved_objects/_find`.
 * @param call - the tool call's requests.
 * @param options - type, search, attributes, and paging.
 * @returns the validated page.
 */
export async function findSavedObjects(call: KibanaCall, options: FindOptions): Promise<FoundPage> {
  const query = new URLSearchParams({ type: options.type, per_page: String(options.perPage) })
  if (options.page !== undefined) query.set('page', String(options.page))
  for (const field of options.fields) query.append('fields', field)
  const search = titleSearch(options.search)
  if (search !== undefined) {
    query.set('search_fields', 'title')
    query.set('search', search)
    query.set('default_search_operator', 'AND')
  }
  if (options.sortField !== undefined) query.set('sort_field', options.sortField)
  const wire = new WireReader(options.purpose)
  const body = wire.object(await call.request({ method: 'GET', path: '/api/saved_objects/_find', query, purpose: options.purpose }), '$')
  const objects = wire.array(body.saved_objects, '$.saved_objects').map((item, index): FoundObject => {
    const path = `$.saved_objects[${String(index)}]`
    const object = wire.object(item, path)
    const updatedAt = wire.optionalString(object.updated_at, `${path}.updated_at`)
    return {
      id: wire.string(object.id, `${path}.id`),
      type: wire.string(object.type, `${path}.type`),
      attributes: wire.object(object.attributes, `${path}.attributes`),
      ...updatedAt === undefined ? {} : { updatedAt },
    }
  })
  return { total: wire.count(body.total, '$.total'), page: wire.count(body.page, '$.page'), perPage: wire.count(body.per_page, '$.per_page'), objects }
}
