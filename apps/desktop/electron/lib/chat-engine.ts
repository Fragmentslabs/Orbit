import { generateText, stepCountIs, streamText, type ModelMessage, type UserContent } from 'ai'
import type { BrowserWindow } from 'electron'
import type {
  AgentPart,
  ChatEvent,
  ChatMessage,
  FilePart,
  MessagePart,
  PermissionMode,
  ReasoningPart,
  SendMessageInput,
  SessionInfo,
  ToolPart,
} from '@shared/chat'
import { StorageKeys } from '@shared/chat'
import { getProvider, modelSupportsVision } from './catalog'
import { compactHistory, findLastSummaryIndex, shouldCompact } from './compaction'
import { createToolApproval, takeDenialReason } from './permission'
import { classifyProviderError, errorToText } from './errors'
import { buildSystemPrompt } from './prompts'
import { buildProviderOptions, interleavedReasoningField, normalizeMessages } from './reasoning'
import { resolveModel } from './providers'
import { attachMediaMessage } from './media'
import { claimsCompletion } from './overclaim'
import { extractPdfText } from './pdf'
import { extractSpreadsheetText } from './xlsx'
import { extractDocxText } from './docx'
import { describeSkillAttachment } from './skills/import'
import { cleanupRevert } from './session/revert'
import { capture, diff } from './snapshot'
import { runProjectInit, type InitHooks } from './project-init'
import { PROJECT_AREAS, type ProjectArea } from '@shared/memory'
import { readJson, writeJson } from './storage'
import { buildToolSet, type ToolContext, type TurnSnapshot } from './tools'
import { verifyTurnChanges, type VerifyChangesResult } from './tools/verify-changes'
import { addTokenUsage, toStepUsage, toTokenUsage } from './usage'
import { messageContextText } from './todo-context'
import { forwardChatEvent } from './companion-server'

/**
 * Motor de chat portado do processador de sessões do opencode: converte o
 * histórico persistido em mensagens de modelo, roda o loop de streamText com
 * ferramentas e emite eventos incrementais para o renderer via IPC.
 */

// Teto de segurança, não um limite operacional normal — o opencode (de onde
// este engine foi portado) roda sem teto por padrão (agent.steps ?? Infinity)
// e só para quando o modelo decide (finishReason === 'stop'). 50 era baixo
// demais: tarefas de código reais passam disso e a stream cortava no meio,
// indistinguível de uma conclusão normal. 300 é folga suficiente pra
// qualquer tarefa real; existe só pra não deixar um loop patológico rodar
// para sempre.
const MAX_STEPS = 300
// Nudge do último passo permitido — mesma ideia do MAX_STEPS_PROMPT do
// opencode (packages/core/src/session/runner/max-steps.ts): em vez de
// cortar a stream no meio de uma tool call, desabilita as tools e força o
// modelo a resumir em texto o que fez e o que falta. `truncated` (abaixo)
// vira um backstop raro, não o caminho comum.
const MAX_STEPS_PROMPT = `MAXIMUM STEPS REACHED for this turn. Tools are now disabled — respond with text ONLY.

Your response must:
- State that the step limit was reached
- Summarize what was accomplished so far
- List any remaining pending items
- Suggest what to do next (the user can say "continue" to resume)`

// Auto-continue quando o modelo bate no limite de TOKENS DE SAÍDA
// (finish_reason "length") — o padrão do opencode (#17471/#18108): a
// resposta foi CORTADA, não finalizada; re-roda-se o turno com um pedido de
// continuação e o contexto completo, limitado por turno. Sem isso, a stream
// cortava no meio de um texto/tool call silenciosamente, indistinguível de
// conclusão normal — a causa raiz das "respostas interrompidas do nada".
const MAX_AUTO_CONTINUES = 3
const AUTO_CONTINUE_PROMPT = `[SYSTEM: the previous reply was cut off by the model's output token limit (finish_reason "length") — this is NOT the end of the turn. Continue exactly from where you left off: do NOT repeat or summarize what was already written, just pick up the next part and finish the work. If you were mid-task, complete it.]`
const AUTO_CONTINUE_TOOL_PROMPT = (toolNames: string) => `[SYSTEM: the previous reply was cut off by the model's output token limit (finish_reason "length") in the middle of a ${toolNames} tool call. That tool call was NOT executed. Do NOT retry it as one giant operation — split it into smaller operations (smaller file writes, shorter commands, less data per call) and continue from where you left off.]`
// Nudge de fechamento da TODO: o turno terminou em 'stop' mas o modelo não
// reenviou a lista marcando os itens como completed (os checkboxes ficam com
// spinner infinito na UI). Re-entramos no loop com uma synthetic user
// message pedindo para resolver o estado — mesmo padrão do auto-continue,
// com teto por turno para não virar loop.
const MAX_TODO_NUDGES = 2
const TODO_COMPLETION_PROMPT = `[SYSTEM: your reply ended, but the last TODO list still has items marked as "in_progress". If you actually completed them, re-send the TODO list marking those items as "completed" (do NOT repeat the work summary — just update the checklist). If they are truly still not finished, say so briefly. Do not end the turn again without resolving the TODO state.]`
// Verificação pós-escrita FORÇADA: quando o turno termina naturalmente
// ('stop') com (a) escrita (edit/write/bash) sem leitura/verificação depois
// da última, ou (b) NENHUMA tool chamada — o modelo respondeu "feito" sem
// tocar no filesystem (overclaim) — o ENGINE executa verify_changes por
// conta própria (sem depender de o modelo chamá-la), injeta o tool part na
// mensagem e re-entra no loop com o RESULTADO REAL na synthetic user
// message. O antigo nudge por prompt não era confiável: o modelo o ignorava
// e concluía mesmo assim. No máximo 1x por turno para não virar loop.
const MAX_VERIFY_NUDGES = 1
// Injeções de sistema são SEMPRE em inglês, como o resto do contexto sintético
// (todo-context.ts) — não seguem o idioma do usuário.
const VERIFY_RESULT_PROMPT = (result: string) =>
  `[SYSTEM: post-write verification executed by the engine — REAL filesystem state, not the model's claims:\n${result}\n\nAdjust your final reply based on THIS result: if there were changes, confirm what was written; if NO change was persisted, say so explicitly — never claim work that was not persisted. Do not call verify_changes again; just correct or confirm your reply.]`
// Ferramentas que alteram o filesystem vs. ferramentas que verificam — a
// heurística da verificação pós-escrita (ver runChat).
const WRITE_TOOLS = new Set(['edit', 'write', 'bash'])
const VERIFY_TOOLS = new Set(['read', 'grep', 'glob', 'verify_changes'])

