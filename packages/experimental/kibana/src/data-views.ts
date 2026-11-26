/** The `kibana_data_views` value, its Kibana request, and its text. @module */

import type { InferValue } from '@deepseek-ai/dsh-tools'
import type { KibanaCall } from './client.ts'
import { findSavedObjects } from './find.ts'
import { clip, fitLines } from './format.ts'
import type { KibanaLimits } from './limits.ts'
import { WireReader } from './wire.ts'

/** Data views one listing reads; a space with more needs a narrower search. */
const DATA_VIEW_PAGE = 100

/** Output schema of `kibana_data_views`. */
export const DATA_VIEWS_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    total: { type: 'integer', required: true },
    dataViews: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          name: { type: 'string' },
          timeFieldName: { type: 'string' },
        },
      },
    },
  },
} as const

/** Canonical value of `kibana_data_views`. */
export type DataViewsValue = InferValue<typeof DATA_VIEWS_OUTPUT>

/**
 * List data views whose titles match `search`, sorted by title.
 * @param call - the tool call's requests.
 * @param search - title words, or `undefined` for every data view.
 * @returns the matching data views, at most {@link DATA_VIEW_PAGE}, and their total.
 */
export async function listDataViews(call: KibanaCall, search: string | undefined): Promise<DataViewsValue> {
  const purpose = 'the data view list'
  const page = await findSavedObjects(call, {
    type: 'index-pattern',
    fields: ['title', 'name', 'timeFieldName'],
    perPage: DATA_VIEW_PAGE,
    purpose,
    ...search === undefined ? {} : { search },
  })
  const wire = new WireReader(purpose)
  const dataViews = page.objects.map((object, index) => {
    const path = `$.saved_objects[${String(index)}].attributes`
    const name = wire.optionalString(object.attributes.name, `${path}.name`)
    const timeFieldName = wire.optionalString(object.attributes.timeFieldName, `${path}.timeFieldName`)
    return {
      id: object.id,
      title: wire.string(object.attributes.title, `${path}.title`),
      ...name === undefined || name === '' ? {} : { name },
      ...timeFieldName === undefined || timeFieldName === '' ? {} : { timeFieldName },
    }
  })
  dataViews.sort((left, right) => left.title < right.title ? -1 : left.title > right.title ? 1 : 0)
  return { total: page.total, dataViews }
}

/**
 * Render a data view listing.
 * @param value - the listing.
 * @param search - the call's search text.
 * @param limits - output caps.
 * @returns the bounded text.
 */
export function renderDataViews(value: DataViewsValue, search: string | undefined, limits: KibanaLimits): string {
  const matching = search === undefined ? '' : ` matching "${clip(search, limits.maxFieldChars)}"`
  if (value.dataViews.length === 0) return `No data views${matching} in this Kibana space.`
  const partial = value.total > value.dataViews.length ? `, ${String(value.dataViews.length)} listed. Pass search to narrow the list` : ''
  const lines = value.dataViews.map((view) => {
    const name = view.name === undefined ? '' : `  name: ${clip(view.name, limits.maxFieldChars)}`
    return `- ${clip(view.title, limits.maxFieldChars)}  time field: ${view.timeFieldName ?? 'none'}  id: ${view.id}${name}`
  })
  return fitLines(
    `${String(value.total)} data views${matching}${partial}:`,
    lines,
    limits.maxOutputChars,
    shown => `[${String(lines.length - shown)} more data views not shown. Pass search to narrow the list.]`,
  )
}
