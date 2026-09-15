/**
 * Localizar um trecho dentro do texto posicionado de uma página de PDF.
 *
 * Roda no RENDERER, a partir dos itens que vieram junto com a imagem. Antes
 * isso era feito no main a cada busca, o que obrigava a redesenhar a página
 * inteira a cada letra digitada — e o painel piscava "carregando". Com os
 * itens em mãos, procurar é uma busca em string e o destaque aparece sem
 * nenhuma ida ao main.
 *
 * As coordenadas são FRAÇÕES da página (0 a 1), então valem para qualquer
 * zoom: trocar a escala não invalida nada.
 */

export interface PdfTextItem {
  x: number
  y: number
  width: number
  height: number
  text: string
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Remove os espaços para a comparação.
 *
 * O PDF quebra a frase em vários itens e a posição dos espaços entre eles não
 * é confiável — "um destino" pode chegar como "um", "des", "tino". Colar tudo
 * e procurar o trecho igualmente colado é o que casa na prática.
 */
function squash(text: string): string {
  return text.replace(/\s+/g, "").toLowerCase()
}

/**
 * Retângulos de TODAS as ocorrências do trecho na página.
 *
 * Todas, e não só a primeira: na busca a palavra costuma repetir na mesma
 * página, e marcar uma só faria o contador dizer 7 enquanto a página mostra 1.
 */
export function locateText(items: PdfTextItem[], needle: string, max = 200): Rect[] {
  const target = squash(needle)
  if (target.length < 2 || items.length === 0) return []

  let flat = ""
  const spans: { from: number; to: number; item: PdfTextItem }[] = []
  for (const item of items) {
    const piece = squash(item.text)
    if (!piece) continue
    spans.push({ from: flat.length, to: flat.length + piece.length, item })
    flat += piece
  }

  const rects: Rect[] = []
  let at = flat.indexOf(target)
  while (at >= 0 && rects.length < max) {
    const end = at + target.length
    for (const span of spans) {
      if (span.to <= at || span.from >= end) continue
      rects.push({
        x: span.item.x,
        y: span.item.y,
        width: span.item.width,
        height: span.item.height,
      })
    }
    at = flat.indexOf(target, at + target.length)
  }
  return rects
}

/**
 * Fator horizontal para a camada de seleção encostar no texto desenhado.
 *
 * A camada é de spans transparentes por cima da imagem: o texto real está no
 * pixel, e estes spans existem só para dar seleção e cópia. Sem correção eles
 * ficariam mais largos ou mais estreitos que os glifos e a marca da seleção
 * apareceria torta. A estimativa usa meia altura por caractere, que é a
 * proporção média das fontes de texto corrido — é aproximação, não medição.
 */
export function selectionScaleX(item: PdfTextItem, aspect: number): number {
  const chars = item.text.length
  if (chars === 0 || item.height <= 0 || aspect <= 0) return 1
  // `height` é fração da ALTURA e `width` é fração da LARGURA: comparar os
  // dois exige passar pela proporção da página, senão o fator sai errado em
  // tudo que não for quadrado.
  const estimated = (chars * item.height * 0.5) / aspect
  if (estimated <= 0) return 1
  return Math.min(3, Math.max(0.2, item.width / estimated))
}
