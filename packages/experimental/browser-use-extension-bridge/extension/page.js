/**
 * Functions the service worker injects into the agent tab with `chrome.scripting.executeScript`.
 * Chrome serializes each function's source, so each one is self-contained and returns plain data.
 */

/**
 * Snapshot visible content as sanitized HTML and mark interactive elements with refs.
 * @param {string | null} selector - CSS selector of the element to read, or the whole body.
 * @param {number} maxChars - cap on the returned HTML.
 * @returns {{ url: string, title: string, html: string, truncated: boolean } | { error: string, message: string }}
 */
export function snapshotPage(selector, maxChars) {
  let root
  try {
    root = selector === null ? document.body : document.querySelector(selector)
  } catch {
    return { error: 'ELEMENT_NOT_FOUND', message: `"${selector}" is not a valid CSS selector.` }
  }
  if (root === null) return { error: 'ELEMENT_NOT_FOUND', message: `No element matches "${selector}".` }
  for (const element of document.querySelectorAll('[data-dsh-ref]')) element.removeAttribute('data-dsh-ref')
  const interactive = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[contenteditable=""],[contenteditable=true]'
  const copy = root.cloneNode(true)
  let next = 1
  const hidden = (element) => {
    if (element.hidden || element.getAttribute('aria-hidden') === 'true') return true
    const style = getComputedStyle(element)
    return style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
  }
  const label = (element) => {
    const labelled = element.labels?.[0]?.innerText ?? element.getAttribute('aria-label') ?? element.getAttribute('placeholder') ?? element.getAttribute('name') ?? ''
    return labelled.trim().replace(/\s+/gu, ' ').slice(0, 120)
  }
  const field = (element, ref) => {
    const kind = element instanceof HTMLSelectElement ? 'select' : element instanceof HTMLTextAreaElement ? 'textarea' : (element.getAttribute('type') ?? 'text').toLowerCase()
    const parts = [`ref=${ref}`, kind]
    const name = label(element)
    if (name !== '') parts.push(JSON.stringify(name))
    if (kind === 'checkbox' || kind === 'radio') parts.push(element.checked ? 'checked' : 'unchecked')
    else if (element instanceof HTMLSelectElement) parts.push(`value=${JSON.stringify(element.selectedOptions[0]?.text ?? '')}`)
    else if (kind !== 'password' && element.value !== '') parts.push(`value=${JSON.stringify(element.value.slice(0, 200))}`)
    return document.createTextNode(` [${parts.join(' ')}] `)
  }
  // Deeper subtrees become their text, keeping the server's conversion bounded.
  const MAX_DEPTH = 300
  const walk = (original, clone, depth) => {
    const originals = Array.from(original.children)
    const clones = Array.from(clone.children)
    originals.forEach((element, index) => {
      const cloned = clones[index]
      if (hidden(element)) {
        cloned.remove()
        return
      }
      if (depth >= MAX_DEPTH) {
        cloned.replaceWith(document.createTextNode(element.innerText ?? ''))
        return
      }
      if (element instanceof HTMLImageElement) cloned.setAttribute('src', element.currentSrc || element.src)
      if (element.matches(interactive)) {
        const ref = next++
        element.setAttribute('data-dsh-ref', String(ref))
        if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
          cloned.replaceWith(field(element, ref))
          return
        }
        if (element instanceof HTMLAnchorElement) cloned.setAttribute('href', element.href)
        cloned.append(` [ref=${ref}]`)
      }
      walk(element, cloned, depth + 1)
    })
  }
  walk(root, copy, 1)
  for (const element of copy.querySelectorAll('script,style,noscript,template,iframe,object,embed,svg,canvas,link,meta')) element.remove()
  const html = copy.outerHTML
  return { url: location.href, title: document.title, html: html.slice(0, maxChars), truncated: html.length > maxChars }
}

/**
 * Whether an element matching the selector exists.
 * @param {string} selector - CSS selector.
 * @returns {boolean | { error: string, message: string }}
 */
export function hasElement(selector) {
  try {
    return document.querySelector(selector) !== null
  } catch {
    return { error: 'ELEMENT_NOT_FOUND', message: `"${selector}" is not a valid CSS selector.` }
  }
}

/**
 * Click an element or replace a field's text, then optionally submit its form.
 * @param {'click' | 'type'} op - the action.
 * @param {{ ref: number } | { selector: string }} target - a ref from the latest read, or a CSS selector.
 * @param {string | null} text - the field's new text for `type`.
 * @param {boolean} submit - submit the field's form after typing.
 * @returns {{ ok: true } | { error: string, message: string }}
 */
export function actOnPage(op, target, text, submit) {
  const description = 'ref' in target ? `ref ${target.ref}` : `"${target.selector}"`
  let element
  try {
    element = document.querySelector('ref' in target ? `[data-dsh-ref="${target.ref}"]` : target.selector)
  } catch {
    return { error: 'ELEMENT_NOT_FOUND', message: `${description} is not a valid CSS selector.` }
  }
  if (element === null) return { error: 'ELEMENT_NOT_FOUND', message: `No element matches ${description}.` }
  element.scrollIntoView({ block: 'center' })
  if (op === 'click') {
    element.click()
    return { ok: true }
  }
  element.focus()
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
    // The native setter keeps framework value trackers able to see the change.
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, text)
  } else if (element instanceof HTMLSelectElement) {
    const option = Array.from(element.options).find(candidate => candidate.value === text || candidate.text.trim() === text)
    if (option === undefined) return { error: 'ELEMENT_NOT_FOUND', message: `${description} has no option "${text}".` }
    element.value = option.value
  } else if (element.isContentEditable) {
    element.textContent = text
  } else {
    return { error: 'ELEMENT_NOT_FOUND', message: `${description} is not a text field.` }
  }
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
  if (submit) {
    if (element.form) element.form.requestSubmit()
    else element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }))
  }
  return { ok: true }
}
