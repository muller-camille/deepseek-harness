/**
 * A loopback `node:http` server that answers like MediaWiki 1.43's `api.php` with `format=json`,
 * `formatversion=2`, and `errorformat=bc`: search, parse, siteinfo, and API error objects. Specs own
 * one instance each and close it in teardown.
 */

import { once } from 'node:events'
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http'

/** One request the fake wiki received. */
export interface WikiRequest {
  readonly pathname: string
  readonly params: URLSearchParams
  readonly headers: IncomingHttpHeaders
}

/**
 * Replaces the default answer: write the response and return `true`, or return `false` to let the
 * default MediaWiki behavior answer.
 */
export type WikiOverride = (request: WikiRequest, response: ServerResponse) => boolean

/** The Oracle Database article as MediaWiki 1.43 renders it with `disableeditsection` and `disabletoc`. */
export const ORACLE_HTML = [
  '<div class="mw-content-ltr mw-parser-output" lang="en" dir="ltr">',
  '<style data-mw-deduplicate="TemplateStyles:r1">.mw-parser-output .hatnote{font-style:italic}</style>',
  '<div role="note" class="hatnote navigation-not-searchable">For the company, see <a href="/wiki/Oracle_Corporation" title="Oracle Corporation">Oracle Corporation</a>.</div>',
  '<table class="infobox vevent"><tbody><tr><th class="infobox-label">Developer</th><td class="infobox-data">Oracle Corporation</td></tr>',
  '<tr><th class="infobox-label">Written in</th><td class="infobox-data">C</td></tr></tbody></table>',
  '<p class="mw-empty-elt"></p>',
  '<p><b>Oracle Database</b> is a proprietary <a href="/wiki/Multi-model_database" title="Multi-model database">multi-model database</a> &amp; RDBMS.<sup id="cite_ref-1" class="reference"><a href="#cite_note-1">[1]</a></sup></p>',
  '<figure typeof="mw:File/Thumb"><a href="/wiki/File:Oracle_logo.svg" class="mw-file-description"><img src="/w/images/a/a1/Oracle_logo.svg" width="220" height="29"></a><figcaption>The Oracle logo</figcaption></figure>',
  '<div class="mw-heading mw-heading2"><h2 id="History">History</h2></div>',
  '<p>Larry Ellison founded Software Development Laboratories in 1977.<br>The first release was Oracle V2.</p>',
  '<div class="mw-heading mw-heading3"><h3 id="Early_releases">Early releases</h3></div>',
  '<ul><li>Oracle V2 (1979)</li><li>Oracle V3 (1983)</li></ul>',
  '<div class="mw-heading mw-heading2"><h2 id="Features"><i>Features</i></h2></div>',
  '<p class="noprint">Edit this list</p>',
  '<p>Supports <a class="external text" href="https://www.oracle.com/database/" rel="nofollow">PL/SQL</a> and <a id="anchor-only">anchors</a>.</p>',
  '<script>alert(1)</script>',
  '<div role="navigation" class="navbox"><table class="nowraplinks"><tbody><tr><td>Navigation box</td></tr></tbody></table></div>',
  '<div class="mw-heading mw-heading2"><h2 id="References">References</h2></div>',
  '<div class="mw-references-wrap"><ol class="references"><li id="cite_note-1"><span class="mw-cite-backlink"><b><a href="#cite_ref-1">^</a></b></span> <span class="reference-text">Oracle documentation.</span></li></ol></div>',
  '</div>',
].join('')

/** The sections `prop=sections` lists for the Oracle Database article, including one transcluded from a template. */
export const ORACLE_SECTIONS = [
  { toclevel: 1, level: '2', line: 'History', number: '1', index: '1', fromtitle: 'Oracle_Database', byteoffset: 1204, anchor: 'History', linkAnchor: 'History' },
  { toclevel: 2, level: '3', line: 'Early releases', number: '1.1', index: '2', fromtitle: 'Oracle_Database', byteoffset: 1680, anchor: 'Early_releases', linkAnchor: 'Early_releases' },
  { toclevel: 1, level: '2', line: '<i>Features</i> &amp; tools', number: '2', index: '3', fromtitle: 'Oracle_Database', byteoffset: 2210, anchor: 'Features', linkAnchor: 'Features' },
  { toclevel: 1, level: '2', line: 'See also', number: '3', index: 'T-1', fromtitle: 'Template:Database_footer', byteoffset: null, anchor: 'See_also', linkAnchor: 'See_also' },
  { toclevel: 1, level: '2', line: 'References', number: '4', index: '4', fromtitle: 'Oracle_Database', byteoffset: 2950, anchor: 'References', linkAnchor: 'References' },
]

const HISTORY_HTML = '<div class="mw-content-ltr mw-parser-output" lang="en" dir="ltr"><div class="mw-heading mw-heading2"><h2 id="History">History</h2></div><p>Larry Ellison founded Software Development Laboratories in 1977.</p></div>'

const SITE_GENERAL = {
  mainpage: 'Main Page',
  base: 'http://wiki.test/wiki/Main_Page',
  sitename: 'Test Wiki',
  generator: 'MediaWiki 1.43.0',
  server: '//wiki.test',
  servername: 'wiki.test',
  articlepath: '/wiki/$1',
  scriptpath: '/w',
  script: '/w/index.php',
}

