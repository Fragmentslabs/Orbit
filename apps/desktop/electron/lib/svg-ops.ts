import { DOMParser, XMLSerializer } from '@xmldom/xmldom'

/**
 * Manipulação de SVG — que é TEXTO, não pixel.
 *
 * Por isso este módulo não usa o sharp: recolorir um ícone é reescrever
 * atributos, não reprocessar imagem. E é a diferença que dá o valor — trocar a
 * cor de um logo em SVG devolve o logo, no mesmo desenho, em qualquer tamanho;
 * a mesma troca num PNG devolve uma aproximação do que já estava lá.
 *
 * O caminho contrário (SVG → PNG) fica com o sharp, que já o faz. O sharp LÊ
 * SVG mas não ESCREVE: vetorizar nunca vai sair dele.
 *
 * Módulo puro de texto (sem Electron, sem IO), para ser testável — mesma
 * separação do pdf-ops.ts e do image-ops.ts.
 */

/** Atributos que carregam cor num SVG. `flood-` e `lighting-` aparecem em
 *  filtros; `stop-color` em gradientes. */
const COLOR_ATTRS = [
  'fill',
  'stroke',
  'stop-color',
  'flood-color',
  'lighting-color',
  'color',
]

/**
 * Valores que PARECEM cor e não são.
 *
 * `none` é ausência de pintura e trocá-lo por uma cor preencheria formas que
 * eram só contorno. `currentColor` é a herança do CSS de quem usa o ícone —
 * é justamente o que torna um ícone recolorível pela página, e resolvê-lo aqui
 * destruiria essa propriedade. `inherit` e `transparent` pela mesma razão.
 */
const NOT_A_COLOR = new Set(['none', 'currentcolor', 'inherit', 'transparent'])

/**
 * Forma comparável de uma cor.
 *
 * Normaliza o que dá para normalizar com certeza — hexadecimal curto para
 * longo, caixa — e deixa o resto em minúsculas, comparado literalmente. Não
 * traduz nome para hexadecimal: `white` continua `white`, então um mapa com
 * `white` casa com `white` e um com `#ffffff` casa com `#fff`. Inventar a
 * tabela de 147 nomes do CSS traria mais erro do que acerto.
 */
export function normalizeColor(value: string): string {
  const text = value.trim().toLowerCase()
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text)
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`
  const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(text)
  if (rgb) {
    const hex = (v: string) => Number(v).toString(16).padStart(2, '0')
    return `#${hex(rgb[1])}${hex(rgb[2])}${hex(rgb[3])}`
  }
  return text
}

function isColor(value: string): boolean {
  const text = value.trim().toLowerCase()
  return text.length > 0 && !NOT_A_COLOR.has(text) && !text.startsWith('url(')
}

export interface SvgInfo {
  width: number | null
  height: number | null
  viewBox: string | null
  /** Cores presentes, normalizadas e sem repetição — é o que permite pedir a
   *  troca sem abrir o arquivo para descobrir o que tem lá dentro. */
  colors: string[]
}

/** Erro explícito quando não é SVG: o DOMParser aceita quase tudo calado e o
 *  resultado seria um "sucesso" que não mudou nada. */
function parse(markup: string): Document {
  // Aviso do parser não vira ruído no terminal: um SVG de editor traz
  // namespace e entidade que o xmldom reclama sem que nada esteja errado. O
  // que importa é o resultado, conferido logo abaixo.
  const doc = new DOMParser({ errorHandler: () => {} }).parseFromString(markup, 'image/svg+xml')
  const root = doc.documentElement
  if (!root || root.nodeName.toLowerCase() !== 'svg') {
    throw new Error('Não é um SVG: o elemento raiz precisa ser <svg>.')
  }
  return doc as unknown as Document
}

function serialize(doc: Document): string {
  return new XMLSerializer().serializeToString(doc as never)
}

/** Percorre todos os elementos — o xmldom não tem querySelectorAll. */
function eachElement(doc: Document, visit: (el: Element) => void): void {
  const walk = (node: Node) => {
    if (node.nodeType === 1) visit(node as Element)
    // No xmldom um nó de texto tem childNodes NULO, e não lista vazia: ler
    // `.length` direto estoura no primeiro SVG com quebra de linha dentro.
    const filhos = node.childNodes
    if (!filhos) return
    for (let i = 0; i < filhos.length; i++) walk(filhos[i])
  }
  walk(doc.documentElement as unknown as Node)
}

/** Cores dentro de `style="fill:#fff;stroke:red"`. */
function eachStyleColor(
  style: string,
  visit: (prop: string, value: string) => string | null,
): string {
  return style
    .split(';')
    .map((decl) => {
      const at = decl.indexOf(':')
      if (at < 0) return decl
      const prop = decl.slice(0, at).trim().toLowerCase()
      const value = decl.slice(at + 1).trim()
      if (!COLOR_ATTRS.includes(prop) || !isColor(value)) return decl
      const next = visit(prop, value)
      return next === null ? decl : `${decl.slice(0, at)}:${next}`
    })
    .join(';')
}

