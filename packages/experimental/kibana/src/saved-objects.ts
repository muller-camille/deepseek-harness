/** The `kibana_saved_objects` value, its Kibana request, and its text. @module */

import type { InferValue } from '@deepseek-ai/dsh-tools'
import type { KibanaCall } from './client.ts'
import { findSavedObjects, type SavedObjectType } from './find.ts'
import { clip, fitLines, oneLine } from './format.ts'
import type { KibanaLimits } from './limits.ts'
import { WireReader } from './wire.ts'

/** Objects one page lists. */
const OBJECT_PAGE = 50

/** Display names of the saved-object types: in a sentence, in the plural, and as a heading. */
export const TYPE_NAMES: Readonly<Record<SavedObjectType, { readonly one: string; readonly many: string; readonly heading: string }>> = {
  'dashboard': { one: 'dashboard', many: 'dashboards', heading: 'Dashboard' },
  'visualization': { one: 'visualization', many: 'visualizations', heading: 'Visualization' },
  'lens': { one: 'Lens visualization', many: 'Lens visualizations', heading: 'Lens visualization' },
  'search': { one: 'saved search', many: 'saved searches', heading: 'Saved search' },
  'index-pattern': { one: 'data view', many: 'data views', heading: 'Data view' },
}

/** Output schema of `kibana_saved_objects`. */
export const SAVED_OBJECTS_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    total: { type: 'integer', required: true },
    page: { type: 'integer', required: true },
    perPage: { type: 'integer', required: true },
    objects: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          description: { type: 'string' },
          updatedAt: { type: 'string' },
        },
      },
    },
  },
} as const

/** Canonical value of `kibana_saved_objects`. */
export type SavedObjectsValue = InferValue<typeof SAVED_OBJECTS_OUTPUT>

/**
 * List one page of saved objects of a type, ordered by their last update.
 * @param call - the tool call's requests.
 * @param type - the object type.
 * @param search - title words, or `undefined` for every object.
 * @param page - the 1-based page.
 * @returns the page.
 */
export async function listSavedObjects(
  call: KibanaCall, type: SavedObjectType, search: string | undefined, page: number,
): Promise<SavedObjectsValue> {
  const purpose = `the ${TYPE_NAMES[type].one} list`
  const found = await findSavedObjects(call, {
    type,
    fields: ['title', 'description'],
    perPage: OBJECT_PAGE,
    page,
    sortField: 'updated_at',
    purpose,
    ...search === undefined ? {} : { search },
  })
  const wire = new WireReader(purpose)
  return {
    total: found.total,
    page: found.page,
    perPage: found.perPage,
    objects: found.objects.map((object, index) => {
      const path = `$.saved_objects[${String(index)}].attributes`
      const description = wire.optionalString(object.attributes.description, `${path}.description`)
      return {
        id: object.id,
        title: wire.optionalString(object.attributes.title, `${path}.title`) ?? '',
        ...description === undefined || description === '' ? {} : { description },
        ...object.updatedAt === undefined ? {} : { updatedAt: object.updatedAt },
      }
    }),
  }
}

/**
 * Render one page of saved objects.
 * @param value - the page.
 * @param type - the listed type.
 * @param search - the call's search text.
 * @param limits - output caps.
 * @returns the bounded text.
 */
export function renderSavedObjects(
  value: SavedObjectsValue, type: SavedObjectType, search: string | undefined, limits: KibanaLimits,
): string {
  const names = TYPE_NAMES[type]
  const matching = search === undefined ? '' : ` matching "${clip(search, limits.maxFieldChars)}"`
  const pages = Math.max(1, Math.ceil(value.total / Math.max(1, value.perPage)))
  if (value.objects.length === 0) {
    return value.total === 0
      ? `No ${names.many}${matching} in this Kibana space.`
      : `Page ${String(value.page)} is empty: ${String(value.total)} ${names.many}${matching} fill ${String(pages)} pages.`
  }
  const next = value.page < pages ? ` Pass page ${String(value.page + 1)} for the next ${String(value.perPage)}.` : ''
  const lines = value.objects.map((object) => {
    const updated = object.updatedAt === undefined ? '' : `  updated: ${object.updatedAt}`
    const title = `- ${clip(object.title === '' ? '(untitled)' : object.title, limits.maxFieldChars)}  id: ${object.id}${updated}`
    return object.description === undefined ? title : `${title}\n  ${clip(oneLine(object.description), limits.maxFieldChars)}`
  })
  return fitLines(
    `${String(value.total)} ${names.many}${matching}, page ${String(value.page)} of ${String(pages)}.${next}`,
    lines,
    limits.maxOutputChars,
    shown => `[${String(lines.length - shown)} more ${names.many} on this page not shown. Pass search to narrow the list.]`,
  )
}
