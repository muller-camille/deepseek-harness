/** Options page: server origins, allowed sites, connection status, and the pause switch. */

import { displaySite, serverOrigin, serverPattern, sitePattern } from './sites.js'

const errorLine = document.getElementById('error')
const showError = (message) => { errorLine.textContent = message }

async function servers() {
  const { servers: list = [] } = await chrome.storage.local.get('servers')
  return list
}

function row(text, onRemove) {
  const item = document.createElement('li')
  const label = document.createElement('span')
  label.textContent = text
  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'quiet'
  remove.textContent = 'Remove'
  remove.addEventListener('click', () => { void onRemove().then(render, error => showError(error.message)) })
  item.append(label, remove)
  return item
}

async function render() {
  const configured = await servers()
  const serverPatterns = new Set(configured.map(serverPattern))
  const { origins = [] } = await chrome.permissions.getAll()
  document.getElementById('servers').replaceChildren(...configured.map(origin => row(origin, async () => {
    const remaining = (await servers()).filter(candidate => candidate !== origin)
    await chrome.storage.local.set({ servers: remaining })
    if (!remaining.some(candidate => serverPattern(candidate) === serverPattern(origin))) {
      await chrome.permissions.remove({ origins: [serverPattern(origin)] })
    }
  })))
  document.getElementById('sites').replaceChildren(...origins.filter(pattern => !serverPatterns.has(pattern)).map(pattern => row(displaySite(pattern), async () => {
    await chrome.permissions.remove({ origins: [pattern] })
  })))
  const { paused } = await chrome.storage.local.get('paused')
  document.getElementById('paused').checked = paused === true
  let relays = 0
  try {
    relays = (await chrome.runtime.sendMessage({ type: 'status' }))?.relays ?? 0
  } catch (_workerStarting) {
    // The service worker is starting; the status refreshes on the next render.
  }
  document.getElementById('status').innerHTML = relays > 0
    ? `<strong>Connected</strong> through ${relays} Web UI tab${relays === 1 ? '' : 's'}`
    : 'Not connected. Open the Web UI in a tab.'
}

document.getElementById('server-form').addEventListener('submit', (event) => {
  event.preventDefault()
  showError('')
  let origin
  try {
    origin = serverOrigin(document.getElementById('server-input').value)
  } catch (error) {
    showError(error instanceof TypeError ? 'Enter an address such as https://10.0.0.5:3080.' : error.message)
    return
  }
  // The permission request must start inside the click's user gesture.
  void chrome.permissions.request({ origins: [serverPattern(origin)] }).then(async (granted) => {
    if (!granted) {
      showError('Chrome did not grant access to the server.')
      return
    }
    const list = await servers()
    if (!list.includes(origin)) await chrome.storage.local.set({ servers: [...list, origin] })
    document.getElementById('server-input').value = ''
    await render()
  }, error => showError(error.message))
})

document.getElementById('site-form').addEventListener('submit', (event) => {
  event.preventDefault()
  showError('')
  let pattern
  try {
    pattern = sitePattern(document.getElementById('site-input').value)
  } catch (error) {
    showError(error.message)
    return
  }
  void chrome.permissions.request({ origins: [pattern] }).then(async (granted) => {
    if (!granted) showError('Chrome did not grant access to the site.')
    document.getElementById('site-input').value = ''
    await render()
  }, error => showError(error.message))
})

document.getElementById('paused').addEventListener('change', (event) => {
  void chrome.storage.local.set({ paused: event.target.checked })
})

void render()
setInterval(() => { void render() }, 3_000)