const SEARCH_HITS = [
  {
    ns: 0,
    title: 'Oracle Database',
    pageid: 2484,
    size: 48120,
    wordcount: 5210,
    snippet: '<span class="searchmatch">Oracle</span> Database (commonly referred to as <span class="searchmatch">Oracle</span> DBMS) is a proprietary multi-model database &amp; RDBMS',
    timestamp: '2024-11-02T08:15:30Z',
  },
  {
    ns: 0,
    title: 'Oracle Corporation',
    pageid: 22742,
    size: 90211,
    wordcount: 980,
    snippet: '',
    timestamp: '2023-05-17T21:04:00Z',
  },
]

function apiError(code: string, info: string) {
  return { error: { code, info, docref: 'See http://wiki.test/w/api.php for API usage.' }, servedby: 'wiki-test' }
}

function parseAnswer(params: URLSearchParams): unknown {
  const requested = params.get('page') ?? ''
  if (requested.includes('|')) return apiError('invalidtitle', `Bad title "${requested}".`)
  const redirected = requested === 'Oracle DB'
  if (requested !== 'Oracle Database' && !redirected) return apiError('missingtitle', 'The page you specified doesn\'t exist.')
  const section = params.get('section')
  if (section !== null && section !== '1') return apiError('nosuchsection', `There is no section ${section} in Oracle Database.`)
  return {
    parse: {
      title: 'Oracle Database',
      pageid: 2484,
      ...redirected ? { redirects: [{ from: 'Oracle DB', to: 'Oracle Database' }] } : {},
      text: section === null ? ORACLE_HTML : HISTORY_HTML,
      sections: section === null ? ORACLE_SECTIONS : [],
      displaytitle: '<span class="mw-page-title-main">Oracle Database</span>',
    },
  }
}

function searchAnswer(params: URLSearchParams): unknown {
  const query = params.get('srsearch')
  if (query === 'oracel') return { batchcomplete: true, query: { searchinfo: { totalhits: 0, suggestion: 'oracle', suggestionsnippet: 'oracle' }, search: [] } }
  if (query !== 'oracle') return { batchcomplete: true, query: { searchinfo: { totalhits: 0 }, search: [] } }
  const limit = Number(params.get('srlimit'))
  return {
    batchcomplete: true,
    continue: { sroffset: limit, continue: '-||' },
    query: { searchinfo: { totalhits: 120 }, search: SEARCH_HITS.slice(0, limit) },
  }
}

/**
 * The default answer of the fake `api.php`.
 * @param params - the request's query parameters.
 * @returns the JSON body.
 */
export function defaultAnswer(params: URLSearchParams): unknown {
  const action = params.get('action')
  if (action === 'parse') return parseAnswer(params)
  if (action === 'query' && params.get('meta') === 'siteinfo') return { batchcomplete: true, query: { general: SITE_GENERAL } }
  if (action === 'query' && params.get('list') === 'search') return searchAnswer(params)
  return apiError('badvalue', 'Unrecognized value for parameter "action".')
}

/**
 * Write a JSON answer the way MediaWiki does.
 * @param response - the response to finish.
 * @param body - the JSON value.
 * @param status - the HTTP status.
 */
export function sendJson(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

/** A running fake wiki; `apiUrl` addresses its `api.php`. */
export class FakeWiki {
  readonly requests: WikiRequest[] = []
  /** Per-test replacement for the default answers. */
  override: WikiOverride | undefined
  private readonly server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const record = { pathname: url.pathname, params: url.searchParams, headers: request.headers }
    this.requests.push(record)
    if (this.override?.(record, response) === true) return
    if (url.pathname !== '/w/api.php') {
      response.writeHead(404, { 'content-type': 'text/html' })
      response.end('<h1>Not Found</h1>')
      return
    }
    sendJson(response, defaultAnswer(url.searchParams))
  })

  private constructor() {}

  /** @returns a listening fake wiki on an ephemeral loopback port. */
  static async start(): Promise<FakeWiki> {
    const wiki = new FakeWiki()
    wiki.server.listen(0, '127.0.0.1')
    await once(wiki.server, 'listening')
    return wiki
  }

  /** The `api.php` URL of the listening server. */
  get apiUrl(): string {
    const address = this.server.address()
    if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
    return `http://127.0.0.1:${String(address.port)}/w/api.php`
  }

  /**
   * Requests for one action, in arrival order.
   * @param action - the `action` parameter, or `siteinfo` for `meta=siteinfo` queries.
   * @returns the matching requests.
   */
  requestsFor(action: 'parse' | 'search' | 'siteinfo'): WikiRequest[] {
    return this.requests.filter(request => action === 'parse'
      ? request.params.get('action') === 'parse'
      : action === 'search' ? request.params.get('list') === 'search' : request.params.get('meta') === 'siteinfo')
  }

  /** Close every connection, including requests a test left hanging, and stop listening. */
  async close(): Promise<void> {
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => { this.server.close(() => { resolve() }) })
  }
}
