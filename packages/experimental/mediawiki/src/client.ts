/**
 * HTTP access to one wiki's `api.php`: request parameters, per-request timeouts, failure
 * classification, and validation of the JSON fields the tools read. API answers are untrusted
 * input; requests go through the global `fetch`, so the process-wide proxy policy routes them.
 * @module
 */

import { MediaWikiError } from './error.ts'

/** Identifies these requests in the wiki's access logs; independent of the package version. */
const USER_AGENT = 'DeepSeek-Harness-MediaWiki/1.0 (+https://github.com/deepseek-ai/deepseek-harness)'

/** Answer format every request pins: formatversion 2 JSON with `{ code, info }` error objects. */
const FORMAT_PARAMETERS = { format: 'json', formatversion: '2', errorformat: 'bc' } as const

const CHECK_ADDRESS = 'Tell the user to check that the wiki tools are configured with the address of the wiki\'s api.php.'

/** API error codes for a title that names no readable page. */
const NOT_FOUND_CODES: ReadonlySet<string> = new Set(['missingtitle', 'invalidtitle'])

/** Next steps appended to the wiki's own text for API errors the model can act on. */
const API_ERROR_HINTS: ReadonlyMap<string, string> = new Map([
  ['nosuchsection', 'Call wiki_read without section to list the article\'s sections.'],
  ['readapidenied', 'This wiki requires signing in to read, which the wiki tools do not support; tell the user.'],
])

/** The date-and-time prefix of MediaWiki's ISO 8601 timestamps. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T/u

/** Title characters MediaWiki's `wfUrlencode` leaves readable in article URLs. */
const READABLE_ESCAPES = /%(?:3B|40|24|2C|2F|3A)/giu

/** Connection and timing for one wiki. */
export interface MediaWikiClientOptions {
  /** Validated absolute http(s) URL of the wiki's `api.php`. */
  readonly apiUrl: string
  /** Budget for one HTTP request, including reading its body. */
  readonly timeoutMs: number
}

/** One `list=search` result. */
export interface SearchHit {
  /** Page title that `action=parse` accepts. */
  readonly title: string
  /** Word count of the page. */
  readonly wordCount: number
  /** ISO 8601 time of the latest edit. */
  readonly timestamp: string
  /** Matched text as HTML with `searchmatch` highlight spans. */
  readonly snippetHtml: string
}

/** One `list=search` answer. */
export interface SearchAnswer {
  /** Total matches the search backend reports; absent when it reports none. */
  readonly totalHits?: number
  /** The search backend's spelling suggestion for the query, as plain text. */
  readonly suggestion?: string
  /** Results in the backend's ranking order. */
  readonly hits: readonly SearchHit[]
}

/** One heading of a parsed article. */
export interface ArticleSection {
  /** Section number that `action=parse&section=` accepts. */
  readonly index: number
  /** Table-of-contents nesting from 1 (top-level headings) to 6. */
  readonly level: number
  /** Heading text as HTML. */
  readonly headingHtml: string
}

/** One `action=parse` answer. */
export interface ParsedArticle {
  /** Canonical title after redirects. */
  readonly title: string
  /** Display title as HTML. */
  readonly displayTitleHtml: string
  /** Parser output HTML. */
  readonly html: string
  /** Headings this page can read by number; headings transcluded from templates are left out. */
  readonly sections: readonly ArticleSection[]
  /** Title the request named when the wiki followed a redirect. */
  readonly redirectedFrom?: string
}

/** Where the wiki serves articles, from `meta=siteinfo&siprop=general`. */
export interface SiteFacts {
  /** `$wgServer`, possibly protocol-relative. */
  readonly server: string
  /** `$wgArticlePath`, where `$1` stands for the title. */
  readonly articlePath: string
}

type JsonRecord = Readonly<Record<string, unknown>>

/**
 * Validate the configured `api.php` address. Runs at plugin load, so a misconfigured address fails
 * before any tool is registered.
 * @param value - the configured address.
 * @returns the normalized absolute URL.
 * @throws Error naming the setting and the required form.
 */
export function parseApiUrl(value: string): string {
  const url = URL.parse(value)
  const form = 'such as http://wiki.intranet/w/api.php'
  if (url === null || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new Error(`mediawiki: apiUrl must be the absolute http(s) URL of the wiki's api.php, ${form}; got ${JSON.stringify(value)}`)
  }
  if (url.username !== '' || url.password !== '') throw new Error('mediawiki: apiUrl must not contain a user name or password; the wiki tools read public wikis without signing in')
  if (url.search !== '' || url.hash !== '') throw new Error(`mediawiki: apiUrl must not contain a query or fragment, ${form}`)
  if (!url.pathname.endsWith('/api.php')) throw new Error(`mediawiki: apiUrl must name the wiki's api.php endpoint, ${form}; got ${JSON.stringify(value)}`)
  return url.href
}

/**
 * Percent-encode a title the way MediaWiki writes it into article URLs: spaces become underscores,
 * and `;@$,/:` stay readable.
 * @param title - the page title.
 * @returns the encoded title for `$1` in the article path.
 */
