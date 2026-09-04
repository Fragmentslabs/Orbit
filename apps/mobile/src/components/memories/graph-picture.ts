/**
 * Gravação da cena do grafo num SkPicture.
 *
 * Um SkPicture é uma lista de comandos de desenho gravada UMA vez e reproduzida
 * pela GPU a cada frame. É a diferença entre o grafo andar e o grafo travar:
 * com react-native-svg cada círculo, traço e rótulo é uma view nativa, e mudar
 * a transform obrigava o motor a redesenhar a árvore inteira em CPU — algumas
 * centenas de nós já não fechavam 60fps num celular. Aqui o React não participa
 * do frame: ele grava a cena quando o CONTEÚDO muda (layout novo, nível de zoom,
 * busca) e a thread de UI só aplica uma matriz por cima.
 *
 * O que sobra fora do picture é o que muda a toque de dedo: o realce do nó
 * selecionado, desenhado como componente normal por cima.
 */
import { Skia, createPicture, PaintStyle } from '@shopify/react-native-skia'
import type { SkFont, SkPaint, SkPicture } from '@shopify/react-native-skia'
import type { IndiceGrafo, NoDesenho } from './graph-index'

export interface Fontes {
  fato: SkFont
  area: SkFont
  raiz: SkFont
}

export interface OpcoesCena {
  /** 3 = tudo, 2 = sem rótulo, 1 = sem anel e só árvore, 0 = resumo por bloco. */
  nivel: number
  /** Ids que casam com a busca; null quando a busca está vazia. */
  casam: Set<string> | null
  fontes: Fontes
  corTexto: string
}

/** Largura já medida do rótulo, guardada no nó — medir é o passo caro da
 *  gravação, e o texto não muda entre uma gravação e outra. */
const larguras = new WeakMap<NoDesenho, number>()

function larguraDe(no: NoDesenho, fonte: SkFont): number {
  const guardada = larguras.get(no)
  if (guardada != null) return guardada
  const largura = fonte.measureText(no.rotulo).width
  larguras.set(no, largura)
  return largura
}

/**
 * Converte as cores do tema (`hsl(...)`) para hexadecimal. O parser de cor do
 * Skia não cobre hsl, e passar a string crua devolveria preto sem avisar.
 */
