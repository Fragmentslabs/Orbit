import path from 'node:path'
import type { ModelMessage } from 'ai'
import type { CatalogModel } from '@shared/chat'
import { parseFileView, parseInspection } from './bash-inspect'

/**
 * Orçamento de contexto DENTRO do turno.
 *
 * A compactação (compaction.ts) só alcança o histórico persistido ENTRE turnos,
 * e o `toModelMessages` já descarta os ToolParts antigos — ou seja, o que ela
 * resume é a menor parte do que vai para o modelo. O que estoura o contexto é o
 * tool loop do turno em andamento: o SDK reenvia toda chamada de ferramenta e
 * todo resultado a cada step, e com centenas de steps isso cresce sem teto
 * (um turno real chegou a pedir 3,4M tokens num modelo de 1M).
 *
 * Este módulo corta esse acúmulo no `prepareStep` — o único ponto onde as
 * mensagens do turno passam antes de virar request.
 */

/** Estimativa grosseira, sem tokenizer: a média de um texto em UTF-8. */
const CHARS_PER_TOKEN = 4

/**
 * Teto absoluto de contexto, independente do `limit.context` anunciado pelo
 * catálogo. Modelos de 1M+ só acionariam os cortes relativos perto de ~1M,
 * deixando a conversa operar rotineiramente com centenas de milhares de tokens
 * de histórico — caro e lento muito antes de virar erro. Compartilhado com a
 * compactação para que os dois cortes falem do mesmo teto.
 */
export const ABSOLUTE_CONTEXT_CAP = 300_000

/** Reserva para a resposta do modelo. */
const OUTPUT_RESERVE_CAP = 32_000
/** Reserva para o system prompt + definições das ferramentas, que não passam
 *  por aqui (o SDK monta o request depois do prepareStep). */
const PROMPT_RESERVE = 30_000
const MIN_BUDGET = 16_000

/** Tamanho fixo cobrado por anexo binário: um PNG de 1MB vira ~1.5k tokens no
 *  provedor, mas ~250k caracteres de base64 — contá-los por caractere faria o
 *  orçamento achar que estourou e descartar meio turno sem necessidade. */
const BINARY_PART_CHARS = 6_000

/**
 * Resultados de ferramenta preservados sempre, por mais apertado que esteja o
 * orçamento: é a mesa de trabalho do modelo neste instante. Descartar os
 * últimos faria o agente perder o que acabou de ler e reler em loop.
 */
const KEEP_RECENT_RESULTS = 10

/**
 * Piso do último recurso: quando nem descartando tudo o que é antigo o turno
 * cabe, o corte avança sobre os recentes e para aqui. Perder o que o modelo
 * acabou de ler é ruim; um request que o provedor recusa inteiro é pior — e
 * era exatamente o que acontecia antes deste módulo existir.
 */
const MIN_KEPT_RESULTS = 2

/**
 * Fração do orçamento a partir da qual chamadas repetidas passam a ser
 * descartadas. Abaixo disso o turno é pequeno e não vale mexer no contexto:
 * economia nenhuma justifica mudar o que o modelo vê num turno que cabe folgado.
 */
const SUPERSEDE_THRESHOLD = 0.5

/** Strings dentro do input de uma chamada descartada acima disso são cortadas
 *  — o `content` de um `write` de arquivo grande fica no contexto para sempre,
 *  e depois de descartado o resultado ele não serve mais para nada. */
const MAX_KEPT_INPUT_STRING = 400

/**
 * Ferramentas cuja repetição com os MESMOS argumentos torna o resultado
 * anterior redundante. Só leitura idempotente entra: `bash` roda comando (o
 * segundo `git status` não invalida o primeiro como registro do que houve) e
 * `write`/`edit` têm efeito colateral.
 */
const IDEMPOTENT_TOOLS = new Set(['read', 'ls', 'glob', 'grep', 'code_search', 'code_outline', 'code_refs'])

/**
 * Teto de TRABALHO do turno, abaixo do teto de segurança (`contextBudget`).
 * O teto de segurança só impede o request que o provedor recusa; nos dados
 * reais os turnos longos rodavam 200–470k tokens por passo, e cada passo
 * reenvia tudo — os 10% de turnos mais pesados eram 66% da entrada. Passando
 * disto, o que é antigo sai em lote (ver BATCH_TARGET).
 */
