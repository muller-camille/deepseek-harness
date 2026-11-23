/** Machine-routable failures of the Kibana tools. @module */

import { HarnessError } from '@deepseek-ai/dsh-error'

/**
 * Every {@link KibanaError} code:
 * - `KIBANA_CREDENTIAL_MISSING` — the configured credential reference holds no usable value.
 * - `KIBANA_AUTH_FAILED` — Kibana or Elasticsearch rejected the credentials or refused the account a privilege.
 * - `KIBANA_NOT_FOUND` — the requested saved object does not exist in the configured space.
 * - `KIBANA_UNREACHABLE` — the request failed on the network, was redirected, or Kibana answered another non-2xx status.
 * - `KIBANA_TIMEOUT` — the tool call's Kibana requests did not finish within `timeoutMs`.
 * - `KIBANA_QUERY_FAILED` — Elasticsearch rejected the search or field request; the message carries its reason.
 * - `KIBANA_BAD_RESPONSE` — Kibana answered with JSON the tools do not recognize.
 */
export type KibanaErrorCode =
  | 'KIBANA_CREDENTIAL_MISSING'
  | 'KIBANA_AUTH_FAILED'
  | 'KIBANA_NOT_FOUND'
  | 'KIBANA_UNREACHABLE'
  | 'KIBANA_TIMEOUT'
  | 'KIBANA_QUERY_FAILED'
  | 'KIBANA_BAD_RESPONSE'

/** Kibana tool failure carrying a stable {@link KibanaErrorCode}. */
export class KibanaError extends HarnessError {
  override readonly code: KibanaErrorCode

  /**
   * @param message - what failed and the next step for the model or the user.
   * @param code - the failure class consumers route on.
   * @param options - standard `cause` chaining.
   */
  constructor(message: string, code: KibanaErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'KibanaError'
    this.code = code
  }
}
