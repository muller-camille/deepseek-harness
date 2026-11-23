/**
 * Service worker of the DeepSeek Harness browser bridge. The relay content script in a Web UI tab
 * forwards the server's commands over a runtime port; this worker runs them in the "DSH agent" tab
 * group and only on sites the user granted.
 */

import { actOnPage, hasElement, snapshotPage } from './page.js'
import { displaySite, isServerHost, serverPattern } from './sites.js'

const PROTOCOL = 1
const VERSION = chrome.runtime.getManifest().version
const RELAY_ID = 'dsh-relay'
const POLL_MS = 150

/** Ports of connected relays, each with the commands it is running. */
const relays = new Map()

class BridgeFailure extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function servers() {
  const { servers: list = [] } = await chrome.storage.local.get('servers')
  return list
}

/** Granted site patterns, excluding the server hosts the relay needs. */
async function allowedSites() {
  const serverPatterns = new Set((await servers()).map(serverPattern))
  const { origins = [] } = await chrome.permissions.getAll()
  return origins.filter(pattern => !serverPatterns.has(pattern)).map(displaySite)
}

async function requireAllowed(url) {
  if (url === undefined) throw new BridgeFailure('SITE_NOT_ALLOWED', 'The agent tab shows a site that is not allowed.')
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new BridgeFailure('SITE_NOT_ALLOWED', `${parsed.protocol} pages are not available to browser tools.`)
  if (isServerHost(url, await servers())) throw new BridgeFailure('SITE_NOT_ALLOWED', 'The DeepSeek Harness server itself is not available to browser tools.')
  if (!await chrome.permissions.contains({ origins: [`${parsed.protocol}//${parsed.hostname}/*`] })) {
    throw new BridgeFailure('SITE_NOT_ALLOWED', `${parsed.hostname} is not allowed.`)
  }
}

function checkCanceled(signal, deadline) {
  if (signal.aborted) throw new BridgeFailure('FAILED', 'The command was canceled.')
  if (Date.now() > deadline) throw new BridgeFailure('TIMEOUT', 'The browser did not finish in time.')
}

async function existingAgentTab() {
  const { agentTabId } = await chrome.storage.session.get('agentTabId')
  if (agentTabId === undefined) return undefined
  try {
    return await chrome.tabs.get(agentTabId)
  } catch {
    // The user closed the agent tab; the next open creates a new one.
    return undefined
  }
}

async function requireAgentTab() {
  const tab = await existingAgentTab()
  if (tab === undefined) throw new BridgeFailure('FAILED', 'No page is open in the agent tab. Call browser_open first.')
  return tab
}

async function navigate(url) {
  const tab = await existingAgentTab()
  if (tab !== undefined) return chrome.tabs.update(tab.id, { url })
  const created = await chrome.tabs.create({ url, active: false })
  const groupId = await chrome.tabs.group({ tabIds: [created.id] })
  await chrome.tabGroups.update(groupId, { title: 'DSH agent', color: 'cyan' })
  await chrome.storage.session.set({ agentTabId: created.id })
  return created
}

/** Wait until the tab has no pending navigation and has finished loading. */
async function waitForLoad(tabId, deadline, signal) {
  for (;;) {
    checkCanceled(signal, deadline)
    let tab
    try {
      tab = await chrome.tabs.get(tabId)
    } catch {
      // chrome.tabs.get rejects once the tab is closed.
      throw new BridgeFailure('FAILED', 'The agent tab was closed.')
    }
    if (tab.status === 'complete' && tab.pendingUrl === undefined) return tab
    await sleep(POLL_MS)
  }
}

async function inPage(tabId, func, args) {
  const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func, args })
  const result = injection?.result
  if (result !== null && typeof result === 'object' && 'error' in result) throw new BridgeFailure(result.error, result.message)
  return result
}

async function waitForSelector(tabId, selector, deadline, signal) {
  for (;;) {
    if (Date.now() > deadline) throw new BridgeFailure('TIMEOUT', `No element matched "${selector}" in time.`)
    checkCanceled(signal, Infinity)
    if (await inPage(tabId, hasElement, [selector])) return
    await sleep(POLL_MS * 2)
  }
}

/** Report the tab's current page after an action, refusing a move to a site that is not allowed. */
async function settledPage(tabId, deadline, signal) {
  await sleep(300)
  const tab = await waitForLoad(tabId, deadline, signal)
  await requireAllowed(tab.url)
  return { url: tab.url, title: tab.title ?? '' }
}