const WORKING_CONTEXT_CAP = 100_000

/**
 * Até onde o corte em lote desce, como fração do teto de trabalho. Descartar
 * só o necessário para caber mudaria o meio do contexto a cada passo — e cada
 * mudança invalida o cache de prefixo do provedor dali em diante. Descendo bem
 * abaixo do teto, o contexto volta a crescer intacto por muitos passos antes
 * do próximo corte.
 */
const BATCH_TARGET = 0.6

/**
 * Tools do Computer Use cujo resultado é uma observação da tela. Uma observação
 * só vale até a próxima árvore COMPLETA do mesmo app: dali para trás os índices
 * e o estado que ela mostra já não são verdade, e cada passo do laço a
 * reenviava — com o screenshot, quando havia. Os diffs (tools/computer.ts) se
 * apoiam na última árvore completa, então ela e o que vem depois ficam.
 */
const OBSERVATION_TOOLS = new Set(['cu_observe', 'cu_computer', 'cu_batch', 'cu_query'])
const OBSERVATION_APP = /^App: .*\bpid (\d+)\)/m
const FULL_TREE = /^Tree \(\d+ elements/m
/**
 * Observações vencidas saem juntas, não uma a cada passo: cada descarte muda
 * o meio do contexto e invalida o cache de prefixo do provedor dali em diante.
 */
const STALE_OBSERVATION_BATCH = 3
const MAX_KEPT_SUMMARY = 500

/** O `read` sem `limit` mostra até isto (MAX_READ_LINES em tools/files.ts). */
const READ_DEFAULT_LINES = 2000

/** Prefixo do texto que substitui um resultado descartado — serve de sentinela
 *  para não reprocessar, step após step, o que já foi cortado. */
const DROPPED_MARK = '[SYSTEM: tool output dropped'

/** Separador da chave de deduplicação: JSON serializado nunca contém quebra de
 *  linha crua, então não há como um argumento forjar a chave de outro. */
const KEY_SEPARATOR = '\n'

/**
 * Teto de passos por turno. O corte de contexto acima já impede o tool loop de
 * estourar a janela, então isto aqui é guarda de custo e de loop em falso: um
 * modelo de contexto pequeno não tem o que fazer com 300 idas ao provedor.
 */
const MAX_STEPS_CEILING = 300
const MAX_STEPS_FLOOR = 120
const TOKENS_PER_STEP = 3_400

export function maxStepsFor(model: CatalogModel | undefined): number {
  const context = model?.limit?.context
  if (!context) return MAX_STEPS_FLOOR
  const scaled = Math.round(Math.min(context, ABSOLUTE_CONTEXT_CAP * 4) / TOKENS_PER_STEP)
  return Math.max(MAX_STEPS_FLOOR, Math.min(MAX_STEPS_CEILING, scaled))
}

/** Quantos tokens as mensagens do turno podem ocupar antes de o corte entrar. */
export function contextBudget(model: CatalogModel | undefined): number {
  const context = Math.min(model?.limit?.context || ABSOLUTE_CONTEXT_CAP, ABSOLUTE_CONTEXT_CAP)
  const output = Math.min(model?.limit?.output || OUTPUT_RESERVE_CAP, OUTPUT_RESERVE_CAP)
  return Math.max(context - output - PROMPT_RESERVE, MIN_BUDGET)
}

/** Teto a partir do qual o corte em lote entra — nunca acima do de segurança. */
export function workingBudget(model: CatalogModel | undefined): number {
  return Math.min(contextBudget(model), WORKING_CONTEXT_CAP)
}

function safeChars(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return 0
  }
}

function safeStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value) ?? null
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object'
}

function partType(part: unknown): string | undefined {
  return isRecord(part) && typeof part.type === 'string' ? part.type : undefined
}

/** Caracteres de uma saída de ferramenta, sem contar base64 de anexo. */
function outputChars(output: unknown): number {
  if (!isRecord(output)) return 0
  if (output.type === 'content' && Array.isArray(output.value)) {
    return output.value.reduce<number>((sum, item) => sum + partChars(item), 0)
  }
  if (typeof output.value === 'string') return output.value.length
  return safeChars(output)
}

