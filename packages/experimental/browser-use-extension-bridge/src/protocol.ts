/**
 * Wire frames between the bridge and the DeepSeek Harness Chrome extension. The extension's relay
 * opens one WebSocket from the Web UI tab to {@link BRIDGE_PATH} on the same origin and exchanges
 * JSON text frames; every inbound frame is validated by {@link parseExtensionFrame}.
 * @module
 */

import { z } from 'zod'

/** Wire protocol version the extension announces in its hello frame. */
export const BRIDGE_PROTOCOL_VERSION = 1

/** WebSocket path on the Web UI origin; the extension relay connects to this fixed path. */
export const BRIDGE_PATH = '/browser-bridge'

/** An element chosen by a `[ref=N]` marker from the latest read, or by a CSS selector. */
export type ElementTarget = { readonly ref: number } | { readonly selector: string }

/** One command the extension runs in its agent tab. */
export type BridgeCommand =
  | { readonly op: 'open'; readonly url: string; readonly waitFor?: string }
  | { readonly op: 'read'; readonly selector?: string; readonly waitFor?: string; readonly maxHtmlChars: number }
  | { readonly op: 'click'; readonly target: ElementTarget }
  | { readonly op: 'type'; readonly target: ElementTarget; readonly text: string; readonly submit: boolean }

/** Frames the bridge sends to the extension. */
export type BridgeServerFrame =
  | { readonly type: 'request'; readonly id: number; readonly timeoutMs: number; readonly command: BridgeCommand }
  | { readonly type: 'cancel'; readonly id: number }

/**
 * Failure classes the extension reports:
 * - `SITE_NOT_ALLOWED` — the page's site is not granted in the extension.
 * - `ELEMENT_NOT_FOUND` — no element matches the ref or selector.
 * - `TIMEOUT` — loading, waiting, or the action exceeded the request's time budget.
 * - `PAUSED` — the user paused browser control in the extension.
 * - `NAVIGATION_FAILED` — the URL is invalid or Chrome could not load it.
 * - `FAILED` — any other browser failure; the message carries Chrome's text.
 */
export const EXTENSION_ERROR_CODES = ['SITE_NOT_ALLOWED', 'ELEMENT_NOT_FOUND', 'TIMEOUT', 'PAUSED', 'NAVIGATION_FAILED', 'FAILED'] as const

/** One code from {@link EXTENSION_ERROR_CODES}. */
export type ExtensionErrorCode = typeof EXTENSION_ERROR_CODES[number]

const sites = z.array(z.string().max(512)).max(1000)

const pageResult = z.strictObject({
  url: z.string().max(8192),
  title: z.string().max(4096),
  html: z.string().optional(),
  truncated: z.boolean().optional(),
})

const extensionFrame = z.union([
  z.strictObject({
    type: z.literal('hello'),
    protocol: z.number().int(),
    extensionVersion: z.string().max(64),
    allowedSites: sites,
  }),
  z.strictObject({ type: z.literal('sites'), allowedSites: sites }),
  z.strictObject({ type: z.literal('response'), id: z.number().int().positive(), ok: z.literal(true), result: pageResult }),
  z.strictObject({
    type: z.literal('response'),
    id: z.number().int().positive(),
    ok: z.literal(false),
    error: z.strictObject({ code: z.enum(EXTENSION_ERROR_CODES), message: z.string().max(4000) }),
  }),
])

/** A validated frame received from the extension. */
export type ExtensionFrame = z.infer<typeof extensionFrame>

/** The page facts an extension reply carries; `html` is present only for reads. */
export type PageResult = z.infer<typeof pageResult>

/**
 * Parse and validate one text frame from the extension.
 * @param text - the frame's UTF-8 text.
 * @returns the frame, or `undefined` when it is not JSON or does not match the protocol.
 */
export function parseExtensionFrame(text: string): ExtensionFrame | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    // Malformed JSON is a protocol violation the caller reports by closing the socket.
    return undefined
  }
  const parsed = extensionFrame.safeParse(value)
  return parsed.success ? parsed.data : undefined
}
