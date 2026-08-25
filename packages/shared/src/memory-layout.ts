/**
 * Layout do canvas de memórias — grafo orgânico no estilo Obsidian,
 * compartilhado entre desktop e mobile.
 *
 * A árvore cresce para TODOS os lados a partir da raiz, sem direção fixa e sem
 * anel: as posições saem de uma simulação de forças (repulsão entre todos os
 * nós + molas nas arestas), semeada por uma distribuição radial com jitter.
 * Isso dá o aspecto "espalhado mas organizado" — cada ramo ocupa a sua região,
 * a distância até o pai varia de nó para nó, e nada fica alinhado em grade.
 *
 * A única regra dura é o ESPAÇO MÍNIMO: depois da simulação, um passe de
 * separação resolve sobreposição usando a caixa do RÓTULO, não só o círculo do
 * nó. Quando uma vizinhança fica apertada demais para caber, os nós são
 * empurrados radialmente para longe da raiz — é o "vai para um nível mais
 * distante" em vez de amontoar texto sobre texto.
 *
 * O layout é determinístico: o gerador aleatório é semeado pelo id do grupo,
 * então a mesma memória cai sempre no mesmo lugar entre renders e entre as
 * duas plataformas.
 */

import type { Memory } from './memory'
import { jaccard, normalizeText, PROJECT_AREAS } from './memory'

/** Distância base entre pai e filho — a mola relaxa em torno deste valor. */
export const BASE_LINK_DISTANCE = 90
/** Folga livre exigida entre as caixas de dois nós quaisquer. */
export const MIN_GAP = 14
/** Altura da linha de rótulo, usada na caixa de colisão. */
export const LABEL_HEIGHT = 14
/** Distância do rótulo abaixo do círculo do nó. */
export const LABEL_OFFSET = 6
/** Largura média de caractere no tamanho de fonte dos rótulos. */
const CHAR_WIDTH = 5.6
/** Corte do rótulo — mesmo limite usado no desenho das duas plataformas. */
export const MAX_LABEL_CHARS = 34
/** Respiro entre duas árvores (projetos) diferentes. */
export const GROUP_GAP = 120

const INFERRED_JACCARD = 0.5
const MAX_INFERRED_EDGES = 30

/** Grupo sintético das memórias que não nasceram em nenhum projeto. */
export const GLOBAL_GROUP = '__global__'

export interface LayoutNode {
  memory: Memory
  x: number
  y: number
  /** Distância em saltos até a raiz do grupo. */
  depth: number
  /** Raiz da árvore do grupo (o overview do projeto). */
  isRoot: boolean
  /** Pai efetivo na árvore de cobertura (undefined na raiz e nos flutuantes). */
  parentId?: string
  /**
   * Nó sem nenhum vínculo com o resto do grupo. Desenhado solto, sem aresta —
   * e é o primeiro a ceder espaço quando a vizinhança satura.
   */
  floating: boolean
  /** Filhos diretos presentes no pool — inclui os ocultos por colapso. */
  childCount: number
  collapsed: boolean
  groupId: string
  /** Raio do círculo desenhado — o layout o possui porque a colisão depende dele. */
  r: number
  /** Meia-largura da caixa do rótulo, para colisão e enquadramento. */
  labelHalfWidth: number
}

export type LayoutEdgeKind =
  /** Aresta pai→filho da árvore de cobertura — traço cheio. */
  | 'tree'
  /** Relação real que não virou aresta de árvore (segundo pai, "related"). */
  | 'cross'
  /** Deduzida por similaridade de tags — sempre dentro do mesmo grupo. */
  | 'inferred'

export interface LayoutEdge {
  from: string
  to: string
  kind: LayoutEdgeKind
  hits: number
}