function partChars(part: unknown): number {
  if (typeof part === 'string') return part.length
  if (!isRecord(part)) return 0
  const type = partType(part)
  if (type === 'file' || type === 'image') return BINARY_PART_CHARS
  if (type === 'tool-result') return outputChars(part.output)
  return safeChars(part)
}

/** Tamanho do que vai ao modelo, em tokens. Superestima markup e subestima
 *  idiomas fora do latin-1, mas o erro é pequeno perto da ordem de grandeza
 *  que interessa aqui (dezenas de milhares de tokens). */
export function estimateTokens(messages: ModelMessage[]): number {
  let chars = 0
  for (const message of messages) {
    if (typeof message.content === 'string') chars += message.content.length
    else if (Array.isArray(message.content)) {
      for (const part of message.content) chars += partChars(part)
    }
  }
  return Math.round(chars / CHARS_PER_TOKEN)
}

function isDropped(part: Record<string, unknown>): boolean {
  const output = part.output
  return (
    isRecord(output) &&
    output.type === 'text' &&
    typeof output.value === 'string' &&
    output.value.startsWith(DROPPED_MARK)
  )
}

interface ResultSlot {
  /** `${índice da mensagem}:${índice da part}` — identidade posicional, porque
   *  o toolCallId pode vir vazio de parts saneadas pelo normalizeMessages. */
  at: string
  toolCallId: string
  toolName: string
  chars: number
  /** Começo do texto do resultado — o `read` e o `write` dizem ali o caminho
   *  absoluto que resolveram, que o input relativo não diz. */
  head: string
  /** Erro da ferramenta ou bash com exit code diferente de zero */
  failed: boolean
  /** Saída de bash com o meio cortado (tools/shell.ts) — não cobre faixa nenhuma */
  partial: boolean
  /** Observação do Computer Use: de qual app, se traz a árvore inteira e o que a ação fez antes dela */
  observation: { pid: number; full: boolean; summary: string } | null
}

/** O texto de uma saída — numa com imagem, a parte de texto. */
function outputText(output: Record<string, unknown>): string {
  if (typeof output.value === 'string') return output.value
  if (output.type === 'content' && Array.isArray(output.value)) {
    return output.value
      .map((item) => (isRecord(item) && item.type === 'text' && typeof item.text === 'string' ? item.text : ''))
      .join('\n')
  }
  return ''
}

function observationOf(toolName: string, text: string): ResultSlot['observation'] {
  if (!OBSERVATION_TOOLS.has(toolName)) return null
  const app = OBSERVATION_APP.exec(text)
  if (!app) return null
  const summary = text.slice(0, app.index).trim()
  return {
    pid: Number(app[1]),
    full: FULL_TREE.test(text),
    summary: summary.length > MAX_KEPT_SUMMARY ? `${summary.slice(0, MAX_KEPT_SUMMARY)}…` : summary,
  }
}

function collectCalls(messages: ModelMessage[]): Map<string, unknown> {
  const calls = new Map<string, unknown>()
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (partType(part) !== 'tool-call') continue
      const call = part as unknown as Record<string, unknown>
      if (typeof call.toolCallId === 'string') calls.set(call.toolCallId, call.input)
    }
  }
  return calls
}

function collectResults(messages: ModelMessage[]): ResultSlot[] {
  const slots: ResultSlot[] = []
  messages.forEach((message, mi) => {
    if (!Array.isArray(message.content)) return
    message.content.forEach((part, pi) => {
      if (partType(part) !== 'tool-result') return
      const result = part as unknown as Record<string, unknown>
      if (isDropped(result)) return
      const output = isRecord(result.output) ? result.output : {}
      const text = typeof output.value === 'string' ? output.value : ''
      const toolName = typeof result.toolName === 'string' ? result.toolName : ''
      slots.push({
        at: `${mi}:${pi}`,
        toolCallId: typeof result.toolCallId === 'string' ? result.toolCallId : '',
        toolName,
        chars: outputChars(result.output),
        head: text.slice(0, 600),
        failed:
          (typeof output.type === 'string' && output.type.startsWith('error')) ||
          /\(exit code: [^)]*\)\s*$/.test(text.slice(-40)),
        partial: text.includes(OMITTED_MIDDLE_MARK),
        observation: observationOf(toolName, outputText(output)),
      })
    })
  })
  return slots
}

