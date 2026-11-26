/**
 * Read-only tools over the user's Kibana 7.10 or later: list data views and fields, search
 * documents with aggregations, and read dashboards, visualizations, Lens visualizations, saved
 * searches, and data views. Credentials are resolved from credential references for every request.
 * @module @deepseek-ai/dsh-kibana
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { KibanaClient, type KibanaAuth } from './client.ts'
import { registerKibanaTools } from './tools.ts'

export { KibanaError, type KibanaErrorCode } from './error.ts'

/** Cordis identity of the Kibana tools plugin. */
export const name = 'kibana'

/** Services required before activation. */
export const inject = ['tools', 'systemPrompt']

/** Where Kibana is, how to authenticate, and the request and output limits. */
export interface Config {
  /** HTTP(S) base URL of Kibana, including any base path, such as `https://host/kibana`. */
  url: string
  /** Kibana space id; every API path is then prefixed with `/s/<space>`. */
  space?: string
  /** Username for HTTP Basic authentication with the password behind {@link passwordEnv}. */
  username?: string
  /** Credential reference holding the Basic authentication password; used only with {@link username}. */
  passwordEnv?: string
  /** Credential reference holding an encoded Kibana API key, sent as `Authorization: ApiKey <key>`. */
  apiKeyEnv?: string
  /** Budget for all Kibana requests of one tool call. */
  timeoutMs?: number
  /** Largest number of hits one search returns. */
  maxHits?: number
  /** Cap on the complete text one tool call returns. */
  maxOutputChars?: number
  /** Cap on one displayed value: a hit field, a title, a description, or a filter. */
  maxFieldChars?: number
  /** Elasticsearch date math that starts a search's time range when the call gives no `from`. */
  defaultFrom?: string
}

type ResolvedConfig = Required<Pick<Config, 'url' | 'passwordEnv' | 'timeoutMs' | 'maxHits' | 'maxOutputChars' | 'maxFieldChars' | 'defaultFrom'>>
  & Pick<Config, 'space' | 'username' | 'apiKeyEnv'>

/** A POSIX identifier, the grammar of a credential reference. */
const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/u

/** Loader defaults and validation. */
export const Config: Schema<Config, ResolvedConfig> = Schema.object({
  url: Schema.string().pattern(/^https?:\/\/[^\s/?#@]+(?:\/[^\s?#]*)?$/iu).required(),
  space: Schema.string().pattern(/^[a-z0-9_-]+$/u),
  username: Schema.string().pattern(/^[^:]+$/u),
  passwordEnv: Schema.string().role('credential-ref').pattern(CREDENTIAL_REF).default('KIBANA_PASSWORD'),
  apiKeyEnv: Schema.string().role('credential-ref').pattern(CREDENTIAL_REF),
  timeoutMs: Schema.natural().min(1_000).max(600_000).default(30_000),
  maxHits: Schema.natural().min(1).max(500).default(20),
  maxOutputChars: Schema.natural().min(1_000).max(1_000_000).default(50_000),
  maxFieldChars: Schema.natural().min(20).max(100_000).default(500),
  defaultFrom: Schema.string().pattern(/\S/u).default('now-24h'),
})

/** Grace the tool budget adds over the request budget, so the plugin's own timeout failure arrives first. */
const TOOL_GRACE_MS = 5_000

/**
 * Validate the configuration and register the Kibana tools.
 * @param ctx - context providing the tool and system-prompt registries.
 * @param input - Kibana location, credentials, and limits.
 * @throws TypeError when both `username` and `apiKeyEnv` are set or the URL does not parse.
 */
export function apply(ctx: Context, input: Config): void {
  const config = Config(input)
  if (config.username !== undefined && config.apiKeyEnv !== undefined) {
    throw new TypeError('kibana: set username (with passwordEnv) for Basic authentication or apiKeyEnv for an API key, not both')
  }
  const url = new URL(config.url)
  const base = `${url.origin}${url.pathname.replace(/\/+$/u, '')}${config.space === undefined ? '' : `/s/${config.space}`}`
  const auth: KibanaAuth = config.username !== undefined
    ? { kind: 'basic', username: config.username, passwordRef: credentialRef(config.passwordEnv) }
    : config.apiKeyEnv === undefined ? { kind: 'none' } : { kind: 'api-key', apiKeyRef: credentialRef(config.apiKeyEnv) }
  registerKibanaTools(ctx, new KibanaClient(ctx, { base, auth, timeoutMs: config.timeoutMs }), {
    maxHits: config.maxHits,
    maxOutputChars: config.maxOutputChars,
    maxFieldChars: config.maxFieldChars,
    defaultFrom: config.defaultFrom,
    toolTimeoutMs: config.timeoutMs + TOOL_GRACE_MS,
  })
}
