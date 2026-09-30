/**
 * Documento autorado pelo agente: um fonte em Markdown que vira três saídas.
 *
 * Por que Markdown e não HTML, sendo que os artefatos já são HTML? Porque o
 * destino aqui é DOCX e PDF, e HTML→DOCX é intratável: CSS arbitrário não tem
 * equivalente em OOXML. Markdown tem um vocabulário pequeno e fechado —
 * título, parágrafo, lista, tabela — que mapeia direto para os dois formatos,
 * e é o que o modelo escreve melhor. Artefato HTML continua sendo o caminho
 * para dashboard e protótipo; documento é outro objeto.
 *
 * O mesmo fonte gera:
 *   - HTML  → preview na conversa (e a origem do PDF, via printToPDF)
 *   - OOXML → o .docx
 *
 * Módulo puro (sem Electron, sem IO) para ser testável.
 */

export type CellAlign = 'left' | 'center' | 'right'

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'listItem'; text: string; ordered: boolean }
  | { type: 'quote'; text: string }
  | { type: 'table'; header: string[]; rows: string[][]; align: CellAlign[] }
  /** Bloco de código cercado por ``` — as linhas vão CRUAS, sem juntar nem
   *  aparar, porque indentação e quebra são o conteúdo. */
  | { type: 'code'; lines: string[]; lang?: string }
  | { type: 'rule' }
  | { type: 'pageBreak' }

// ─── Diagramas ───────────────────────────────────────────────────────────

/**
 * Um diagrama Mermaid já desenhado (ver mermaid-render.ts): o SVG vai para o
 * HTML/PDF e o PNG para o .docx. Largura e altura em px CSS (96 dpi).
 */
export interface RenderedDiagram {
  svg: string
  png: Buffer
  width: number
  height: number
}

/**
 * Encontra o diagrama de uma fonte Mermaid. Quem renderiza não sabe desenhar
 * — isso exige DOM e vive no main —, só pergunta. Fonte sem resposta cai para
 * o bloco de código, e o documento sai inteiro mesmo com um diagrama quebrado.
 */
export type DiagramLookup = (source: string) => RenderedDiagram | undefined

export const isMermaid = (block: Block): block is Extract<Block, { type: 'code' }> =>
  block.type === 'code' && block.lang?.toLowerCase() === 'mermaid'

/** A fonte de um bloco ```mermaid, do jeito que o renderer do diagrama recebe. */
export const mermaidSource = (block: Extract<Block, { type: 'code' }>) =>
  block.lines.join('\n').trim()

/** As fontes Mermaid do documento, na ordem em que aparecem. */
export function mermaidSourcesOf(blocks: Block[]): string[] {
  return blocks.filter(isMermaid).map(mermaidSource).filter((src) => src.length > 0)
}

// ─── Estilo do documento ─────────────────────────────────────────────────

/**
 * Personalização do documento. É um conjunto FECHADO de opções, e não CSS
 * livre, por uma razão dura: tudo aqui precisa existir também em OOXML. CSS
 * arbitrário renderizaria um PDF bonito e um .docx quebrado, e o usuário só
 * descobriria ao abrir o arquivo no Word.
 */
export interface DocumentStyle {
  /** Família da fonte. Um nome que não exista na máquina do leitor cai no
   *  fallback — tanto no navegador quanto no Word. */
  fontFamily?: string
  /** Corpo do texto em pontos. Títulos escalam proporcionalmente. */
  fontSize?: number
  /** Cor de destaque (hex): títulos, cabeçalho de tabela e réguas. */
  accentColor?: string
  /** Margem da página em centímetros (vale para o PDF; na tela a margem é de
   *  leitura). */
  marginCm?: number
  /** Colunas do texto. Vale para o documento inteiro. */
  columns?: number
  align?: 'left' | 'justify'
}

export interface ResolvedStyle {
  fontFamily: string
  fontSize: number
  accentColor: string
  marginCm: number
  columns: number
  align: 'left' | 'justify'
}

const DEFAULT_STYLE: ResolvedStyle = {
  fontFamily: 'Georgia',
  fontSize: 11,
  accentColor: '111111',
  marginCm: 2.5,
  columns: 1,
  align: 'justify',
}

/** Escala dos títulos sobre o corpo — mantém a proporção original (11pt →
 *  20/15/12.5pt) em qualquer tamanho base. */
const HEADING_SCALE = [1.82, 1.36, 1.14]

/**
 * O estilo vem do MODELO, então cada campo é validado antes de virar CSS ou
 * atributo XML. Um nome de fonte com `;}` injetaria regra no CSS do documento;
 * uma cor com aspas quebraria o XML e o .docx nem abriria.
 */