/**
 * O que um resultado representa, para saber quando um posterior o torna
 * redundante:
 * - `query`: leitura idempotente; a mesma chave repetida substitui a anterior.
 * - `file`: um trecho de arquivo (`read`, `cat`, `sed -n`, `head`); um trecho
 *   posterior do MESMO arquivo que o cubra o substitui.
 * - `overwrite`: um `write` do arquivo inteiro; nada antes dele sobre esse
 *   arquivo continua verdade.
 */
type ResultView =
  | { kind: 'query'; key: string }
  | { kind: 'file'; path: string; from: number; to: number }
  | { kind: 'overwrite'; path: string }

/** O que tools/shell.ts escreve no lugar do meio de uma saída longa */
const OMITTED_MIDDLE_MARK = 'characters omitted from the middle of the output'

const READ_HEADER = /^<file path="([^"]+)">/
const WRITE_HEADER = /^File written: (.+) \(\d+ characters\)/

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function viewOf(slot: ResultSlot, calls: Map<string, unknown>, directory?: string): ResultView | null {
  if (!slot.toolCallId || !calls.has(slot.toolCallId)) return null
  const input = calls.get(slot.toolCallId)
  if (slot.toolName === 'write') {
    const match = WRITE_HEADER.exec(slot.head)
    return match && !slot.failed ? { kind: 'overwrite', path: match[1] } : null
  }
  if (slot.toolName === 'read') {
    // Só arquivo de texto: documento (PDF/DOCX) pagina por página, não por linha.
    const match = READ_HEADER.exec(slot.head)
    if (match && isRecord(input)) {
      const from = Math.max(1, numberOr(input.offset, 1))
      const lines = Math.min(numberOr(input.limit, READ_DEFAULT_LINES), READ_DEFAULT_LINES)
      return { kind: 'file', path: match[1], from, to: from + Math.max(1, lines) - 1 }
    }
  }
  if (slot.toolName === 'bash') {
    if (!directory || !isRecord(input) || typeof input.command !== 'string') return null
    const inspection = parseInspection(input.command, directory)
    if (!inspection) return null
    const file = parseFileView(inspection)
    if (file) return slot.failed || slot.partial ? null : { kind: 'file', ...file }
    return { kind: 'query', key: `bash${KEY_SEPARATOR}${inspection.cwd}${KEY_SEPARATOR}${inspection.command}` }
  }
  if (!IDEMPOTENT_TOOLS.has(slot.toolName)) return null
  const serialized = safeStringify(input)
  return serialized == null ? null : { kind: 'query', key: `${slot.toolName}${KEY_SEPARATOR}${serialized}` }
}

/** Por que um resultado posterior torna este redundante — null quando não torna. */
function supersededBy(older: ResultView, newer: ResultView, newerFailed: boolean): DropReason | null {
  if (older.kind === 'query') {
    return newer.kind === 'query' && newer.key === older.key ? 'superseded' : null
  }
  if (older.kind !== 'file' || newer.kind === 'query' || path.normalize(newer.path) !== path.normalize(older.path)) {
    return null
  }
  if (newer.kind === 'overwrite') return 'overwritten'
  return !newerFailed && newer.from <= older.from && newer.to >= older.to ? 'covered' : null
}

type DropReason = 'superseded' | 'covered' | 'overwritten' | 'age' | 'oversized' | 'staleObservation'

function droppedText(toolName: string, chars: number, reason: DropReason, summary = ''): string {
  const tool = toolName || 'tool'
  if (reason === 'staleObservation') {
    // O que a ação fez fica: sem isso o modelo perde o histórico do que já tentou.
    return `${DROPPED_MARK} — an older screen observation of this app; a newer full one is further down and these indices are no longer valid.${summary ? ` What this call did: ${summary}` : ''}]`
  }
  if (reason === 'oversized') {
    return `${DROPPED_MARK} — the \`${tool}\` result (${chars} chars) was too large to fit in the context window on its own. Call it again asking for a narrower result (smaller range, filter, limit).]`
  }
  if (reason === 'superseded') {
    return `${DROPPED_MARK} — this \`${tool}\` call was repeated later in the turn with identical arguments; only the newest result is kept. Look further down for it.]`
  }
  if (reason === 'covered') {
    return `${DROPPED_MARK} — these lines of the file were read again later in the turn; only the newest read is kept. Look further down for it.]`
  }
  if (reason === 'overwritten') {
    return `${DROPPED_MARK} — this file was rewritten later in the turn with \`write\`, so this earlier content is stale.]`
  }
  return `${DROPPED_MARK} — the \`${tool}\` result (${chars} chars) was removed to free up context in this turn. Call the tool again if you still need it.]`
}