export interface LayoutGroup {
  id: string
  label: string
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface MemoryLayout {
  nodes: LayoutNode[]
  edges: LayoutEdge[]
  groups: LayoutGroup[]
}

// ---------------------------------------------------------------------------
// Geometria do nó
// ---------------------------------------------------------------------------

/** Raio do círculo: raiz maior, área intermediária, fato comum por peso. */
export function nodeRadius(memory: Memory, isRoot: boolean): number {
  if (isRoot) return 22
  if (memory.area) return 14
  return 7 + memory.weight * 4
}

/** Texto do rótulo com o corte padrão — o mesmo nas duas plataformas. */
export function nodeLabelText(memory: Memory, isRoot: boolean): string {
  if (isRoot && memory.projectName) return memory.projectName
  if (memory.area) return PROJECT_AREAS[memory.area]?.label ?? memory.text
  return memory.text.length > MAX_LABEL_CHARS
    ? `${memory.text.slice(0, MAX_LABEL_CHARS)}…`
    : memory.text
}

function labelHalfWidthOf(text: string): number {
  return (Math.min(text.length, MAX_LABEL_CHARS + 1) * CHAR_WIDTH) / 2
}

/**
 * Caixa de colisão do nó: o círculo unido ao rótulo centrado logo abaixo dele.
 * É esta caixa — e não o raio — que a separação usa, porque o que não pode
 * encavalar é o texto.
 */
function boxOf(node: { r: number; labelHalfWidth: number }): {
  halfW: number
  top: number
  bottom: number
} {
  return {
    halfW: Math.max(node.r, node.labelHalfWidth),
    top: node.r,
    bottom: node.r + LABEL_OFFSET + LABEL_HEIGHT,
  }
}

// ---------------------------------------------------------------------------
// Aleatoriedade determinística
// ---------------------------------------------------------------------------

/** Hash de string para semente — determinismo por grupo. */
function seedOf(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** mulberry32 — PRNG pequeno e determinístico, suficiente para o jitter. */
function makeRng(seed: number): () => number {
  let a = seed || 1
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------------------
// Agrupamento e árvore de cobertura
// ---------------------------------------------------------------------------

/**
 * Grupo (árvore) a que uma memória pertence no canvas. Memórias de projeto vão
 * para o próprio projeto; as demais, para o projeto onde nasceram — caindo no
 * grupo global quando não há origem registrada.
 */
export function groupIdOf(memory: Memory): string {
  if (memory.kind === 'project' && memory.projectId) return memory.projectId
  return memory.originProjectId ?? GLOBAL_GROUP
}

function groupLabelOf(memory: Memory): string | undefined {
  if (memory.kind === 'project') return memory.projectName
  return memory.originProjectName
}

/** true quando a relação declarada de `parent` para `child` é hierárquica. */
function isParentEdge(parent: Memory, childId: string): boolean {
  const types = parent.relationTypes
  // Dados antigos não têm relationTypes — nesse caso qualquer vínculo serve
  // como candidato a aresta de árvore, senão o grafo legado vira só órfãos.
  if (!types) return true
  return types[childId] === 'parent'
}

/**
 * Escolhe a raiz de um grupo entre os nós que REALMENTE têm vínculo: o overview
 * do escopo raiz e, na falta dele, o nó mais conectado. Um grupo em que ninguém
 * está ligado a ninguém não tem raiz — devolve undefined, e todos os nós
 * flutuam. Sem essa condição, o nó de maior peso virava um hub artificial com
 * uma aresta para cada órfão do grupo.
 */
function pickRoot(members: Memory[], connected: Set<string>): Memory | undefined {
  const candidates = members.filter((m) => connected.has(m.id))
  if (candidates.length === 0) return undefined
  const overview = candidates
    .filter((m) => m.area === 'overview' && !m.subproject)
    .sort((a, b) => b.relatedIds.length - a.relatedIds.length || a.createdAt - b.createdAt)[0]
  if (overview) return overview
  return [...candidates].sort(
    (a, b) => b.relatedIds.length - a.relatedIds.length || b.weight - a.weight || a.createdAt - b.createdAt,
  )[0]
}

interface TreeShape {
  parentOf: Map<string, string>
  childrenOf: Map<string, string[]>
  /** undefined quando nenhum nó do grupo tem vínculo com outro. */
  rootId?: string
  /** Nós sem vínculo nenhum — desenhados soltos, sem aresta inventada. */
  floating: string[]
}

/**
 * Extrai uma árvore de cobertura do subgrafo do grupo. BFS a partir da raiz
 * seguindo primeiro as relações "parent" declaradas e só depois as livres —
 * assim a hierarquia informada pelo agente vence, e os "related" viram
 * arestas cross em vez de distorcerem a árvore.
 */
function spanningTree(members: Memory[]): TreeShape {
  const byId = new Map(members.map((m) => [m.id, m]))
  // "Conectado" é ter pelo menos um vínculo com outro membro DESTE grupo —
  // relatedIds apontando para fora não conta.
  const connected = new Set(
    members.filter((m) => m.relatedIds.some((rel) => rel !== m.id && byId.has(rel))).map((m) => m.id),
  )
  const root = pickRoot(members, connected)
  const parentOf = new Map<string, string>()
  const childrenOf = new Map<string, string[]>()
  if (!root) {
    return { parentOf, childrenOf, rootId: undefined, floating: members.map((m) => m.id) }
  }
  const seen = new Set<string>([root.id])

  const attach = (parentId: string, childId: string) => {
    parentOf.set(childId, parentId)
    const bucket = childrenOf.get(parentId) ?? []
    bucket.push(childId)
    childrenOf.set(parentId, bucket)
    seen.add(childId)
  }

  // Passe 1 — só hierarquia declarada, camada a camada.
  let frontier = [root.id]
  while (frontier.length) {
    const next: string[] = []
    for (const id of frontier) {
      const node = byId.get(id)
      if (!node) continue
      for (const rel of node.relatedIds) {
        if (seen.has(rel) || !byId.has(rel)) continue
        if (!isParentEdge(node, rel)) continue
        attach(id, rel)
        next.push(rel)
      }
    }
    frontier = next
  }

  // Passe 2 — vínculos livres puxam para a árvore quem ficou de fora.
  let progress = true
  while (progress) {
    progress = false
    for (const node of members) {
      if (!seen.has(node.id)) continue
      for (const rel of node.relatedIds) {
        if (seen.has(rel) || !byId.has(rel)) continue
        attach(node.id, rel)
        progress = true
      }
    }
  }

  // Passe 3 — quem sobrou não tem vínculo nenhum. Fica FLUTUANDO: pendurá-lo
  // na raiz criaria uma aresta que não existe e faria o grupo virar uma
  // estrela em volta de um nó qualquer.
  const floating: string[] = []
  for (const node of members) {
    if (seen.has(node.id)) continue
    floating.push(node.id)
  }

  return { parentOf, childrenOf, rootId: root.id, floating }
}

/** Descendentes de nós recolhidos — o próprio nó recolhido continua visível. */
function hiddenDescendants(shape: TreeShape, collapsedIds: Set<string>): Set<string> {
  const hidden = new Set<string>()
  if (collapsedIds.size === 0) return hidden
  for (const id of collapsedIds) {
    const queue = [...(shape.childrenOf.get(id) ?? [])]
    while (queue.length) {
      const current = queue.pop()!
      if (hidden.has(current)) continue
      hidden.add(current)
      queue.push(...(shape.childrenOf.get(current) ?? []))
    }
  }
  return hidden
}

// ---------------------------------------------------------------------------
// Simulação de forças
// ---------------------------------------------------------------------------

interface SimNode extends LayoutNode {
  vx: number
  vy: number
  /** Quantos nós descem desta subárvore — ramos pesados repelem mais. */
  subtreeSize: number
}

const ITERATIONS = 320
const ALPHA_DECAY = 0.016
/** Intensidade da repulsão entre pares — é o que abre o grafo. */
const REPULSION = 3400
/** Rigidez das molas pai→filho. */
const SPRING = 0.09
/** Atração fraca ao centro do grupo, para o conjunto não se dispersar. */
const GRAVITY = 0.012

/**
 * Semeia as posições em anéis por profundidade, herdando o ângulo do pai com
 * abertura e jitter. Sem esta semente a simulação parte de um emaranhado e
 * converge para algo torcido; com ela cada ramo já nasce apontando para o seu
 * próprio setor, e a simulação apenas relaxa o desenho.
 */
function seedPositions(nodes: Map<string, SimNode>, shape: TreeShape, rng: () => number): void {
  const root = shape.rootId ? nodes.get(shape.rootId) : undefined
  if (!root) {
    scatterFloating(nodes, [...nodes.keys()], 0, rng)
    return
  }
  root.x = 0
  root.y = 0

  interface Slot {
    id: string
    angle: number
    spread: number
    depth: number
  }
  const queue: Slot[] = [
    { id: root.memory.id, angle: rng() * Math.PI * 2, spread: Math.PI * 2, depth: 0 },
  ]

  while (queue.length) {
    const slot = queue.shift()!
    const children = (shape.childrenOf.get(slot.id) ?? []).filter((id) => nodes.has(id))
    if (children.length === 0) continue
    const parent = nodes.get(slot.id)!

    // O setor do pai é repartido entre os filhos proporcionalmente ao tamanho
    // da subárvore de cada um — ramo grande recebe mais abertura e não espreme
    // o vizinho.
    const weights = children.map((id) => Math.sqrt(nodes.get(id)!.subtreeSize))
    const total = weights.reduce((a, b) => a + b, 0) || 1
    let cursor = slot.angle - slot.spread / 2

    children.forEach((id, i) => {
      const child = nodes.get(id)!
      const share = (weights[i] / total) * slot.spread
      // Jitter dentro da fatia: tira o aspecto de leque perfeito sem deixar o
      // filho invadir a fatia do irmão.
      const angle = cursor + share * (0.3 + rng() * 0.4)
      // A distância também varia — é o que quebra o padrão de anéis concêntricos.
      const distance = BASE_LINK_DISTANCE * (0.8 + rng() * 0.6) * (1 + slot.depth * 0.15)
      child.x = parent.x + Math.cos(angle) * distance
      child.y = parent.y + Math.sin(angle) * distance
      // Filho nunca recebe o círculo inteiro: no máximo a fatia do pai, e
      // sempre com folga para não fechar sobre si mesmo.
      queue.push({
        id,
        angle,
        spread: Math.min(share * 0.9, Math.PI * 1.2),
        depth: slot.depth + 1,
      })
      cursor += share
    })
  }

  // Flutuantes ficam NA FAIXA da árvore, não fora dela: uma memória geral criada
  // dentro do projeto X é conhecimento do X e tem que orbitar os nós do X, não
  // formar uma casca distante. A separação depois acomoda cada uma numa brecha.
  const floatingSet = new Set(shape.floating)
  let treeRadius = 0
  for (const [id, node] of nodes) {
    if (floatingSet.has(id)) continue
    treeRadius = Math.max(treeRadius, Math.hypot(node.x, node.y))
  }
  scatterFloating(nodes, shape.floating, treeRadius * 0.45, rng, treeRadius * 0.75)
}

/**
 * Espalha nós sem vínculo pelo ângulo áureo (girassol): θ = i × 137.5°, raio
 * proporcional a √i. Enche o plano por igual sem criar anéis nem raios
 * perceptíveis — é o que faz a nuvem de órfãos parecer natural.
 */
function scatterFloating(
  nodes: Map<string, SimNode>,
  ids: string[],
  startRadius: number,
  rng: () => number,
  /** Faixa em que os primeiros nós se acomodam antes do raio crescer. */
  band = 0,
): void {
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
  const spacing = BASE_LINK_DISTANCE * 1.6
  const phase = rng() * Math.PI * 2
  ids.forEach((id, i) => {
    const node = nodes.get(id)
    if (!node) return
    const angle = phase + i * GOLDEN_ANGLE
    // √i mantém a densidade constante conforme o raio cresce; a faixa inicial
    // é sorteada para os primeiros nós já nascerem misturados à árvore.
    const radius = startRadius + band * rng() + spacing * Math.sqrt(i) * (0.85 + rng() * 0.3)
    node.x = Math.cos(angle) * radius
    node.y = Math.sin(angle) * radius
  })
}

/** Molas + repulsão + gravidade, com resfriamento progressivo. */
function simulate(list: SimNode[], links: Array<{ a: SimNode; b: SimNode; rest: number }>): void {
  let alpha = 1
  for (let iter = 0; iter < ITERATIONS; iter++) {
    // Repulsão entre todos os pares. O grupo é pequeno o bastante (centenas de
    // nós) para o O(n²) direto sair mais barato que montar uma quadtree.
    for (let i = 0; i < list.length; i++) {
      const a = list[i]
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j]
        let dx = b.x - a.x
        let dy = b.y - a.y
        let d2 = dx * dx + dy * dy
        if (d2 < 1) {
          // Coincidentes: desempata com um empurrão determinístico.
          dx = (i % 7) - 3 + 0.5
          dy = (j % 7) - 3 + 0.5
          d2 = dx * dx + dy * dy
        }
        // Nós de ramos maiores empurram mais forte, abrindo espaço para eles.
        const strength =
          (REPULSION * (1 + Math.log2(1 + a.subtreeSize + b.subtreeSize) * 0.35)) / d2
        const d = Math.sqrt(d2)
        const fx = (dx / d) * strength
        const fy = (dy / d) * strength
        a.vx -= fx
        a.vy -= fy
        b.vx += fx
        b.vy += fy
      }
    }

    for (const link of links) {
      const dx = link.b.x - link.a.x
      const dy = link.b.y - link.a.y
      const d = Math.hypot(dx, dy) || 0.01
      const force = SPRING * (d - link.rest)
      const fx = (dx / d) * force
      const fy = (dy / d) * force
      link.a.vx += fx
      link.a.vy += fy
      link.b.vx -= fx
      link.b.vy -= fy
    }

    for (const node of list) {
      if (node.isRoot) {
        // A raiz fica presa no centro: é o âncora visual do grupo.
        node.vx = 0
        node.vy = 0
        node.x = 0
        node.y = 0
        continue
      }
      node.vx -= node.x * GRAVITY
      node.vy -= node.y * GRAVITY
      node.x += node.vx * alpha
      node.y += node.vy * alpha
      // Amortecimento: sem ele o sistema oscila em vez de assentar.
      node.vx *= 0.6
      node.vy *= 0.6
    }

    alpha *= 1 - ALPHA_DECAY
  }
}

/** true quando as caixas de a e b se invadem (incluindo a folga mínima). */
function overlapOf(a: SimNode, b: SimNode): { x: number; y: number } | null {
  const ba = boxOf(a)
  const bb = boxOf(b)
  const x = ba.halfW + bb.halfW + MIN_GAP - Math.abs(b.x - a.x)
  if (x <= 0) return null
  // Vertical assimétrico: a caixa desce mais do que sobe (o rótulo fica abaixo
  // do círculo), então o teste depende de quem está por cima.
  const dy = b.y - a.y
  const y = dy >= 0 ? ba.bottom + bb.top + MIN_GAP - dy : bb.bottom + ba.top + MIN_GAP + dy
  if (y <= 0) return null
  return { x, y }
}

/**
 * Passe de separação — a regra dura do espaço mínimo. Resolve sobreposição das
 * CAIXAS DE RÓTULO empurrando o par pelo eixo de menor penetração, que é o
 * deslocamento mínimo capaz de abrir a folga.
 */
function separate(list: SimNode[]): void {
  const PASSES = 90
  for (let pass = 0; pass < PASSES; pass++) {
    let moved = false
    for (let i = 0; i < list.length; i++) {
      const a = list[i]
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j]
        const overlap = overlapOf(a, b)
        if (!overlap) continue
        moved = true
        if (overlap.x < overlap.y) {
          const dir = b.x >= a.x ? 1 : -1
          const push = (overlap.x / 2) * dir
          if (!a.isRoot) a.x -= push
          if (!b.isRoot) b.x += push
        } else {
          const dir = b.y >= a.y ? 1 : -1
          const push = (overlap.y / 2) * dir
          if (!a.isRoot) a.y -= push
          if (!b.isRoot) b.y += push
        }
      }
    }
    if (!moved) break
  }
}

