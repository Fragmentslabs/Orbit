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
  /**
   * Caixa de colisão já resolvida. Ela depende só do raio e do rótulo, que não
   * mudam depois da montagem — e a separação consulta isto milhões de vezes.
   */
  halfW: number
  top: number
  bottom: number
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
function seedPositions(
  nodes: Map<string, SimNode>,
  shape: TreeShape,
  rng: () => number,
  escala = 1,
): void {
  const root = shape.rootId ? nodes.get(shape.rootId) : undefined
  if (!root) {
    scatterFloating(nodes, [...nodes.keys()], 0, rng, 0, escala)
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

  for (let cabeca = 0; cabeca < queue.length; cabeca++) {
    const slot = queue[cabeca]
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
      const distance =
        BASE_LINK_DISTANCE * escala * (0.8 + rng() * 0.6) * (1 + slot.depth * 0.15)
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
  scatterFloating(nodes, shape.floating, treeRadius * 0.45, rng, treeRadius * 0.75, escala)
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
  escala = 1,
): void {
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
  const spacing = BASE_LINK_DISTANCE * escala * 1.6
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

// ---------------------------------------------------------------------------
// Execução em fatias
// ---------------------------------------------------------------------------
//
// As três fases pesadas (repulsão, separação e desempate radial) varrem todos
// os pares do grupo — juntas, ~470 varreduras O(n²). Rodadas de uma tacada só
// elas prendem a thread de JS por segundos: nada pinta e nada responde ao
// toque, que é exatamente a travada ao abrir o grafo.
//
// Por isso cada uma vive num cursor retomável: o laço externo pode parar no
// meio de uma varredura e continuar na chamada seguinte. A ORDEM das operações
// é a mesma da versão de uma tacada só — cada par continua lendo as posições
// que os pares anteriores deixaram —, então o resultado é idêntico; o que muda
// é apenas quem decide a hora de devolver o controle.

const SEPARATE_PASSES = 90
const PUSH_ROUNDS = 60

/**
 * Passes de separação e rodadas de desempate por tamanho de grupo. No caminho
 * exato cada passe é O(n²) e 90 já é caro; no da grade ele é O(n · vizinhos),
 * barato o bastante para dar bem mais — e é disso que a vizinhança saturada de
 * um grafo grande precisa para não deixar rótulo sobre rótulo.
 */
function passesDe(n: number): number {
  return n > GRADE_MINIMA ? 240 : SEPARATE_PASSES
}
function rodadasDe(n: number): number {
  return n > GRADE_MINIMA ? 120 : PUSH_ROUNDS
}
/**
 * Pares avaliados entre duas leituras do relógio. O passo tem que ser contado
 * em PARES, não em índices do laço externo: num grupo de 3 mil nós cada índice
 * externo vale milhares de pares, e um passo fixo de 32 índices estourava o
 * orçamento da fatia em mais de um segundo. Contando pares, a fatia passa do
 * orçamento por no máximo o custo de um bloco — alguns milissegundos.
 */
const PARES_POR_CHECAGEM = 2048

/**
 * Acima deste tamanho o grupo troca as varreduras de todos os pares por uma
 * GRADE ESPACIAL. Abaixo dele nada muda: o caminho exato de sempre continua
 * valendo, e nenhum grafo que já existe hoje muda de desenho.
 *
 * O corte é onde o O(n²) ainda cabe num piscar — 250 nós são 31 mil pares por
 * varredura, ~15 milhões no pipeline inteiro.
 */
const GRADE_MINIMA = 250
/**
 * Raio além do qual a repulsão é desprezada no caminho da grade. A força cai
 * com 1/d², então a partir de uma vizinhança e meia o que sobra é ruído — e é
 * ele que custa O(n²). O formato do grafo passa a vir das molas, da semente
 * radial e do passe de separação, que são os que realmente desenham.
 */
const CUTOFF = BASE_LINK_DISTANCE * 1.5
/**
 * Gravidade no caminho da grade. Sem a repulsão de longe empurrando para fora,
 * a atração ao centro precisa cair junto — senão o grupo colapsa num nó só e
 * sobra tudo para a separação resolver.
 */
const GRAVITY_GRADE = 0.004
/** Deslocamento médio por nó abaixo do qual a simulação já assentou. */
const CONVERGIU = 0.08
/**
 * Teto do passo de um nó numa iteração.
 *
 * A repulsão cresce com 1/d², então um par quase coincidente gera uma força
 * enorme — e sem teto ela vira um arremesso. Num grupo denso isso encadeia: a
 * cada iteração alguém é jogado para longe, e o grupo inteiro sai de escala.
 * Com mil memórias num projeto só, as posições chegavam a 10²⁶ e o desenho
 * virava lixo; o passe de separação depois não tinha o que salvar.
 *
 * O teto é o remédio clássico de layout por forças (o "resfriamento" do
 * Fruchterman-Reingold): a direção da força continua valendo, só o tamanho do
 * passo é limitado.
 *
 * Vale SÓ no caminho da grade. Medindo o algoritmo antigo, grupo por grupo: até
 * ~500 nós ele era saudável (raio máximo na casa dos milhares) e só a partir de
 * ~700 saía de escala — e nenhum teto serve para os dois casos, porque mesmo um
 * grafo sadio de 150 nós dá passos grandes nas primeiras iterações, que o
 * desenho depois absorve. Como o caminho exato só roda em grupo de até 250, ele
 * fica sem teto e continua bit a bit igual ao de hoje; a trava entra onde a
 * densidade realmente quebra.
 */
const MAX_PASSO = BASE_LINK_DISTANCE * 2

/** Iterações da simulação por tamanho de grupo — grafo grande assenta com
 *  menos, e cada iteração dele custa muito mais. */
function iteracoesDe(n: number): number {
  if (n <= GRADE_MINIMA) return ITERATIONS
  if (n <= 1500) return 240
  return 160
}

/**
 * Grade uniforme sobre as posições, em formato CSR (um array de índices e um
 * de deslocamentos). Sem array por célula: com milhares de nós, alocar e
 * coletar milhares de arrays a cada varredura custaria mais que a própria
 * conta.
 */
interface Grade {
  cell: number
  minX: number
  minY: number
  cols: number
  rows: number
  /** Deslocamento inicial de cada célula em `itens` (tamanho cols*rows+1). */
  inicio: Int32Array
  /** Índices dos nós, agrupados por célula. */
  itens: Int32Array
}

function montarGrade(list: SimNode[], celulaMinima: number): Grade {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const node of list) {
    if (node.x < minX) minX = node.x
    if (node.x > maxX) maxX = node.x
    if (node.y < minY) minY = node.y
    if (node.y > maxY) maxY = node.y
  }
  const largura = Math.max(1, maxX - minX)
  const altura = Math.max(1, maxY - minY)
  // Teto de células: num grupo espalhado a grade fina gastaria mais memória
  // que o próprio grupo. Dobrar a célula só aumenta a vizinhança varrida — o
  // corte por distância continua sendo quem decide de verdade.
  let cell = celulaMinima
  const teto = 8 * list.length + 1024
  while ((Math.ceil(largura / cell) + 1) * (Math.ceil(altura / cell) + 1) > teto) cell *= 2
  const cols = Math.ceil(largura / cell) + 1
  const rows = Math.ceil(altura / cell) + 1

  const total = cols * rows
  const inicio = new Int32Array(total + 1)
  const celulaDe = new Int32Array(list.length)
  for (let i = 0; i < list.length; i++) {
    const node = list[i]
    const c = Math.min(cols - 1, Math.max(0, Math.floor((node.x - minX) / cell)))
    const l = Math.min(rows - 1, Math.max(0, Math.floor((node.y - minY) / cell)))
    const cel = l * cols + c
    celulaDe[i] = cel
    inicio[cel + 1]++
  }
  for (let cel = 0; cel < total; cel++) inicio[cel + 1] += inicio[cel]
  const itens = new Int32Array(list.length)
  const cursor = inicio.slice(0, total)
  for (let i = 0; i < list.length; i++) itens[cursor[celulaDe[i]]++] = i
  return { cell, minX, minY, cols, rows, inicio, itens }
}

/** Índices dos nós nas 9 células ao redor de `i`, escritos em `buffer`. */
function vizinhosDe(grade: Grade, list: SimNode[], i: number, buffer: Int32Array): number {
  const node = list[i]
  const c = Math.min(grade.cols - 1, Math.max(0, Math.floor((node.x - grade.minX) / grade.cell)))
  const l = Math.min(grade.rows - 1, Math.max(0, Math.floor((node.y - grade.minY) / grade.cell)))
  const c0 = c > 0 ? c - 1 : 0
  const c1 = c + 1 < grade.cols ? c + 1 : grade.cols - 1
  const l0 = l > 0 ? l - 1 : 0
  const l1 = l + 1 < grade.rows ? l + 1 : grade.rows - 1
  let qtd = 0
  for (let ll = l0; ll <= l1; ll++) {
    const base = ll * grade.cols
    for (let cc = c0; cc <= c1; cc++) {
      const cel = base + cc
      const fim = grade.inicio[cel + 1]
      for (let p = grade.inicio[cel]; p < fim; p++) buffer[qtd++] = grade.itens[p]
    }
  }
  return qtd
}

/** Lado da célula que garante achar toda caixa capaz de encavalar com outra. */
function celulaDeSeparacao(list: SimNode[]): number {
  let maxHalfW = 0
  let maxTop = 0
  let maxBottom = 0
  for (const node of list) {
    const box = boxOf(node)
    if (box.halfW > maxHalfW) maxHalfW = box.halfW
    if (box.top > maxTop) maxTop = box.top
    if (box.bottom > maxBottom) maxBottom = box.bottom
  }
  // A folga de 1.5 cobre o quanto um nó anda DENTRO de uma varredura: a grade
  // é montada no começo dela e as posições mudam enquanto ela roda.
  return Math.max(2 * maxHalfW + MIN_GAP, maxTop + maxBottom + MIN_GAP) * 1.5
}

const relogio: () => number =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now()

interface SimLink {
  a: SimNode
  b: SimNode
  rest: number
}

type FaseGrupo = 'sim' | 'sep' | 'push' | 'ok'

interface GrupoSim {
  id: string
  list: SimNode[]
  links: SimLink[]
  fase: FaseGrupo
  /** Grupo grande: varreduras por grade em vez de todos os pares. */
  usaGrade: boolean
  /** Iterações da simulação — menos nos grupos grandes. */
  iteracoes: number
  /** Passes de separação e rodadas de desempate deste grupo. */
  passes: number
  rodadas: number
  /** Grade da varredura em curso, refeita a cada volta. */
  grade: Grade | null
  /** Lado da célula usado nas fases de separação. */
  celulaSep: number
  /**
   * Escala do grupo. A distância natural entre pai e filho (90) é MENOR que a
   * largura de uma caixa de rótulo (até 190): num grupo grande a simulação
   * entrega um emaranhado, e a separação recebe centenas de vizinhos por nó
   * para desfazer sozinha. Esticar molas, semente e alcance da repulsão pelo
   * tamanho médio da caixa faz a simulação já entregar o espaçamento certo —
   * é a diferença entre a grade valer a pena e não valer.
   */
  escala: number
  /** Alcance da repulsão ao quadrado e força, escalados junto. */
  cutoff2: number
  repulsao: number
  /** Rascunho dos vizinhos — um por grupo, reaproveitado a cada consulta. */
  buffer: Int32Array
  /** Deslocamento somado na iteração em curso, para detectar convergência. */
  movimento: number
  /** Resfriamento da simulação — sobrevive entre fatias. */
  alpha: number
  /** Iteração (sim), passe (sep) ou rodada (push) em curso. */
  volta: number
  /** Índice do laço externo onde a varredura parou. */
  cursor: number
  /** Alguém se moveu na varredura em curso? Quando ninguém se move, a fase
   *  termina antes do limite — é o `break` das versões de uma tacada só. */
  ativo: boolean
}

/**
 * Unidade de progresso: um nó varrido. Serve para os dois caminhos — dentro de
 * um grupo o custo por nó é uniforme, então a barra anda linear.
 */
function varredurasDe(n: number): number {
  return iteracoesDe(n) + passesDe(n) + rodadasDe(n)
}

/**
 * Penetração das caixas de a e b nos dois eixos (incluindo a folga mínima), ou
 * null quando elas não se tocam.
 *
 * O objeto de retorno é REAPROVEITADO: a separação chama isto milhões de vezes
 * e alocar três objetos por chamada — as duas caixas e o resultado — era a
 * conta mais cara da fase. Quem chama lê os dois campos na hora e não guarda a
 * referência.
 */
const penetracao = { x: 0, y: 0 }
function overlapOf(a: SimNode, b: SimNode): { x: number; y: number } | null {
  const x = a.halfW + b.halfW + MIN_GAP - Math.abs(b.x - a.x)
  if (x <= 0) return null
  // Vertical assimétrico: a caixa desce mais do que sobe (o rótulo fica abaixo
  // do círculo), então o teste depende de quem está por cima.
  const dy = b.y - a.y
  const y = dy >= 0 ? a.bottom + b.top + MIN_GAP - dy : b.bottom + a.top + MIN_GAP + dy
  if (y <= 0) return null
  penetracao.x = x
  penetracao.y = y
  return penetracao
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
 * Layout em andamento — o mesmo trabalho de `layoutMemoryGraph`, só que
 * entregue em fatias para quem não pode bloquear a thread.
 */
export interface MemoryGraphJob {
  /** Trabalha por até `budgetMs` e devolve `true` quando terminou. Com
   *  `Infinity` roda tudo numa chamada só. */
  step(budgetMs: number): boolean
  readonly done: boolean
  /** 0..1, monotônico — alimenta a barra de progresso. */
  readonly progress: number
  /**
   * Layout com as posições ATUAIS. Enquanto `done` for falso ele é parcial: é
   * o que permite mostrar o grafo se assentando em vez de um spinner opaco.
   */
  snapshot(): MemoryLayout
}

/**
 * Monta o canvas inteiro: um grafo orgânico por projeto, empacotados lado a
 * lado sem se tocarem — em fatias, para caber entre dois frames.
 */
export function createMemoryGraphJob(
  pool: Memory[],
  options: LayoutOptions = {},
): MemoryGraphJob {
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

  const grupos: GrupoSim[] = []
  const treeEdges: LayoutEdge[] = []

  // O progresso é dominado pelas varreduras de pares, então o peso de cada
  // grupo é o número de pares vezes as varreduras que ele ainda vai levar. A
  // preparação entra fora da conta: ao lado disso ela é ruído.
  let totalUnidades = 0
  for (const gid of groupIds) {
    const n = byGroup.get(gid)!.length
    totalUnidades += n * varredurasDe(n)
  }
  totalUnidades = Math.max(1, totalUnidades)
  let unidades = 0

  let fase: 'prep' | 'grupos' | 'done' = 'prep'
  let prepIdx = 0
  let grupoIdx = 0

  /** Árvore, semente e molas de um grupo — tudo que a simulação precisa. */
  function prepararGrupo(gid: string): GrupoSim | null {
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
      const raio = nodeRadius(memory, isRoot)
      const meiaLargura = labelHalfWidthOf(labelOf(memory, isRoot))
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
        r: raio,
        labelHalfWidth: meiaLargura,
        subtreeSize: subtreeSize.get(memory.id) ?? 1,
        halfW: Math.max(raio, meiaLargura),
        top: raio,
        bottom: raio + LABEL_OFFSET + LABEL_HEIGHT,
      })
    }
    if (nodes.size === 0) return null

    const lista = [...nodes.values()]
    const usaGrade = lista.length > GRADE_MINIMA
    // Caixa média do grupo (largura cheia + folga) contra a distância natural
    // de uma aresta: o quociente é o quanto o grupo precisa esticar.
    let somaHalfW = 0
    for (const node of lista) somaHalfW += node.halfW
    const caixaMedia = (2 * somaHalfW) / lista.length + MIN_GAP
    const escala = usaGrade ? Math.max(1, caixaMedia / BASE_LINK_DISTANCE) : 1

    seedPositions(nodes, shape, makeRng(seedOf(gid)), escala)

    const links: SimLink[] = []
    for (const node of nodes.values()) {
      const parent = node.parentId ? nodes.get(node.parentId) : undefined
      if (!parent) continue
      // Pai com muitos filhos precisa de mais raio para todos caberem ao redor.
      const siblings = parent.childCount || 1
      const rest =
        BASE_LINK_DISTANCE *
        (0.85 + Math.sqrt(siblings) * 0.22) *
        (1 + Math.min(node.depth, 5) * 0.06)
      links.push({ a: parent, b: node, rest: rest * escala })
      treeEdges.push({
        from: parent.memory.id,
        to: node.memory.id,
        kind: 'tree',
        hits: parent.memory.hits + node.memory.hits,
      })
    }

    return {
      id: gid,
      list: lista,
      links,
      fase: 'sim',
      usaGrade,
      iteracoes: iteracoesDe(lista.length),
      passes: passesDe(lista.length),
      rodadas: rodadasDe(lista.length),
      grade: null,
      celulaSep: celulaDeSeparacao(lista),
      escala,
      // A força cresce com o quadrado da distância para o equilíbrio entre
      // mola e repulsão cair no mesmo ponto, só que na escala nova.
      cutoff2: (CUTOFF * escala) ** 2,
      repulsao: REPULSION * escala * escala,
      buffer: new Int32Array(lista.length),
      movimento: 0,
      alpha: 1,
      volta: 0,
      cursor: 0,
      ativo: false,
    }
  }

  /**
   * Repulsão de `i` contra todos os pares seguintes — o caminho exato, com o
   * empurrão aplicado nos dois nós de uma vez. Devolve os pares avaliados.
   */
  function repulsaoExata(list: SimNode[], i: number): number {
    const n = list.length
    const a = list[i]
    for (let j = i + 1; j < n; j++) {
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
    return n - 1 - i
  }

  /**
   * Repulsão de `i` contra a vizinhança da grade — só o que está dentro do
   * corte. Aqui a força é aplicada SÓ em `i`: cada par acaba avaliado duas
   * vezes, uma de cada lado, e a soma das forças é a mesma do caminho exato.
   */
  function repulsaoVizinha(g: GrupoSim, i: number): number {
    const { list, buffer } = g
    const a = list[i]
    const qtd = vizinhosDe(g.grade!, list, i, buffer)
    for (let p = 0; p < qtd; p++) {
      const j = buffer[p]
      if (j === i) continue
      const b = list[j]
      let dx = b.x - a.x
      let dy = b.y - a.y
      let d2 = dx * dx + dy * dy
      if (d2 > g.cutoff2) continue
      if (d2 < 1) {
        // Coincidentes: mesmo desempate do caminho exato, orientado do par
        // menor para o maior, para os dois lados se empurrarem em sentidos
        // opostos em vez de na mesma direção.
        const menor = i < j ? i : j
        const maior = i < j ? j : i
        dx = (menor % 7) - 3 + 0.5
        dy = (maior % 7) - 3 + 0.5
        if (i !== menor) {
          dx = -dx
          dy = -dy
        }
        d2 = dx * dx + dy * dy
      }
      const strength =
        (g.repulsao * (1 + Math.log2(1 + a.subtreeSize + b.subtreeSize) * 0.35)) / d2
      const d = Math.sqrt(d2)
      a.vx -= (dx / d) * strength
      a.vy -= (dy / d) * strength
    }
    return qtd
  }

  /** Molas + repulsão + gravidade, com resfriamento progressivo. */
  function simular(g: GrupoSim, estourou: () => boolean): boolean {
    const { list, links } = g
    const n = list.length
    const gravidade = g.usaGrade ? GRAVITY_GRADE : GRAVITY
    while (g.volta < g.iteracoes) {
      // A grade vale por uma iteração: na seguinte as posições já são outras.
      // Montá-la custa O(n), contra os O(n · vizinhos) da varredura.
      if (g.usaGrade && g.cursor === 0) {
        g.grade = montarGrade(list, CUTOFF * g.escala)
        g.movimento = 0
      }
      // Repulsão — o laço externo é o ponto de retomada.
      while (g.cursor < n) {
        let restante = PARES_POR_CHECAGEM
        while (g.cursor < n && restante > 0) {
          const i = g.cursor++
          restante -= g.usaGrade ? repulsaoVizinha(g, i) : repulsaoExata(list, i)
          unidades++
        }
        if (estourou()) return false
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
        node.vx -= node.x * gravidade
        node.vy -= node.y * gravidade
        let px = node.vx * g.alpha
        let py = node.vy * g.alpha
        if (g.usaGrade) {
          const passo = Math.hypot(px, py)
          const teto = MAX_PASSO * g.escala
          if (passo > teto) {
            // Corta o passo E a velocidade: só encurtar o passo deixaria a
            // energia guardada na velocidade para estourar na iteração seguinte.
            const freio = teto / passo
            px *= freio
            py *= freio
            node.vx *= freio
            node.vy *= freio
          }
        }
        node.x += px
        node.y += py
        if (g.usaGrade) g.movimento += Math.abs(px) + Math.abs(py)
        // Amortecimento: sem ele o sistema oscila em vez de assentar.
        node.vx *= 0.6
        node.vy *= 0.6
      }

      g.alpha *= 1 - ALPHA_DECAY
      g.volta++
      g.cursor = 0
      // Assentou: as iterações que faltam não mexem mais no desenho, e num
      // grupo grande cada uma delas custa caro.
      // O limiar acompanha a escala do grupo: num grupo esticado, "parado" é
      // proporcionalmente maior em unidades de mundo.
      if (g.usaGrade && g.movimento / n < CONVERGIU * g.escala) {
        unidades += (g.iteracoes - g.volta) * n
        return true
      }
      if (estourou()) return false
    }
    return true
  }

  /**
   * Passe de separação — a regra dura do espaço mínimo. Resolve sobreposição
   * das CAIXAS DE RÓTULO empurrando o par pelo eixo de menor penetração, que é
   * o deslocamento mínimo capaz de abrir a folga.
   */
  function separar(g: GrupoSim, estourou: () => boolean): boolean {
    const { list, buffer } = g
    const n = list.length
    while (g.volta < g.passes) {
      if (g.usaGrade && g.cursor === 0) g.grade = montarGrade(list, g.celulaSep)
      while (g.cursor < n) {
        let restante = PARES_POR_CHECAGEM
        while (g.cursor < n && restante > 0) {
          const i = g.cursor++
          const a = list[i]
          // Na grade só as 9 células ao redor entram; no caminho exato, todos
          // os índices seguintes. Nos dois casos cada par é tratado uma vez só
          // e na mesma ordem.
          const qtd = g.usaGrade ? vizinhosDe(g.grade!, list, i, buffer) : n
          for (let p = g.usaGrade ? 0 : i + 1; p < qtd; p++) {
            const j = g.usaGrade ? buffer[p] : p
            if (j <= i) continue
            const b = list[j]
            const overlap = overlapOf(a, b)
            if (!overlap) continue
            g.ativo = true
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
          restante -= qtd
          unidades++
        }
        if (estourou()) return false
      }
      const moveu = g.ativo
      g.ativo = false
      g.cursor = 0
      g.volta++
      if (!moveu) {
        // Assentou antes do limite: o que sobrou da fase entra no progresso de
        // uma vez, senão a barra ficaria presa esperando um trabalho que não
        // vai acontecer.
        unidades += (g.passes - g.volta) * n
        return true
      }
      if (estourou()) return false
    }
    return true
  }

  /**
   * Rede de segurança: se depois da separação ainda houver caixa encavalada
   * (vizinhança saturada), empurra o nó mais profundo radialmente para fora até
   * abrir espaço. É o "vai para um nível mais distante" literal.
   */
  function empurrar(g: GrupoSim, estourou: () => boolean): boolean {
    const { list, buffer } = g
    const n = list.length
    while (g.volta < g.rodadas) {
      if (g.usaGrade && g.cursor === 0) g.grade = montarGrade(list, g.celulaSep)
      while (g.cursor < n) {
        let restante = PARES_POR_CHECAGEM
        while (g.cursor < n && restante > 0) {
          const i = g.cursor++
          const a = list[i]
          const qtd = g.usaGrade ? vizinhosDe(g.grade!, list, i, buffer) : n
          for (let p = g.usaGrade ? 0 : i + 1; p < qtd; p++) {
            const j = g.usaGrade ? buffer[p] : p
            if (j <= i) continue
            const b = list[j]
            const overlap = overlapOf(a, b)
            if (!overlap) continue
            g.ativo = true
            // Cede quem tem menos vínculo: flutuante antes de quem está na
            // árvore e, entre dois da árvore, o mais profundo. A raiz nunca se
            // move.
            const rank = (node: SimNode) => (node.isRoot ? -1 : node.floating ? 1e6 : node.depth)
            const victim = a.isRoot ? b : b.isRoot ? a : rank(a) >= rank(b) ? a : b
            const dist = Math.hypot(victim.x, victim.y) || 0.01
            const step = Math.max(overlap.x, overlap.y) + MIN_GAP
            victim.x += (victim.x / dist) * step
            victim.y += (victim.y / dist) * step
          }
          restante -= qtd
          unidades++
        }
        if (estourou()) return false
      }
      const colidiu = g.ativo
      g.ativo = false
      g.cursor = 0
      g.volta++
      if (!colidiu) {
        unidades += (g.rodadas - g.volta) * n
        return true
      }
      if (estourou()) return false
    }
    return true
  }

  /** Avança um grupo pelas suas três fases; false quando o orçamento acabou. */
  function passoGrupo(g: GrupoSim, estourou: () => boolean): boolean {
    if (g.fase === 'sim') {
      if (!simular(g, estourou)) return false
      g.fase = 'sep'
      g.volta = 0
      g.cursor = 0
      g.ativo = false
    }
    if (g.fase === 'sep') {
      if (!separar(g, estourou)) return false
      g.fase = 'push'
      g.volta = 0
      g.cursor = 0
      g.ativo = false
    }
    if (g.fase === 'push') {
      if (!empurrar(g, estourou)) return false
      g.fase = 'ok'
    }
    return true
  }

  /**
   * Dispersão dos grupos + montagem do resultado. Empacotar em linhas produzia
   * fileiras visíveis de projetos lado a lado; a espiral de ângulo áureo
   * espalha as ilhas sem alinhamento perceptível, e a separação garante que
   * duas nunca se toquem.
   *
   * Roda a partir das posições atuais, então serve tanto para o resultado final
   * quanto para as prévias do meio do caminho.
   */
  function montar(): MemoryLayout {
    const nodes: LayoutNode[] = []
    const groups: LayoutGroup[] = []

    interface Island {
      grupo: GrupoSim
      minX: number
      minY: number
      maxX: number
      maxY: number
      cx: number
      cy: number
      radius: number
    }
    // Raio do círculo que envolve o grupo — meia diagonal da sua caixa.
    const islands: Island[] = grupos.map((grupo) => {
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const node of grupo.list) {
        const box = boxOf(node)
        minX = Math.min(minX, node.x - box.halfW)
        maxX = Math.max(maxX, node.x + box.halfW)
        minY = Math.min(minY, node.y - box.top)
        maxY = Math.max(maxY, node.y + box.bottom)
      }
      return {
        grupo,
        minX,
        minY,
        maxX,
        maxY,
        cx: 0,
        cy: 0,
        radius: Math.hypot(maxX - minX, maxY - minY) / 2,
      }
    })
    // Maiores primeiro para ocuparem o miolo; o id desempata para o resultado
    // não depender da ordem de iteração do Map.
    islands.sort((a, b) => b.radius - a.radius || a.grupo.id.localeCompare(b.grupo.id))

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
      // Desloca pelo CENTRO da caixa, não pelo canto — é o centro que a espiral
      // posicionou.
      const dx = island.cx - (island.minX + island.maxX) / 2
      const dy = island.cy - (island.minY + island.maxY) / 2
      for (const node of island.grupo.list) {
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
        id: island.grupo.id,
        label: labels.get(island.grupo.id) ?? '',
        minX: island.minX + dx,
        minY: island.minY + dy,
        maxX: island.maxX + dx,
        maxY: island.maxY + dy,
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

  function step(budgetMs: number): boolean {
    if (fase === 'done') return true
    const inicio = relogio()
    const estourou = () => relogio() - inicio >= budgetMs

    for (;;) {
      if (fase === 'prep') {
        while (prepIdx < groupIds.length) {
          const grupo = prepararGrupo(groupIds[prepIdx++])
          if (grupo) grupos.push(grupo)
          if (estourou()) return false
        }
        fase = 'grupos'
        grupoIdx = 0
        continue
      }
      if (grupoIdx >= grupos.length) {
        fase = 'done'
        return true
      }
      if (!passoGrupo(grupos[grupoIdx], estourou)) return false
      grupoIdx++
    }
  }

  return {
    step,
    get done() {
      return fase === 'done'
    },
    get progress() {
      return fase === 'done' ? 1 : Math.min(0.999, unidades / totalUnidades)
    },
    snapshot: montar,
  }
}

/**
 * Layout completo numa chamada — a forma síncrona, para quem pode bloquear
 * (o desktop, os testes). No mobile use `createMemoryGraphJob`.
 */
export function layoutMemoryGraph(pool: Memory[], options: LayoutOptions = {}): MemoryLayout {
  const job = createMemoryGraphJob(pool, options)
  // Com orçamento infinito o step nunca devolve o controle no meio; o laço é
  // só rede de segurança.
  while (!job.step(Infinity)) {
    /* vazio */
  }
  return job.snapshot()
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
