import { describe, expect, it } from 'vitest'
import { BRIDGE_PATH, BRIDGE_PROTOCOL_VERSION, parseExtensionFrame } from '../src/protocol.ts'

describe('extension frame parsing', () => {
  it('accepts every protocol frame', () => {
    expect(BRIDGE_PATH).toBe('/browser-bridge')
    expect(parseExtensionFrame(JSON.stringify({ type: 'hello', protocol: BRIDGE_PROTOCOL_VERSION, extensionVersion: '0.2.3', allowedSites: ['example.com'] })))
      .toEqual({ type: 'hello', protocol: 1, extensionVersion: '0.2.3', allowedSites: ['example.com'] })
    expect(parseExtensionFrame('{"type":"sites","allowedSites":[]}')).toEqual({ type: 'sites', allowedSites: [] })
    expect(parseExtensionFrame('{"type":"response","id":3,"ok":true,"result":{"url":"https://a.test/","title":"A","html":"<p>x</p>","truncated":false}}'))
      .toEqual({ type: 'response', id: 3, ok: true, result: { url: 'https://a.test/', title: 'A', html: '<p>x</p>', truncated: false } })
    expect(parseExtensionFrame('{"type":"response","id":4,"ok":false,"error":{"code":"TIMEOUT","message":"slow"}}'))
      .toEqual({ type: 'response', id: 4, ok: false, error: { code: 'TIMEOUT', message: 'slow' } })
  })

  it('rejects malformed JSON, unknown fields, unknown codes, and invalid ids', () => {
    expect(parseExtensionFrame('{')).toBeUndefined()
    expect(parseExtensionFrame('{"type":"sites","allowedSites":[],"extra":1}')).toBeUndefined()
    expect(parseExtensionFrame('{"type":"response","id":1,"ok":false,"error":{"code":"OOPS","message":"x"}}')).toBeUndefined()
    expect(parseExtensionFrame('{"type":"response","id":0,"ok":true,"result":{"url":"u","title":"t"}}')).toBeUndefined()
    expect(parseExtensionFrame('{"type":"request","id":1}')).toBeUndefined()
  })
})