export function svgInfo(markup: string): SvgInfo {
  const doc = parse(markup)
  const root = doc.documentElement as unknown as Element
  const colors = new Set<string>()

  eachElement(doc, (el) => {
    for (const attr of COLOR_ATTRS) {
      const value = el.getAttribute(attr)
      if (value && isColor(value)) colors.add(normalizeColor(value))
    }
    const style = el.getAttribute('style')
    if (style) {
      eachStyleColor(style, (_prop, value) => {
        colors.add(normalizeColor(value))
        return null
      })
    }
  })

  const size = (name: string) => {
    const raw = root.getAttribute(name)
    if (!raw) return null
    const n = Number.parseFloat(raw)
    return Number.isFinite(n) ? n : null
  }

  return {
    width: size('width'),
    height: size('height'),
    viewBox: root.getAttribute('viewBox'),
    colors: [...colors].sort(),
  }
}

export interface RecolorOptions {
  /** Troca dirigida: de → para. As chaves são comparadas normalizadas. */
  map?: Record<string, string>
  /** Pinta TODA cor com esta — a variante monocromática de um ícone. */
  all?: string
}

export interface RecolorResult {
  markup: string
  /** Quantas pinturas mudaram. Zero é a resposta honesta a um mapa que não
   *  casou com nada, e é o que distingue isso de um sucesso silencioso. */
  changed: number
}

/**
 * Troca as cores mantendo o desenho.
 *
 * Alcança atributo (`fill="#f00"`) e estilo embutido (`style="fill:#f00"`).
 * NÃO alcança regra dentro de `<style>`: aquilo é CSS de verdade, com
 * seletores e especificidade, e um replace de texto ali acerta por sorte. O
 * resultado diz quantas pinturas mudaram, então um SVG que só se pinta por
 * CSS aparece como zero em vez de passar por trocado.
 */
export function recolorSvg(markup: string, options: RecolorOptions): RecolorResult {
  const doc = parse(markup)
  const map = new Map<string, string>()
  for (const [from, to] of Object.entries(options.map ?? {})) {
    map.set(normalizeColor(from), to)
  }
  if (map.size === 0 && !options.all) {
    throw new Error('Informe `map` (de → para) ou `all` (pinta tudo de uma cor).')
  }

  let changed = 0
  const troca = (value: string): string | null => {
    if (options.all) {
      changed++
      return options.all
    }
    const next = map.get(normalizeColor(value))
    if (next === undefined) return null
    changed++
    return next
  }

  eachElement(doc, (el) => {
    for (const attr of COLOR_ATTRS) {
      const value = el.getAttribute(attr)
      if (!value || !isColor(value)) continue
      const next = troca(value)
      if (next !== null) el.setAttribute(attr, next)
    }
    const style = el.getAttribute('style')
    if (style) {
      const next = eachStyleColor(style, (_prop, value) => troca(value))
      if (next !== style) el.setAttribute('style', next)
    }
  })

  return { markup: serialize(doc), changed }
}

/**
 * Muda o tamanho de exibição sem tocar no desenho.
 *
 * O que dá escala a um SVG é o `viewBox`: ele é o sistema de coordenadas, e
 * width/height são só o tamanho em que aquilo é pintado. Por isso aqui o
 * viewBox nunca muda — mexer nele recortaria ou deslocaria o desenho, que é o
 * oposto de redimensionar.
 *
 * Sem viewBox no arquivo original, um é criado a partir do tamanho que ele
 * tinha; senão o novo width/height esticaria o conteúdo em vez de escalá-lo.
 */
export function resizeSvg(markup: string, size: { width?: number; height?: number }): string {
  if (!size.width && !size.height) throw new Error('Informe width e/ou height.')
  const doc = parse(markup)
  const root = doc.documentElement as unknown as Element

  const atual = svgInfo(markup)
  if (!atual.viewBox && atual.width && atual.height) {
    root.setAttribute('viewBox', `0 0 ${atual.width} ${atual.height}`)
  }

  // Um lado só preserva a proporção do viewBox, que é o comportamento
  // esperado de "quero este ícone com 512 de largura".
  const box = (root.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number)
  const proporcao = box.length === 4 && box[2] > 0 && box[3] > 0 ? box[3] / box[2] : null

  const width = size.width ?? (size.height && proporcao ? size.height / proporcao : null)
  const height = size.height ?? (size.width && proporcao ? size.width * proporcao : null)

  if (width) root.setAttribute('width', String(Math.round(width)))
  if (height) root.setAttribute('height', String(Math.round(height)))
  return serialize(doc)
}

/**
 * Verifica que o markup é um SVG utilizável, e recusa o que não é.
 *
 * Um `<script>` dentro do arquivo não executa onde nós o mostramos (servido
 * como image/svg+xml e desenhado em `<img>`), mas ele acompanha o arquivo que
 * a pessoa baixa e leva para outro lugar. Recusar aqui é mais honesto do que
 * entregar um arquivo com carga que nós não vamos usar.
 */
export function assertSafeSvg(markup: string): void {
  parse(markup)
  if (/<\s*script[\s>]/i.test(markup)) {
    throw new Error('SVG com <script> não é aceito: o arquivo sai daqui para outros lugares.')
  }
  if (/\son\w+\s*=/i.test(markup)) {
    throw new Error('SVG com manipulador de evento (onload, onclick…) não é aceito.')
  }
}