/**
 * Rede de segurança: se depois da separação ainda houver caixa encavalada
 * (vizinhança saturada), empurra o nó mais profundo radialmente para fora até
 * abrir espaço. É o "vai para um nível mais distante" literal.
 */
function pushOutRemaining(list: SimNode[]): void {
  const ROUNDS = 60
  for (let round = 0; round < ROUNDS; round++) {
    let collided = false
    for (let i = 0; i < list.length; i++) {
      const a = list[i]
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j]
        const overlap = overlapOf(a, b)
        if (!overlap) continue
        collided = true
        // Cede quem tem menos vínculo: flutuante antes de quem está na árvore
        // e, entre dois da árvore, o mais profundo. A raiz nunca se move.
        const rank = (n: SimNode) => (n.isRoot ? -1 : n.floating ? 1e6 : n.depth)
        const victim = a.isRoot ? b : b.isRoot ? a : rank(a) >= rank(b) ? a : b
        const dist = Math.hypot(victim.x, victim.y) || 0.01
        const step = Math.max(overlap.x, overlap.y) + MIN_GAP
        victim.x += (victim.x / dist) * step
        victim.y += (victim.y / dist) * step
      }
    }
    if (!collided) break
  }
}

// ---------------------------------------------------------------------------
// Montagem do canvas
// ---------------------------------------------------------------------------