export function normalizeStyle(style?: DocumentStyle): ResolvedStyle {
  // O modelo costuma mandar uma PILHA de CSS ("Inter, Segoe UI, sans-serif")
  // onde o esquema pede um nome. Sem separar, a limpeza abaixo apagava as
  // vírgulas e sobrava "Inter Segoe UI sans-serif" — uma fonte que não existe
  // em máquina nenhuma, então o documento caía no fallback em silêncio.
  const first = (style?.fontFamily ?? '').split(',')[0].replace(/["']/g, '')
  // O hífen fica por último na classe, onde é literal — sem precisar de escape.
  const family = first.replace(/[^a-zA-Z0-9 -]/g, '').trim().slice(0, 40)
  const hex = (style?.accentColor ?? '').replace(/^#/, '')
  return {
    fontFamily: family || DEFAULT_STYLE.fontFamily,
    fontSize: clamp(style?.fontSize, 7, 18, DEFAULT_STYLE.fontSize),
    accentColor: /^[0-9a-fA-F]{6}$/.test(hex) ? hex.toUpperCase() : DEFAULT_STYLE.accentColor,
    marginCm: clamp(style?.marginCm, 0.5, 5, DEFAULT_STYLE.marginCm),
    columns: Math.round(clamp(style?.columns, 1, 3, DEFAULT_STYLE.columns)),
    align: style?.align === 'left' ? 'left' : DEFAULT_STYLE.align,
  }
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

export function headingSize(style: ResolvedStyle, level: 1 | 2 | 3): number {
  return Math.round(style.fontSize * HEADING_SCALE[level - 1] * 10) / 10
}

/** Pilha de fallback: a fonte pedida, depois um genérico compatível. Sem isto,
 *  um nome inexistente deixaria o documento na fonte padrão do sistema, que
 *  pode ser bem diferente do que o agente quis. */
export function fontStack(style: ResolvedStyle): string {
  const monoish = /courier|mono|consolas/i.test(style.fontFamily)
  const sansish = /arial|helvetica|calibri|verdana|tahoma|segoe|roboto|inter|open sans|sans-serif/i.test(style.fontFamily)
  const generic = monoish ? 'monospace' : sansish ? 'sans-serif' : "'Times New Roman', serif"
  return `'${style.fontFamily}', ${generic}`
}

/** Quebra de página explícita no fonte — o Markdown não tem sintaxe para isso
 *  e um documento de várias páginas precisa. */
const PAGE_BREAK = /^\\pagebreak\s*$/i

/**
 * Cerca de bloco de código. Sem isto, ``` caía no ramo de parágrafo e as
 * linhas eram JUNTADAS POR ESPAÇO — o código chegava ao documento numa linha
 * só, com os marcadores crus à mostra. É a sintaxe que mais aparece em
 * documentação técnica, que é o uso mais comum do documento.
 */
const FENCE = /^(`{3,}|~{3,})\s*([A-Za-z0-9+#._-]*)\s*$/

const HEADING = /^(#{1,3})\s+(.*)$/
const BULLET = /^[-*+]\s+(.*)$/
const ORDERED = /^\d+[.)]\s+(.*)$/
const QUOTE = /^>\s?(.*)$/
const RULE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/
const TABLE_ROW = /^\|(.+)\|\s*$/
const TABLE_DIVIDER = /^\|[\s:|-]+\|\s*$/

function tableCells(line: string): string[] {
  return line
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim())
}

/**
 * Alinhamento a partir da linha divisória (`|:---|:---:|---:|`).
 *
 * A divisória sempre foi ACEITA com `:` e o alinhamento, descartado — uma
 * tabela de valores pedida à direita saía toda à esquerda, sem aviso. Ler
 * aqui é o que torna a sintaxe honesta.
 */
function tableAlign(divider: string, columns: number): CellAlign[] {
  const marks = tableCells(divider)
  return Array.from({ length: columns }, (_, i) => {
    const mark = marks[i] ?? ''
    const left = mark.startsWith(':')
    const right = mark.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    return 'left'
  })
}

/**
 * Markdown → blocos. É um SUBCONJUNTO deliberado: o que existe nos dois
 * formatos de destino. Sintaxe não reconhecida cai como parágrafo em vez de
 * ser descartada — perder texto do usuário seria pior que formatá-lo mal.
 */
export function parseMarkdown(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let paragraph: string[] = []

  const flushParagraph = () => {
    if (paragraph.length === 0) return
    blocks.push({ type: 'paragraph', text: paragraph.join(' ').trim() })
    paragraph = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    if (trimmed === '') {
      flushParagraph()
      continue
    }
    if (PAGE_BREAK.test(trimmed)) {
      flushParagraph()
      blocks.push({ type: 'pageBreak' })
      continue
    }
    if (RULE.test(trimmed)) {
      flushParagraph()
      blocks.push({ type: 'rule' })
      continue
    }

    // A cerca é testada ANTES da régua e do resto: dentro dela nada é
    // interpretado, senão um `# comentário` de shell viraria título.
    const fence = FENCE.exec(trimmed)
    if (fence) {
      flushParagraph()
      const marker = fence[1][0]
      const size = fence[1].length
      const code: string[] = []
      i += 1
      while (i < lines.length) {
        const closing = FENCE.exec(lines[i].trim())
        // Fecha só com o MESMO caractere e pelo menos o mesmo comprimento: é o
        // que deixa um bloco de Markdown conter uma cerca menor por dentro.
        if (closing && closing[1][0] === marker && closing[1].length >= size) break
        code.push(lines[i])
        i += 1
      }
      // Cerca não fechada: o bloco entra assim mesmo, até o fim do texto.
      // Descartar seria perder o conteúdo por causa de um marcador faltando.
      blocks.push({ type: 'code', lines: code, ...(fence[2] ? { lang: fence[2] } : {}) })
      continue
    }

    const heading = HEADING.exec(trimmed)
    if (heading) {
      flushParagraph()
      blocks.push({
        type: 'heading',
        level: heading[1].length as 1 | 2 | 3,
        text: heading[2].trim(),
      })
      continue
    }

    // Tabela: linha de cabeçalho seguida da linha divisória. Sem a divisória
    // não é tabela — é texto com barras verticais, e tratar como tabela
    // destruiria o conteúdo.
    if (TABLE_ROW.test(trimmed) && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1].trim())) {
      flushParagraph()
      const header = tableCells(trimmed)
      i += 1 // consome a divisória, mas lê o alinhamento dela antes
      const align = tableAlign(lines[i].trim(), header.length)
      const rows: string[][] = []
      while (i + 1 < lines.length && TABLE_ROW.test(lines[i + 1].trim())) {
        i += 1
        rows.push(tableCells(lines[i].trim()))
      }
      blocks.push({ type: 'table', header, rows, align })
      continue
    }

    const bullet = BULLET.exec(trimmed)
    if (bullet) {
      flushParagraph()
      blocks.push({ type: 'listItem', text: bullet[1].trim(), ordered: false })
      continue
    }
    const ordered = ORDERED.exec(trimmed)
    if (ordered) {
      flushParagraph()
      blocks.push({ type: 'listItem', text: ordered[1].trim(), ordered: true })
      continue
    }
    const quote = QUOTE.exec(trimmed)
    if (quote) {
      flushParagraph()
      blocks.push({ type: 'quote', text: quote[1].trim() })
      continue
    }

    paragraph.push(trimmed)
  }
  flushParagraph()
  return blocks
}

// ─── Inline ──────────────────────────────────────────────────────────────

export interface InlineRun {
  text: string
  bold?: boolean
  italic?: boolean
  code?: boolean
  /** Quebra de linha dentro do parágrafo (veio de um <br> no fonte). */
  br?: boolean
}

/**
 * Ênfase SÓ com asterisco e crase — `_` e `__` ficaram deliberadamente de
 * fora.
 *
 * Num documento, sequência de underscore quase nunca é ênfase: é linha de
 * preencher ("Nome: ______"), que é o pão de cada dia de formulário, prova e
 * ficha. Com a regra de underscore ativa, `__ **Data:** __` casava como um
 * itálico único e ENGOLIA o `**Data:**` no meio — o documento saía com o
 * marcador cru visível. O modelo sempre pode usar * e **; a linha de
 * preencher não tem alternativa.
 */
const INLINE = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/
/** <br>, <br/> e <br /> — o que o modelo escreve para abrir espaço de resposta. */
const LINE_BREAK = /<br\s*\/?>/gi

/**
 * Caracteres que a barra invertida neutraliza, como manda o Markdown.
 *
 * Aqui o motivo é concreto: o modelo escreve `\\_\\_\\_\\_/\\_\\_\\_\\_` para desenhar um
 * campo de data que não vire negrito na TELA (onde o underscore é ênfase), e
 * esse mesmo texto vira o PDF. Sem tratar o escape, o documento saía com a
 * barra invertida à mostra — o problema trocava de lugar em vez de sumir.
 */
const ESCAPABLE = /\\([\\`*_{}[\]()#+\-.!|>~])/g
/** Marcador do caractere escapado enquanto a ênfase é separada. Nunca aparece
 *  num documento de verdade, que é o requisito para servir de marcador. */
const MASK = '\u0000'

function maskEscapes(text: string): string {
  return text.replace(ESCAPABLE, (_all, char: string) => `${MASK}${char.charCodeAt(0)}${MASK}`)
}

function unmaskEscapes(text: string): string {
  return text.replace(
    new RegExp(`${MASK}(\\d+)${MASK}`, 'g'),
    (_all, code: string) => String.fromCharCode(Number(code)),
  )
}

/**
 * Quebra o texto em trechos com marcação. Um passo só, sem aninhamento:
 * negrito dentro de itálico é raro num documento gerado e o custo de suportar
 * (um parser de verdade) não se paga aqui.
 */
export function parseInline(text: string): InlineRun[] {
  const runs: InlineRun[] = []
  // O <br> é tratado ANTES da ênfase: ele é estrutura, não estilo, e precisa
  // sobreviver ao escape de HTML que o resto do conteúdo sofre.
  const segments = text.split(LINE_BREAK)
  segments.forEach((segment, index) => {
    if (index > 0) runs.push({ text: '', br: true })
    // O caractere escapado sai de cena antes da separação da ênfase: é isso
    // que faz `\*` ser um asterisco no texto, e não o começo de um itálico.
    for (const part of maskEscapes(segment).split(INLINE)) {
      if (part === '') continue
      const push = (run: InlineRun) => runs.push({ ...run, text: unmaskEscapes(run.text) })
      if (/^\*\*[\s\S]+\*\*$/.test(part)) push({ text: part.slice(2, -2), bold: true })
      else if (/^`[\s\S]+`$/.test(part)) push({ text: part.slice(1, -1), code: true })
      else if (/^\*[\s\S]+\*$/.test(part)) push({ text: part.slice(1, -1), italic: true })
      else push({ text: part })
    }
  })
  return runs.length > 0 ? runs : [{ text: '' }]
}

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// ─── HTML (preview e origem do PDF) ──────────────────────────────────────

function inlineHtml(text: string): string {
  return parseInline(text)
    .map((run) => {
      if (run.br) return '<br>'
      const escaped = escapeXml(run.text)
      if (run.bold) return `<strong>${escaped}</strong>`
      if (run.italic) return `<em>${escaped}</em>`
      if (run.code) return `<code>${escaped}</code>`
      return escaped
    })
    .join('')
}

/**
 * CSS de documento impresso, não de página web: medidas em centímetro, fonte
 * do estilo escolhido, quebra de página controlada. É o mesmo HTML que vira
 * PDF, então o conteúdo do preview é o do arquivo.
 */
function documentCss(style: ResolvedStyle): string {
  const accent = `#${style.accentColor}`
  // Cabeçalho de tabela e régua usam a cor de destaque com transparência, para
  // um destaque forte não virar uma faixa sólida ilegível.
  const columns =
    style.columns > 1
      ? `column-count: ${style.columns}; column-gap: 1cm;`
      : ''
  return `
  /*
   * Margem SÓ no padding do body. Com @page margin também definida, as duas
   * somavam: o PDF saía com 5cm no topo em vez de 2.5cm, e cabiam 25 linhas
   * onde cabem 30.
   */
  @page { size: A4; margin: 0; }
  :root { color-scheme: light }
  body { margin: 0; padding: ${style.marginCm}cm ${Math.max(0.5, style.marginCm - 0.5)}cm;
         background: #fff; color: #111;
         font: ${style.fontSize}pt/1.6 ${fontStack(style)}; ${columns} }
  h1 { font-size: ${headingSize(style, 1)}pt; margin: 0 0 .6em; color: ${accent}; }
  h2 { font-size: ${headingSize(style, 2)}pt; margin: 1.4em 0 .4em; color: ${accent}; }
  h3 { font-size: ${headingSize(style, 3)}pt; margin: 1.2em 0 .3em; color: ${accent}; }
  p { margin: 0 0 .7em; text-align: ${style.align}; }
  ul, ol { margin: 0 0 .7em 1.4em; padding: 0; }
  li { margin: 0 0 .25em; }
  blockquote { margin: 0 0 .7em; padding-left: 1em; border-left: 3px solid ${accent}; color: #444; }
  code { font-family: 'Courier New', monospace; font-size: .92em; background: #f3f3f3; padding: .1em .3em; }
  /*
   * Bloco de código. O pre-wrap não é enfeite: numa folha A4 a linha longa
   * sem quebra sai CORTADA no PDF, e o que passa da margem simplesmente não
   * é impresso. E o alinhamento volta a ser à esquerda porque o corpo do
   * documento pode estar justificado, o que em código espaça os símbolos.
   */
  pre { margin: 0 0 .8em; padding: .6em .8em; background: #f6f7f9;
        border: 1px solid #e4e6ea; border-left: 3px solid ${accent};
        font-family: 'Courier New', monospace; font-size: ${Math.max(7, style.fontSize - 1.5)}pt;
        line-height: 1.45; text-align: left; white-space: pre-wrap;
        overflow-wrap: break-word; break-inside: avoid; }
  /* Dentro do bloco o <code> não repete o fundo nem o respiro do inline. */
  pre code { background: none; padding: 0; font-size: 1em; }
  /* Diagrama Mermaid: o SVG vem com a largura natural e encolhe para caber na
     coluna, sem nunca ser partido entre duas páginas. */
  .diagram { margin: .4em 0 1em; text-align: center; break-inside: avoid; }
  .diagram svg { max-width: 100%; height: auto; }
  hr { border: 0; border-top: 1px solid ${accent}; margin: 1.2em 0; opacity: .35; }
  table { border-collapse: collapse; width: 100%; margin: 0 0 .9em;
          font-size: ${Math.max(7, style.fontSize - 1)}pt; }
  th, td { border: 1px solid #bbb; padding: .35em .5em; vertical-align: top; }
  th { background: ${accent}; color: #fff; font-weight: bold; }
  /* Alinhamento vindo da divisória da tabela (|:---:|) */
  .c { text-align: center; } .r { text-align: right; } .l { text-align: left; }
  /* Uma tabela partida entre colunas fica ilegível; a coluna quebra antes. */
  table, blockquote { break-inside: avoid; }
  /* break-before e o nome moderno; page-break-before fica como fallback.
     A classe vai no bloco seguinte a quebra, nunca num elemento vazio. */
  .page-break { break-before: page; page-break-before: always; }

  /*
   * NA TELA o documento usa margem de leitura, não de impressão. O preview
   * cabe na largura do card e renderiza no tamanho natural — sem reduzir por
   * transform, que é o que deixava o texto pequeno e mole. Com 2.5cm de
   * margem numa coluna de chat sobraria pouco texto por linha.
   *
   * O printToPDF respeita @media print e ignora @media screen (verificado),
   * então o arquivo entregue mantém a margem de documento.
   */
  @media screen {
    body { padding: 1.2cm 1.4cm; }
  }
  @media print {
    body { padding: ${style.marginCm}cm ${Math.max(0.5, style.marginCm - 0.5)}cm; }
  }
`
}

/**
 * Os blocos em HTML, sem página nem estilo — é o que o documento impresso e a
 * miniatura nativa têm em comum. Cada um põe o seu CSS em volta.
 */
function htmlBody(blocks: Block[], diagrams?: DiagramLookup): string {
  const parts: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  /**
   * A quebra é aplicada ao bloco SEGUINTE, nunca como elemento próprio: um
   * `<div class="page-break">` vazio é colapsado pelo Chromium e o
   * page-break-before simplesmente não acontece — o PDF saía com uma página
   * só. Mesma estratégia do renderOoxmlBody.
   */
  let pendingBreak = false
  const breakClass = () => {
    if (!pendingBreak) return ''
    pendingBreak = false
    return ' class="page-break"'
  }

  const flushList = () => {
    if (!list) return
    const tag = list.ordered ? 'ol' : 'ul'
    parts.push(
      `<${tag}${breakClass()}>${list.items.map((i) => `<li>${inlineHtml(i)}</li>`).join('')}</${tag}>`,
    )
    list = null
  }

  for (const block of blocks) {
    if (block.type !== 'listItem') flushList()
    switch (block.type) {
      case 'heading':
        parts.push(`<h${block.level}${breakClass()}>${inlineHtml(block.text)}</h${block.level}>`)
        break
      case 'paragraph':
        parts.push(`<p${breakClass()}>${inlineHtml(block.text)}</p>`)
        break
      case 'quote':
        parts.push(`<blockquote${breakClass()}>${inlineHtml(block.text)}</blockquote>`)
        break
      case 'code': {
        const diagram = isMermaid(block) ? diagrams?.(mermaidSource(block)) : undefined
        if (diagram) {
          const brk = breakClass()
          parts.push(`<figure class="diagram${brk ? ' page-break' : ''}">${diagram.svg}</figure>`)
          break
        }
        parts.push(
          `<pre${breakClass()}><code>${block.lines.map(escapeXml).join('\n')}</code></pre>`,
        )
        break
      }
      case 'rule':
        parts.push(`<hr${breakClass()}>`)
        break
      case 'pageBreak':
        pendingBreak = true
        break
      case 'table': {
        // Classe de alinhamento por COLUNA, vinda da divisória do Markdown.
        const cls = (i: number) => {
          const a = block.align[i] ?? 'left'
          return a === 'center' ? ' class="c"' : a === 'right' ? ' class="r"' : ''
        }
        const head = block.header.map((c, i) => `<th${cls(i)}>${inlineHtml(c)}</th>`).join('')
        const body = block.rows
          .map((row) => `<tr>${row.map((c, i) => `<td${cls(i)}>${inlineHtml(c)}</td>`).join('')}</tr>`)
          .join('')
        parts.push(
          `<table${breakClass()}><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`,
        )
        break
      }
      case 'listItem':
        if (!list || list.ordered !== block.ordered) {
          flushList()
          list = { ordered: block.ordered, items: [] }
        }
        list.items.push(block.text)
        break
    }
  }
  flushList()
  return parts.join('\n')
}

export function renderHtml(
  blocks: Block[],
  title: string,
  style?: DocumentStyle,
  diagrams?: DiagramLookup,
): string {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeXml(title)}</title>
<style>${documentCss(normalizeStyle(style))}</style>
</head><body>
${htmlBody(blocks, diagrams)}
</body></html>`
}

/**
 * A MINIATURA de um documento vivo em Markdown.
 *
 * O tile da galeria é a capa do documento, então ele tem que parecer o que o
 * usuário vê ao abrir: a tela nativa no tema do Orbit, e não a folha A4 branca
 * — essa é a cara do PDF, e só quem foi pedido como arquivo merece.
 *
 * Sai com as DUAS paletas na mesma página, trocadas por uma classe no
 * <html>: a captura carrega a página uma vez e fotografa os dois temas, o que
 * evita uma segunda janela do Chromium e deixa o tile certo mesmo quando o
 * usuário troca o tema depois.
 *
 * As cores são os tokens do app (index.css), em oklch — o Chromium entende, e
 * copiar os valores é o que faz o tile combinar com a grade em volta dele. A
 * fonte não: a Geist é empacotada pelo renderer e não existe nesta janela, daí
 * a pilha de sistema.
 */
export function renderThumbHtml(
  blocks: Block[],
  title: string,
  diagrams?: DiagramLookup,
): string {
  const body = htmlBody(blocks, diagrams)
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<title>${escapeXml(title)}</title>
<style>
  :root { color-scheme: light;
    --bg: oklch(1 0 0); --fg: oklch(0.141 0.005 285.823);
    --muted: oklch(0.967 0.001 286.375); --muted-fg: oklch(0.552 0.016 285.938);
    --border: oklch(0.92 0.004 286.32); }
  :root.dark { color-scheme: dark;
    --bg: oklch(0.141 0.005 285.823); --fg: oklch(0.985 0 0);
    --muted: oklch(0.274 0.006 286.033); --muted-fg: oklch(0.705 0.015 286.067);
    --border: oklch(1 0 0 / 14%); }
  body { margin: 0; padding: 34px 40px; background: var(--bg); color: var(--fg);
         font: 15px/1.65 ui-sans-serif, 'Segoe UI', system-ui, sans-serif; }
  h1 { font-size: 1.7em; margin: 0 0 .5em; font-weight: 600; letter-spacing: -.01em; }
  h2 { font-size: 1.3em; margin: 1.2em 0 .4em; font-weight: 600; }
  h3 { font-size: 1.1em; margin: 1em 0 .3em; font-weight: 600; }
  p { margin: 0 0 .7em; }
  ul, ol { margin: 0 0 .7em 1.3em; padding: 0; }
  li { margin: 0 0 .25em; }
  blockquote { margin: 0 0 .7em; padding-left: .9em; border-left: 2px solid var(--border);
               color: var(--muted-fg); }
  code { font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace; font-size: .88em;
         background: var(--muted); border-radius: 4px; padding: .1em .35em; }
  pre { margin: 0 0 .8em; padding: .7em .9em; background: var(--muted);
        border: 1px solid var(--border); border-radius: 8px;
        font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace; font-size: .82em;
        line-height: 1.5; white-space: pre-wrap; overflow-wrap: break-word; }
  pre code { background: none; padding: 0; font-size: 1em; }
  hr { border: 0; border-top: 1px solid var(--border); margin: 1.2em 0; }
  table { border-collapse: collapse; width: 100%; margin: 0 0 .8em; font-size: .9em; }
  th, td { border: 1px solid var(--border); padding: .35em .5em; text-align: left; }
  th { background: var(--muted); font-weight: 600; }
  .c { text-align: center; } .r { text-align: right; }
  /* O diagrama é desenhado em fundo claro; no tema escuro ele vira um cartão
     branco em vez de linhas escuras sumindo no fundo. */
  .diagram { margin: 0 0 .8em; padding: .6em; background: #fff; border-radius: 8px;
             text-align: center; }
  .diagram svg { max-width: 100%; height: auto; }
</style>
</head><body>
${body}
</body></html>`
}

// ─── OOXML (o .docx) ─────────────────────────────────────────────────────

function inlineOoxml(text: string): string {
  return parseInline(text)
    .map((run) => {
      // No OOXML a quebra dentro do parágrafo é um run só com <w:br/>.
      if (run.br) return '<w:r><w:br/></w:r>'
      const props: string[] = []
      if (run.bold) props.push('<w:b/>')
      if (run.italic) props.push('<w:i/>')
      if (run.code) props.push('<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>')
      const rPr = props.length > 0 ? `<w:rPr>${props.join('')}</w:rPr>` : ''
      return `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(run.text)}</w:t></w:r>`
    })
    .join('')
}

/** numId das definições de lista declaradas em numbering.xml. */
const NUM_BULLET = 1
const NUM_ORDERED = 2

function paragraphOoxml(
  content: string,
  opts: { style?: string; numId?: number; pageBreak?: boolean; after?: number } = {},
): string {
  const pPr: string[] = []
  // Na ordem do schema do pPr: pStyle, pageBreakBefore, numPr, spacing.
  if (opts.style) pPr.push(`<w:pStyle w:val="${opts.style}"/>`)
  if (opts.pageBreak) pPr.push('<w:pageBreakBefore/>')
  if (opts.numId) pPr.push(`<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${opts.numId}"/></w:numPr>`)
  if (opts.after !== undefined) pPr.push(`<w:spacing w:after="${opts.after}"/>`)
  const props = pPr.length > 0 ? `<w:pPr>${pPr.join('')}</w:pPr>` : ''
  return `<w:p>${props}${content}</w:p>`
}

function tableOoxml(
  header: string[],
  rows: string[][],
  align: CellAlign[],
  style: ResolvedStyle,
): string {
  /** No OOXML o alinhamento é do PARÁGRAFO dentro da célula (w:jc), não da
   *  célula — alinhar a célula não move o texto. */
  const jc = (i: number) => {
    const a = align[i] ?? 'left'
    return a === 'left' ? '' : `<w:jc w:val="${a}"/>`
  }
  const cell = (text: string, i: number, isHeader: boolean) => {
    // Cabeçalho com a cor de destaque preenchida e texto branco, espelhando o
    // CSS — sem w:shd o Word desenha o cabeçalho igual ao corpo.
    const shading = isHeader
      ? `<w:shd w:val="clear" w:color="auto" w:fill="${style.accentColor}"/>`
      : ''
    const content = isHeader
      ? `<w:r><w:rPr><w:b/><w:color w:val="FFFFFF"/></w:rPr><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`
      : inlineOoxml(text)
    return `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/>${shading}</w:tcPr><w:p><w:pPr>${jc(i)}</w:pPr>${content}</w:p></w:tc>`
  }
  const headerRow = `<w:tr>${header.map((c, i) => cell(c, i, true)).join('')}</w:tr>`
  const bodyRows = rows
    .map((row) => `<w:tr>${row.map((c, i) => cell(c, i, false)).join('')}</w:tr>`)
    .join('')
  // Bordas explícitas: sem tblBorders o Word desenha a tabela sem linha nenhuma.
  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((side) => `<w:${side} w:val="single" w:sz="4" w:color="999999"/>`)
    .join('')
  return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${borders}</w:tblBorders></w:tblPr>${headerRow}${bodyRows}</w:tbl>`
}

/**
 * Uma imagem já registrada no pacote: o rId aponta para o PNG em word/media,
 * e o tamanho é o natural do diagrama em px CSS.
 */
export interface DocxImage {
  rId: string
  width: number
  height: number
}

/** EMU por px CSS (96 dpi) e por cm — as unidades de desenho do OOXML. */
const EMU_PER_PX = 9525
const EMU_PER_CM = 360000
/** Teto de altura: um diagrama mais alto que isso não cabe numa folha A4. */
const MAX_IMAGE_HEIGHT_CM = 22

/**
 * O parágrafo centralizado com a imagem inline. Encolhe (sem distorcer) para
 * a largura útil da coluna — o PNG é 2x, então o encolhimento não perde nitidez.
 */
function imageOoxml(
  image: DocxImage,
  drawingId: number,
  maxWidthEmu: number,
  pageBreak: boolean,
): string {
  let cx = image.width * EMU_PER_PX
  let cy = image.height * EMU_PER_PX
  const k = Math.min(1, maxWidthEmu / cx, (MAX_IMAGE_HEIGHT_CM * EMU_PER_CM) / cy)
  cx = Math.round(cx * k)
  cy = Math.round(cy * k)
  const name = `Diagrama ${drawingId}`
  const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
  const drawing =
    `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${drawingId}" name="${name}"/>` +
    `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="${A}" noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic xmlns:a="${A}">` +
    `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:nvPicPr><pic:cNvPr id="${drawingId}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${image.rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
  // jc no próprio parágrafo: o corpo pode estar justificado, e imagem
  // "justificada" encosta na margem esquerda.
  // A ordem dentro do pPr é a do schema (pageBreakBefore, spacing, jc): o
  // Word recusa o arquivo quando ela vem trocada.
  return `<w:p><w:pPr>${
    pageBreak ? '<w:pageBreakBefore/>' : ''
  }<w:spacing w:before="120" w:after="200"/><w:jc w:val="center"/></w:pPr>${drawing}</w:p>`
}

/**
 * Corpo do document.xml a partir dos blocos. `images` responde, pela fonte
 * Mermaid, a imagem que o pacote já registrou; o documento que a usa precisa
 * declarar os namespaces wp e r (ver buildDocx).
 */
export function renderOoxmlBody(
  blocks: Block[],
  style?: DocumentStyle,
  images?: (source: string) => DocxImage | undefined,
): string {
  const resolved = normalizeStyle(style)
  const parts: string[] = []
  let pendingBreak = false
  let drawingId = 0
  // Largura útil de UMA coluna: A4 menos as margens laterais (as mesmas do
  // buildDocx), dividida pelas colunas descontado o espaço entre elas.
  const sideCm = Math.max(0.5, resolved.marginCm - 0.5)
  const columnCm = (21 - 2 * sideCm - (resolved.columns - 1) * 0.75) / resolved.columns
  const maxWidthEmu = Math.round(columnCm * EMU_PER_CM)

  for (const block of blocks) {
    switch (block.type) {
      case 'heading':
        parts.push(paragraphOoxml(inlineOoxml(block.text), { style: `Heading${block.level}`, pageBreak: pendingBreak }))
        break
      case 'paragraph':
        parts.push(paragraphOoxml(inlineOoxml(block.text), { pageBreak: pendingBreak }))
        break
      case 'quote':
        parts.push(paragraphOoxml(inlineOoxml(block.text), { style: 'Quote', pageBreak: pendingBreak }))
        break
      case 'listItem':
        parts.push(
          paragraphOoxml(inlineOoxml(block.text), {
            style: 'ListParagraph',
            numId: block.ordered ? NUM_ORDERED : NUM_BULLET,
            pageBreak: pendingBreak,
          }),
        )
        break
      case 'table':
        // A quebra de página não se aplica a tabela (não existe
        // pageBreakBefore em w:tbl): entra como parágrafo vazio antes.
        if (pendingBreak) parts.push(paragraphOoxml('', { pageBreak: true }))
        parts.push(tableOoxml(block.header, block.rows, block.align, resolved))
        break
      case 'code': {
        const image = isMermaid(block) ? images?.(mermaidSource(block)) : undefined
        if (image) {
          parts.push(imageOoxml(image, ++drawingId, maxWidthEmu, pendingBreak))
          break
        }
        // Uma linha por PARÁGRAFO: o OOXML não tem elemento de bloco
        // pré-formatado, e um parágrafo só com <w:br/> perderia o fundo
        // cinza linha a linha. Bloco vazio ainda rende um parágrafo, senão
        // ``` ``` sumiria sem deixar rastro.
        const lines = block.lines.length > 0 ? block.lines : ['']
        lines.forEach((line, idx) => {
          parts.push(
            paragraphOoxml(`<w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r>`, {
              style: 'CodeBlock',
              pageBreak: pendingBreak && idx === 0,
              // O estilo zera o espaço entre as linhas do bloco; a última
              // devolve o respiro, senão o texto seguinte cola no código.
              ...(idx === lines.length - 1 ? { after: 160 } : {}),
            }),
          )
        })
        break
      }
      case 'rule':
        parts.push(
          `<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:color="AAAAAA"/></w:pBdr>${
            pendingBreak ? '<w:pageBreakBefore/>' : ''
          }</w:pPr></w:p>`,
        )
        break
      case 'pageBreak':
        pendingBreak = true
        continue
    }
    pendingBreak = false
  }
  return parts.join('')
}
