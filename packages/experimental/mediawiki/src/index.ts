/**
 * Tools that search and read articles on a MediaWiki site, such as a local Wikipedia mirror,
 * through its `api.php`. Requests carry no credentials, so the wiki must allow anonymous reading.
 * @module @deepseek-ai/dsh-mediawiki
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { MediaWikiClient, parseApiUrl } from './client.ts'
import { registerWikiTools } from './tools.ts'

export { MediaWikiError, type MediaWikiErrorCode } from './error.ts'

/** Cordis identity for the MediaWiki tools. */
export const name = 'mediawiki'

/** Services required before activation. */
export const inject = ['tools', 'systemPrompt']

/** The wiki address and the tools' time and size limits. */
export interface Config {
  /** Absolute http(s) URL of the wiki's `api.php`, such as `http://wiki.intranet/w/api.php`. */
  apiUrl: string
  /** Budget for one HTTP request to the wiki, including reading its answer. */
  timeoutMs?: number
  /** Cap on the complete text one `wiki_read` returns. */
  maxContentChars?: number
  /** Default and maximum number of results one `wiki_search` returns. */
  searchLimit?: number
}

type ResolvedConfig = Required<Config>

/** Loader defaults and validation; a missing or malformed `apiUrl` fails the load. */
export const Config: Schema<Config, ResolvedConfig> = Schema.object({
  apiUrl: Schema.transform(Schema.string(), parseApiUrl).required(),
  timeoutMs: Schema.natural().min(1_000).max(120_000).default(15_000),
  maxContentChars: Schema.natural().min(1_000).max(1_000_000).default(40_000),
  searchLimit: Schema.natural().min(1).max(50).default(10),
})

/**
 * Register `wiki_search`, `wiki_read`, and their prompt guidance for the configured wiki.
 * @param ctx - context providing the tool and system-prompt registries.
 * @param input - the wiki address and limits.
 */
export function apply(ctx: Context, input: Config): void {
  const config = Config(input)
  const client = new MediaWikiClient({ apiUrl: config.apiUrl, timeoutMs: config.timeoutMs })
  registerWikiTools(ctx, client, { maxContentChars: config.maxContentChars, searchLimit: config.searchLimit })
}
