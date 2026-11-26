/**
 * HTTP access to one Kibana deployment: per-request credentials, one deadline per tool call, and
 * the translation of every failed answer into a {@link KibanaError}.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { normalizeApiKey, resolveCredentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { KibanaError } from './error.ts'
import { oneLine } from './format.ts'
import { isJsonObject, parseJsonText, type Json } from './wire.ts'

/** How requests authenticate; credential values are resolved for every request. */
export type KibanaAuth =
  | { readonly kind: 'none' }
  | { readonly kind: 'basic'; readonly username: string; readonly passwordRef: CredentialRef }
  | { readonly kind: 'api-key'; readonly apiKeyRef: CredentialRef }

/** Connection settings resolved from the plugin configuration. */
export interface KibanaClientOptions {
  /** Kibana origin, base path, and space prefix without a trailing slash; API paths are appended. */
  readonly base: string
  /** Credentials sent with every request. */
  readonly auth: KibanaAuth
  /** Budget for all Kibana requests of one tool call. */
  readonly timeoutMs: number
}

/** One request a tool sends. The tool, never the model, chooses its method and path. */
export interface KibanaRequest {
  /** HTTP method. */
  readonly method: 'GET' | 'POST'
  /** Path below {@link KibanaClientOptions.base}, starting with `/api/`. */
  readonly path: string
  /** Query parameters. */
  readonly query?: URLSearchParams
  /** JSON request body. */
  readonly body?: Json
  /** What the request reads, as failure messages name it, such as `the data view list`. */
  readonly purpose: string
  /** Message of the `KIBANA_NOT_FOUND` failure for a 404 answer; without it a 404 is `KIBANA_UNREACHABLE`. */
  readonly notFound?: string
  /** Whether Kibana's Dev Tools console forwards the request to Elasticsearch. */
  readonly elasticsearch?: true
}

/**
 * Read one Elasticsearch failure cause as `<type>: <reason>`.
 * @param value - a cause object from an error body or a shard failure.
 * @returns the cause, or `undefined` when the value carries no reason.
 */
export function elasticsearchCause(value: unknown): string | undefined {
  if (!isJsonObject(value) || typeof value.reason !== 'string') return undefined
  return typeof value.type === 'string' ? `${value.type}: ${value.reason}` : value.reason
}

function firstItem(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : undefined
}

/**
 * Read the reason from an Elasticsearch error body: the first root cause and, when present, the
 * first failed shard's or the error's `caused_by`.
 * @param body - the parsed response body.
 * @returns the reason, or `undefined` when the body is not an Elasticsearch error.
 */
export function elasticsearchReason(body: unknown): string | undefined {
  const error = isJsonObject(body) ? body.error : undefined
  if (!isJsonObject(error)) return undefined
  const shard = firstItem(error.failed_shards)
  const detail = isJsonObject(shard) && isJsonObject(shard.reason) ? shard.reason.caused_by : error.caused_by
  const root = elasticsearchCause(firstItem(error.root_cause)) ?? elasticsearchCause(error)
  const reasons = [root, elasticsearchCause(detail)].filter(reason => reason !== undefined)
  return reasons.length === 0 ? undefined : reasons.join('; caused by ')
}

/**
 * Describe a transport failure by its innermost cause, such as `connect ECONNREFUSED`.
 * @param error - what `fetch` or the body read rejected with.
 * @returns the innermost message.
 */
export function failureDetail(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  return error.cause === undefined ? error.message : failureDetail(error.cause)
}

/** The plugin's Kibana connection; {@link open} starts the requests of one tool call. */
export class KibanaClient {
  /**
   * @param ctx - the plugin context, which resolves credential references.
   * @param options - connection settings.
   */
  constructor(private readonly ctx: Context, readonly options: KibanaClientOptions) {}

  /**
   * Start one tool call's requests under a deadline of `timeoutMs`.
   * @param signal - the tool call's cancellation.
   * @returns the call's request runner.
   */
  open(signal: AbortSignal): KibanaCall {
    return new KibanaCall(this, signal)
  }

