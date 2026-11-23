/**
 * Relay content script for a DeepSeek Harness Web UI tab. Its WebSocket carries the page's own
 * origin and sign-in cookie, so the server admits it like the Web UI; commands pass to the
 * service worker over a runtime port. It runs only on server origins the user configured.
 */
(() => {
  if (globalThis.__dshBrowserBridgeRelay === true) return
  globalThis.__dshBrowserBridgeRelay = true

  const PATH = '/browser-bridge'
  const MAX_RETRY_MS = 30_000
  let socket
  let port
  let retryMs = 1_000
  const pending = new Set()

  const extensionAlive = () => chrome.runtime?.id !== undefined
  const send = (message) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
  }

  function openPort() {
    port = chrome.runtime.connect({ name: 'dsh-relay' })
    port.onMessage.addListener((message) => {
      if (message.type === 'response') pending.delete(message.id)
      send(message)
    })
    port.onDisconnect.addListener(() => {
      port = undefined
      // A restarted service worker lost these commands; fail them now rather than at the server's timeout.
      for (const id of pending) send({ type: 'response', id, ok: false, error: { code: 'FAILED', message: 'The browser extension restarted while the command ran.' } })
      pending.clear()
      if (extensionAlive() && socket?.readyState === WebSocket.OPEN) {
        setTimeout(() => {
          openPort()
          port.postMessage({ type: 'relay-open' })
        }, 200)
      }
    })
  }

  function connect() {
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${PATH}`)
    socket.addEventListener('open', () => {
      retryMs = 1_000
      if (port === undefined) openPort()
      port.postMessage({ type: 'relay-open' })
    })
    socket.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        // The server sends only JSON text frames; anything else is ignored.
        return
      }
      if (message.type === 'request') pending.add(message.id)
      if (port === undefined) openPort()
      port.postMessage(message)
    })
    socket.addEventListener('close', () => {
      if (!extensionAlive()) return
      setTimeout(connect, retryMs)
      retryMs = Math.min(retryMs * 2, MAX_RETRY_MS)
    })
  }

  void chrome.storage.local.get('servers').then(({ servers = [] }) => {
    if (servers.includes(location.origin)) connect()
  })
})()