/** Encurta strings longas do input de uma chamada cujo resultado foi
 *  descartado, preservando as chaves: o provedor valida o input contra o
 *  schema da ferramenta, e um objeto vazio derrubaria o turno com 400. */
function shrinkInput(input: unknown): unknown {
  if (!isRecord(input) || Array.isArray(input)) return input
  let changed = false
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' && value.length > MAX_KEPT_INPUT_STRING) {
      changed = true
      const cut = value.length - MAX_KEPT_INPUT_STRING
      next[key] = `${value.slice(0, MAX_KEPT_INPUT_STRING)}… [+${cut} chars dropped]`
    } else {
      next[key] = value
    }
  }
  return changed ? next : input
}

function rewrite(
  messages: ModelMessage[],
  dropped: Map<string, string>,
  droppedCallIds: Set<string>,
): ModelMessage[] {
  return messages.map((message, mi) => {
    if (!Array.isArray(message.content)) return message
    let changed = false
    const content = message.content.map((part, pi) => {
      const type = partType(part)
      if (type === 'tool-result') {
        const stub = dropped.get(`${mi}:${pi}`)
        if (stub === undefined) return part
        changed = true
        return { ...(part as unknown as Record<string, unknown>), output: { type: 'text', value: stub } }
      }
      if (type === 'tool-call') {
        const call = part as unknown as Record<string, unknown>
        if (typeof call.toolCallId !== 'string' || !droppedCallIds.has(call.toolCallId)) return part
        const input = shrinkInput(call.input)
        if (input === call.input) return part
        changed = true
        return { ...call, input }
      }
      return part
    })
    return changed ? ({ ...message, content } as unknown as ModelMessage) : message
  })
}

/**
 * Corta o acúmulo do tool loop até caber no orçamento. Devolve a MESMA
 * referência quando nada muda, para o `prepareStep` poder responder `{}` e o
 * SDK pular a reescrita das mensagens.
 *
 * Critérios, nesta ordem:
 * 1. Resultados que um posterior torna redundante: a mesma leitura repetida
 *    (`read` do mesmo arquivo três vezes num turno é de longe o caso mais
 *    comum), um trecho relido que cobre o anterior — pelo `read` ou por
 *    `cat`/`sed -n` no bash — e o arquivo reescrito por `write`.
 * 2. Teto de trabalho (`softBudget`), quando passa dele: o antigo sai em lote
 *    até BATCH_TARGET do teto, preservando os últimos resultados.
 * 3. Teto de segurança (`budgetTokens`), quando ainda não couber: descarta do
 *    mais antigo para o mais novo, e no limite até os recentes.
 *
 * O que é descartado vira uma linha dizendo o que havia ali e que a ferramenta
 * pode ser chamada de novo — nunca some em silêncio, senão o modelo conclui que
 * nunca leu o arquivo. As tool CALLS ficam: o par call/result é exigido pelos
 * provedores, e quebrá-lo derruba o turno com 400.
 */
export interface TrimOptions {
  /** Teto de trabalho do corte em lote (ver workingBudget) */
  softBudget?: number
  /**
   * Memória do turno. O SDK entrega ao `prepareStep` as mensagens ORIGINAIS a
   * cada passo, então sem isto o corte seria refeito do zero e o lote
   * escorregaria um pouco a cada passo — exatamente a mudança no meio do
   * contexto que o lote existe para evitar. Com ela, o que saiu continua fora,
   * com o mesmo texto, e o prefixo fica estável entre os cortes.
   */
  state?: TrimState
  /** Pasta onde o bash roda, para resolver os caminhos de `cat`/`sed -n` */
  directory?: string
}

export interface TrimState {
  dropped: Map<string, DropReason>
}

export function createTrimState(): TrimState {
  return { dropped: new Map() }
}

