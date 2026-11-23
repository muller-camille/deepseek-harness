/** Machine-routable failures of the extension browser bridge. @module */

import { HarnessError } from '@deepseek-ai/dsh-error'
import type { ExtensionErrorCode } from './protocol.ts'

/**
 * Every {@link BrowserBridgeError} code:
 * - `BROWSER_NOT_CONNECTED` — no Web UI tab with the extension relay is connected; the user must connect Chrome.
 * - `BROWSER_DISCONNECTED` — the extension disconnected or broke the protocol while the command ran.
 * - `BROWSER_TIMEOUT` — the extension did not finish the command within the configured time.
 * - `BROWSER_SITE_NOT_ALLOWED` — the user has not allowed the page's site in the extension.
 * - `BROWSER_ELEMENT_NOT_FOUND` — no element matches the ref or selector; read the page again.
 * - `BROWSER_PAUSED` — the user paused browser control in the extension.
 * - `BROWSER_NAVIGATION_FAILED` — Chrome could not load the URL.
 * - `BROWSER_COMMAND_FAILED` — Chrome reported another failure; the message carries its text.
 */
export const BROWSER_BRIDGE_ERROR_CODES = [
  'BROWSER_NOT_CONNECTED',
  'BROWSER_DISCONNECTED',
  'BROWSER_TIMEOUT',
  'BROWSER_SITE_NOT_ALLOWED',
  'BROWSER_ELEMENT_NOT_FOUND',
  'BROWSER_PAUSED',
  'BROWSER_NAVIGATION_FAILED',
  'BROWSER_COMMAND_FAILED',
] as const

/** One code from {@link BROWSER_BRIDGE_ERROR_CODES}. */
export type BrowserBridgeErrorCode = typeof BROWSER_BRIDGE_ERROR_CODES[number]

/** Browser bridge failure carrying a stable {@link BrowserBridgeErrorCode}. */
export class BrowserBridgeError extends HarnessError {
  override readonly code: BrowserBridgeErrorCode

  /**
   * @param message - what failed and the next step for the model or the user.
   * @param code - the failure class consumers route on.
   * @param options - standard `cause` chaining.
   */
  constructor(message: string, code: BrowserBridgeErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'BrowserBridgeError'
    this.code = code
  }
}

const EXTENSION_CODE_MAP: Readonly<Record<ExtensionErrorCode, BrowserBridgeErrorCode>> = {
  SITE_NOT_ALLOWED: 'BROWSER_SITE_NOT_ALLOWED',
  ELEMENT_NOT_FOUND: 'BROWSER_ELEMENT_NOT_FOUND',
  TIMEOUT: 'BROWSER_TIMEOUT',
  PAUSED: 'BROWSER_PAUSED',
  NAVIGATION_FAILED: 'BROWSER_NAVIGATION_FAILED',
  FAILED: 'BROWSER_COMMAND_FAILED',
}

/**
 * Translate an extension-reported failure into a bridge error with the next step for the model.
 * @param code - the extension's failure class.
 * @param message - the extension's description.
 * @param allowedSites - the sites the user granted, listed when a site was refused.
 * @returns the bridge error the tool throws.
 */
export function extensionFailure(code: ExtensionErrorCode, message: string, allowedSites: readonly string[]): BrowserBridgeError {
  const next = code === 'SITE_NOT_ALLOWED'
    ? ` Allowed sites: ${allowedSites.length === 0 ? 'none' : allowedSites.join(', ')}. Ask the user to allow the site in the DeepSeek Harness extension.`
    : code === 'ELEMENT_NOT_FOUND'
      ? ' Call browser_read again for current refs.'
      : code === 'PAUSED'
        ? ' Ask the user to resume browser control in the extension.'
        : ''
  return new BrowserBridgeError(`${message}${next}`, EXTENSION_CODE_MAP[code])
}
