import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { Memory, MemoryGraphJob, MemoryLayout } from '@orbit/shared'
import { createMemoryGraphJob } from '@orbit/shared'

/**
 * Layout do grafo servido em fatias, para a tela entrar na hora.
 *
 * `layoutMemoryGraph` roda simulação de forças e duas passadas de separação —
 * trabalho de segundos com algumas centenas de memórias. Antes ele rodava numa
 * tarefa só: a thread de JS ficava presa, o "Montando o grafo…" nem chegava a
 * pintar e o app parecia travado.
 *
 * Aqui o mesmo trabalho vem de `createMemoryGraphJob`, que devolve o controle a
 * cada poucos milissegundos. O grafo abre imediatamente com o progresso real e
 * — enquanto o pool é pequeno o bastante para a prévia sair barata — com as
 * posições parciais, então dá para ver o desenho se assentando.
 *
 * O resultado fica num cache pequeno por assinatura do pool: alternar filtro de
 * projeto e voltar não recalcula nada.
 */

/**
 * Fatia por frame com a tela do grafo na frente. Sobe para 11 ms porque, com a
 * tela de construção no ar, não há concorrente: fatiar em 8 ms deixava o
 * relógio de parede quase dobrar sem ninguém aproveitar a folga.
 */
const ORCAMENTO_ATIVO = 11
/** Fatia quando o layout está sendo adiantado com a LISTA na frente: aqui
 *  roubar frame aparece na rolagem, então a mordida é menor. */
const ORCAMENTO_FUNDO = 4
/**
 * Intervalo mínimo entre duas prévias. Cada uma remonta a cena inteira — o
 * layout parcial é um conjunto novo de posições —, então elas competem com as
 * próprias fatias do layout. A 250 ms o imposto era alto demais; a 600 ms ainda
 * dá para ver o grafo se assentando sem transformar a construção numa disputa.
 */
const INTERVALO_PREVIA = 600
/** Acima disto a prévia custa mais do que informa: fica só a barra. */
const MAX_NOS_PREVIA = 800
/** Filtro de projeto costuma ir e voltar entre dois ou três recortes. */
const MAX_CACHE = 3

export interface GraphLayoutState {
  /** Parcial enquanto `building`; nulo até a primeira prévia. */
  layout: MemoryLayout | null
  /** Momento em que o layout foi montado — "recente"/"esquecida" são relativos
   *  a ele, e não ao frame atual (senão o memo da cena morria a cada frame). */
  now: number
  /** 0..1 — alimenta a barra de progresso. */
  progress: number
  building: boolean
}

interface Entrada {
  chave: string
  layout: MemoryLayout
  now: number
}

interface Execucao {
  chave: string
  pool: Memory[]
  job: MemoryGraphJob
  layout: MemoryLayout | null
  progress: number
  now: number
  orcamento: number
  frame: number | null
  ultimaPrevia: number
  /** Último inteiro de porcentagem já avisado ao React. */
  pctAvisado: number
}

/** LRU minúsculo: mais recente no fim. */
const cache: Entrada[] = []
let atual: Execucao | null = null
const inscritos = new Set<() => void>()
/**
 * O estado entregue ao React. `useSyncExternalStore` compara por identidade a
 * cada render, então ele só pode ser reconstruído quando algo mudou de verdade
 * — senão vira laço infinito de renders.
 */
let snapshot: { chave: string; estado: GraphLayoutState } | null = null

/**
 * Assinatura barata do pool: o layout só depende de quem está nele e das
 * ligações declaradas. É um hash, não a concatenação dos ids — com milhares de
 * memórias a string sozinha custava mais que uma fatia inteira.
 */
function assinatura(pool: Memory[]): string {
  let h = 2166136261
  for (const memory of pool) {
    const id = memory.id
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    h ^= memory.relatedIds.length + 1
    h = Math.imul(h, 16777619)
  }
  return `${pool.length}:${(h >>> 0).toString(36)}`
}

function doCache(chave: string): Entrada | undefined {
  const i = cache.findIndex((e) => e.chave === chave)
  if (i < 0) return undefined
  const [entrada] = cache.splice(i, 1)
  cache.push(entrada)
  return entrada
}

function guardar(entrada: Entrada): void {
  cache.push(entrada)
  while (cache.length > MAX_CACHE) cache.shift()
}

