/**
 * Site rules shared by the service worker and the options page. Chrome match patterns carry no
 * port, so a grant covers every port of its host.
 */

/**
 * Normalize a DeepSeek Harness server address to its origin.
 * @param {string} input - an address such as `https://10.0.0.5:3080`.
 * @returns {string} the origin, for example `https://10.0.0.5:3080`.
 */
export function serverOrigin(input) {
  const url = new URL(input.trim())
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('The server address must start with https:// or http://.')
  return url.origin
}

/**
 * The host permission pattern that lets the relay run on a server origin.
 * @param {string} origin - a server origin.
 * @returns {string} a match pattern such as `https://10.0.0.5/*`.
 */
export function serverPattern(origin) {
  const url = new URL(origin)
  return `${url.protocol}//${url.hostname}/*`
}

/**
 * The host permission pattern for a site the agent may use.
 * @param {string} input - `example.com`, `*.example.com`, or a URL.
 * @returns {string} a match pattern covering HTTP and HTTPS, such as `*://example.com/*`.
 */
export function sitePattern(input) {
  const text = input.trim().toLowerCase()
  const wildcard = text.startsWith('*.')
  const host = wildcard ? text.slice(2) : /^[a-z][a-z0-9+.-]*:\/\//u.test(text) ? new URL(text).hostname : text.split('/')[0].split(':')[0]
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/u.test(host)) throw new Error(`"${input}" is not a host name.`)
  return `*://${wildcard ? '*.' : ''}${host}/*`
}

/**
 * The text shown to people and to the model for a granted pattern.
 * @param {string} pattern - a host match pattern.
 * @returns {string} for example `*.example.com` or `https://10.0.0.5`.
 */
export function displaySite(pattern) {
  return pattern.replace(/^\*:\/\//u, '').replace(/\/\*$/u, '')
}

/**
 * Whether a URL belongs to a configured server host; browser tools never operate the Web UI itself.
 * @param {string} url - the page URL.
 * @param {readonly string[]} servers - configured server origins.
 * @returns {boolean}
 */
export function isServerHost(url, servers) {
  const hostname = new URL(url).hostname
  return servers.some(origin => new URL(origin).hostname === hostname)
}
