/**
 * Leitura de um deck de slides a partir do HTML, no main.
 *
 * O deck é um arquivo só (`index.html` com um `<section class="slide">` por
 * slide) — o mesmo documento que o scheme serve e o runtime anima. Aqui não há
 * navegador: o que este módulo entrega é o que dá para saber LENDO o arquivo —
 * quantos slides, o título de cada um e as notas do apresentador. É o que o
 * agente recebe de volta do `slides_preview` e o que a aba usa como fallback
 * antes do runtime responder.
 *
 * As regras de título e de nota são as MESMAS do runtime (slides-runtime.ts):
 * `data-title`, senão o primeiro h1/h2/h3, senão "Slide N"; a nota é o texto de
 * `<aside class="notes">` ou de um elemento com `data-notes`.
 *
 * O parser é de propósito um scanner de tags, e não um DOM: rodar um DOM no main
 * custaria uma janela do Chromium por preview, e o que se extrai aqui é raso.
 */

export interface DeckSlideSummary {
  /** Título exibível (o mesmo que a aba mostra na lista). */
  title: string
  /** Notas do apresentador, texto puro ('' quando não há). */
  notes: string
}

export interface DeckSummary {
  /** <title> do documento ('' quando ausente). */
  title: string
  slides: DeckSlideSummary[]
}

/** Teto de slides lidos — um deck de verdade não chega perto disso. */
const MAX_SLIDES = 300

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
}

/** Texto puro de um trecho de HTML: tags fora, entidades resolvidas. */
export function plainText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
      if (code.startsWith('#')) {
        const num = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
        return Number.isFinite(num) ? String.fromCodePoint(num) : match
      }
      return ENTITIES[code.toLowerCase()] ?? match
    })
    .replace(/\s+/g, ' ')
    .trim()
}

/** Atributos de uma tag de abertura, sem interpretar CSS nem nada. */
function attr(attrs: string, name: string): string | null {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
  const match = pattern.exec(attrs)
  if (!match) return null
  return plainText(match[2] ?? match[3] ?? match[4] ?? '')
}

function isSlideOpen(attrs: string): boolean {
  const className = attr(attrs, 'class') ?? ''
  return className.split(/\s+/).includes('slide')
}

export interface DeckSlideBody {
  /** Atributos da tag de abertura do slide (é onde mora o `data-title`). */
  attrs: string
  /** O que está entre a abertura e o fechamento. */
  body: string
}

/**
 * Corpo de cada `<section class="slide">` de TOPO, na ordem do documento.
 * Seções aninhadas pertencem ao slide que as contém (o mesmo critério do
 * runtime), então a busca pula o que já está dentro de um slide aberto.
 */
export function slideBodies(html: string): DeckSlideBody[] {
  const bodies: DeckSlideBody[] = []
  const tag = /<(\/?)section\b([^>]*)>/gi
  let depth = 0
  let slideStart = -1
  let slideDepth = -1
  let match: RegExpExecArray | null

  while ((match = tag.exec(html))) {
    const closing = match[1] === '/'
    if (!closing) {
      if (slideStart < 0 && isSlideOpen(match[2])) {
        slideStart = match.index
        slideDepth = depth
      }
      depth++
      continue
    }
    depth--
    if (slideStart >= 0 && depth === slideDepth) {
      // O `</section>` que fecha o slide: o corpo é o que está entre a tag de
      // abertura e este fechamento.
      const openTagEnd = html.indexOf('>', slideStart)
      bodies.push({
        attrs: html.slice(slideStart, openTagEnd).replace(/^<section\b/i, '').trim(),
        body: html.slice(openTagEnd + 1, match.index),
      })
      slideStart = -1
      slideDepth = -1
      if (bodies.length >= MAX_SLIDES) break
    }
  }
  return bodies
}

/** Título de um slide: `data-title`, senão o primeiro heading, senão "Slide N". */
export function slideTitle(body: string, attrs: string | null, index: number): string {
  const explicit = attrs ? attr(attrs, 'data-title') : null
  if (explicit && explicit.trim()) return explicit.trim()
  const heading = /<(h1|h2|h3)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(body)
  const text = heading ? plainText(heading[2]) : ''
  return text || `Slide ${index + 1}`
}

/**
 * Notas do apresentador. Duas formas, com semânticas diferentes:
 *
 *   <aside class="notes">o texto</aside>   → o TEXTO do elemento
 *   <div data-notes="o texto">…</div>      → o VALOR do atributo
 *
 * Se o elemento tem `data-notes` preenchido, ele manda (é a forma explícita);
 * sem valor, vale o conteúdo — a mesma regra do runtime.
 */
export function slideNotes(body: string): string {
  const marked = /<([a-z][a-z0-9]*)\b([^>]*\bdata-notes\b[^>]*)>([\s\S]*?)<\/\1>/i.exec(body)
  if (marked) {
    const value = attr(marked[2], 'data-notes')
    if (value && value.trim()) return value.trim()
    return plainText(marked[3])
  }
  const aside = /<aside\b([^>]*)>([\s\S]*?)<\/aside>/gi
  let match: RegExpExecArray | null
  while ((match = aside.exec(body))) {
    const className = attr(match[1], 'class') ?? ''
    if (className.split(/\s+/).includes('notes')) return plainText(match[2])
  }
  return ''
}

/** Tamanho do palco declarado pelo deck (padrão quando não há meta). */
export interface DeckSize {
  width: number
  height: number
}

/**
 * O tamanho do palco, lido do `<meta name="orbit-slides">`.
 *
 * O runtime já faz esta leitura no navegador, para escalar; aqui ela existe de
 * novo porque o PDF é impresso no PROCESSO PRINCIPAL, longe do deck: sem saber
 * o tamanho real, a página do PDF sairia 16:9 e um deck 4:3 (ou 1920x1080)
 * seria cortado ou reduzido com margem branca nas laterais.
 *
 * Mesmo parse do runtime, e pelo mesmo motivo: `width=1920,height=1080`,
 * separado por vírgula ou ponto e vírgula. Valor inválido cai no padrão.
 */
export function parseDeckSize(html: string, fallback: DeckSize): DeckSize {
  let width = fallback.width
  let height = fallback.height
  const meta = /<meta\b[^>]*name=["']orbit-slides["'][^>]*>/i.exec(html)
  if (!meta) return { width, height }
  const content = attr(meta[0], 'content') ?? ''
  for (const pair of content.split(/[,;]/)) {
    const at = pair.indexOf('=')
    if (at < 0) continue
    const key = pair.slice(0, at).trim().toLowerCase()
    const num = Number(pair.slice(at + 1).trim())
    if (!Number.isFinite(num) || num <= 0) continue
    if (key === 'width') width = Math.round(num)
    if (key === 'height') height = Math.round(num)
  }
  return { width, height }
}

/** Resumo do deck lido do arquivo. */
export function readDeckSummary(html: string): DeckSummary {
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  // Os atributos de abertura acompanham o corpo: o `data-title` mora na tag,
  // não dentro dela.
  const slides = slideBodies(html).map(({ attrs, body }, index) => ({
    title: slideTitle(body, attrs, index),
    notes: slideNotes(body),
  }))

  return {
    title: titleTag ? plainText(titleTag[1]) : '',
    slides,
  }
}
