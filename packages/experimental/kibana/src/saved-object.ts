/**
 * The `kibana_saved_object` value: one saved object read with `GET /api/saved_objects/<type>/<id>`,
 * its JSON-string attributes parsed, and its references' titles resolved with one
 * `POST /api/saved_objects/_bulk_get`.
 * @module
 */

import type { InferValue } from '@deepseek-ai/dsh-tools'
import type { KibanaCall } from './client.ts'
import { SAVED_OBJECT_TYPES, type SavedObjectType } from './find.ts'
import { capOutput, clip, oneLine } from './format.ts'
import type { KibanaLimits } from './limits.ts'
import { TYPE_NAMES } from './saved-objects.ts'
import { isJsonObject, WireReader, type JsonObject } from './wire.ts'

const REFERENCE_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { type: 'string', required: true },
    id: { type: 'string', required: true },
    title: { type: 'string' },
  },
} as const

const STRINGS_OUTPUT = { type: 'array', items: { type: 'string' } } as const

/** Output schema of `kibana_saved_object`; members a type does not have are omitted. */
export const SAVED_OBJECT_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { type: 'string', required: true, enum: SAVED_OBJECT_TYPES },
    id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    description: { type: 'string' },
    updatedAt: { type: 'string' },
    visualizationType: { type: 'string' },
    name: { type: 'string' },
    timeFieldName: { type: 'string' },
    timeRange: {
      type: 'object',
      additionalProperties: false,
      properties: { from: { type: 'string', required: true }, to: { type: 'string', required: true } },
    },
    dataViews: { type: 'array', items: REFERENCE_OUTPUT },
    savedSearch: REFERENCE_OUTPUT,
    query: {
      type: 'object',
      additionalProperties: false,
      properties: { query: { type: 'string', required: true }, language: { type: 'string' } },
    },
    filters: STRINGS_OUTPUT,
    columns: STRINGS_OUTPUT,
    sort: STRINGS_OUTPUT,
    dimensions: STRINGS_OUTPUT,
    panels: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: { type: 'string', required: true },
          title: { type: 'string' },
          object: REFERENCE_OUTPUT,
        },
      },
    },
  },
} as const

/** Canonical value of `kibana_saved_object`. */
export type SavedObjectValue = InferValue<typeof SAVED_OBJECT_OUTPUT>

type Reference = InferValue<typeof REFERENCE_OUTPUT>

/** One saved-object reference: the name the object uses for it and the object it names. */
interface NamedReference {
  readonly name: string
  readonly type: string
  readonly id: string
}

/** Members shared by several types, in output order. */
type Details = Omit<SavedObjectValue, 'type' | 'id' | 'title' | 'description' | 'updatedAt'>

/**
 * Resolve the titles of referenced objects with one `_bulk_get`.
 * @returns titles keyed by `<type>/<id>`; an object that is missing or has no title has no entry.
 */
async function referenceTitles(call: KibanaCall, references: readonly NamedReference[]): Promise<ReadonlyMap<string, string>> {
  const titles = new Map<string, string>()
  const wanted = new Map(references.map(reference => [`${reference.type}/${reference.id}`, { type: reference.type, id: reference.id, fields: ['title'] }]))
  if (wanted.size === 0) return titles
  const purpose = 'the titles of referenced objects'
  const wire = new WireReader(purpose)
  const body = wire.object(await call.request({ method: 'POST', path: '/api/saved_objects/_bulk_get', body: [...wanted.values()], purpose }), '$')
  for (const [index, item] of wire.array(body.saved_objects, '$.saved_objects').entries()) {
    const path = `$.saved_objects[${String(index)}]`
    const object = wire.object(item, path)
    const attributes = wire.optionalObject(object.attributes, `${path}.attributes`)
    const title = wire.optionalString(attributes?.title, `${path}.attributes.title`)
    if (title !== undefined) titles.set(`${wire.string(object.type, `${path}.type`)}/${wire.string(object.id, `${path}.id`)}`, title)
  }
  return titles
}

/** Reads the parts of one saved object's attributes that the value reports. */
class AttributeReader {
  constructor(
    readonly wire: WireReader,
    private readonly references: readonly NamedReference[],
    private readonly titles: ReadonlyMap<string, string>,
    private readonly maxFieldChars: number,
  ) {}

  reference(reference: NamedReference): Reference {
    const title = this.titles.get(`${reference.type}/${reference.id}`)
    return { type: reference.type, id: reference.id, ...title === undefined ? {} : { title } }
  }

