/**
 * Índice de desenho do grafo — o que a cena precisa por nó, calculado UMA vez
 * por layout, e os blocos espaciais que permitem montar só o pedaço visível.
 *
 * Antes cada render da cena refazia, por nó: `normalizeText` sobre o texto
 * inteiro da memória para saber se ela casava com a busca, o corte do rótulo, a
 * conta de "recente/esquecida" e a caixa de colisão. Com milhares de nós isso
 * era trabalho proporcional ao grafo INTEIRO a cada mudança de viewport.
 *
 * Os blocos sobraram de quando a cena era montada em SVG e precisava ser
 * cortada por viewport. Com o desenho em Skia — a cena inteira gravada num
 * SkPicture e só transformada por frame — eles não decidem mais o que é
 * desenhado; servem ao RESUMO do zoom de longe, onde cada bloco vira um ponto
 * com o tamanho proporcional a quantas memórias representa.
 */
import type { Memory, MemoryLayout, LayoutNode } from '@orbit/shared'
import { LABEL_HEIGHT, LABEL_OFFSET, nodeLabelText, normalizeText } from '@orbit/shared'
import { KIND_COLOR, lastActivity } from './meta'

const RECENT_MS = 7 * 24 * 60 * 60 * 1000
const STALE_MS = 30 * 24 * 60 * 60 * 1000
/** Nós por bloco. Poucos demais e a lista de blocos vira o custo; muitos e o
 *  bloco deixa de ser um pedaço pequeno. */
const NOS_POR_BLOCO = 48
/** Cinza das arestas que não são de relação. */
const CINZA_ARESTA = '#8a8e99'

export interface Regiao {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

export interface NoDesenho {
  id: string
  x: number
  y: number
  r: number
  cor: string
  fillOpacity: number
  larguraTraco: number
  rotulo: string
  rotuloY: number
  fontSize: number
  fontWeight: '400' | '600' | '700'
  isRoot: boolean
  /** Raiz ou área: os marcos que continuam desenhados no zoom de longe. */
  marco: boolean
  recente: boolean
  velha: boolean
  /** Caixa ocupada (círculo + rótulo), já resolvida. */
  minX: number
  maxX: number
  minY: number
  maxY: number
}

export interface ArestaDesenho {
  chave: string
  x1: number
  y1: number
  x2: number
  y2: number
  cor: string
  opacidade: number
  largura: number
  traco?: string
  arvore: boolean
}

/**
 * Bloco de NÓS. A caixa cobre só os círculos e rótulos, sem as arestas: uma
 * aresta longa esticaria a caixa por meio canvas e o bloco entraria na cena a
 * cada arrasto, que é o oposto do que os blocos existem para fazer.
 */
export interface BlocoNos {
  chave: string
  minX: number
  maxX: number
  minY: number
  maxY: number
  nos: NoDesenho[]
  /** Resumo do bloco para o zoom de longe: um ponto no centro de massa. */
  cx: number
  cy: number
  raio: number
  cor: string
}

export interface IndiceGrafo {
  blocos: BlocoNos[]
  /** Todos os nós, na ordem de desenho. */
  nos: NoDesenho[]
  arestas: ArestaDesenho[]
  /** Raízes e áreas — desenhadas em qualquer nível de zoom. */
  marcos: NoDesenho[]
  limites: Regiao
  total: number
}

const VAZIO: IndiceGrafo = {
  blocos: [],
  nos: [],
  arestas: [],
  marcos: [],
  limites: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
  total: 0,
}

function noDesenho(node: LayoutNode, now: number): NoDesenho {
  const { memory } = node
  const atividade = lastActivity(memory)
  const cor = KIND_COLOR[memory.kind]
  const rotulo = nodeLabelText(memory, node.isRoot)
  const halfW = Math.max(node.r, node.labelHalfWidth)
  return {
    id: memory.id,
    x: node.x,
    y: node.y,
    r: node.r,
    cor,
    fillOpacity: node.isRoot ? 0.3 : memory.area ? 0.16 : 0.24,
    larguraTraco: node.isRoot ? 2 : 1.2,
    rotulo,
    rotuloY: node.r + LABEL_OFFSET + 10,
    fontSize: node.isRoot ? 13 : memory.area ? 11 : 10,
    fontWeight: node.isRoot ? '700' : memory.area ? '600' : '400',
    isRoot: node.isRoot,
    marco: node.isRoot || memory.area != null,
    recente: now - atividade < RECENT_MS,
    velha: now - atividade > STALE_MS,
    minX: node.x - halfW,
    maxX: node.x + halfW,
    minY: node.y - node.r,
    maxY: node.y + node.r + LABEL_OFFSET + LABEL_HEIGHT,
  }
}

export function construirIndice(
  layout: MemoryLayout | null,
  now: number,
  corPrimaria: string,
): IndiceGrafo {
  if (!layout || layout.nodes.length === 0) return VAZIO

  const nos = layout.nodes.map((node) => noDesenho(node, now))
  const porId = new Map(nos.map((n) => [n.id, n]))
  const marcos = nos.filter((n) => n.marco)

  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const no of nos) {
    if (no.minX < minX) minX = no.minX
    if (no.maxX > maxX) maxX = no.maxX
    if (no.minY < minY) minY = no.minY
    if (no.maxY > maxY) maxY = no.maxY
  }

