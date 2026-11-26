/** Machine-routable failures of the MediaWiki tools. @module */

import { HarnessError } from '@deepseek-ai/dsh-error'

/**
 * Every {@link MediaWikiError} code:
 * - `WIKI_PAGE_NOT_FOUND` — the wiki reported the title missing (`missingtitle`) or invalid (`invalidtitle`).
 * - `WIKI_API_ERROR` — the wiki answered with another API error; the message carries the wiki's `info` text.
 * - `WIKI_UNREACHABLE` — the request failed on the network or the wiki answered a non-2xx HTTP status.
 * - `WIKI_TIMEOUT` — one request outlived the configured `timeoutMs`.
 * - `WIKI_BAD_RESPONSE` — the answer is not JSON, lacks the fields the tool reads, or holds HTML too deeply nested to convert.
 */
export const MEDIAWIKI_ERROR_CODES = [
  'WIKI_PAGE_NOT_FOUND',
  'WIKI_API_ERROR',
  'WIKI_UNREACHABLE',
  'WIKI_TIMEOUT',
  'WIKI_BAD_RESPONSE',
] as const

/** One code from {@link MEDIAWIKI_ERROR_CODES}. */
export type MediaWikiErrorCode = typeof MEDIAWIKI_ERROR_CODES[number]

/** MediaWiki tool failure carrying a stable {@link MediaWikiErrorCode}. */
export class MediaWikiError extends HarnessError {
  override readonly code: MediaWikiErrorCode

  /**
   * @param message - what failed and the next step for the model or the user.
   * @param code - the failure class consumers route on.
   * @param options - standard `cause` chaining.
   */
  constructor(message: string, code: MediaWikiErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'MediaWikiError'
    this.code = code
  }
}