  /** Data views the object references, once each. */
  dataViews(): Pick<Details, 'dataViews'> {
    const byId = new Map<string, Reference>()
    for (const reference of this.references) {
      if (reference.type === 'index-pattern' && !byId.has(reference.id)) byId.set(reference.id, this.reference(reference))
    }
    return byId.size === 0 ? {} : { dataViews: [...byId.values()] }
  }

  /** The saved search a visualization is built on. */
  savedSearch(): Pick<Details, 'savedSearch'> {
    const reference = this.references.find(candidate => candidate.type === 'search')
    return reference === undefined ? {} : { savedSearch: this.reference(reference) }
  }

  /** The search source Kibana stores as JSON in `kibanaSavedObjectMeta.searchSourceJSON`. */
  searchSource(attributes: JsonObject): JsonObject | undefined {
    const meta = this.wire.optionalObject(attributes.kibanaSavedObjectMeta, '$.attributes.kibanaSavedObjectMeta')
    const path = '$.attributes.kibanaSavedObjectMeta.searchSourceJSON'
    return meta?.searchSourceJSON === undefined ? undefined : this.wire.object(this.wire.embedded(meta.searchSourceJSON, path), path)
  }

  /** Query and filters of a search source or Lens state. */
  queryAndFilters(source: JsonObject | undefined, path: string, filterKey: string): Pick<Details, 'query' | 'filters'> {
    const query = this.wire.optionalObject(source?.query, `${path}.query`)
    const text = typeof query?.query === 'string' ? query.query : query?.query === undefined ? '' : JSON.stringify(query.query)
    const language = this.wire.optionalString(query?.language, `${path}.query.language`)
    const filters = this.wire.optionalArray(source?.[filterKey], `${path}.${filterKey}`)
      .map((filter, index) => this.filter(this.wire.object(filter, `${path}.${filterKey}[${String(index)}]`)))
    return {
      ...text === '' ? {} : { query: { query: text, ...language === undefined ? {} : { language } } },
      ...filters.length === 0 ? {} : { filters },
    }
  }

  /** One Kibana filter as its condition JSON, marked when negated or disabled. */
  filter(filter: JsonObject): string {
    const { meta, $state: _state, ...rest } = filter
    const negate = isJsonObject(meta) && meta.negate === true ? 'NOT ' : ''
    const disabled = isJsonObject(meta) && meta.disabled === true ? '(disabled) ' : ''
    return clip(oneLine(`${disabled}${negate}${JSON.stringify(rest.query ?? rest)}`), this.maxFieldChars)
  }

  strings(value: unknown, path: string): string[] {
    return this.wire.optionalArray(value, path).map((item, index) => this.wire.string(item, `${path}[${String(index)}]`))
  }

  /** Sort of a saved search: one `[field, direction]` pair or a list of them. */
  sort(value: unknown): string[] {
    const entries = this.wire.optionalArray(value, '$.attributes.sort')
    const pairs = entries.length > 0 && entries.every(entry => typeof entry === 'string') ? [entries] : entries
    return pairs.map((pair, index) => this.strings(pair, `$.attributes.sort[${String(index)}]`).join(' '))
  }

  /** Panels of a dashboard, each with the object it shows when the dashboard references one. */
  panels(attributes: JsonObject): Pick<Details, 'panels'> {
    if (attributes.panelsJSON === undefined) return {}
    const list = this.wire.array(this.wire.embedded(attributes.panelsJSON, '$.attributes.panelsJSON'), '$.attributes.panelsJSON')
    return {
      panels: list.map((item, index) => {
        const path = `$.attributes.panelsJSON[${String(index)}]`
        const panel = this.wire.object(item, path)
        const config = this.wire.optionalObject(panel.embeddableConfig, `${path}.embeddableConfig`)
        const byValue = this.wire.optionalObject(config?.attributes, `${path}.embeddableConfig.attributes`)
        const refName = this.wire.optionalString(panel.panelRefName, `${path}.panelRefName`)
        const panelIndex = this.wire.optionalString(panel.panelIndex, `${path}.panelIndex`)
        // Kibana 7 names a panel's reference `panel_0`; Kibana 8 prefixes the panel index: `<panelIndex>:panel_<panelIndex>`.
        const reference = refName === undefined ? undefined : this.references.find(candidate => candidate.name === refName || candidate.name === `${panelIndex ?? ''}:${refName}`)
        const title = this.wire.optionalString(panel.title, `${path}.title`)
          ?? this.wire.optionalString(config?.title, `${path}.embeddableConfig.title`)
          ?? this.wire.optionalString(byValue?.title, `${path}.embeddableConfig.attributes.title`)
        return {
          type: this.wire.string(panel.type, `${path}.type`),
          ...title === undefined || title === '' ? {} : { title },
          ...reference === undefined ? {} : { object: this.reference(reference) },
        }
      }),
    }
  }