/** Resumo legível do resultado de verify_changes para a synthetic user message. */
function formatVerifyResult(result: VerifyChangesResult): string {
  const base =
    result.changes.length === 0
      ? 'Nenhuma alteração foi gravada neste turno.'
      : `Arquivos alterados neste turno (${result.changes.length}):\n` +
        result.changes.map((c) => `- ${c.state}: ${c.path} (patchSize ${c.patchSize} chars)`).join('\n')
  return result.note ? `${base} Nota do engine: ${result.note}` : base
}

/**
 * Nudge de overclaim: o turno terminou afirmando trabalho feito, mas o
 * snapshot prova que NENHUM arquivo mudou. É o buraco que o nudge de
 * verificação acima não cobre — aquele exige que uma tool de escrita tenha
 * rodado, e o overclaim clássico é justamente o turno que não chamou write
 * nenhuma e mesmo assim relata conclusão.
 */
const MAX_OVERCLAIM_NUDGES = 1
const NO_CHANGES_PROMPT = `[SYSTEM: automatic verification — NO file was modified in this turn. The filesystem snapshot taken before your response is identical to the one taken now; this is measured by the engine, not inferred. If your reply claims you created, edited, fixed, removed or refactored anything, that claim is false. Either do the work now with the write/edit tools, or correct your reply and state plainly what was NOT done and why.]`

/** Veredito da comparação de snapshots do turno (ver verifyTurn em runChat). */
type TurnVerification =
  | { state: 'changed'; end: string; files: string[]; patch: string }
  | { state: 'unchanged' }
  | { state: 'unknown'; error?: string }
const abortControllers = new Map<string, AbortController>()
// Comando bash ativo por sessão (diagnóstico): preenchido no tool-call e
// limpo no tool-result/error — o abortChat loga o comando que estava rodando
// quando o usuário apertou parar, e o finally avisa se ele pode ter ficado vivo.
const activeBashCommands = new Map<string, string>()

/** true quando a última todowrite da mensagem tem itens "in_progress" —
 * o card de tarefas ficaria com spinner eterno se o turno acabar assim. */
function hasTodoInProgress(parts: MessagePart[]): boolean {
  const todo = [...parts]
    .reverse()
    .find((p): p is ToolPart => p.type === 'tool' && p.tool === 'todowrite' && p.state === 'done')
  const items = (todo?.input?.items ?? []) as { status?: string }[]
  return items.some((i) => i.status === 'in_progress')
}

function newId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

async function loadMessages(sessionId: string): Promise<ChatMessage[]> {
  return (await readJson<ChatMessage[]>(StorageKeys.messages(sessionId))) ?? []
}

async function saveMessages(sessionId: string, messages: ChatMessage[]) {
  await writeJson(StorageKeys.messages(sessionId), messages)
}

function partText(parts: MessagePart[], type: 'text'): string {
  return parts
    .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === type)
    .map((p) => p.text)
    .join('\n')
}

/** Decodifica o payload de um data URL como texto UTF-8. */
function decodeDataUrlText(url: string): string | null {
  const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(url)
  if (!match) return null
  try {
    return match[2] ? Buffer.from(match[3], 'base64').toString('utf8') : decodeURIComponent(match[3])
  } catch {
    return null
  }
}

/** Decodifica o payload de um data URL como bytes (para formatos binários: ZIP, planilhas). */
function decodeDataUrlBytes(url: string): Buffer | null {
  const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(url)
  if (!match) return null
  try {
    return match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]), 'utf8')
  } catch {
    return null
  }
}

const PDF_EXT = /\.pdf$/i
const TEXT_MIME = /^(text\/|application\/(json|xml|javascript|typescript|yaml|toml|x-sh|sql))/
// Fallback por extensão: navegadores às vezes reportam mime vazio ou
// "application/octet-stream" para .md/.skill/.csv no Windows.
const TEXT_EXT_FALLBACK = /\.(md|markdown|txt|log|csv|yaml|yml|toml|env|ini|conf|skill)$/i
const SPREADSHEET_MIME = /^application\/(vnd\.ms-excel|vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|vnd\.oasis\.opendocument\.spreadsheet)$/
const SPREADSHEET_EXT = /\.(xlsx?|ods)$/i
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const DOCX_EXT = /\.docx$/i
const SKILL_LIKE_EXT = /\.(skill|md|markdown)$/i

/** Converte um anexo (FilePart) em conteúdo de modelo: imagem/PDF nativos,
 * arquivos de texto viram texto inline; o resto vira só uma nota. Usado só
 * para HISTÓRICO já persistido — anexos novos são pré-processados em
 * `preprocessAttachment` antes de chegar aqui (ver runChat). */
function fileToModelContent(file: FilePart): Exclude<UserContent, string>[number] {
  if (file.mime.startsWith('image/')) {
    return { type: 'image', image: file.url, mediaType: file.mime }
  }
  if (file.mime === 'application/pdf' || PDF_EXT.test(file.filename ?? '')) {
    return { type: 'text', text: `[PDF anexado anteriormente: ${file.filename ?? 'documento'}]` }
  }
  if (TEXT_MIME.test(file.mime) || TEXT_EXT_FALLBACK.test(file.filename ?? '')) {
    const text = decodeDataUrlText(file.url)
    if (text != null) {
      return { type: 'text', text: `[Arquivo anexado: ${file.filename ?? 'sem nome'}]\n\n${text}` }
    }
  }
  return { type: 'text', text: `[Arquivo anexado não suportado: ${file.filename ?? file.mime}]` }
}

/** Chip de anexo sem o data URL (evita duplicar bytes grandes no histórico —
 * o conteúdo já vai como texto no TextPart que acompanha este chip). Mantém
 * `url` vazio de propósito: é o que `toModelMessages` usa para reconhecer e
 * pular este FilePart ao montar o conteúdo do modelo (o texto já cobre isso). */
function attachmentChip(file: FilePart): FilePart {
  return { id: file.id, type: 'file', mime: file.mime, filename: file.filename, url: '' }
}

/** Pré-processa um anexo NOVO antes de persistir: PDF, planilha e skill viram
 * texto extraído (evita data URLs enormes no histórico) + um chip sem dados
 * pra UI continuar mostrando o anexo; imagem continua nativa (o modelo lê
 * melhor via image part). Espelha o mesmo padrão para cada tipo — extrai,
 * embrulha em TextPart, nunca falha o envio da mensagem. */