  /**
   * Describe the credentials requests carry, for authentication failures.
   * @returns a phrase such as `user "alice" with the password from KIBANA_PASSWORD`.
   */
  credentials(): string {
    const auth = this.options.auth
    if (auth.kind === 'none') return 'no credentials, because the kibana plugin configures neither username nor apiKeyEnv'
    if (auth.kind === 'basic') return `user "${auth.username}" with the password from ${auth.passwordRef}`
    return `the API key from ${auth.apiKeyRef}`
  }

  /**
   * Build the `Authorization` header from the current credential value.
   * @returns the header value, or `undefined` when requests carry no credentials.
   */
  async authorization(): Promise<string | undefined> {
    const auth = this.options.auth
    if (auth.kind === 'none') return undefined
    if (auth.kind === 'basic') {
      const password = await resolveCredentialRef(this.ctx, auth.passwordRef)
      if (password === undefined) throw missingCredential('password', auth.passwordRef)
      return `Basic ${Buffer.from(`${auth.username}:${password}`, 'utf8').toString('base64')}`
    }
    const raw = await resolveCredentialRef(this.ctx, auth.apiKeyRef)
    if (raw === undefined) throw missingCredential('API key', auth.apiKeyRef)
    const key = normalizeApiKey(raw)
    if (!key.ok) {
      throw new KibanaError(
        `The Kibana API key in ${auth.apiKeyRef} is not usable (${key.reason === 'empty' ? 'it is blank' : 'it contains characters an HTTP header cannot carry'}). Ask the user to store the encoded API key that Kibana showed when the key was created.`,
        'KIBANA_CREDENTIAL_MISSING',
      )
    }
    return `ApiKey ${key.value}`
  }
}

function missingCredential(what: string, ref: CredentialRef): KibanaError {
  return new KibanaError(
    `The Kibana ${what} reference ${ref} holds no value. Ask the user to store ${ref} in the credential store or set it in the environment that starts dsh.`,
    'KIBANA_CREDENTIAL_MISSING',
  )
}

/** The requests of one tool call, sharing its cancellation and one deadline. */
export class KibanaCall {
  private readonly deadline: AbortSignal
  private readonly signal: AbortSignal

  /**
   * @param client - the plugin's connection.
   * @param caller - the tool call's cancellation; its abort propagates unchanged.
   */
  constructor(private readonly client: KibanaClient, private readonly caller: AbortSignal) {
    this.deadline = AbortSignal.timeout(client.options.timeoutMs)
    this.signal = AbortSignal.any([caller, this.deadline])
  }

  /**
   * Send one request and return its JSON body.
   * @param request - method, path, and how failures read.
   * @returns the parsed body of a 2xx answer, not yet validated.
   */
  async request(request: KibanaRequest): Promise<unknown> {
    const headers: Record<string, string> = { 'accept': 'application/json', 'kbn-xsrf': 'true' }
    const authorization = await this.client.authorization()
    if (authorization !== undefined) headers.authorization = authorization
    if (request.body !== undefined) headers['content-type'] = 'application/json'
    const query = request.query === undefined ? '' : `?${request.query.toString()}`
    let response: Response
    let text: string
    try {
      response = await fetch(`${this.client.options.base}${request.path}${query}`, {
        method: request.method,
        headers,
        ...request.body === undefined ? {} : { body: JSON.stringify(request.body) },
        redirect: 'manual',
        signal: this.signal,
      })
      text = await response.text()
    } catch (error) {
      throw this.transportFailure(error, request.purpose)
    }
    return this.answer(request, response, text)
  }