  /** What a classic visualization computes, from the aggregations in its `visState`. */
  visualization(attributes: JsonObject): Pick<Details, 'visualizationType' | 'dimensions'> {
    if (attributes.visState === undefined) return {}
    const state = this.wire.object(this.wire.embedded(attributes.visState, '$.attributes.visState'), '$.attributes.visState')
    const type = this.wire.optionalString(state.type, '$.attributes.visState.type')
    const dimensions = this.wire.optionalArray(state.aggs, '$.attributes.visState.aggs').map((item, index) => {
      const path = `$.attributes.visState.aggs[${String(index)}]`
      const agg = this.wire.object(item, path)
      const params = this.wire.optionalObject(agg.params, `${path}.params`)
      const field = this.wire.optionalString(params?.field, `${path}.params.field`)
      const aggregation = this.wire.string(agg.type, `${path}.type`)
      return field === undefined ? aggregation : `${aggregation} of ${field}`
    })
    return { ...type === undefined ? {} : { visualizationType: type }, ...dimensions.length === 0 ? {} : { dimensions } }
  }
}

function values(value: unknown): unknown[] {
  return isJsonObject(value) ? Object.values(value) : []
}

function member(value: unknown, key: string): unknown {
  return isJsonObject(value) ? value[key] : undefined
}

/** Column labels of a Lens visualization, from every layer of every datasource. */
function lensColumns(state: JsonObject | undefined): string[] {
  const labels: string[] = []
  for (const datasource of values(state?.datasourceStates)) {
    for (const layer of values(member(datasource, 'layers'))) {
      for (const column of values(member(layer, 'columns'))) {
        const label = member(column, 'label')
        if (typeof label === 'string') labels.push(label)
      }
    }
  }
  return labels
}

/** The type-specific members of one saved object. */
const DETAILS: Readonly<Record<SavedObjectType, (reader: AttributeReader, attributes: JsonObject) => Details>> = {
  'dashboard': (reader, attributes) => {
    const restore = attributes.timeRestore === true
    const from = reader.wire.optionalString(attributes.timeFrom, '$.attributes.timeFrom')
    const to = reader.wire.optionalString(attributes.timeTo, '$.attributes.timeTo')
    return {
      ...restore && from !== undefined && to !== undefined ? { timeRange: { from, to } } : {},
      ...reader.dataViews(),
      ...reader.queryAndFilters(reader.searchSource(attributes), '$.attributes.kibanaSavedObjectMeta.searchSourceJSON', 'filter'),
      ...reader.panels(attributes),
    }
  },
  'search': (reader, attributes) => {
    const columns = reader.strings(attributes.columns, '$.attributes.columns')
    const sort = reader.sort(attributes.sort)
    return {
      ...reader.dataViews(),
      ...reader.queryAndFilters(reader.searchSource(attributes), '$.attributes.kibanaSavedObjectMeta.searchSourceJSON', 'filter'),
      ...columns.length === 0 ? {} : { columns },
      ...sort.length === 0 ? {} : { sort },
    }
  },
  'visualization': (reader, attributes) => ({
    ...reader.visualization(attributes),
    ...reader.dataViews(),
    ...reader.savedSearch(),
    ...reader.queryAndFilters(reader.searchSource(attributes), '$.attributes.kibanaSavedObjectMeta.searchSourceJSON', 'filter'),
  }),
  'lens': (reader, attributes) => {
    const type = reader.wire.optionalString(attributes.visualizationType, '$.attributes.visualizationType')
    const state = reader.wire.optionalObject(attributes.state, '$.attributes.state')
    const dimensions = lensColumns(state)
    return {
      ...type === undefined ? {} : { visualizationType: type },
      ...dimensions.length === 0 ? {} : { dimensions },
      ...reader.dataViews(),
      ...reader.queryAndFilters(state, '$.attributes.state', 'filters'),
    }
  },
  'index-pattern': (reader, attributes) => {
    const name = reader.wire.optionalString(attributes.name, '$.attributes.name')
    const timeFieldName = reader.wire.optionalString(attributes.timeFieldName, '$.attributes.timeFieldName')
    return {
      ...name === undefined || name === '' ? {} : { name },
      ...timeFieldName === undefined || timeFieldName === '' ? {} : { timeFieldName },
    }
  },
}