  // Lado do bloco calculado a partir da densidade real: o grafo pode ocupar
  // trezentos ou trezentos mil pontos de mundo, e um lado fixo seria bom em um
  // caso e péssimo no outro.
  const area = Math.max(1, (maxX - minX) * (maxY - minY))
  const lado = Math.max(1, Math.sqrt((area / nos.length) * NOS_POR_BLOCO))
  const colunas = Math.max(1, Math.ceil((maxX - minX) / lado) + 1)

  const blocosNos = new Map<number, BlocoNos>()
  const indiceDe = (x: number, y: number) =>
    Math.floor((y - minY) / lado) * colunas + Math.floor((x - minX) / lado)

  for (const no of nos) {
    const chave = indiceDe(no.x, no.y)
    let b = blocosNos.get(chave)
    if (!b) {
      b = {
        chave: `n${chave}`,
        minX: Infinity,
        maxX: -Infinity,
        minY: Infinity,
        maxY: -Infinity,
        nos: [],
        cx: 0,
        cy: 0,
        raio: 0,
        cor: '',
      }
      blocosNos.set(chave, b)
    }
    b.nos.push(no)
    if (no.minX < b.minX) b.minX = no.minX
    if (no.maxX > b.maxX) b.maxX = no.maxX
    if (no.minY < b.minY) b.minY = no.minY
    if (no.maxY > b.maxY) b.maxY = no.maxY
  }

  const arestas: ArestaDesenho[] = []
  for (const edge of layout.edges) {
    const a = porId.get(edge.from)
    const b = porId.get(edge.to)
    if (!a || !b) continue
    const arvore = edge.kind === 'tree'
    // Cor e opacidade SEPARADAS: no Skia a pintura recebe a cor e depois o
    // alfa, então um `rgba(...)` com transparência embutida seria apagado pelo
    // `setAlphaf` que vem em seguida.
    const desenho: ArestaDesenho = {
      chave: `${edge.from}:${edge.to}`,
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      cor: arvore || edge.kind === 'inferred' ? CINZA_ARESTA : corPrimaria,
      opacidade: arvore ? 0.45 : edge.kind === 'inferred' ? 0.2 : 0.3,
      largura: arvore ? 1 + Math.min(edge.hits / 14, 1.4) : 1,
      traco: arvore ? undefined : edge.kind === 'inferred' ? '3 5' : '6 4',
      arvore,
    }
    arestas.push(desenho)
  }

  const lista = [...blocosNos.values()]
  for (const b of lista) {
    let somaX = 0
    let somaY = 0
    const contagem = new Map<string, number>()
    for (const no of b.nos) {
      somaX += no.x
      somaY += no.y
      contagem.set(no.cor, (contagem.get(no.cor) ?? 0) + 1)
    }
    const total = Math.max(1, b.nos.length)
    b.cx = somaX / total
    b.cy = somaY / total
    // Raio do resumo cresce com a raiz da contagem: é assim que a área do
    // ponto fica proporcional a quantas memórias ele representa.
    b.raio = Math.min(lado / 2, 6 + Math.sqrt(b.nos.length) * 3)
    let melhor = ''
    let melhorQtd = -1
    for (const [cor, qtd] of contagem) {
      if (qtd > melhorQtd) {
        melhorQtd = qtd
        melhor = cor
      }
    }
    b.cor = melhor || KIND_COLOR.general
  }

  return {
    blocos: lista,
    nos,
    arestas,
    marcos,
    limites: { minX, maxX, minY, maxY },
    total: nos.length,
  }
}

/** Ids das memórias que casam com a busca. `null` = busca vazia (todas casam). */
export function idsQueCasam(pool: Memory[], query: string): Set<string> | null {
  const tokens = normalizeText(query).split(' ').filter(Boolean)
  if (tokens.length === 0) return null
  const casam = new Set<string>()
  for (const memory of pool) {
    const alvo = normalizeText(`${memory.text} ${memory.tags.join(' ')}`)
    if (tokens.every((tok) => alvo.includes(tok))) casam.add(memory.id)
  }
  return casam
}
