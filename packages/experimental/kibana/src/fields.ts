/** The `kibana_fields` value, its Elasticsearch request, and its text. @module */

import type { InferValue } from '@deepseek-ai/dsh-tools'
import type { KibanaCall } from './client.ts'
import { clip, fitLines } from './format.ts'
import type { KibanaLimits } from './limits.ts'
import { WireReader } from './wire.ts'

/** Output schema of `kibana_fields`. */
export const FIELDS_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    index: { type: 'string', required: true },
    fields: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          types: { type: 'array', required: true, items: { type: 'string' } },
          aggregatable: { type: 'boolean', required: true },
          searchable: { type: 'boolean', required: true },
        },
      },
    },
  },
} as const

/** Canonical value of `kibana_fields`. */
export type FieldsValue = InferValue<typeof FIELDS_OUTPUT>

/**
 * Read the fields of an index pattern with Elasticsearch `_field_caps`. Metadata fields starting
 * with `_` and `object` parents are left out; a field mapped with different types in different
 * indices lists every type and counts as aggregatable or searchable only when all of them are.
 * @param call - the tool call's requests.
 * @param index - a validated index pattern.
 * @returns the fields sorted by name.
 */
export async function readFields(call: KibanaCall, index: string): Promise<FieldsValue> {
  const purpose = `the fields of ${index}`
  const wire = new WireReader(purpose)
  const body = wire.object(await call.elasticsearch('GET', `${index}/_field_caps?fields=*`, purpose), '$')
  const fields: FieldsValue['fields'] = []
  for (const [name, byType] of Object.entries(wire.object(body.fields, '$.fields'))) {
    if (name.startsWith('_')) continue
    const capabilities = Object.entries(wire.object(byType, `$.fields.${name}`))
      .filter(([type]) => type !== 'object')
      .map(([type, value]) => {
        const path = `$.fields.${name}.${type}`
        const capability = wire.object(value, path)
        return { type, aggregatable: wire.boolean(capability.aggregatable, `${path}.aggregatable`), searchable: wire.boolean(capability.searchable, `${path}.searchable`) }
      })
    if (capabilities.length === 0) continue
    fields.push({
      name,
      types: capabilities.map(capability => capability.type),
      aggregatable: capabilities.every(capability => capability.aggregatable),
      searchable: capabilities.every(capability => capability.searchable),
    })
  }
  fields.sort((left, right) => left.name < right.name ? -1 : 1)
  return { index, fields }
}

/**
 * Render a field listing.
 * @param value - the listing.
 * @param limits - output caps.
 * @returns the bounded text.
 */
export function renderFields(value: FieldsValue, limits: KibanaLimits): string {
  const index = clip(value.index, limits.maxFieldChars)
  if (value.fields.length === 0) return `No fields found for ${index}. Check the index pattern with kibana_data_views.`
  const lines = value.fields.map(field =>
    `- ${field.name}: ${field.types.join('|')}${field.aggregatable ? ', aggregatable' : ''}${field.searchable ? '' : ', not searchable'}`)
  return fitLines(
    `${String(lines.length)} fields in ${index}, sorted by name, without _ metadata fields:`,
    lines,
    limits.maxOutputChars,
    shown => `[${String(lines.length - shown)} more fields not shown. Pass a narrower index to see them.]`,
  )
}