async function execute(command, timeoutMs, signal) {
  const { paused } = await chrome.storage.local.get('paused')
  if (paused === true) throw new BridgeFailure('PAUSED', 'The user paused browser control.')
  const deadline = Date.now() + timeoutMs
  switch (command.op) {
    case 'open': {
      let url
      try {
        url = new URL(command.url)
      } catch {
        // new URL rejects malformed input with a TypeError.
        throw new BridgeFailure('NAVIGATION_FAILED', `"${command.url}" is not a valid URL.`)
      }
      await requireAllowed(url.href)
      const tab = await navigate(url.href)
      const page = await settledPage(tab.id, deadline, signal)
      if (command.waitFor !== undefined) await waitForSelector(tab.id, command.waitFor, deadline, signal)
      return command.waitFor === undefined ? page : settledPage(tab.id, deadline, signal)
    }
    case 'read': {
      const tab = await requireAgentTab()
      await requireAllowed(tab.url)
      if (command.waitFor !== undefined) await waitForSelector(tab.id, command.waitFor, deadline, signal)
      return inPage(tab.id, snapshotPage, [command.selector ?? null, command.maxHtmlChars])
    }
    case 'click':
    case 'type': {
      const tab = await requireAgentTab()
      await requireAllowed(tab.url)
      await inPage(tab.id, actOnPage, [command.op, command.target, command.text ?? null, command.submit === true])
      return settledPage(tab.id, deadline, signal)
    }
    default:
      throw new BridgeFailure('FAILED', `Unknown browser command "${command.op}". Update the extension.`)
  }
}

function post(port, message) {
  try {
    port.postMessage(message)
  } catch (_relayGone) {
    // The relay disconnected; its socket close already failed the command on the server.
  }
}

async function handle(port, message) {
  const running = relays.get(port)
  if (running === undefined) return
  switch (message.type) {
    case 'relay-open':
      post(port, { type: 'hello', protocol: PROTOCOL, extensionVersion: VERSION, allowedSites: await allowedSites() })
      return
    case 'cancel':
      running.get(message.id)?.abort()
      return
    case 'request': {
      const controller = new AbortController()
      running.set(message.id, controller)
      try {
        const result = await execute(message.command, message.timeoutMs, controller.signal)
        post(port, { type: 'response', id: message.id, ok: true, result })
      } catch (error) {
        const failure = error instanceof BridgeFailure
          ? { code: error.code, message: error.message }
          : { code: 'FAILED', message: String(error instanceof Error ? error.message : error) }
        post(port, { type: 'response', id: message.id, ok: false, error: { code: failure.code, message: failure.message.slice(0, 4000) } })
      } finally {
        running.delete(message.id)
      }
    }
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== RELAY_ID) return
  relays.set(port, new Map())
  port.onDisconnect.addListener(() => {
    for (const controller of relays.get(port)?.values() ?? []) controller.abort()
    relays.delete(port)
  })
  port.onMessage.addListener((message) => { void handle(port, message) })
})

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.type !== 'status') return false
  reply({ relays: relays.size })
  return false
})

/** Register the relay for every configured server with a granted permission and start it in open tabs. */
async function syncRelay() {
  const granted = []
  for (const origin of await servers()) {
    if (await chrome.permissions.contains({ origins: [serverPattern(origin)] })) granted.push(serverPattern(origin))
  }
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [RELAY_ID] })
  if (registered.length > 0) await chrome.scripting.unregisterContentScripts({ ids: [RELAY_ID] })
  if (granted.length === 0) return
  await chrome.scripting.registerContentScripts([{ id: RELAY_ID, matches: granted, js: ['relay.js'], runAt: 'document_idle', persistAcrossSessions: true }])
  for (const tab of await chrome.tabs.query({ url: granted })) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['relay.js'] })
    } catch (_tabLoading) {
      // A tab that is still loading receives the registered script when it finishes.
    }
  }
}

async function broadcastSites() {
  const message = { type: 'sites', allowedSites: await allowedSites() }
  for (const port of relays.keys()) post(port, message)
}

chrome.runtime.onInstalled.addListener(() => { void syncRelay() })
chrome.runtime.onStartup.addListener(() => { void syncRelay() })
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'servers' in changes) void syncRelay().then(broadcastSites)
})
chrome.permissions.onAdded.addListener(() => { void syncRelay().then(broadcastSites) })
chrome.permissions.onRemoved.addListener(() => { void syncRelay().then(broadcastSites) })
