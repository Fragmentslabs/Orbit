/**
 * O que este teste protege: o texto do diagrama é escrito dentro de um
 * `<script>`. Se um `</script>` passar cru, o resto do conteúdo vira HTML
 * executável dentro do WebView — que já roda com JavaScript ligado e vê todas
 * as requisições da página. Escapar `<` é a defesa, e ela não pode sair daqui
 * sem alguém perceber.
 *
 * A lib entrou pelo mesmo caminho (é JS, dentro do mesmo `<script>`), com uma
 * diferença: ela não pode ser JSON-escapada, então o escape dela é só o
 * fechamento de tag — e isso também está coberto aqui.
 */
import { describe, expect, it } from 'vitest'
import { buildMermaidHtml } from './mermaid-html'

/** Um código qualquer: o teste olha a montagem do documento, não o desenho. */
const LIB = 'window.mermaid={initialize:function(){},render:function(){}};'

describe('buildMermaidHtml', () => {
  it('embeda o diagrama como string JSON', () => {
    const html = buildMermaidHtml('graph TD; A-->B', { dark: false, lib: LIB })
    expect(html).toContain('var source = "graph TD; A-->B";')
  })

  it('não deixa `</script>` do diagrama encerrar o bloco', () => {
    const html = buildMermaidHtml('graph TD; A["</script><img src=x onerror=alert(1)>"]', {
      dark: false,
      lib: LIB,
    })

    // O fechamento do script que montamos continua sendo o único depois do
    // bloco de código — o do usuário virou \u003c.
    expect(html).not.toContain('</script><img')
    expect(html).toContain('\\u003c/script>')
    // O texto não some: chega inteiro ao parser do navegador.
    expect(html).toContain('onerror=alert(1)')
  })

  it('escapa `<` em todo o documento, inclusive no título do diagrama', () => {
    const html = buildMermaidHtml('graph TD; A[<b>]', { dark: true, lib: LIB })
    expect(html).not.toContain('"graph TD; A[<b>]"')
    expect(html).toContain('A[\\u003cb>]')
  })

  it('escolhe o tema pelo modo do app', () => {
    expect(buildMermaidHtml('graph TD; A-->B', { dark: true, lib: LIB })).toContain(
      "theme: 'dark'",
    )
    expect(buildMermaidHtml('graph TD; A-->B', { dark: false, lib: LIB })).toContain(
      "theme: 'neutral'",
    )
  })

  it('embeda a lib no documento em vez de buscar de CDN', () => {
    const html = buildMermaidHtml('graph TD; A-->B', { dark: false, lib: LIB })

    expect(html).toContain(LIB)
    // Nenhum `<script src>`: o documento não busca nada na rede.
    expect(html).not.toMatch(/<script[^>]+src=/)
    expect(html).not.toContain('cdn.jsdelivr.net')
  })

  it('não deixa `</script>` da lib encerrar o bloco cedo', () => {
    const libWithEnd = 'var close = "</script>";'
    const html = buildMermaidHtml('graph TD; A-->B', { dark: false, lib: libWithEnd })

    expect(html).toContain('var close = "<\\/script>";')
    // A forma crua, que encerraria o bloco, não existe em lugar nenhum.
    expect(html).not.toContain('"</script>"')
  })

  it('avisa o RN quando o diagrama não desenha', () => {
    const html = buildMermaidHtml('graph TD; A-->B', { dark: false, lib: LIB })
    // Sem lib, sem desenho: o componente precisa saber para cair no código.
    expect(html).toContain('if (!window.mermaid)')
    expect(html).toContain("type: 'error'")
  })
})