export function encodeTitle(title: string): string {
  return encodeURIComponent(title.replaceAll(' ', '_')).replace(READABLE_ESCAPES, escape => decodeURIComponent(escape))
}

/**
 * Build the browser URL of an article.
 * @param site - the wiki's server and article path.
 * @param title - the canonical page title.
 * @param apiUrl - the `api.php` URL, which supplies the scheme for a protocol-relative server.
 * @returns the absolute http(s) URL, or `undefined` when the site facts do not form one.
 */
export function articleUrl(site: SiteFacts, title: string, apiUrl: string): string | undefined {
  // A replacer function keeps `$&` and similar sequences in titles literal.
  const url = URL.parse(`${site.server}${site.articlePath.replace('$1', () => encodeTitle(title))}`, apiUrl)
  return url !== null && (url.protocol === 'http:' || url.protocol === 'https:') ? url.href : undefined
}

/**
 * The message of the deepest `cause` in an error chain. undici reports a socket failure as the
 * cause of a generic "fetch failed" error.
 * @param error - the thrown value.
 * @returns the most specific message available.
 */
export function innermostMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  return error.cause === undefined ? error.message : innermostMessage(error.cause)
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function malformed(path: string, expected: string): MediaWikiError {
  return new MediaWikiError(`The wiki's answer has no valid ${path} (expected ${expected}). ${CHECK_ADDRESS}`, 'WIKI_BAD_RESPONSE')
}

function readRecord(value: unknown, path: string): JsonRecord {
  if (isRecord(value)) return value
  throw malformed(path, 'an object')
}

function readList(value: unknown, path: string): readonly unknown[] {
  if (Array.isArray(value)) return value
  throw malformed(path, 'an array')
}

function readString(value: unknown, path: string): string {
  if (typeof value === 'string') return value
  throw malformed(path, 'a string')
}

function readInteger(value: unknown, path: string, min: number, max: number): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) return value
  throw malformed(path, `an integer from ${min} to ${max}`)
}

function readTimestamp(value: unknown, path: string): string {
  const text = readString(value, path)
  if (ISO_TIMESTAMP.test(text)) return text
  throw malformed(path, 'an ISO 8601 timestamp')
}

/** Classify an API `error` object, or return `undefined` for an answer without one. */
function apiFailure(json: JsonRecord): MediaWikiError | undefined {
  if (json.error === undefined) return undefined
  const error = readRecord(json.error, 'error')
  const code = readString(error.code, 'error.code')
  const info = readString(error.info, 'error.info')
  if (NOT_FOUND_CODES.has(code)) return new MediaWikiError(`${info} Call wiki_search to find the exact article title.`, 'WIKI_PAGE_NOT_FOUND')
  const hint = API_ERROR_HINTS.get(code)
  return new MediaWikiError(`The wiki refused the request (${code}): ${info}${hint === undefined ? '' : ` ${hint}`}`, 'WIKI_API_ERROR')
}

function searchAnswer(json: JsonRecord): SearchAnswer {
  const query = readRecord(json.query, 'query')
  const info: JsonRecord = query.searchinfo === undefined ? {} : readRecord(query.searchinfo, 'query.searchinfo')
  const hits = readList(query.search, 'query.search').map((entry, position): SearchHit => {
    const path = `query.search[${position}]`
    const hit = readRecord(entry, path)
    return {
      title: readString(hit.title, `${path}.title`),
      wordCount: readInteger(hit.wordcount, `${path}.wordcount`, 0, Number.MAX_SAFE_INTEGER),
      timestamp: readTimestamp(hit.timestamp, `${path}.timestamp`),
      snippetHtml: readString(hit.snippet, `${path}.snippet`),
    }
  })
  return {
    ...info.totalhits === undefined ? {} : { totalHits: readInteger(info.totalhits, 'query.searchinfo.totalhits', 0, Number.MAX_SAFE_INTEGER) },
    ...info.suggestion === undefined ? {} : { suggestion: readString(info.suggestion, 'query.searchinfo.suggestion') },
    hits,
  }
}

function parsedArticle(json: JsonRecord): ParsedArticle {
  const parse = readRecord(json.parse, 'parse')
  const sections = readList(parse.sections, 'parse.sections').flatMap((entry, position): ArticleSection[] => {
    const path = `parse.sections[${position}]`
    const section = readRecord(entry, path)
    const index = readString(section.index, `${path}.index`)
    // Headings transcluded from templates carry indexes such as `T-1`, which this page's `section=` cannot read.
    if (!/^\d+$/u.test(index)) return []
    return [{ index: Number(index), level: readInteger(section.toclevel, `${path}.toclevel`, 1, 6), headingHtml: readString(section.line, `${path}.line`) }]
  })
  const redirect = parse.redirects === undefined ? undefined : readList(parse.redirects, 'parse.redirects')[0]
  return {
    title: readString(parse.title, 'parse.title'),
    displayTitleHtml: readString(parse.displaytitle, 'parse.displaytitle'),
    html: readString(parse.text, 'parse.text'),
    sections,
    ...redirect === undefined ? {} : { redirectedFrom: readString(readRecord(redirect, 'parse.redirects[0]').from, 'parse.redirects[0].from') },
  }
}

