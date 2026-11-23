import { describe, expect, it } from 'vitest'
import { articleMarkdown, nestingDepth, plainText } from '../src/markdown.ts'

describe('wiki markup conversion', () => {
  it('measures element nesting without counting void or self-closing elements', () => {
    expect(nestingDepth('<p>text</p>')).toBe(1)
    expect(nestingDepth('<DIV><p><b>x</b><br><IMG src="a"><x-icon /></p></DIV><p>y</p>')).toBe(3)
    expect(nestingDepth('plain text <!-- a comment -->')).toBe(0)
  })

  it('refuses deeply nested markup quickly', () => {
    const deep = `${'<span>'.repeat(20_000)}x`
    const started = performance.now()
    expect(() => articleMarkdown(deep)).toThrow('nested more than 512 elements deep')
    expect(() => plainText(deep)).toThrow('nested more than 512 elements deep')
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  it('drops wiki chrome, keeps reference text, and renders only external links as links', () => {
    expect(articleMarkdown([
      '<span class="mw-editsection">[edit]</span>',
      '<p>Text<sup class="reference"><a href="#cite_note-1">[1]</a></sup> with <sup>2</sup> and <a href="/wiki/Other" title="Other">a wiki link</a>.</p>',
      '<table class="navbox"><tbody><tr><td>navigation</td></tr></tbody></table>',
      '<ol class="references"><li><span class="mw-cite-backlink">^</span> <a href="http://example.test/a">Source</a></li></ol>',
    ].join(''))).toBe('Text with 2 and a wiki link.\n\n1.   [Source](http://example.test/a)')
  })

  it('fences preformatted text and highlighted code verbatim, with a fence longer than any backtick run inside', () => {
    expect(articleMarkdown([
      '<div class="mw-highlight mw-highlight-lang-c"><pre><span></span><span class="kt">int</span> x_1 = `y`;\n  return *p;\n</pre></div>',
      '<pre>a ``` b</pre>',
    ].join(''))).toBe('```\nint x_1 = `y`;\n  return *p;\n```\n\n````\na ``` b\n````')
  })

  it('renders fragments as one line of plain text with entities decoded and Markdown left unescaped', () => {
    expect(plainText('History')).toBe('History')
    expect(plainText('  Early\n  history ')).toBe('Early history')
    expect(plainText('<i>Features</i> &amp; *tools* &lt;b&gt; &#039;x&#039;')).toBe('Features & *tools* <b> \'x\'')
    expect(plainText('An <span class="searchmatch">oracle</span>\nis')).toBe('An oracle is')
  })
})