async function preprocessAttachment(file: FilePart): Promise<MessagePart[]> {
  const filename = file.filename ?? ''

  if (file.mime === 'application/pdf' || PDF_EXT.test(filename)) {
    let text: string
    try {
      text = await extractPdfText(file.url)
    } catch (err) {
      text = `(erro ao extrair texto: ${errorToText(err)})`
    }
    return [
      attachmentChip(file),
      { id: newId('prt'), type: 'text', text: `[PDF anexado: ${filename || 'documento'}]\n\n${text}`, state: 'done', source: 'attachment' },
    ]
  }

  if (SPREADSHEET_MIME.test(file.mime) || SPREADSHEET_EXT.test(filename)) {
    let text: string
    try {
      text = await extractSpreadsheetText(file.url)
    } catch (err) {
      text = `(erro ao ler planilha: ${errorToText(err)})`
    }
    return [
      attachmentChip(file),
      { id: newId('prt'), type: 'text', text: `[Planilha anexada: ${filename || 'arquivo'}]\n\n${text}`, state: 'done', source: 'attachment' },
    ]
  }

  if (file.mime === DOCX_MIME || DOCX_EXT.test(filename)) {
    let text: string
    try {
      text = await extractDocxText(file.url)
    } catch (err) {
      text = `(erro ao ler documento: ${errorToText(err)})`
    }
    return [
      attachmentChip(file),
      { id: newId('prt'), type: 'text', text: `[Documento anexado: ${filename || 'arquivo'}]\n\n${text}`, state: 'done', source: 'attachment' },
    ]
  }

  // Skill anexada (.skill texto/ZIP, ou .md com frontmatter de skill) — o
  // agente lê o conteúdo e PODE propor com a tool create_skill se fizer
  // sentido; se não for uma skill válida, cai no tratamento de texto comum.
  if (SKILL_LIKE_EXT.test(filename)) {
    const bytes = decodeDataUrlBytes(file.url)
    const description = bytes ? describeSkillAttachment(bytes, filename) : null
    if (description) {
      return [
        attachmentChip(file),
        {
          id: newId('prt'),
          type: 'text',
          text:
            `[Skill anexada: ${filename}]\n\n${description}\n\n` +
            '(Se o usuário pedir para adicionar isso como skill, ou fizer sentido pelo contexto, use a tool create_skill com este conteúdo — não presuma sem que o pedido/contexto justifique.)',
          state: 'done',
          source: 'attachment',
        },
      ]
    }
  }

  if (TEXT_MIME.test(file.mime) || TEXT_EXT_FALLBACK.test(filename)) {
    const text = decodeDataUrlText(file.url)
    if (text != null) {
      return [
        attachmentChip(file),
        { id: newId('prt'), type: 'text', text: `[Arquivo anexado: ${filename || 'sem nome'}]\n\n${text}`, state: 'done', source: 'attachment' },
      ]
    }
  }

  return [file]
}

/**
 * Converte o histórico persistido em mensagens para o modelo (texto +
 * anexos do usuário). Havendo compactação, corta no último resumo: envia
 * resumo + mensagens posteriores; o histórico completo continua no storage.
 */
export function toModelMessages(history: ChatMessage[]): ModelMessage[] {
  const lastSummary = findLastSummaryIndex(history)
  const window = lastSummary >= 0 ? history.slice(lastSummary) : history
  const result: ModelMessage[] = []
  for (const message of window) {
    // messageContextText preserva o estado da TODO (todowrite) e o aviso de
    // truncamento como texto — ToolParts em si nunca são reenviados ao
    // modelo fora do streaming da própria chamada que os gerou.
    const text = messageContextText(message, partText(message.parts, 'text'))
    // Chips sem dados (url === '') são só decoração da UI — o conteúdo real
    // já está no TextPart irmão extraído em preprocessAttachment; incluí-los
    // aqui duplicaria uma nota vazia no lugar do texto já extraído.
    const files = message.parts.filter((p): p is FilePart => p.type === 'file' && p.url !== '')
    if (message.role === 'user' && files.length > 0) {
      const content: UserContent = files.map(fileToModelContent)
      if (text.trim()) content.push({ type: 'text', text })
      result.push({ role: 'user', content })
      continue
    }
    if (message.role === 'assistant') {
      // Reenvia o raciocínio do assistente ao modelo: provedores com
      // reasoning_content (ex: DeepSeek) exigem o texto de volta nos turnos
      // seguintes. O campo é injetado via providerOptions por
      // normalizeMessages (interleaved) — aqui só preservamos os parts.
      const reasoning = message.parts
        .filter((p): p is ReasoningPart => p.type === 'reasoning')
        .map((p) => p.text)
        .join('\n')
      const content: Extract<ModelMessage, { role: 'assistant' }>['content'] = []
      if (reasoning.trim()) content.push({ type: 'reasoning', text: reasoning })
      if (text.trim()) content.push({ type: 'text', text })
      if (content.length === 0) continue
      result.push({ role: 'assistant', content })
      continue
    }
    if (!text.trim()) continue
    result.push({ role: message.role, content: text })
  }
  return result
}

const MAX_TITLE_LENGTH = 50

