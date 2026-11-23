/** Limits the plugin configuration hands to the Kibana tools. @module */

/** Output and request limits shared by the Kibana tools. */
export interface KibanaLimits {
  /** Largest `size` one search may request. */
  readonly maxHits: number
  /** Cap on the complete text one tool call returns, notes included. */
  readonly maxOutputChars: number
  /** Cap on one displayed value: a hit field, a title, a description, or a filter. */
  readonly maxFieldChars: number
  /** Start of a search's time range when the call gives no `from`. */
  readonly defaultFrom: string
  /** Tool-call budget: the request budget plus a grace for the plugin's own timeout failure. */
  readonly toolTimeoutMs: number
}