  /**
   * Send one Elasticsearch request through Kibana's Dev Tools console.
   * @param method - the Elasticsearch method.
   * @param path - the Elasticsearch path and query, such as `logs-*\/_search`.
   * @param purpose - what the request reads.
   * @param body - the Elasticsearch request body.
   * @returns the parsed body of a 2xx answer, not yet validated.
   */
  elasticsearch(method: 'GET' | 'POST', path: string, purpose: string, body?: Json): Promise<unknown> {
    return this.request({
      method: 'POST',
      path: '/api/console/proxy',
      query: new URLSearchParams({ path, method }),
      ...body === undefined ? {} : { body },
      purpose,
      elasticsearch: true,
    })
  }

  private transportFailure(error: unknown, purpose: string): unknown {
    if (this.caller.aborted) return error
    if (this.deadline.aborted) {
      return new KibanaError(
        `Kibana did not answer ${purpose} within ${String(this.client.options.timeoutMs)} ms. Narrow the time range or the request, or ask the user to raise the kibana plugin's timeoutMs.`,
        'KIBANA_TIMEOUT',
        { cause: error },
      )
    }
    return new KibanaError(
      `Could not reach Kibana for ${purpose}: ${failureDetail(error)}. Ask the user to check the kibana plugin's url and the network path to Kibana; an intranet Kibana behind a proxy must be listed in no_proxy.`,
      'KIBANA_UNREACHABLE',
      { cause: error },
    )
  }

  private answer(request: KibanaRequest, response: Response, text: string): unknown {
    const { status } = response
    const parsed = parseJsonText(text)
    if (status >= 200 && status < 300) {
      if (parsed !== undefined) return parsed.value
      throw new KibanaError(
        `Kibana answered ${request.purpose} with a body that is not JSON. Ask the user to check that the kibana plugin's url points at Kibana, including any base path.`,
        'KIBANA_BAD_RESPONSE',
      )
    }
    if (status < 400) {
      const location = response.headers.get('location')
      throw new KibanaError(
        `Kibana answered ${request.purpose} with a redirect (HTTP ${String(status)})${location === null ? '' : ` to ${location}`}. Ask the user to check the kibana plugin's url, including any base path; the tools do not follow redirects.`,
        'KIBANA_UNREACHABLE',
      )
    }
    const body = parsed?.value
    const who = this.client.credentials()
    const reason = request.elasticsearch === true ? elasticsearchReason(body) : undefined
    if (reason !== undefined) {
      const detail = oneLine(reason)
      if (status === 401 || status === 403) {
        throw new KibanaError(
          `Elasticsearch refused ${request.purpose} for ${who} (HTTP ${String(status)}): ${detail}. Ask the user to grant the account read access to the index.`,
          'KIBANA_AUTH_FAILED',
        )
      }
      throw new KibanaError(`Elasticsearch rejected ${request.purpose} (HTTP ${String(status)}): ${detail}. Fix the request and try again.`, 'KIBANA_QUERY_FAILED')
    }
    const message = oneLine(isJsonObject(body) && typeof body.message === 'string' ? body.message : text.trim())
    const detail = message === '' ? '' : `: ${message}`
    if (status === 401) {
      throw new KibanaError(
        `Kibana rejected the credentials for ${request.purpose} (HTTP 401${detail}); the request carried ${who}. Ask the user to check the kibana plugin's credentials.`,
        'KIBANA_AUTH_FAILED',
      )
    }
    if (status === 403) {
      const privilege = request.elasticsearch === true
        ? 'kibana_fields and kibana_search run through Kibana Dev Tools, so the account needs the Dev Tools privilege and read access to the index.'
        : 'The account needs read access to saved objects in this Kibana space.'
      throw new KibanaError(`Kibana refused ${request.purpose} for ${who} (HTTP 403${detail}). ${privilege}`, 'KIBANA_AUTH_FAILED')
    }
    if (status === 404 && request.notFound !== undefined) throw new KibanaError(request.notFound, 'KIBANA_NOT_FOUND')
    throw new KibanaError(
      `Kibana answered ${request.purpose} with HTTP ${String(status)}${detail}. Ask the user to check that the kibana plugin's url points at a healthy Kibana, including any base path.`,
      'KIBANA_UNREACHABLE',
    )
  }
}
