import sharp from 'sharp'

/**
 * Miniatura de um documento da aba Fontes.
 *
 * O ícone por tipo diz o FORMATO, e é a informação que menos importa quando a
 * lista cresce: cinco PDFs viram cinco ícones iguais. A miniatura diz QUAL
 * documento é — pela cara da primeira página, que é como a pessoa reconhece um
 * arquivo que ela mesma anexou.
 *
 * Dois caminhos, porque nem toda fonte tem página:
 *
 * - PDF é a página 1 de verdade, renderizada pelo mesmo pdfjs do visualizador.
 * - O resto (DOCX, planilha, texto colado, site) não tem imagem nenhuma
 *   guardada — o que existe é o texto extraído. Então a miniatura DESENHA uma
 *   folha com as primeiras linhas, que é o que um gerenciador de arquivos faz
 *   e o que deixa dois textos colados distinguíveis um do outro.
 *
 * Sem BrowserWindow no segundo caso: o SVG entra direto no sharp, que o
 * rasteriza. É por isso que o texto é desenhado aqui e não em HTML.
 */

/** Tamanho gravado — 2x do exibido, para não borrar em tela hidpi. */
export const THUMB_WIDTH = 160
/** Proporção ~1:1.3, a de uma folha A4 de pé. */
export const THUMB_HEIGHT = 208

/** Linhas que cabem na folha desenhada, no tamanho de fonte abaixo. */
const TEXT_LINES = 13
const FONT_SIZE = 7.5
const LINE_HEIGHT = 11
/** Largura média de um caractere, para cortar a linha antes de vazar da folha. */
const CHAR_WIDTH = 3.9
const PADDING = 11

/**
 * Cadeia de fontes com um representante de cada plataforma. Não é decoração:
 * se nenhuma resolver, o librsvg desenha a folha VAZIA em vez de dar erro — é
 * o caso que o `looksBlank` abaixo pega.
 */
const FONT_STACK = 'Segoe UI, DejaVu Sans, Liberation Sans, Helvetica, Arial, sans-serif'

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * As primeiras linhas úteis do texto.
 *
 * Linha em branco não vira linha da miniatura: num documento com espaçamento
 * duplo, metade da folha seria vazia. Linha comprida é cortada no que cabe —
 * quebrar em duas gastaria o espaço de outra linha de conteúdo.
 */
function previewLines(text: string, max: number): string[] {
  const limit = Math.floor((THUMB_WIDTH - PADDING * 2) / CHAR_WIDTH)
  const lines: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+/g, ' ').trim()
    if (!line) continue
    lines.push(line.length > limit ? `${line.slice(0, limit - 1)}…` : line)
    if (lines.length >= max) break
  }
  return lines
}

/** A folha desenhada: fundo branco, um filete de borda e o texto. */
function pageSvg(lines: string[]): string {
  const text = lines
    .map(
      (line, i) =>
        `<text x="${PADDING}" y="${PADDING + 8 + i * LINE_HEIGHT}" font-family="${FONT_STACK}" font-size="${FONT_SIZE}" fill="#3f3f46">${escapeXml(line)}</text>`,
    )
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${THUMB_WIDTH}" height="${THUMB_HEIGHT}">
    <rect width="${THUMB_WIDTH}" height="${THUMB_HEIGHT}" fill="#ffffff"/>
    <rect x="0.5" y="0.5" width="${THUMB_WIDTH - 1}" height="${THUMB_HEIGHT - 1}" fill="none" stroke="#e4e4e7"/>
    ${text}
  </svg>`
}

/**
 * Mesma folha, com barras no lugar do texto.
 *
 * É o plano B de quando nenhuma fonte resolveu: `<rect>` não depende de
 * fontconfig, então isto desenha em qualquer máquina. O comprimento de cada
 * barra acompanha o da linha real, o que ainda distingue um parágrafo denso de
 * uma lista curta.
 */
function skeletonSvg(lines: string[]): string {
  const bars = lines
    .map((line, i) => {
      const width = Math.max(12, Math.min(THUMB_WIDTH - PADDING * 2, line.length * CHAR_WIDTH))
      return `<rect x="${PADDING}" y="${PADDING + 3 + i * LINE_HEIGHT}" width="${width}" height="3.5" rx="1.5" fill="#d4d4d8"/>`
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${THUMB_WIDTH}" height="${THUMB_HEIGHT}">
    <rect width="${THUMB_WIDTH}" height="${THUMB_HEIGHT}" fill="#ffffff"/>
    <rect x="0.5" y="0.5" width="${THUMB_WIDTH - 1}" height="${THUMB_HEIGHT - 1}" fill="none" stroke="#e4e4e7"/>
    ${bars}
  </svg>`
}