function calcular(chave: string): GraphLayoutState {
  const pronto = cache.find((e) => e.chave === chave)
  if (pronto) return { layout: pronto.layout, now: pronto.now, progress: 1, building: false }
  if (atual?.chave === chave) {
    return { layout: atual.layout, now: atual.now, progress: atual.progress, building: true }
  }
  return { layout: null, now: 0, progress: 0, building: true }
}

function ler(chave: string): GraphLayoutState {
  if (snapshot?.chave === chave) return snapshot.estado
  snapshot = { chave, estado: calcular(chave) }
  return snapshot.estado
}

function notificar(): void {
  snapshot = null
  for (const fn of inscritos) fn()
}

function agendar(exec: Execucao, primeiro = false): void {
  if (exec.frame != null) return
  // No primeiro agendamento são DOIS frames: o primeiro rAF ainda roda antes de
  // o React ter pintado o estado de carregando, e começar a moer ali seguraria
  // justamente o frame que precisa aparecer.
  const passo = () => {
    exec.frame = null
    trabalhar(exec)
  }
  exec.frame = requestAnimationFrame(primeiro ? () => {
    exec.frame = requestAnimationFrame(passo)
  } : passo)
}

function trabalhar(exec: Execucao): void {
  if (atual !== exec) return
  const terminou = exec.job.step(exec.orcamento)
  exec.progress = exec.job.progress

  if (terminou) {
    const layout = exec.job.snapshot()
    const now = Date.now()
    exec.layout = layout
    exec.now = now
    guardar({ chave: exec.chave, layout, now })
    atual = null
    notificar()
    return
  }

  const agora = Date.now()
  let mudou = false
  if (exec.pool.length <= MAX_NOS_PREVIA && agora - exec.ultimaPrevia >= INTERVALO_PREVIA) {
    exec.ultimaPrevia = agora
    exec.layout = exec.job.snapshot()
    if (!exec.now) exec.now = agora
    mudou = true
  }
  // Fora as prévias, o único visível é a porcentagem: avisar o React a cada
  // fatia seria um render por frame para redesenhar o mesmo número.
  const pct = Math.round(exec.progress * 100)
  if (pct !== exec.pctAvisado) {
    exec.pctAvisado = pct
    mudou = true
  }
  if (mudou) notificar()
  agendar(exec)
}

function cancelar(): void {
  if (!atual) return
  if (atual.frame != null) cancelAnimationFrame(atual.frame)
  atual = null
  snapshot = null
}

function iniciar(chave: string, pool: Memory[], orcamento: number): void {
  if (doCache(chave)) return
  if (atual?.chave === chave) {
    // Já está rodando: quem chegou com pressa (a tela do grafo aberta) manda no
    // tamanho da fatia.
    if (orcamento > atual.orcamento) atual.orcamento = orcamento
    return
  }
  cancelar()
  const exec: Execucao = {
    chave,
    pool,
    job: createMemoryGraphJob(pool, { inferEdges: true }),
    layout: null,
    progress: 0,
    now: 0,
    orcamento,
    frame: null,
    ultimaPrevia: Date.now(),
    pctAvisado: -1,
  }
  atual = exec
  snapshot = null
  agendar(exec, true)
}

function inscrever(fn: () => void): () => void {
  inscritos.add(fn)
  return () => {
    inscritos.delete(fn)
  }
}

/**
 * Adianta o layout enquanto o usuário ainda está na lista. Na prática é isto
 * que faz o toggle Lista→Grafo abrir pronto na maioria das vezes.
 */
export function prewarmGraphLayout(pool: Memory[]): void {
  if (pool.length === 0) return
  iniciar(assinatura(pool), pool, ORCAMENTO_FUNDO)
}

/** Encerra o que estiver rodando — a tela de memórias saiu de cena. */
export function stopGraphLayout(): void {
  cancelar()
}

export function useGraphLayout(pool: Memory[]): GraphLayoutState {
  // Memoizada: sem isto a assinatura seria refeita a cada render do grafo —
  // inclusive nos frames de gesto, que é justamente onde não pode haver
  // trabalho proporcional ao número de memórias.
  const chave = useMemo(() => assinatura(pool), [pool])

  useEffect(() => {
    iniciar(chave, pool, ORCAMENTO_ATIVO)
    return () => {
      // Sem a tela do grafo na frente o trabalho continua, só que devagar:
      // voltar para ela retoma de onde parou em vez de recomeçar do zero.
      if (atual) atual.orcamento = ORCAMENTO_FUNDO
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a chave resume o pool
  }, [chave])

  return useSyncExternalStore(
    inscrever,
    useCallback(() => ler(chave), [chave]),
  )
}