export function corSkia(cor: string): string {
  const m = /hsla?\(\s*([\d.]+)[,\s]+([\d.]+)%[,\s]+([\d.]+)%/.exec(cor)
  if (!m) return cor
  const h = Number(m[1]) / 360
  const s = Number(m[2]) / 100
  const l = Number(m[3]) / 100
  if (s === 0) {
    const v = Math.round(l * 255)
    return `#${v.toString(16).padStart(2, '0').repeat(3)}`
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const canal = (t: number) => {
    let x = t
    if (x < 0) x += 1
    if (x > 1) x -= 1
    if (x < 1 / 6) return p + (q - p) * 6 * x
    if (x < 1 / 2) return q
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6
    return p
  }
  const hex = (v: number) =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${hex(canal(h + 1 / 3))}${hex(canal(h))}${hex(canal(h - 1 / 3))}`
}

/** Opacidade do nó: fora da busca apaga, esquecida desbota. */
function opacidadeDe(no: NoDesenho, casam: Set<string> | null): number {
  if (casam && !casam.has(no.id)) return 0.18
  return no.velha ? 0.45 : 1
}

function pintura(estilo: PaintStyle): SkPaint {
  const p = Skia.Paint()
  p.setAntiAlias(true)
  p.setStyle(estilo)
  return p
}

export function gravarCena(indice: IndiceGrafo, opcoes: OpcoesCena): SkPicture | null {
  if (indice.total === 0) return null
  const { nivel, casam, fontes, corTexto } = opcoes
  const limites = indice.limites
  const caixa = Skia.XYWHRect(
    limites.minX,
    limites.minY,
    Math.max(1, limites.maxX - limites.minX),
    Math.max(1, limites.maxY - limites.minY),
  )

  return createPicture((canvas) => {
    // Três pinturas para a cena inteira, reconfiguradas antes de cada comando:
    // o Skia copia o estado da pintura para a lista no momento do desenho, e
    // criar uma por nó só geraria lixo.
    const preenche = pintura(PaintStyle.Fill)
    const traca = pintura(PaintStyle.Stroke)
    const texto = pintura(PaintStyle.Fill)
    texto.setColor(Skia.Color(corTexto))

    // ── Resumo: um ponto por bloco, no zoom em que o nó vira sujeira ──────
    if (nivel === 0) {
      for (const bloco of indice.blocos) {
        const cor = Skia.Color(bloco.cor)
        preenche.setColor(cor)
        preenche.setAlphaf(0.3)
        canvas.drawCircle(bloco.cx, bloco.cy, bloco.raio, preenche)
        traca.setColor(cor)
        traca.setAlphaf(0.7)
        traca.setStrokeWidth(1)
        canvas.drawCircle(bloco.cx, bloco.cy, bloco.raio, traca)
      }
      // Os marcos ficam: são eles que dizem onde cada projeto está enquanto o
      // resto é nuvem.
      for (const no of indice.marcos) {
        desenharNo(canvas, no, 1, preenche, traca)
        if (no.isRoot) desenharRotulo(canvas, no, fontes.raiz, texto, 1)
      }
      return
    }

    // ── Arestas ──────────────────────────────────────────────────────────
    const tracejado = Skia.PathEffect.MakeDash([6, 4], 0)
    const pontilhado = Skia.PathEffect.MakeDash([3, 5], 0)
    for (const aresta of indice.arestas) {
      // Nível 1 é o zoom de longe: só a árvore, que é o esqueleto do desenho.
      // As arestas de relação viram cruzamento ilegível nessa escala.
      if (nivel <= 1 && !aresta.arvore) continue
      traca.setColor(Skia.Color(aresta.cor))
      traca.setAlphaf(aresta.opacidade)
      traca.setStrokeWidth(aresta.largura)
      traca.setPathEffect(
        aresta.traco === '3 5' ? pontilhado : aresta.traco === '6 4' ? tracejado : null,
      )
      canvas.drawLine(aresta.x1, aresta.y1, aresta.x2, aresta.y2, traca)
    }
    traca.setPathEffect(null)

    // ── Nós ──────────────────────────────────────────────────────────────
    for (const no of indice.nos) {
      const opacidade = opacidadeDe(no, casam)
      if (nivel >= 2 && no.recente && !no.isRoot) {
        traca.setColor(Skia.Color(no.cor))
        traca.setAlphaf(0.5 * opacidade)
        traca.setStrokeWidth(1.5)
        canvas.drawCircle(no.x, no.y, no.r + 4, traca)
      }
      desenharNo(canvas, no, opacidade, preenche, traca)
      if (nivel >= 3 || no.isRoot) {
        const fonte = no.isRoot ? fontes.raiz : no.fontSize >= 11 ? fontes.area : fontes.fato
        desenharRotulo(canvas, no, fonte, texto, opacidade)
      }
    }
  }, caixa)
}

/** Círculo do nó: preenchimento translúcido + contorno na cor do tipo. */
function desenharNo(
  canvas: Parameters<Parameters<typeof createPicture>[0]>[0],
  no: NoDesenho,
  opacidade: number,
  preenche: SkPaint,
  traca: SkPaint,
): void {
  const cor = Skia.Color(no.cor)
  preenche.setColor(cor)
  preenche.setAlphaf(no.fillOpacity * opacidade)
  canvas.drawCircle(no.x, no.y, no.r, preenche)
  traca.setColor(cor)
  traca.setAlphaf(opacidade)
  traca.setStrokeWidth(no.larguraTraco)
  canvas.drawCircle(no.x, no.y, no.r, traca)
}

/** Rótulo centrado abaixo do círculo (estilo Obsidian). O Skia desenha a
 *  partir da linha de base à esquerda, então a centralização é nossa. */
function desenharRotulo(
  canvas: Parameters<Parameters<typeof createPicture>[0]>[0],
  no: NoDesenho,
  fonte: SkFont,
  texto: SkPaint,
  opacidade: number,
): void {
  if (!no.rotulo) return
  texto.setAlphaf(opacidade)
  canvas.drawText(no.rotulo, no.x - larguraDe(no, fonte) / 2, no.y + no.rotuloY, texto, fonte)
}