/**
 * A folha saiu em branco?
 *
 * Serve para um caso só, mas real: sem fonte instalada o librsvg não reclama —
 * ele devolve a folha limpa. Contar pixel escuro é o que separa "renderizou" de
 * "renderizou nada", e é barato numa imagem de 160x208.
 *
 * Mede só o MIOLO, recortando a moldura: ela é desenhada com `<rect>` e sai
 * igual nos dois casos, então contá-la seria dar por renderizada uma folha em
 * que nenhuma letra apareceu.
 *
 * E o corte é baixo de propósito. Um texto colado de duas linhas pinta pouco
 * mais de cem pixels no tamanho em que isto é desenhado; um corte calibrado
 * para "folha cheia" descartaria o texto curto, que é justamente o caso em que
 * a capa mais ajuda a distinguir uma fonte da outra.
 */
const BLANK_MARGIN = 3
const INK_LEVEL = 200
const MIN_INK_PIXELS = 20

async function looksBlank(png: Buffer): Promise<boolean> {
  try {
    const { data } = await sharp(png)
      .extract({
        left: BLANK_MARGIN,
        top: BLANK_MARGIN,
        width: THUMB_WIDTH - BLANK_MARGIN * 2,
        height: THUMB_HEIGHT - BLANK_MARGIN * 2,
      })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true })
    let ink = 0
    for (let i = 0; i < data.length; i++) {
      if (data[i] < INK_LEVEL && ++ink > MIN_INK_PIXELS) return false
    }
    return true
  } catch {
    return false
  }
}

async function toWebp(svg: string): Promise<Buffer> {
  return sharp(Buffer.from(svg)).webp({ quality: 80 }).toBuffer()
}

/**
 * Miniatura desenhada a partir do texto do documento.
 *
 * Nunca lança: a miniatura é enfeite, e uma fonte sem miniatura continua
 * perfeitamente utilizável na lista (o ícone do tipo volta a aparecer).
 */
export async function textThumb(text: string): Promise<Buffer | null> {
  const lines = previewLines(text, TEXT_LINES)
  if (lines.length === 0) return null
  try {
    const rendered = await sharp(Buffer.from(pageSvg(lines))).png().toBuffer()
    if (!(await looksBlank(rendered))) return sharp(rendered).webp({ quality: 80 }).toBuffer()
    return await toWebp(skeletonSvg(lines))
  } catch {
    try {
      return await toWebp(skeletonSvg(lines))
    } catch {
      return null
    }
  }
}

/**
 * Miniatura da primeira página renderizada de um PDF.
 *
 * `contain` sobre branco, e não `cover`: recortar a página para preencher o
 * quadro cortaria justamente o topo, que é onde está o título pelo qual a
 * pessoa reconhece o documento.
 */
export async function pageThumb(png: Buffer): Promise<Buffer | null> {
  try {
    return await sharp(png)
      .resize({
        width: THUMB_WIDTH,
        height: THUMB_HEIGHT,
        fit: 'contain',
        background: '#ffffff',
      })
      .webp({ quality: 78 })
      .toBuffer()
  } catch {
    return null
  }
}