function siteFacts(json: JsonRecord): SiteFacts {
  const general = readRecord(readRecord(json.query, 'query').general, 'query.general')
  const articlePath = readString(general.articlepath, 'query.general.articlepath')
  if (!articlePath.includes('$1')) throw malformed('query.general.articlepath', 'a path containing $1')
  return { server: readString(general.server, 'query.general.server'), articlePath }
}

/** Reads one wiki's API. One instance serves one plugin activation and owns that activation's site facts. */
export class MediaWikiClient {
  /** Site facts from the first successful `siteinfo` read; failures are not cached. */
  private site: SiteFacts | undefined
  private readonly origin: string

  /** @param options - the validated address and the per-request budget. */
  constructor(private readonly options: MediaWikiClientOptions) {
    this.origin = new URL(options.apiUrl).origin
  }

  /**
   * Full-text search over articles in the main namespace.
   * @param query - the search terms.
   * @param limit - maximum results, already clamped to the configured bound.
   * @param signal - the tool call's cancellation.
   * @returns the validated answer.
   */
  async search(query: string, limit: number, signal: AbortSignal): Promise<SearchAnswer> {
    return searchAnswer(await this.request({
      action: 'query',
      list: 'search',
      srsearch: query,
      srnamespace: '0',
      srlimit: String(limit),
      srprop: 'snippet|wordcount|timestamp',
      srinfo: 'totalhits|suggestion',
    }, signal))
  }

  /**
   * Render an article, or one of its sections, following redirects.
   * @param title - the page title.
   * @param section - section number, or `undefined` for the whole article.
   * @param signal - the tool call's cancellation.
   * @returns the validated parser output.
   */
  async parse(title: string, section: number | undefined, signal: AbortSignal): Promise<ParsedArticle> {
    return parsedArticle(await this.request({
      action: 'parse',
      page: title,
      prop: 'text|sections|displaytitle',
      redirects: '1',
      disableeditsection: '1',
      disabletoc: '1',
      ...section === undefined ? {} : { section: String(section) },
    }, signal))
  }

  /**
   * Resolve an article's browser URL. The first call that reads `siteinfo` successfully caches the
   * site facts for this client's lifetime; a failed read yields `undefined`, and a later call asks again.
   * @param title - the canonical page title.
   * @param signal - the tool call's cancellation; aborting it rejects instead of yielding `undefined`.
   * @returns the article URL, or `undefined` when the wiki does not supply one.
   */
  async articleUrl(title: string, signal: AbortSignal): Promise<string | undefined> {
    const site = this.site ?? await this.readSite(signal)
    return site === undefined ? undefined : articleUrl(site, title, this.options.apiUrl)
  }

  private async readSite(signal: AbortSignal): Promise<SiteFacts | undefined> {
    let site: SiteFacts
    try {
      site = siteFacts(await this.request({ action: 'query', meta: 'siteinfo', siprop: 'general' }, signal))
    } catch (error: unknown) {
      // The URL line is optional, so this read omits it. Cancellation still ends the tool call.
      if (signal.aborted) throw error
      return undefined
    }
    this.site = site
    return site
  }

  /** Send one GET with the pinned answer format and return its JSON, classifying every failure. */
  private async request(parameters: Readonly<Record<string, string>>, signal: AbortSignal): Promise<JsonRecord> {
    const url = new URL(this.options.apiUrl)
    for (const [key, value] of Object.entries({ ...parameters, ...FORMAT_PARAMETERS })) url.searchParams.set(key, value)
    const deadline = AbortSignal.timeout(this.options.timeoutMs)
    let response: Response
    let text: string
    try {
      response = await fetch(url, {
        headers: { 'accept': 'application/json', 'user-agent': USER_AGENT },
        signal: AbortSignal.any([signal, deadline]),
      })
      text = await response.text()
    } catch (error: unknown) {
      // The tool pipeline reports the caller's own cancellation; rethrowing keeps its identity.
      if (signal.aborted) throw error
      if (deadline.aborted) {
        throw new MediaWikiError(`The wiki at ${this.origin} did not answer within ${this.options.timeoutMs / 1000} seconds. Try again later, or tell the user that the wiki is slow or down.`, 'WIKI_TIMEOUT', { cause: error })
      }
      throw new MediaWikiError(`Could not reach the wiki at ${this.origin}: ${innermostMessage(error)}. Tell the user that the wiki is unreachable from DeepSeek Harness.`, 'WIKI_UNREACHABLE', { cause: error })
    }
    if (!response.ok) {
      throw new MediaWikiError(`The wiki at ${this.origin} answered HTTP ${response.status}. Try again later, or tell the user that the wiki's API is failing.`, 'WIKI_UNREACHABLE')
    }
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch (error: unknown) {
      throw new MediaWikiError(`The wiki at ${this.origin} answered with something other than JSON. ${CHECK_ADDRESS}`, 'WIKI_BAD_RESPONSE', { cause: error })
    }
    const answer = readRecord(json, 'top-level object')
    const failure = apiFailure(answer)
    if (failure !== undefined) throw failure
    return answer
  }
}
