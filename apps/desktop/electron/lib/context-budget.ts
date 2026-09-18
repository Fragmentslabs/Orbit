import type { ModelMessage } from 'ai'
import type { CatalogModel } from '@shared/chat'

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
const IDEMPOTENT_TOOLS = new Set(['read', 'ls', 'glob', 'grep'])

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
      slots.push({
        at: `${mi}:${pi}`,
        toolCallId: typeof result.toolCallId === 'string' ? result.toolCallId : '',
        toolName: typeof result.toolName === 'string' ? result.toolName : '',
        chars: outputChars(result.output),
      })
    })
  })
  return slots
}

/** Chave de identidade de uma chamada — null quando a ferramenta não é
 *  idempotente ou os argumentos não são serializáveis. */
function signature(slot: ResultSlot, calls: Map<string, unknown>): string | null {
  if (!IDEMPOTENT_TOOLS.has(slot.toolName) || !slot.toolCallId) return null
  if (!calls.has(slot.toolCallId)) return null
  const input = safeStringify(calls.get(slot.toolCallId))
  return input == null ? null : `${slot.toolName}${KEY_SEPARATOR}${input}`
}

function droppedText(toolName: string, chars: number, reason: 'superseded' | 'age'): string {
  const tool = toolName || 'tool'
  if (reason === 'superseded') {
    return `${DROPPED_MARK} — this \`${tool}\` call was repeated later in the turn with identical arguments; only the newest result is kept. Look further down for it.]`
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
 * Dois critérios, nesta ordem:
 * 1. Chamadas repetidas com os mesmos argumentos (`read` do mesmo arquivo três
 *    vezes num turno é de longe o caso mais comum): só a mais recente sobrevive.
 * 2. Idade, quando ainda não couber: descarta do mais antigo para o mais novo,
 *    preservando sempre os últimos resultados.
 *
 * O que é descartado vira uma linha dizendo o que havia ali e que a ferramenta
 * pode ser chamada de novo — nunca some em silêncio, senão o modelo conclui que
 * nunca leu o arquivo. As tool CALLS ficam: o par call/result é exigido pelos
 * provedores, e quebrá-lo derruba o turno com 400.
 */
export function trimTurnContext(messages: ModelMessage[], budgetTokens: number): ModelMessage[] {
  const results = collectResults(messages)
  if (results.length === 0) return messages

  const calls = collectCalls(messages)
  const dropped = new Map<string, string>()
  const droppedCallIds = new Set<string>()
  let used = estimateTokens(messages)

  // O aviso substituto é montado aqui, e não na reescrita, para que o
  // abatimento seja o tamanho REAL do que sobrou. Estimá-lo por uma constante
  // deixava o contador otimista alguns tokens por descarte — com centenas de
  // descartes num turno, a conta fechava dentro do orçamento e o request saía
  // fora dele, que é exatamente o erro que este módulo existe para evitar.
  const drop = (slot: ResultSlot, reason: 'superseded' | 'age') => {
    const stub = droppedText(slot.toolName, slot.chars, reason)
    dropped.set(slot.at, stub)
    if (slot.toolCallId) droppedCallIds.add(slot.toolCallId)
    used -= Math.max(0, Math.round((slot.chars - stub.length) / CHARS_PER_TOKEN))
  }

  if (used > budgetTokens * SUPERSEDE_THRESHOLD) {
    const newest = new Map<string, string>()
    for (const slot of results) {
      const key = signature(slot, calls)
      if (key) newest.set(key, slot.at)
    }
    for (const slot of results) {
      const key = signature(slot, calls)
      if (key && newest.get(key) !== slot.at) drop(slot, 'superseded')
    }
  }

  const evict = (keep: number) => {
    for (const slot of results.slice(0, Math.max(0, results.length - keep))) {
      if (used <= budgetTokens) break
      if (dropped.has(slot.at)) continue
      drop(slot, 'age')
    }
  }
  evict(KEEP_RECENT_RESULTS)
  // Ainda não coube: avança sobre a mesa de trabalho até o piso. Não é o caso
  // comum — acontece quando poucas saídas gigantes sozinhas já passam do
  // orçamento —, mas é o que garante um teto de verdade em vez de um teto que
  // vale só enquanto o turno colabora.
  evict(MIN_KEPT_RESULTS)

  if (dropped.size === 0) return messages
  return rewrite(messages, dropped, droppedCallIds)
}