function truncateTitle(text: string): string {
  const cleaned = text
    .trim()
    .replace(/\*\*/g, '') // negrito/marcação forte
    .replace(/[*_`#>~]/g, '') // outra marcação markdown
    .replace(/^["']|["']$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.length <= MAX_TITLE_LENGTH) return cleaned
  // corta no limite de caracteres SEM quebrar palavra no meio, quando possível
  const hard = cleaned.slice(0, MAX_TITLE_LENGTH)
  const lastSpace = hard.lastIndexOf(' ')
  const cut = lastSpace > MAX_TITLE_LENGTH * 0.5 ? lastSpace : hard.length
  return hard.slice(0, cut).trim()
}

async function generateTitle(input: SendMessageInput, win: BrowserWindow) {
  try {
    const model = await resolveModel(input.providerId, input.modelId)
    const { text } = await generateText({
      model,
      system:
        'Gere um título curto e descritivo para a conversa, em texto puro, no idioma da mensagem do usuário. ' +
        'Regras: sem negrito, sem asteriscos, sem aspas, sem emojis e sem formatação de qualquer tipo; no máximo 50 caracteres. ' +
        'Responda APENAS com o título final, nada mais.',
      prompt: input.text.slice(0, 2000),
    })
    const title = truncateTitle(text)
    if (!title) return

    await bumpSessionActivity(win, input.sessionId)
    emit(win, { type: 'title', sessionId: input.sessionId, title })
  } catch {
    // título é cosmético; falha silenciosa
  }
}

function emit(win: BrowserWindow, event: ChatEvent) {
  if (!win.isDestroyed()) win.webContents.send('chat:event', event)
  forwardChatEvent(event)
}

export function abortChat(sessionId: string) {
  const cmd = activeBashCommands.get(sessionId)
  console.log(
    `[chat] abort da sessão ${sessionId}${cmd ? ` — comando bash ativo: ${cmd}` : ''}`,
  )
  abortControllers.get(sessionId)?.abort()
}

/** Sessões com um runChat em andamento — o main re-emite o status após um
 *  reload do renderer, para a UI voltar a mostrar spinner/botão de parar. */
export function getRunningSessionIds(): string[] {
  return [...abortControllers.keys()]
}

/** Enviar mensagem = atividade: atualiza o updatedAt da sessão e propaga o
 *  evento "session" para todas as janelas e o mobile. Sem esse evento o store
 *  do renderer nunca vê o novo updatedAt e a sidebar não reordena — o chat
 *  não sobe para o topo dos recentes (nem a pasta que o contém). */
async function bumpSessionActivity(win: BrowserWindow, sessionId: string): Promise<void> {
  const session = await readJson<SessionInfo>(StorageKeys.session(sessionId))
  if (!session) return
  const updated = { ...session, updatedAt: Date.now() }
  await writeJson(StorageKeys.session(sessionId), updated)
  emit(win, { type: 'session', sessionId, session: updated })
}

export async function runChat(win: BrowserWindow, input: SendMessageInput): Promise<void> {
  const { sessionId } = input
  abortControllers.get(sessionId)?.abort()
  const controller = new AbortController()
  abortControllers.set(sessionId, controller)

  emit(win, { type: 'status', sessionId, status: 'submitted' })
  await bumpSessionActivity(win, sessionId)

  // Revert ativo: nova mensagem consolida o revert — descarta as mensagens
  // posteriores ao ponto revertido antes de carregar o histórico
  try {
    await cleanupRevert(sessionId)
  } catch (err) {
    console.error('[revert] cleanup falhou:', err)
  }

  const history = await loadMessages(sessionId)
  const isFirstExchange = history.length === 0

  // Comando /compact — compacta o histórico e não gera resposta do modelo
  if (input.text.trim() === '/compact') {
    try {
      const model = await resolveModel(input.providerId, input.modelId)
      const summary = await compactHistory(history, model)
      if (summary) {
        const lastSummary = findLastSummaryIndex(history)
        for (let i = lastSummary + 1; i < history.length; i++) {
          history[i].tokens = undefined
        }
        await saveMessages(sessionId, history)
        emit(win, { type: 'messages', sessionId, messages: history })
      }
    } catch (err) {
      console.error('[compaction] /compact falhou:', err)
    }
    return
  }

  // Extrai texto de anexos (PDF, planilha, skill) antes de persistir — evita
  // data URLs enormes no histórico e dá ao agente acesso ao conteúdo real,
  // independente da pasta de trabalho selecionada (as tools read/glob/bash só
  // enxergam o filesystem, nunca os anexos do chat — por isso o conteúdo
  // precisa entrar como texto na própria mensagem).
  const processedParts: MessagePart[] = []
  for (const file of input.files ?? []) {
    processedParts.push(...(await preprocessAttachment(file)))
  }

  const userMessage: ChatMessage = {
    id: newId('msg'),
    role: 'user',
    parts: [
      ...processedParts,
      { id: newId('prt'), type: 'text', text: input.text, state: 'done' },
    ],
    createdAt: Date.now(),
    // Metadados do turno persistidos na mensagem do usuário — a tool
    // session_context os lê para responder "o que foi alterado no turno X?"
    mode: input.mode,
    permissionMode: input.options.permissionMode ?? 'ask',
  }
  history.push(userMessage)
  emit(win, { type: 'message', sessionId, message: userMessage })

  const assistantMessage: ChatMessage = {
    id: newId('msg'),
    role: 'assistant',
    parts: [],
    createdAt: Date.now(),
    providerId: input.providerId,
    modelId: input.modelId,
    simple: input.options.simple || undefined,
  }
  history.push(assistantMessage)
  await saveMessages(sessionId, history)
  emit(win, { type: 'message', sessionId, message: assistantMessage })

  const upsertPart = (part: MessagePart) => {
    const idx = assistantMessage.parts.findIndex((p) => p.id === part.id)
    if (idx >= 0) assistantMessage.parts[idx] = part
    else assistantMessage.parts.push(part)
    emit(win, { type: 'part', sessionId, messageId: assistantMessage.id, part })
  }

  try {
    const model = await resolveModel(input.providerId, input.modelId)
    const provider = await getProvider(input.providerId)
    const supportsTools = provider?.models[input.modelId]?.tool_call !== false

    // Compactação automática: os tokens reais da última resposta indicam que o
    // contexto está perto do limite → resume o trecho antigo uma única vez
    const lastTokens = [...history].reverse().find((m) => m.role === 'assistant' && m.tokens)?.tokens
    if (shouldCompact(lastTokens, provider?.models[input.modelId])) {
      try {
        const summary = await compactHistory(history, model)
        if (summary) {
          // Zera .tokens das mensagens após o sumário — os tokens antigos
          // refletiam o contexto cheio (pré-compactação) e inflariam o meter
          const lastSummary = findLastSummaryIndex(history)
          for (let i = lastSummary + 1; i < history.length; i++) {
            history[i].tokens = undefined
          }
          await saveMessages(sessionId, history)
          emit(win, { type: 'messages', sessionId, messages: history })
        }
      } catch (err) {
        // compactação é otimização — nunca derruba o turno
        console.error('[compaction] falhou:', err)
      }
    }

    // Snapshot do turno em andamento: preenchido pela captura inicial abaixo e
    // exposto às tools via getTurnSnapshot — leitura por closure porque a
    // captura acontece DEPOIS da criação do context (verify_changes difere o
    // estado atual contra este start).
    let turnSnapshot: TurnSnapshot | undefined
    const toolContext: ToolContext | null =
      input.mode === 'code' && input.directory
        ? {
            sessionId,
            directory: input.directory,
            extraDirectories: input.extraDirectories ?? [],
            abort: controller.signal,
            getTurnSnapshot: () => turnSnapshot,
            // Visão do modelo: decide se o panel_screenshot oferece `ver`
            modelVision: modelSupportsVision(provider, input.modelId),
          }
        : null

    // Snapshot start: estado do filesystem antes do stream (revert per-message)
    if (toolContext) {
      try {
        turnSnapshot = { start: await capture(toolContext.directory) }
        assistantMessage.snapshot = { start: turnSnapshot.start }
      } catch (err) {
        // Não esconder a falha: grava snapshot marcado como failed (sem start,
        // motivo em captureError) — o revert de filesystem fica indisponível e
        // a UI/ferramentas precisam saber por quê, em vez de um turno que
        // parece ter snapshot normalmente.
        const reason = errorToText(err)
        turnSnapshot = { failed: true, error: reason }
        assistantMessage.snapshot = { failed: true, captureError: reason }
        console.error('[snapshot] captura inicial falhou:', reason, {
          directory: toolContext.directory,
        })
      }
    }

    // initMode: pipeline de análise de projeto renderizado como acordeons —
    // o agente principal (narração da revisão) em cima e um acordeon por
    // subagent streamando a exploração; no fim todos fecham e fica o resumo
    if (input.options.initMode && toolContext) {
      emit(win, { type: 'status', sessionId, status: 'streaming' })

      const startedAt = new Map<string, number>()
      const agentParts = new Map<string, AgentPart>()

      const mainPart: AgentPart = {
        id: newId('prt'),
        type: 'agent',
        role: 'main',
        label: 'Agente principal',
        text: '',
        state: 'running',
      }
      const mainStart = Date.now()
      upsertPart(mainPart)

      const appendAgent = (part: AgentPart, delta: string) => {
        part.text += delta
        emit(win, {
          type: 'part-delta',
          sessionId,
          messageId: assistantMessage.id,
          partId: part.id,
          kind: 'agent',
          delta,
        })
      }

      const hooks: InitHooks = {
        onMainDelta: (delta) => appendAgent(mainPart, delta),
        onAgentStart: (area, label) => {
          const part: AgentPart = {
            id: newId('prt'),
            type: 'agent',
            role: 'worker',
            label,
            text: '',
            state: 'running',
          }
          agentParts.set(area, part)
          startedAt.set(area, Date.now())
          upsertPart(part)
        },
        onAgentDelta: (area, delta) => {
          const part = agentParts.get(area)
          if (part) appendAgent(part, delta)
        },
        onAgentDone: (area, ok) => {
          const part = agentParts.get(area)
          if (!part) return
          part.state = ok ? 'done' : 'error'
          part.durationMs = Date.now() - (startedAt.get(area) ?? Date.now())
          upsertPart(part)
          // Persistência incremental: cada área concluída não se perde num crash
          void saveMessages(sessionId, history)
        },
      }

      try {
        const areas = await runProjectInit({
          directory: toolContext.directory,
          providerId: input.providerId,
          modelId: input.modelId,
          workerProviderId: input.workerModel?.providerId,
          workerModelId: input.workerModel?.modelId,
          force: input.text.includes('--force'),
          hooks,
          language: input.language,
        })
        mainPart.state = 'done'
        mainPart.durationMs = Date.now() - mainStart
        upsertPart(mainPart)

        const areaNames = areas.map((a) => PROJECT_AREAS[a as ProjectArea]?.label ?? a)
        const summary =
          areaNames.length > 0
            ? `## Projeto analisado\n\nCriei ${areaNames.length} memórias por área — **${areaNames.join(', ')}** — ligadas ao node central no grafo (aba Memórias). Elas entram no meu contexto conforme a tarefa: mudanças de UI puxam Design System, deploy puxa Infraestrutura, e assim por diante.`
            : '## Análise concluída\n\nNenhuma memória foi gerada — o projeto pode estar vazio ou inacessível.'
        upsertPart({ id: newId('prt'), type: 'text', text: summary, state: 'done' })
      } catch (err) {
        mainPart.state = 'error'
        mainPart.durationMs = Date.now() - mainStart
        upsertPart(mainPart)
        for (const part of agentParts.values()) {
          if (part.state === 'running') {
            part.state = 'error'
            upsertPart(part)
          }
        }
        upsertPart({
          id: newId('prt'),
          type: 'text',
          text: `## Análise falhou\n\n${errorToText(err)}`,
          state: 'done',
        })
      }
      await saveMessages(sessionId, history)
      emit(win, { type: 'message', sessionId, message: assistantMessage })
      emit(win, { type: 'status', sessionId, status: 'idle' })
      return
    }

    /**
     * Verificação de fim de turno: compara o filesystem contra o snapshot
     * inicial. O resultado é DISCRIMINADO de propósito — antes, "nada mudou" e
     * "a captura falhou" retornavam ambos undefined, e um erro de git ficava
     * indistinguível de um turno que não escreveu nada. Como isso agora
     * alimenta o registro enviado ao modelo, confundir os dois faria o engine
     * afirmar "nenhum arquivo alterado" sem ter verificado.
     */
    const verifyTurn = async (): Promise<TurnVerification> => {
      const start = assistantMessage.snapshot?.start
      if (!toolContext || !start) return { state: 'unknown' }
      try {
        const end = await capture(toolContext.directory)
        if (end === start) return { state: 'unchanged' }
        const changes = await diff(toolContext.directory, start, end)
        return { state: 'changed', end, files: changes.files, patch: changes.patch }
      } catch (err) {
        console.error('[snapshot] captura final falhou:', err)
        return { state: 'unknown', error: errorToText(err) }
      }
    }
    /** Veredito da última iteração do loop — reaproveitado após o break para
     *  não capturar o snapshot duas vezes. */
    let verification: TurnVerification | null = null

    const mode: PermissionMode = input.options.permissionMode ?? 'ask'
    const toolApproval = supportsTools
      ? createToolApproval(
          mode,
          input.sessionId,
          toolContext?.directory ?? null,
          assistantMessage.id,
          controller.signal,
          input.parentSessionId,
          input.workerTitle,
        )
      : undefined

    // Só injeta conteúdo de memória na primeira troca da sessão
    input.isFirstExchange = isFirstExchange

    // Mensagens para a PRIMEIRA chamada da rodada (histórico até a última
    // mensagem do usuário). As continuações usam as mensagens de resposta
    // acumuladas do turno anterior + a instrução de continuar (padrão do
    // opencode: injetar uma "synthetic user message" e re-entrar no loop,
    // com teto de tentativas por turno).
    const initialMessages = normalizeMessages(
      toModelMessages(history.slice(0, -1)),
      interleavedReasoningField(provider, input.modelId),
    )
    let autoContinues = 0
    let todoNudges = 0
    let verifyNudges = 0
    // Resultado da verificação forçada do turno (formatado) — quando presente,
    // a próxima iteração do loop recebe o RESULTADO REAL (em vez de um pedido
    // para chamar a tool) e a resposta final fica ancorada no que foi gravado.
    let verifyResultText: string | null = null
    let overclaimNudges = 0
    let lastFinishReason: string | undefined
    let previousResponseMessages: ModelMessage[] = []
    let truncatedToolNames = ''

    for (;;) {
      const result = streamText({
        model,
        system: await buildSystemPrompt(input),
        messages:
          autoContinues === 0 && todoNudges === 0 && verifyNudges === 0 && overclaimNudges === 0
            ? initialMessages
            : normalizeMessages(
                [
                  ...initialMessages,
                  ...previousResponseMessages,
                  {
                    role: 'user' as const,
                    content: verifyResultText
                      ? VERIFY_RESULT_PROMPT(verifyResultText)
                      : overclaimNudges > 0
                        ? NO_CHANGES_PROMPT
                        : todoNudges > 0
                        ? TODO_COMPLETION_PROMPT
                        : truncatedToolNames
                          ? AUTO_CONTINUE_TOOL_PROMPT(truncatedToolNames)
                          : AUTO_CONTINUE_PROMPT,
                  },
                ],
                interleavedReasoningField(provider, input.modelId),
              ),
        tools: supportsTools ? buildToolSet(input, toolContext) : undefined,
        toolApproval,
        stopWhen: stepCountIs(MAX_STEPS),
        abortSignal: controller.signal,
        providerOptions: await buildProviderOptions(input),
        prepareStep: ({ stepNumber, messages }) => {
          // Reaplica a normalização de reasoning a cada passo do tool loop: o
          // SDK reconstrói as mensagens entre steps e pode descartar o
          // reasoning_content vazio retornado numa chamada de tool (DeepSeek
          // exige o campo de volta em todas as mensagens de assistente).
          const normalized = normalizeMessages(
            messages,
            interleavedReasoningField(provider, input.modelId),
          )
          if (stepNumber < MAX_STEPS) return normalized === messages ? {} : { messages: normalized }
          return {
            activeTools: [],
            toolChoice: 'none' as const,
            messages: [...normalized, { role: 'user' as const, content: MAX_STEPS_PROMPT }],
          }
        },
        onError: () => {
          // erros são tratados no loop do fullStream
        },
      })

      let streaming = false
      let sawFinish = false
      let lastSave = Date.now()
      const reasoningStart = new Map<string, number>()
      // Usage do último step (última chamada real ao modelo) — ao contrário do
      // total do turno (soma de todos os steps), reflete o tamanho real do
      // contexto no momento em que a resposta terminou.
      let lastStepUsage: ReturnType<typeof toStepUsage> | undefined
      let stepCount = 0

      for await (const part of result.fullStream) {
        if (!streaming) {
          streaming = true
          emit(win, { type: 'status', sessionId, status: 'streaming' })
        }

        switch (part.type) {
          case 'finish-step':
            lastStepUsage = toStepUsage(part.usage)
            stepCount++
            break
          case 'text-start':
            upsertPart({ id: part.id, type: 'text', text: '', state: 'streaming' })
            break
          case 'text-delta': {
            const existing = assistantMessage.parts.find((p) => p.id === part.id)
            if (existing?.type === 'text') {
              existing.text += part.text
              emit(win, {
                type: 'part-delta',
                sessionId,
                messageId: assistantMessage.id,
                partId: part.id,
                kind: 'text',
                delta: part.text,
              })
            }
            break
          }
          case 'text-end': {
            const existing = assistantMessage.parts.find((p) => p.id === part.id)
            if (existing?.type === 'text') upsertPart({ ...existing, state: 'done' })
            break
          }
          case 'reasoning-start':
            reasoningStart.set(part.id, Date.now())
            upsertPart({ id: part.id, type: 'reasoning', text: '', state: 'streaming' })
            break
          case 'reasoning-delta': {
            const existing = assistantMessage.parts.find((p) => p.id === part.id)
            if (existing?.type === 'reasoning') {
              existing.text += part.text
              emit(win, {
                type: 'part-delta',
                sessionId,
                messageId: assistantMessage.id,
                partId: part.id,
                kind: 'reasoning',
                delta: part.text,
              })
            }
            break
          }
          case 'reasoning-end': {
            const existing = assistantMessage.parts.find((p) => p.id === part.id)
            if (existing?.type === 'reasoning') {
              const started = reasoningStart.get(part.id)
              upsertPart({
                ...existing,
                state: 'done',
                durationMs: started ? Date.now() - started : undefined,
              })
            }
            break
          }
          case 'tool-call':
            upsertPart({
              id: part.toolCallId,
              type: 'tool',
              tool: part.toolName,
              state: 'running',
              input: part.input as Record<string, unknown>,
            })
            if (part.toolName === 'bash') {
              const input = part.input as Record<string, unknown> | undefined
              activeBashCommands.set(sessionId, typeof input?.command === 'string' ? input.command : '')
            }
            break
          case 'tool-result': {
            const existing = assistantMessage.parts.find((p) => p.id === part.toolCallId) as
              | ToolPart
              | undefined
            upsertPart({
              id: part.toolCallId,
              type: 'tool',
              tool: part.toolName,
              state: 'done',
              input: existing?.input,
              output: typeof part.output === 'string' ? part.output : JSON.stringify(part.output, null, 2),
            })
            if (part.toolName === 'bash') activeBashCommands.delete(sessionId)
            // show_image: a imagem vira parte da resposta (renderizada pelo ai/image)
            if (part.toolName === 'show_image') {
              const output = part.output as { mediaUrl?: string; alt?: string } | string
              if (typeof output === 'object' && output?.mediaUrl) {
                upsertPart({
                  id: `${part.toolCallId}-img`,
                  type: 'image',
                  src: output.mediaUrl,
                  alt: output.alt || undefined,
                })
                // Completa o registro de mídia: a tool não conhece o id da
                // mensagem (roda no meio do turno) — a galeria usa esse
                // vínculo para o "abrir no chat".
                void attachMediaMessage(output.mediaUrl, assistantMessage.id, sessionId)
              }
            }
            break
          }
          case 'tool-output-denied': {
            // Execução negada pelo gate de permissões (política ou usuário)
            const existing = assistantMessage.parts.find((p) => p.id === part.toolCallId) as
              | ToolPart
              | undefined
            upsertPart({
              id: part.toolCallId,
              type: 'tool',
              tool: part.toolName,
              state: 'error',
              input: existing?.input,
              error: takeDenialReason(part.toolCallId) ?? 'Ação negada pela política de permissões.',
            })
            if (part.toolName === 'bash') activeBashCommands.delete(sessionId)
            break
          }
          case 'tool-error': {
            const existing = assistantMessage.parts.find((p) => p.id === part.toolCallId) as
              | ToolPart
              | undefined
            upsertPart({
              id: part.toolCallId,
              type: 'tool',
              tool: part.toolName,
              state: 'error',
              input: existing?.input,
              error: errorToText(part.error),
            })
            if (part.toolName === 'bash') activeBashCommands.delete(sessionId)
            break
          }
          case 'finish':
            // Usage agregado da geração (todos os steps) + custo via catálogo;
            // lastStep guarda o tamanho real do contexto na última chamada.
            // Em auto-continue, soma a cada iteração do loop (a mensagem é a
            // mesma, mas cada chamada ao modelo tem seu próprio uso).
            {
              const stepTokens = toTokenUsage(part.totalUsage, provider?.models[input.modelId]?.cost)
              assistantMessage.tokens = {
                ...addTokenUsage(assistantMessage.tokens, stepTokens),
                lastStep: lastStepUsage,
              }
            }
            lastFinishReason = part.finishReason
            sawFinish = true
            // Backstop raro: o prepareStep acima já força um resumo em texto
            // no último passo (finishReason deveria vir 'stop'). Isso só
            // dispara se mesmo assim o modelo não fechar limpo — sem isso,
            // esse caso ficaria indistinguível de uma conclusão normal tanto
            // pra UI quanto pro modelo no próximo turno.
            if (stepCount >= MAX_STEPS && part.finishReason !== 'stop') {
              assistantMessage.truncated = true
            }
            break
          case 'error':
            throw part.error instanceof Error ? part.error : new Error(errorToText(part.error))
          default:
            break
        }

        // Persistência incremental: garante que um crash não perca a resposta
        if (assistantMessage.parts.length > 0 && Date.now() - lastSave > 2000) {
          lastSave = Date.now()
          await saveMessages(sessionId, history)
        }
      }

      // Alguns provedores/gateways encerram o stream sem emitir `finish` (ou
      // retornam um motivo não padronizado) quando a conexão é interrompida.
      // Sem este diagnóstico o turno parecia concluído normalmente e o agente
      // parava no meio. Não tentamos repetir automaticamente — isso poderia
      // duplicar tool calls — mas persistimos o estado como truncado e deixamos
      // o próximo turno receber o lembrete de continuação.
      if (!sawFinish && !controller.signal.aborted) {
        assistantMessage.truncated = true
        console.warn(`[chat] stream terminou sem finish para sessão ${sessionId}`)
      }

      // Auto-continue por limite de TOKENS DE SAÍDA (finish_reason 'length'):
      // a resposta foi cortada no meio, não finalizada — igual ao opencode
      // (#17471/#18108), re-entramos no loop com uma "synthetic user message"
      // pedindo pra continuar do ponto exato do corte, com teto por turno.
      // Se a última tool call ficou pela metade (part sem resultado), a tool
      // é marcada como não executada e o modelo é instruído a dividir a
      // operação em pedaços menores.
      const pendingToolCalls = assistantMessage.parts.filter(
        (p): p is ToolPart => p.type === 'tool' && p.state === 'running',
      )

      if (
        lastFinishReason === 'length' &&
        !controller.signal.aborted &&
        autoContinues < MAX_AUTO_CONTINUES
      ) {
        autoContinues++
        for (const pending of pendingToolCalls) {
          upsertPart({
            ...pending,
            state: 'error',
            error: 'Chamada de ferramenta cortada pelo limite de tokens de saída — não executada.',
          })
        }
        truncatedToolNames = pendingToolCalls.map((p) => p.tool).join(', ')
        previousResponseMessages = await result.responseMessages
        continue
      }

      if (lastFinishReason === 'length') {
        // Esgotou o teto de continuações: sinaliza truncamento (a UI mostra o
        // aviso e o próximo turno recebe o nudge de continuar via
        // messageContextText) — nunca um fim silencioso.
        assistantMessage.truncated = true
      }

      // Nudge de fechamento da TODO: o turno terminou naturalmente ('stop')
      // mas a última todowrite ainda tem itens "in_progress" — o modelo
      // respondeu sem marcar as tarefas como concluídas, e o card fica com
      // spinner eterno. Re-entra no loop com a synthetic user message
      // (padrão do auto-continue) pedindo o fechamento, limitado por turno.
      if (
        lastFinishReason !== 'length' &&
        !controller.signal.aborted &&
        todoNudges < MAX_TODO_NUDGES &&
        hasTodoInProgress(assistantMessage.parts)
      ) {
        todoNudges++
        previousResponseMessages = await result.responseMessages
        continue
      }

      // Verificação pós-escrita FORÇADA (anti-overclaim): o turno terminou
      // naturalmente ('stop') mas (a) houve escrita — edit/write/bash
      // executadas OU que falharam — sem leitura/verificação
      // (read/grep/glob/verify_changes) depois da última, ou (b) nenhuma
      // tool foi chamada no turno inteiro: o modelo pode estar afirmando
      // trabalho que não aconteceu. O nudge por prompt não é confiável, então
      // o ENGINE executa verify_changes aqui mesmo, injeta o tool part na
      // mensagem (a UI mostra o card) e re-entra no loop com o resultado real
      // na synthetic user message — a resposta final fica ancorada no estado
      // de fato gravado. No máximo 1x por turno.
      const doneToolIdxs = assistantMessage.parts
        .map((p, i) => ({ p, i }))
        .filter((x): x is { p: ToolPart; i: number } => x.p.type === 'tool' && x.p.state === 'done')
      // Tentativas de escrita que falharam (erro/negada) também contam como
      // escrita: o modelo pode afirmar sucesso mesmo assim — a verificação
      // mostra a realidade, o diff não muda com a intenção.
      const writeToolIdxs = assistantMessage.parts
        .map((p, i) => ({ p, i }))
        .filter(
          (x): x is { p: ToolPart; i: number } =>
            x.p.type === 'tool' && (x.p.state === 'done' || x.p.state === 'error') && WRITE_TOOLS.has(x.p.tool),
        )
        .map((x) => x.i)
      const lastWriteIdx = writeToolIdxs.length > 0 ? Math.max(...writeToolIdxs) : -1
      const verifiedAfterLastWrite = doneToolIdxs.some(
        (x) => x.i > lastWriteIdx && VERIFY_TOOLS.has(x.p.tool),
      )
      const anyToolRan = assistantMessage.parts.some((p) => p.type === 'tool')
      const lastPart = assistantMessage.parts[assistantMessage.parts.length - 1]
      const lastPartIsDoneText = lastPart?.type === 'text' && lastPart.state === 'done'
      if (
        lastFinishReason === 'stop' &&
        !controller.signal.aborted &&
        verifyNudges < MAX_VERIFY_NUDGES &&
        lastPartIsDoneText &&
        toolContext !== null &&
        !input.options.plan &&
        (lastWriteIdx >= 0 ? !verifiedAfterLastWrite : !anyToolRan)
      ) {
        verifyNudges++
        // 1) Verificação determinística — não depende de o modelo chamar a tool
        const verifyResult = await verifyTurnChanges(toolContext)
        // 2) Injeta o tool part na mensagem: a UI mostra o card com o resultado
        upsertPart({
          id: newId('call'),
          type: 'tool',
          tool: 'verify_changes',
          state: 'done',
          input: {},
          output: JSON.stringify(verifyResult, null, 2),
        })
        // 3) Re-entra no loop com o RESULTADO real (não um pedido para verificar)
        verifyResultText = formatVerifyResult(verifyResult)
        previousResponseMessages = await result.responseMessages
        continue
      }

      // Nudge de overclaim: a resposta afirma ter feito algo e o snapshot
      // prova que nada foi escrito. Diferente do nudge acima, este NÃO exige
      // que uma tool de escrita tenha rodado — cobre exatamente o caso em que
      // o agente relata conclusão sem ter tocado em nenhum arquivo.
      //
      // O veredito é calculado aqui (e não depois do loop) para poder cobrar a
      // correção ainda dentro do turno; fica guardado em `verification` e é
      // reaproveitado no fim, sem capturar o snapshot duas vezes.
      // Em modo plano a escrita está desligada e o entregável (PLAN.md) é
      // gravado fora do turno — "escrevi o plano" ali não é overclaim.
      if (lastFinishReason === 'stop' && !controller.signal.aborted && toolContext) {
        verification = await verifyTurn()
        if (
          verification.state === 'unchanged' &&
          !input.options.plan &&
          overclaimNudges < MAX_OVERCLAIM_NUDGES &&
          lastPartIsDoneText &&
          claimsCompletion(partText(assistantMessage.parts, 'text'))
        ) {
          console.warn('[overclaim] turno alegou conclusão sem alterar arquivos', { sessionId })
          overclaimNudges++
          verification = null // o turno continua: o veredito atual não é o final
          previousResponseMessages = await result.responseMessages
          continue
        }
      }
      break
    }

    // Finaliza partes que ficaram em streaming (ex.: abort)
    for (const part of assistantMessage.parts) {
      if ((part.type === 'text' || part.type === 'reasoning') && part.state === 'streaming') {
        part.state = 'done'
      }
    }
    assistantMessage.completedAt = Date.now()
    // TODO não fechada ao final do turno → lembrete persistente para o
    // próximo turno (messageContextText reemite o aviso via todoReminder).
    if (hasTodoInProgress(assistantMessage.parts)) assistantMessage.todoReminder = true
    // Persiste a mensagem primeiro para que o usuário a veja o quanto antes
    await saveMessages(sessionId, history)
    // Veredito do turno: reaproveita o que o loop já calculou (só recaptura se
    // o turno saiu por outro caminho — abort, teto de passos).
    const endSnapshot = verification ?? (await verifyTurn())
    if (assistantMessage.snapshot) {
      assistantMessage.snapshot.verified = endSnapshot.state
      if (endSnapshot.state === 'changed') {
        assistantMessage.snapshot.end = endSnapshot.end
        assistantMessage.snapshot.files = endSnapshot.files
        assistantMessage.snapshot.patch = endSnapshot.patch
      }
      await saveMessages(sessionId, history)
    }

    await bumpSessionActivity(win, sessionId)

    emit(win, { type: 'message', sessionId, message: assistantMessage })
    emit(win, { type: 'status', sessionId, status: 'idle' })

    // Workers já nascem com título (task.title) — não sobrescrever
    if (isFirstExchange && input.orchestrationRole !== 'worker') void generateTitle(input, win)
  } catch (err) {
    const aborted = controller.signal.aborted
    const { kind, detail: message } = classifyProviderError(err)
    assistantMessage.error = aborted ? undefined : message
    assistantMessage.errorKind = aborted || kind === 'unknown' ? undefined : kind
    for (const part of assistantMessage.parts) {
      if ((part.type === 'text' || part.type === 'reasoning') && part.state === 'streaming') {
        part.state = 'done'
      }
    }
    assistantMessage.completedAt = Date.now()
    await saveMessages(sessionId, history)
    emit(win, { type: 'message', sessionId, message: assistantMessage })
    emit(win, {
      type: 'status',
      sessionId,
      status: aborted ? 'idle' : 'error',
      error: aborted ? undefined : message,
    })
  } finally {
    if (abortControllers.get(sessionId) === controller) abortControllers.delete(sessionId)
    const activeCmd = activeBashCommands.get(sessionId)
    activeBashCommands.delete(sessionId)
    if (controller.signal.aborted && activeCmd) {
      console.warn(
        `[chat] turno da sessão ${sessionId} abortado com comando bash ativo — ` +
          'se ele não encerrou, continua rodando (veja o painel de processos): ' +
          `${activeCmd}`,
      )
    }
  }
}

/** Compactação manual acionada pelo botão na UI ou pelo comando /compact. */
export async function compactSession(
  win: BrowserWindow,
  sessionId: string,
): Promise<void> {
  const history = await loadMessages(sessionId)
  const lastAssistant = [...history].reverse().find((m) => m.role === 'assistant' && m.providerId)
  const providerId = lastAssistant?.providerId
  const modelId = lastAssistant?.modelId
  if (!providerId || !modelId) return

  try {
    const model = await resolveModel(providerId, modelId)
    const summary = await compactHistory(history, model)
    if (summary) {
      const lastSummary = findLastSummaryIndex(history)
      for (let i = lastSummary + 1; i < history.length; i++) {
        history[i].tokens = undefined
      }
      await saveMessages(sessionId, history)
      emit(win, { type: 'messages', sessionId, messages: history })
    }
  } catch (err) {
    console.error('[compaction] manual falhou:', err)
  }
}