export function trimTurnContext(
  messages: ModelMessage[],
  budgetTokens: number,
  options: TrimOptions = {},
): ModelMessage[] {
  const results = collectResults(messages)
  if (results.length === 0) return messages

  const calls = collectCalls(messages)
  const dropped = new Map<string, string>()
  const droppedCallIds = new Set<string>()
  let used = estimateTokens(messages)
  const memoryKey = (slot: ResultSlot) => slot.toolCallId || slot.at

  // O aviso substituto é montado aqui, e não na reescrita, para que o
  // abatimento seja o tamanho REAL do que sobrou. Estimá-lo por uma constante
  // deixava o contador otimista alguns tokens por descarte — com centenas de
  // descartes num turno, a conta fechava dentro do orçamento e o request saía
  // fora dele, que é exatamente o erro que este módulo existe para evitar.
  const drop = (slot: ResultSlot, reason: DropReason) => {
    if (dropped.has(slot.at)) return
    const stub = droppedText(slot.toolName, slot.chars, reason, slot.observation?.summary)
    dropped.set(slot.at, stub)
    options.state?.dropped.set(memoryKey(slot), reason)
    if (slot.toolCallId) droppedCallIds.add(slot.toolCallId)
    used -= Math.max(0, Math.round((slot.chars - stub.length) / CHARS_PER_TOKEN))
  }

  // O que já saiu num passo anterior continua fora, com o mesmo aviso.
  if (options.state) {
    for (const slot of results) {
      const reason = options.state.dropped.get(memoryKey(slot))
      if (reason) drop(slot, reason)
    }
  }

  // Observações vencidas saem sem esperar o orçamento apertar: não são só
  // grandes, são falsas (índices e estado de uma tela que já mudou).
  const latestFull = new Map<number, number>()
  results.forEach((slot, i) => {
    if (slot.observation?.full) latestFull.set(slot.observation.pid, i)
  })
  const stale = results.filter((slot, i) => {
    const obs = slot.observation
    return obs !== null && i < (latestFull.get(obs.pid) ?? -1) && !dropped.has(slot.at)
  })
  if (stale.length >= STALE_OBSERVATION_BATCH) for (const slot of stale) drop(slot, 'staleObservation')

  const softBudget = options.softBudget ? Math.min(options.softBudget, budgetTokens) : budgetTokens
  if (used > softBudget * SUPERSEDE_THRESHOLD) {
    const views = results.map((slot) => viewOf(slot, calls, options.directory))
    results.forEach((slot, i) => {
      const older = views[i]
      if (!older || dropped.has(slot.at)) return
      for (let j = results.length - 1; j > i; j--) {
        const newer = views[j]
        const reason = newer && supersededBy(older, newer, results[j].failed)
        if (reason) {
          drop(slot, reason)
          return
        }
      }
    })
  }

  const evict = (keep: number, target = budgetTokens) => {
    for (const slot of results.slice(0, Math.max(0, results.length - keep))) {
      if (used <= target) break
      if (dropped.has(slot.at)) continue
      drop(slot, 'age')
    }
  }
  if (options.softBudget && used > softBudget) evict(KEEP_RECENT_RESULTS, softBudget * BATCH_TARGET)
  evict(KEEP_RECENT_RESULTS)
  // Ainda não coube: avança sobre a mesa de trabalho até o piso. Não é o caso
  // comum — acontece quando poucas saídas gigantes sozinhas já passam do
  // orçamento —, mas é o que garante um teto de verdade em vez de um teto que
  // vale só enquanto o turno colabora.
  evict(MIN_KEPT_RESULTS)
  // O piso protege a mesa de trabalho, mas não pode proteger um resultado que
  // sozinho não cabe: um screenshot em base64 de 3,3M caracteres era o último
  // resultado do turno, o piso o preservava e o request saía com 917k tokens
  // num modelo de 1M. Aqui o maior sai primeiro, até caber.
  if (used > budgetTokens) {
    const bySize = [...results].sort((a, b) => b.chars - a.chars)
    for (const slot of bySize) {
      if (used <= budgetTokens) break
      if (dropped.has(slot.at)) continue
      drop(slot, 'oversized')
    }
  }

  if (dropped.size === 0) return messages
  return rewrite(messages, dropped, droppedCallIds)
}
