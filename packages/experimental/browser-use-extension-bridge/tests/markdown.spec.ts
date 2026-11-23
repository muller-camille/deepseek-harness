import { describe, expect, it } from 'vitest'
import { nestingDepth, pageMarkdown } from '../src/markdown.ts'

describe('page Markdown', () => {
  it('measures element nesting without counting void or self-closing elements', () => {
    expect(nestingDepth('<p>text</p>')).toBe(1)
    expect(nestingDepth('<DIV><p><b>x</b><br><img src="a"><x-icon /></p></DIV><p>y</p>')).toBe(3)
    expect(nestingDepth('plain text')).toBe(0)
  })

  it('refuses deep markup quickly and keeps ref markers readable', () => {
    const started = performance.now()
    expect(pageMarkdown(`${'<div>'.repeat(20_000)}x`)).toBeUndefined()
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(pageMarkdown('<p>Go [ref=2]</p><script>x()</script>')).toBe('Go [ref=2]')
  })
})
