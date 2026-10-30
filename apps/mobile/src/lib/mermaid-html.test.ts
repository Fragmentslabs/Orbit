/**
 * What this test protects: the diagram text is written inside a
 * `<script>`. If a `</script>` passes through raw, the rest of the content becomes
 * executable HTML inside the WebView — which already runs with JavaScript on and sees all
 * the requests of the page. Escaping `<` is the defense, and it cannot leave here
 * without someone noticing.
 *
 * The lib came in through the same path (it is JS, inside the same `<script>`), with one
 * difference: it cannot be JSON-escaped, so its escape is only the
 * tag closing — and that is covered here too.
 */
import { describe, expect, it } from 'vitest'
import { buildMermaidHtml } from './mermaid-html'

/** Any code at all: the test looks at the assembly of the document, not at the drawing. */
const LIB = 'window.mermaid={initialize:function(){},render:function(){}};'

describe('buildMermaidHtml', () => {
  it('embeds the diagram as a JSON string', () => {
    const html = buildMermaidHtml('graph TD; A-->B', { dark: false, lib: LIB })
    expect(html).toContain('var source = "graph TD; A-->B";')
  })

  it('does not let a `</script>` from the diagram close the block', () => {
    const html = buildMermaidHtml('graph TD; A["</script><img src=x onerror=alert(1)>"]', {
      dark: false,
      lib: LIB,
    })

    // The closing of the script we assemble is still the only one after the
    // code block — the user's became \u003c.
    expect(html).not.toContain('</script><img')
    expect(html).toContain('\\u003c/script>')
    // The text does not vanish: it reaches the browser parser intact.
    expect(html).toContain('onerror=alert(1)')
  })

  it('escapes `<` in the whole document, including in the diagram title', () => {
    const html = buildMermaidHtml('graph TD; A[<b>]', { dark: true, lib: LIB })
    expect(html).not.toContain('"graph TD; A[<b>]"')
    expect(html).toContain('A[\\u003cb>]')
  })

  it('picks the theme from the app mode', () => {
    expect(buildMermaidHtml('graph TD; A-->B', { dark: true, lib: LIB })).toContain(
      "theme: 'dark'",
    )
    expect(buildMermaidHtml('graph TD; A-->B', { dark: false, lib: LIB })).toContain(
      "theme: 'neutral'",
    )
  })

  it('embeds the lib in the document instead of fetching it from a CDN', () => {
    const html = buildMermaidHtml('graph TD; A-->B', { dark: false, lib: LIB })

    expect(html).toContain(LIB)
    // No `<script src>`: the document fetches nothing from the network.
    expect(html).not.toMatch(/<script[^>]+src=/)
    expect(html).not.toContain('cdn.jsdelivr.net')
  })

  it('does not let a `</script>` from the lib close the block early', () => {
    const libWithEnd = 'var close = "</script>";'
    const html = buildMermaidHtml('graph TD; A-->B', { dark: false, lib: libWithEnd })

    expect(html).toContain('var close = "<\\/script>";')
    // The raw form, which would end the block, exists nowhere.
    expect(html).not.toContain('"</script>"')
  })

  it('notifies RN when the diagram does not draw', () => {
    const html = buildMermaidHtml('graph TD; A-->B', { dark: false, lib: LIB })
    // No lib, no drawing: the component needs to know so it falls back to the code.
    expect(html).toContain('if (!window.mermaid)')
    expect(html).toContain("type: 'error'")
  })
})