export interface LayoutOptions {
  /** Ids com a subárvore recolhida. */
  collapsedIds?: Set<string>
  /** Desenha arestas deduzidas por tags (sempre dentro do mesmo grupo). */
  inferEdges?: boolean
  /**
   * Rótulo efetivamente desenhado, quando a plataforma traduz o texto (as
   * áreas aparecem no idioma da UI). Só afeta a largura usada na colisão.
   */
  labelOf?: (memory: Memory, isRoot: boolean) => string
}

/**
 * Monta o canvas inteiro: um grafo orgânico por projeto, empacotados lado a
 * lado sem se tocarem.
 */
export function layoutMemoryGraph(pool: Memory[], options: LayoutOptions = {}): MemoryLayout {
  const collapsedIds = options.collapsedIds ?? new Set<string>()
  const labelOf = options.labelOf ?? nodeLabelText

  const byGroup = new Map<string, Memory[]>()
  const labels = new Map<string, string>()
  for (const memory of pool) {
    const gid = groupIdOf(memory)
    const bucket = byGroup.get(gid) ?? []
    bucket.push(memory)
    byGroup.set(gid, bucket)
    const label = groupLabelOf(memory)
    if (label && !labels.has(gid)) labels.set(gid, label)
  }

  // Projetos maiores primeiro; o grupo global fecha a lista.
  const groupIds = [...byGroup.keys()].sort((a, b) => {
    if (a === GLOBAL_GROUP) return 1
    if (b === GLOBAL_GROUP) return -1
    return byGroup.get(b)!.length - byGroup.get(a)!.length
  })

  interface Laid {
    id: string
    nodes: SimNode[]
    minX: number
    minY: number
    maxX: number
    maxY: number
  }
  const laid: Laid[] = []
  const treeEdges: LayoutEdge[] = []

  for (const gid of groupIds) {
    const members = byGroup.get(gid)!
    const shape = spanningTree(members)
    const hidden = hiddenDescendants(shape, collapsedIds)
    const floatingIds = new Set(shape.floating)

    // Profundidade e tamanho de subárvore — alimentam a semeadura e a repulsão.
    // Sem raiz (grupo totalmente desconectado) não há travessia: todo mundo
    // flutua e recebe a profundidade default logo abaixo.
    const depth = new Map<string, number>(shape.rootId ? [[shape.rootId, 0]] : [])
    const order: string[] = shape.rootId ? [shape.rootId] : []
    for (let i = 0; i < order.length; i++) {
      const id = order[i]
      for (const child of shape.childrenOf.get(id) ?? []) {
        depth.set(child, depth.get(id)! + 1)
        order.push(child)
      }
    }
    const subtreeSize = new Map<string, number>()
    for (let i = order.length - 1; i >= 0; i--) {
      const id = order[i]
      let size = 1
      for (const child of shape.childrenOf.get(id) ?? []) size += subtreeSize.get(child) ?? 1
      subtreeSize.set(id, size)
    }

    const nodes = new Map<string, SimNode>()
    for (const memory of members) {
      if (hidden.has(memory.id)) continue
      const isRoot = memory.id === shape.rootId
      const children = shape.childrenOf.get(memory.id) ?? []
      nodes.set(memory.id, {
        memory,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        depth: depth.get(memory.id) ?? 0,
        isRoot,
        floating: floatingIds.has(memory.id),
        parentId: shape.parentOf.get(memory.id),
        childCount: children.length,
        collapsed: collapsedIds.has(memory.id),
        groupId: gid,
        r: nodeRadius(memory, isRoot),
        labelHalfWidth: labelHalfWidthOf(labelOf(memory, isRoot)),
        subtreeSize: subtreeSize.get(memory.id) ?? 1,
      })
    }
    if (nodes.size === 0) continue

    seedPositions(nodes, shape, makeRng(seedOf(gid)))

    const links: Array<{ a: SimNode; b: SimNode; rest: number }> = []
    for (const node of nodes.values()) {
      const parent = node.parentId ? nodes.get(node.parentId) : undefined
      if (!parent) continue
      // Pai com muitos filhos precisa de mais raio para todos caberem ao redor.
      const siblings = parent.childCount || 1
      const rest =
        BASE_LINK_DISTANCE *
        (0.85 + Math.sqrt(siblings) * 0.22) *
        (1 + Math.min(node.depth, 5) * 0.06)
      links.push({ a: parent, b: node, rest })
      treeEdges.push({
        from: parent.memory.id,
        to: node.memory.id,
        kind: 'tree',
        hits: parent.memory.hits + node.memory.hits,
      })
    }

    const list = [...nodes.values()]
    simulate(list, links)
    separate(list)
    pushOutRemaining(list)

    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const node of list) {
      const box = boxOf(node)
      minX = Math.min(minX, node.x - box.halfW)
      maxX = Math.max(maxX, node.x + box.halfW)
      minY = Math.min(minY, node.y - box.top)
      maxY = Math.max(maxY, node.y + box.bottom)
    }
    laid.push({ id: gid, nodes: list, minX, minY, maxX, maxY })
  }

  // Dispersão dos grupos: espiral de ângulo áureo + separação de círculos.
  // Empacotar em linhas produzia fileiras visíveis de projetos lado a lado;
  // a espiral espalha as ilhas sem alinhamento perceptível, e a separação
  // garante que duas nunca se toquem.
  const nodes: LayoutNode[] = []
  const groups: LayoutGroup[] = []

  interface Island {
    group: (typeof laid)[number]
    cx: number
    cy: number
    radius: number
  }
  // Raio do círculo que envolve o grupo — meia diagonal da sua caixa.
  const islands: Island[] = laid.map((group) => ({
    group,
    cx: 0,
    cy: 0,
    radius: Math.hypot(group.maxX - group.minX, group.maxY - group.minY) / 2,
  }))
  // Maiores primeiro para ocuparem o miolo; o id desempata para o resultado
  // não depender da ordem de iteração do Map.
  islands.sort((a, b) => b.radius - a.radius || a.group.id.localeCompare(b.group.id))

  const groupRng = makeRng(seedOf('memory-graph-islands'))
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
  let reach = 0
  islands.forEach((island, i) => {
    if (i === 0) return
    // O raio acumula o tamanho das ilhas já colocadas, então grupos grandes
    // afastam os seguintes em vez de serem atropelados por eles.
    reach += island.radius * 0.85
    const angle = i * GOLDEN_ANGLE + groupRng() * 0.4
    island.cx = Math.cos(angle) * reach
    island.cy = Math.sin(angle) * reach
  })

  for (let pass = 0; pass < 240; pass++) {
    let moved = false
    for (let i = 0; i < islands.length; i++) {
      for (let j = i + 1; j < islands.length; j++) {
        const a = islands[i]
        const b = islands[j]
        const dx = b.cx - a.cx
        const dy = b.cy - a.cy
        const distance = Math.hypot(dx, dy) || 0.01
        const needed = a.radius + b.radius + GROUP_GAP
        if (distance >= needed) continue
        moved = true
        const push = (needed - distance) / 2
        const ux = dx / distance
        const uy = dy / distance
        a.cx -= ux * push
        a.cy -= uy * push
        b.cx += ux * push
        b.cy += uy * push
      }
    }
    if (!moved) break
  }

  for (const island of islands) {
    const { group } = island
    // Desloca pelo CENTRO da caixa, não pelo canto — é o centro que a espiral
    // posicionou.
    const dx = island.cx - (group.minX + group.maxX) / 2
    const dy = island.cy - (group.minY + group.maxY) / 2
    for (const node of group.nodes) {
      nodes.push({
        memory: node.memory,
        x: node.x + dx,
        y: node.y + dy,
        depth: node.depth,
        isRoot: node.isRoot,
        floating: node.floating,
        parentId: node.parentId,
        childCount: node.childCount,
        collapsed: node.collapsed,
        groupId: node.groupId,
        r: node.r,
        labelHalfWidth: node.labelHalfWidth,
      })
    }
    groups.push({
      id: group.id,
      label: labels.get(group.id) ?? '',
      minX: group.minX + dx,
      minY: group.minY + dy,
      maxX: group.maxX + dx,
      maxY: group.maxY + dy,
    })
  }

  const visibleById = new Map(nodes.map((n) => [n.memory.id, n]))
  const edges: LayoutEdge[] = treeEdges.filter(
    (e) => visibleById.has(e.from) && visibleById.has(e.to),
  )
  const seen = new Set(edges.map((e) => [e.from, e.to].sort().join(':')))

  // Relações reais que a árvore não absorveu (segundo pai, "related").
  for (const node of nodes) {
    for (const rel of node.memory.relatedIds) {
      const other = visibleById.get(rel)
      if (!other) continue
      // Ligação entre grupos é sempre ruído: projetos distintos não se cruzam.
      if (other.groupId !== node.groupId) continue
      const key = [node.memory.id, rel].sort().join(':')
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({
        from: node.memory.id,
        to: rel,
        kind: 'cross',
        hits: node.memory.hits + other.memory.hits,
      })
    }
  }

  if (options.inferEdges) {
    const tagIndex = new Map<string, string[]>()
    for (const node of nodes) {
      for (const tag of node.memory.tags) {
        const key = `${node.groupId}::${normalizeText(tag)}`
        const bucket = tagIndex.get(key) ?? []
        bucket.push(node.memory.id)
        tagIndex.set(key, bucket)
      }
    }
    let count = 0
    const compared = new Set<string>()
    for (const node of nodes) {
      if (count >= MAX_INFERRED_EDGES) break
      const candidates = new Set<string>()
      for (const tag of node.memory.tags) {
        for (const id of tagIndex.get(`${node.groupId}::${normalizeText(tag)}`) ?? []) {
          if (id !== node.memory.id) candidates.add(id)
        }
      }
      for (const candidateId of candidates) {
        if (count >= MAX_INFERRED_EDGES) break
        const key = [node.memory.id, candidateId].sort().join(':')
        if (seen.has(key) || compared.has(key)) continue
        compared.add(key)
        const other = visibleById.get(candidateId)?.memory
        if (!other || other.tags.length === 0) continue
        if (jaccard(node.memory.tags, other.tags) >= INFERRED_JACCARD) {
          seen.add(key)
          edges.push({ from: node.memory.id, to: candidateId, kind: 'inferred', hits: 0 })
          count++
        }
      }
    }
  }

  return { nodes, edges, groups }
}

/**
 * Regra de visibilidade do filtro de projeto — usada pelas duas plataformas.
 *
 * Selecionar um projeto mostra SÓ o que pertence a ele: as memórias do projeto
 * e as gerais que nasceram ali. Memórias gerais de outros projetos (ou sem
 * origem registrada, caso das criadas antes deste campo existir) ficam de fora
 * — elas poluíam a vista de todo projeto sem ter relação com nenhum. Para vê-las
 * basta voltar o seletor para "todos os projetos".
 *
 * Isto é filtro de VISUALIZAÇÃO apenas: o contexto injetado no prompt continua
 * carregando as preferências gerais em qualquer projeto (loadPromptContext).
 */
export function matchesProjectFilter(memory: Memory, projectId: string): boolean {
  if (memory.kind === 'project') return memory.projectId === projectId
  return memory.originProjectId === projectId
}