/**
 * Read one saved object and resolve the titles of the objects it references.
 * @param call - the tool call's requests.
 * @param type - the object type.
 * @param id - the object id; it is URL-encoded into the path.
 * @param limits - the cap on each filter description.
 * @returns the object's value.
 */
export async function readSavedObject(
  call: KibanaCall, type: SavedObjectType, id: string, limits: KibanaLimits,
): Promise<SavedObjectValue> {
  const one = TYPE_NAMES[type].one
  const purpose = `the ${one} ${id}`
  const raw = await call.request({
    method: 'GET',
    path: `/api/saved_objects/${type}/${encodeURIComponent(id)}`,
    purpose,
    notFound: `No ${one} with id ${id} exists in this Kibana space. Find ids with kibana_saved_objects.`,
  })
  const wire = new WireReader(purpose)
  const body = wire.object(raw, '$')
  const attributes = wire.object(body.attributes, '$.attributes')
  const references = wire.optionalArray(body.references, '$.references').map((item, index): NamedReference => {
    const path = `$.references[${String(index)}]`
    const reference = wire.object(item, path)
    return { name: wire.string(reference.name, `${path}.name`), type: wire.string(reference.type, `${path}.type`), id: wire.string(reference.id, `${path}.id`) }
  })
  const description = wire.optionalString(attributes.description, '$.attributes.description')
  const updatedAt = wire.optionalString(body.updated_at, '$.updated_at')
  const reader = new AttributeReader(wire, references, await referenceTitles(call, references), limits.maxFieldChars)
  return {
    type,
    id,
    title: wire.optionalString(attributes.title, '$.attributes.title') ?? '',
    ...description === undefined || description === '' ? {} : { description },
    ...updatedAt === undefined ? {} : { updatedAt },
    ...DETAILS[type](reader, attributes),
  }
}

const QUERY_LANGUAGES: Readonly<Record<string, string>> = { kuery: 'KQL', lucene: 'Lucene' }

function referenceText(reference: Reference, max: number): string {
  return `${clip(reference.title ?? '(title unavailable)', max)} (${reference.type} ${reference.id})`
}

/**
 * Render one saved object.
 * @param value - the object's value.
 * @param limits - output caps.
 * @returns the bounded text.
 */
export function renderSavedObject(value: SavedObjectValue, limits: KibanaLimits): string {
  const max = limits.maxFieldChars
  const lines = [`${TYPE_NAMES[value.type].heading}: ${clip(value.title === '' ? '(untitled)' : value.title, max)}`, `ID: ${value.id}`]
  const add = (label: string, text: string | undefined) => { if (text !== undefined) lines.push(`${label}: ${text}`) }
  add('Description', value.description === undefined ? undefined : clip(oneLine(value.description), max))
  add('Updated', value.updatedAt)
  add('Type', value.visualizationType)
  add('Name', value.name === undefined ? undefined : clip(value.name, max))
  add('Time field', value.timeFieldName)
  add('Time range', value.timeRange === undefined ? undefined : `${value.timeRange.from} to ${value.timeRange.to}`)
  add('Data views', value.dataViews?.map(reference => referenceText(reference, max)).join(', '))
  add('Built on saved search', value.savedSearch === undefined ? undefined : referenceText(value.savedSearch, max))
  if (value.query !== undefined) {
    const language = value.query.language === undefined ? '' : ` (${QUERY_LANGUAGES[value.query.language] ?? value.query.language})`
    lines.push(`Query${language}: ${clip(oneLine(value.query.query), max)}`)
  }
  if (value.filters !== undefined) lines.push('Filters:', ...value.filters.map(filter => `- ${filter}`))
  add('Columns', value.columns?.join(', '))
  add('Sort', value.sort?.join(', '))
  add('Shows', value.dimensions?.map(dimension => clip(dimension, max)).join('; '))
  if (value.panels !== undefined) {
    lines.push(`Panels (${String(value.panels.length)}):`)
    for (const [index, panel] of value.panels.entries()) {
      const title = panel.title === undefined ? '' : ` "${clip(panel.title, max)}"`
      const shows = panel.object === undefined ? ' (stored in the dashboard)' : `: ${referenceText(panel.object, max)}`
      lines.push(`${String(index + 1)}. ${panel.type}${title}${shows}`)
    }
  }
  return capOutput(lines.join('\n'), limits.maxOutputChars)
}
