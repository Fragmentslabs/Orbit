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

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'listItem'; text: string; ordered: boolean }
  | { type: 'quote'; text: string }
  | { type: 'table'; header: string[]; rows: string[][] }
  | { type: 'rule' }
  | { type: 'pageBreak' }

/** Quebra de página explícita no fonte — o Markdown não tem sintaxe para isso
 *  e um documento de várias páginas precisa. */
const PAGE_BREAK = /^\\pagebreak\s*$/i

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
      const rows: string[][] = []
      i += 1 // pula a divisória
      while (i + 1 < lines.length && TABLE_ROW.test(lines[i + 1].trim())) {
        i += 1
        rows.push(tableCells(lines[i].trim()))
      }
      blocks.push({ type: 'table', header, rows })
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
    for (const part of segment.split(INLINE)) {
      if (part === '') continue
      if (/^\*\*[\s\S]+\*\*$/.test(part)) runs.push({ text: part.slice(2, -2), bold: true })
      else if (/^`[\s\S]+`$/.test(part)) runs.push({ text: part.slice(1, -1), code: true })
      else if (/^\*[\s\S]+\*$/.test(part)) runs.push({ text: part.slice(1, -1), italic: true })
      else runs.push({ text: part })
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
 * serifada, quebra de página controlada. É o mesmo HTML que vira PDF, então
 * o que se vê no preview é o que sai impresso.
 */
const DOCUMENT_CSS = `
  @page { size: A4; margin: 2.5cm 2cm; }
  :root { color-scheme: light }
  body { margin: 0; padding: 2.5cm 2cm; background: #fff; color: #111;
         font: 11pt/1.6 Georgia, 'Times New Roman', serif; }
  h1 { font-size: 20pt; margin: 0 0 .6em; }
  h2 { font-size: 15pt; margin: 1.4em 0 .4em; }
  h3 { font-size: 12.5pt; margin: 1.2em 0 .3em; }
  p { margin: 0 0 .7em; text-align: justify; }
  ul, ol { margin: 0 0 .7em 1.4em; padding: 0; }
  li { margin: 0 0 .25em; }
  blockquote { margin: 0 0 .7em; padding-left: 1em; border-left: 3px solid #ccc; color: #444; }
  code { font-family: 'Courier New', monospace; font-size: .92em; background: #f3f3f3; padding: .1em .3em; }
  hr { border: 0; border-top: 1px solid #ccc; margin: 1.2em 0; }
  table { border-collapse: collapse; width: 100%; margin: 0 0 .9em; font-size: 10pt; }
  th, td { border: 1px solid #bbb; padding: .35em .5em; text-align: left; vertical-align: top; }
  th { background: #f0f0f0; font-weight: bold; }
  /* break-before e o nome moderno; page-break-before fica como fallback.
     A classe vai no bloco seguinte a quebra, nunca num elemento vazio. */
  .page-break { break-before: page; page-break-before: always; }
  @media screen { body { padding: 2.5cm 2cm; box-shadow: 0 0 0 1px #e5e5e5; } }
`

export function renderHtml(blocks: Block[], title: string): string {
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
      case 'rule':
        parts.push(`<hr${breakClass()}>`)
        break
      case 'pageBreak':
        pendingBreak = true
        break
      case 'table': {
        const head = block.header.map((c) => `<th>${inlineHtml(c)}</th>`).join('')
        const body = block.rows
          .map((row) => `<tr>${row.map((c) => `<td>${inlineHtml(c)}</td>`).join('')}</tr>`)
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

  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeXml(title)}</title>
<style>${DOCUMENT_CSS}</style>
</head><body>
${parts.join('\n')}
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

function paragraphOoxml(content: string, opts: { style?: string; numId?: number; pageBreak?: boolean } = {}): string {
  const pPr: string[] = []
  if (opts.style) pPr.push(`<w:pStyle w:val="${opts.style}"/>`)
  if (opts.numId) pPr.push(`<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${opts.numId}"/></w:numPr>`)
  if (opts.pageBreak) pPr.push('<w:pageBreakBefore/>')
  const props = pPr.length > 0 ? `<w:pPr>${pPr.join('')}</w:pPr>` : ''
  return `<w:p>${props}${content}</w:p>`
}

function tableOoxml(header: string[], rows: string[][]): string {
  const cell = (text: string, bold: boolean) =>
    `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${paragraphOoxml(
      bold ? `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>` : inlineOoxml(text),
    )}</w:tc>`
  const headerRow = `<w:tr>${header.map((c) => cell(c, true)).join('')}</w:tr>`
  const bodyRows = rows
    .map((row) => `<w:tr>${row.map((c) => cell(c, false)).join('')}</w:tr>`)
    .join('')
  // Bordas explícitas: sem tblBorders o Word desenha a tabela sem linha nenhuma.
  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((side) => `<w:${side} w:val="single" w:sz="4" w:color="999999"/>`)
    .join('')
  return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${borders}</w:tblBorders></w:tblPr>${headerRow}${bodyRows}</w:tbl>`
}

/** Corpo do document.xml a partir dos blocos. */
export function renderOoxmlBody(blocks: Block[]): string {
  const parts: string[] = []
  let pendingBreak = false

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
        parts.push(tableOoxml(block.header, block.rows))
        break
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
