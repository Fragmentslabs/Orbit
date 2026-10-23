import { generateText, stepCountIs, streamText, type ModelMessage, type UserContent } from 'ai'
import fs from 'node:fs/promises'
import { basename } from 'node:path'
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
  TextPart,
  ToolPart,
} from '@shared/chat'
import {
  BROWSER_SELECTION_MIME,
  DOCUMENT_QUOTE_MIME,
  formatMotionQuoteText,
  formatDesignQuoteText,
  StorageKeys,
  type QuotePayload,
} from '@shared/chat'
import { getProvider, modelSupportsVision } from './catalog'
import { resolveTitle, titleFromUserText } from './chat-title'
import { compactHistory, findLastSummaryIndex, shouldCompact } from './compaction'
import { contextBudget, estimateTokens, maxStepsFor, trimTurnContext } from './context-budget'
import { clearManualSaves, manualSavesUnder, stripFilesFromPatch } from './manual-saves'
import { createToolApproval, takeDenialReason } from './permission'
import { t as mainT } from './i18n'
import { classifyProviderError, errorToText, isRecoverableErrorKind, isTransientErrorKind } from './errors'
import { selectDraftImages } from './image-drafts'
import { hasStreamedContent, resolveRotation, retryDelay, waitUnlessAborted } from './model-rotation'
import { buildSystemPrompt } from './prompts'
import { buildProviderOptions, interleavedReasoningField, normalizeMessages } from './reasoning'
import { resolveModel } from './providers'
import { withProviderSession } from './provider-session'
import {
  attachArtifactMessage,
  attachDocumentMessage,
  attachMediaMessage,
  deleteMedia,
  getMediaEntry,
  mediaIdFromUrl,
  readMedia,
  saveMedia,
} from './media'
import { assetUrl, mediaKind, thumbUrl, type MediaEntry } from '@shared/media'
import sharp from 'sharp'
import { claimsCompletion, isNoCorrectionReply } from './overclaim'
import {
  documentKindOf,
  pageLabel,
  type DocumentKind,
  type DocumentPage,
} from './document-pages'
import { saveSessionDocument, type SessionDocument } from './session-documents'
import { describeSkillAttachment } from './skills/import'
import {
  clearTurnImages,
  getTurnImages,
  registerTurnImages,
  type TurnImage,
} from './vision'
import { cleanupRevert } from './session/revert'
import { capture, diff } from './snapshot'
import { isInitAborted, runProjectInit, type InitHooks, type InitResult } from './project-init'
import { readJson, writeJson } from './storage'
import { getAppSettings } from './app-settings'
import { audioExt, audioIdFrom, isAudioFile, saveAudio } from './audio-store'
import { isVideoFile, saveVideoAttachment, videoAttachmentExt, videoPathFromFileUrl } from './attachment-ref'
import { imageRefLine, posterDataUrl, probeVideoAttachment, videoAttachmentNote } from './video/attachment-note'
import { addVideoToGallery } from './video/video-gallery'
import { MIN_COMPACTION_CONTEXT, resolveAuxModel } from './aux-model'
import { notifyChatError, notifyNewMessage } from './notifications'
import { buildToolSet, type ImageToolHooks, type ToolContext, type TurnSnapshot } from './tools'
import { endActivity } from './computer/session'
import { designNameFromInputJson, openDesignLive } from './tools/design-chat'
import { openMotionLive } from './tools/motion-chat'
import { addTokenUsage, costOfUsage, toStepUsage, toTokenUsage } from './usage'
import { engineAnnotations, stripEngineMarkers } from './todo-context'
import { forwardChatEvent } from './companion-server'
import { modoGlobal } from './permission/modo-global'

// Tools cujo input (ainda em streaming) abre a aba correspondente AO VIVO,
// assim que o campo `name` aparece no JSON — antes do modelo terminar de
// transmitir o payload (o HTML dos artboards ou da composição). O report()
// final da tool segue como estava; isto só adianta a abertura.
const LIVE_OPEN_TOOLS: Record<string, (sessionId: string, name: string) => Promise<void>> = {
  design_write: openDesignLive,
  design_edit: (sessionId, name) => openDesignLive(sessionId, name, { placeholder: false }),
  motion_write: openMotionLive,
  motion_edit: (sessionId, name) => openMotionLive(sessionId, name, { placeholder: false }),
}

/**
 * Motor de chat portado do processador de sessões do opencode: converte o
 * histórico persistido em mensagens de modelo, roda o loop de streamText com
 * ferramentas e emite eventos incrementais para o renderer via IPC.
 */

// Teto de segurança, não um limite operacional normal — o opencode (de onde
// este engine foi portado) roda sem teto por padrão (agent.steps ?? Infinity)
// e só para quando o modelo decide (finishReason === 'stop'). 50 era baixo
// demais: tarefas de código reais passam disso e a stream cortava no meio,
// indistinguível de uma conclusão normal. O teto agora sai de `maxStepsFor`
// (context-budget), que o escala pelo contexto do modelo: quem tem janela
// pequena não tem o que fazer com 300 idas ao provedor. Existe só pra não
// deixar um loop patológico rodar para sempre — o estouro de contexto quem
// segura é o trimTurnContext no prepareStep.
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
const AUTO_CONTINUE_PROMPT = `[SYSTEM: the previous reply was cut off by the model's output token limit (finish_reason "length") — this is NOT the end of the turn. Continue exactly from where you left off: resume mid-sentence if the cut happened mid-sentence, do NOT repeat what was already written, do NOT restart the answer, and do NOT append a closing summary — the text you produce now is displayed as the direct continuation of the previous text, together forming one single answer. If you were mid-task, complete it.]`
const AUTO_CONTINUE_TOOL_PROMPT = (toolNames: string) => `[SYSTEM: the previous reply was cut off by the model's output token limit (finish_reason "length") in the middle of a ${toolNames} tool call. That tool call was NOT executed. Do NOT retry it as one giant operation — split it into smaller operations (smaller file writes, shorter commands, less data per call) and continue from where you left off.]`
// Nudge de fechamento da TODO: o turno terminou em 'stop' mas o modelo não
// reenviou a lista marcando os itens como completed (os checkboxes ficam com
// spinner infinito na UI). Re-entramos no loop com uma synthetic user
// message pedindo para resolver o estado — mesmo padrão do auto-continue,
// com teto por turno para não virar loop.
const MAX_TODO_NUDGES = 2
const TODO_COMPLETION_PROMPT = `[SYSTEM: your reply ended, but the last TODO list still has items marked as "in_progress". If you actually completed them, re-send the TODO list marking those items as "completed" (do NOT repeat the work summary — just update the checklist). If they are truly still not finished, say so briefly. Do not end the turn again without resolving the TODO state.]`
/**
 * Nudge de overclaim: o turno terminou afirmando trabalho feito, mas o
 * snapshot prova que NENHUM arquivo mudou — o overclaim clássico é o turno
 * que relata conclusão sem ter chamado write/editar nenhum e mesmo assim
 * afirma ter feito algo.
 */
const MAX_OVERCLAIM_NUDGES = 1
const NO_CHANGES_PROMPT = `[SYSTEM: automatic verification — NO file was modified in this turn. The filesystem snapshot taken before your response is identical to the one taken now; this is measured by the engine, not inferred. If your reply claims you created, edited, fixed, removed or refactored anything, that claim is false. Either do the work now with the write/edit tools (then end with your normal final answer), or correct the claim briefly in 1-2 sentences starting with "Correção:". Do not repeat the full answer and do not produce a new concluding text unless you actually changed files. If your reply made no false claim (e.g. it only described work from previous turns or answered a question), reply ONLY with the single line: Nada a corrigir. — nothing else.]`

/**
 * Ferramentas que podem gravar no diretório de trabalho — o snapshot do
 * verifyTurn cobre esse diretório, então só faz sentido cobrar overclaim em
 * turnos que as usaram. Texto de conclusão num turno sem nenhuma delas (ex.:
 * pergunta informativa respondida só com leitura ou texto puro) descreve
 * trabalho de turnos anteriores, não deste — cobrar seria ruído. MCP entra
 * por conservadorismo: o engine não conhece as capacidades de cada servidor.
 */
const WRITE_TOOL_NAMES = new Set(['write', 'edit', 'bash', 'bash_background', 'panel_screenshot'])
function usedFileWritingTools(parts: MessagePart[]): boolean {
  return parts.some(
    (p) => p.type === 'tool' && (WRITE_TOOL_NAMES.has(p.tool) || p.tool.startsWith('mcp__')),
  )
}

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

/** Mensagem final do /init: o que foi gravado na árvore, ou por que nada foi.
 *  É texto do produto para o usuário, então segue o idioma do app. */
async function initSummary(result: InitResult): Promise<string> {
  const note = result.note ? `\n\n${result.note}` : ''
  const limit = result.unfinished ? `\n\n${await mainT('init.unfinished')}` : ''
  if (!result.saved) {
    return `${await mainT('init.nothing.title')}${note || `\n\n${await mainT('init.nothing.body')}`}${limit}`
  }
  const counts = (
    await Promise.all([
      result.created ? mainT('init.count.created', { count: result.created }) : '',
      result.updated ? mainT('init.count.updated', { count: result.updated }) : '',
      result.retired ? mainT('init.count.retired', { count: result.retired }) : '',
      result.learnings ? mainT('init.count.learnings', { count: result.learnings }) : '',
    ])
  ).filter(Boolean)
  const titles = result.titles.length ? `: **${result.titles.join('**, **')}**` : ''
  return (
    `${await mainT('init.saved.title')}\n\n${await mainT('init.saved.tree', { counts: counts.join(', ') })}${titles}.${note}\n\n` +
    (await mainT('init.saved.footer')) +
    limit
  )
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

/**
 * Abaixo deste tamanho o documento entra INTEIRO na mensagem, como antes.
 * Paginar um anexo de duas páginas só trocaria contexto barato por uma ida e
 * volta de tool — o custo da paginação só compensa quando o documento é
 * grande o bastante para pesar em todos os turnos seguintes.
 */
const INLINE_DOC_CHARS = 8000
/** Páginas do trecho de abertura de um documento grande. */
const PREVIEW_PAGES = 2

/** O anexo é um documento paginável? Combina o MIME (quando o navegador
 *  informa) com a extensão (quando ele manda octet-stream). */
function attachmentDocumentKind(mime: string, filename: string): DocumentKind | null {
  if (mime === 'application/pdf' || PDF_EXT.test(filename)) return 'pdf'
  if (mime === DOCX_MIME || DOCX_EXT.test(filename)) return 'docx'
  if (SPREADSHEET_MIME.test(mime) || SPREADSHEET_EXT.test(filename)) return 'spreadsheet'
  return documentKindOf(filename)
}

/**
 * Texto que representa o documento na mensagem. Pequeno vai inteiro; grande
 * vai como trecho de abertura mais a instrução de como alcançar o resto.
 *
 * Este texto é persistido e reenviado em todo turno, então ele é justamente o
 * que precisa ficar pequeno — é aqui que a economia acontece.
 */
function documentAttachmentPreview(doc: SessionDocument, pages: DocumentPage[]): string {
  const unit = doc.kind === 'spreadsheet' ? 'sheets' : doc.kind === 'docx' ? 'blocks' : 'pages'
  const head = `[Document attached: ${doc.filename} — ${doc.totalPages} ${unit}, id ${doc.id}]`
  const render = (list: DocumentPage[]) =>
    list
      .map((page) => `--- ${pageLabel(page, doc.kind)} ---\n${page.text || '(no text)'}`)
      .join('\n\n')

  if (doc.totalChars <= INLINE_DOC_CHARS && !doc.truncated) {
    return `${head}\n\n${render(pages)}`
  }
  const shown = pages.slice(0, PREVIEW_PAGES)
  return (
    `${head}\n\nOpening excerpt (${unit} 1-${shown.length} of ${doc.totalPages}):\n\n${render(shown)}\n\n` +
    `[The document is NOT all here. For the rest: doc_search({ pattern }) finds the ${unit === 'sheets' ? 'sheet' : unit === 'blocks' ? 'block' : 'page'} and doc_read({ docId: "${doc.id}", offset }) reads from there. ` +
    `Do not answer about content beyond this excerpt without looking it up — and never ask the user to paste the text.]`
  )
}

/** Converte um anexo (FilePart) em conteúdo de modelo: imagem/PDF nativos,
 * arquivos de texto viram texto inline; o resto vira só uma nota. Usado só
 * para HISTÓRICO já persistido — anexos novos são pré-processados em
 * `preprocessAttachment` antes de chegar aqui (ver runChat). */
function fileToModelContent(file: FilePart, modelVision: boolean): Exclude<UserContent, string>[number] {
  if (file.mime.startsWith('image/')) {
    // Parte `file`, e não `image`: o ai-sdk depreciou o tipo `image` e avisa no
    // terminal a cada anexo. A parte `file` com mediaType de imagem é o
    // substituto, e os provedores a recebem igual.
    if (modelVision) return { type: 'file', data: file.url, mediaType: file.mime }
    // Modelo sem visão (histórico): nota de texto — a descrição, quando
    // existe, já está no TextPart irmão gerado em preprocessAttachment.
    return { type: 'text', text: `[Image attached earlier: ${file.filename ?? 'image'}]` }
  }
  if (file.mime === 'application/pdf' || PDF_EXT.test(file.filename ?? '')) {
    return { type: 'text', text: `[PDF attached earlier: ${file.filename ?? 'document'}]` }
  }
  if (TEXT_MIME.test(file.mime) || TEXT_EXT_FALLBACK.test(file.filename ?? '')) {
    const text = decodeDataUrlText(file.url)
    if (text != null) {
      return { type: 'text', text: `[File attached: ${file.filename ?? 'unnamed'}]\n\n${text}` }
    }
  }
  return { type: 'text', text: `[Unsupported file attached: ${file.filename ?? file.mime}]` }
}

/** Chip de anexo sem o data URL original (evita duplicar bytes grandes no
 * histórico — o conteúdo já vai como texto no TextPart que acompanha este
 * chip). Em imagens, `thumbUrl` traz um thumbnail reduzido só para a bolha do
 * chat (o modelo continua não recebendo o arquivo: toModelMessages ignora
 * chips pela flag `chip`). */
function attachmentChip(
  file: FilePart,
  thumbUrl?: string,
  documentId?: string,
  mediaUrl?: string,
): FilePart {
  return {
    id: file.id,
    type: 'file',
    mime: file.mime,
    filename: file.filename,
    url: thumbUrl ?? '',
    chip: true,
    ...(documentId ? { documentId } : {}),
    ...(mediaUrl ? { mediaUrl } : {}),
  }
}

/** Thumbnail (WebP, máx 320px) de um data URL de imagem — só para exibição na
 * bolha do chat; o histórico guarda o thumbnail em vez dos bytes originais.
 * Falha silenciosa → undefined (o chip fica sem url, como antes). */
async function imageThumbDataUrl(url: string): Promise<string | undefined> {
  try {
    const bytes = decodeDataUrlBytes(url)
    if (!bytes) return undefined
    const out = await sharp(bytes)
      .rotate()
      .resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 75 })
      .toBuffer()
    return `data:image/webp;base64,${out.toString('base64')}`
  } catch (err) {
    console.error('[attachment] thumbnail falhou:', err)
    return undefined
  }
}

const IMAGE_MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/** Extensão de arquivo para persistir uma imagem anexada (mime → ext, com
 * fallback pelo filename e, por fim, png). */
function imageExt(file: FilePart): string {
  const fromMime = IMAGE_MIME_EXT[file.mime]
  if (fromMime) return fromMime
  const match = /\.(png|jpe?g|webp|gif)$/i.exec(file.filename ?? '')
  if (match) {
    const ext = match[1].toLowerCase()
    return ext === 'jpeg' ? 'jpg' : ext
  }
  return 'png'
}

/**
 * Registra a print colada pelo usuário na galeria de mídia (source 'user'):
 * o original ganha arquivo em disco + registro no índice — com o modo Visão,
 * hoje os bytes originais se perdem (o histórico guarda só o thumbnail).
 * Melhor esforço: falha silenciosa — o envio da mensagem nunca quebra por
 * causa do registro.
 */
async function saveUserImage(
  file: FilePart,
  sessionId?: string,
  messageId?: string,
): Promise<string | undefined> {
  try {
    const bytes = decodeDataUrlBytes(file.url)
    if (!bytes) return undefined
    return await saveMedia(bytes, imageExt(file), {
      source: 'user',
      sessionId,
      messageId,
      name: file.filename,
    })
  } catch (err) {
    console.error('[attachment] registro da imagem na galeria falhou:', err)
    return undefined
  }
}

/**
 * Nota que o agente recebe por um anexo de áudio. Com a transcrição ligada,
 * a referência e quando usá-la; desligada, o que dizer ao usuário.
 */
function audioAttachmentNote(filename: string, id: string, file: string): string {
  const head = `[Audio attached: ${filename || 'unnamed'} — ref ${id}]\nFile: ${file} (in this chat's media)`
  if (!getAppSettings().voice.stt.enabled) {
    return (
      `${head}\n(Attachment, not a user message. Audio transcription is DISABLED in Settings → Voice → Speech to text: ` +
      "if the request depends on what is said in it, tell the user you can't listen to it because the feature is off, " +
      'and that they can enable it there if this machine has a dictation engine ready.)'
    )
  }
  return (
    `${head}\n(Attachment, not a user message. NOT transcribed: if what is SPOKEN in it matters for the request, call audio_transcribe with ref "${id}". ` +
    'If it is music, a sound effect or audio to be used somewhere, do not transcribe it.)'
  )
}

/**
 * Um vídeo anexado vira: o arquivo guardado no app (o agente só recebe a
 * REFERÊNCIA e uma linha de metadados), uma miniatura para a bolha e a nota.
 *
 * O vídeo chega de duas formas. Escolhido ou arrastado do disco, o renderer manda
 * só o CAMINHO (`file://…`) e o arquivo é copiado aqui, por clone quando o
 * sistema de arquivos permite — nunca passa inteiro pela memória. Colado da área
 * de transferência não há caminho, e vêm os bytes (data URL).
 */
async function preprocessVideoAttachment(
  file: FilePart,
  deps: { sessionId?: string; messageId?: string },
): Promise<MessagePart[]> {
  const filename = file.filename ?? ''
  const refuse = (problem: string): MessagePart[] => [
    attachmentChip(file),
    {
      id: newId('prt'),
      type: 'text',
      text: videoAttachmentNote({ filename, id: 'unavailable', file: '', probe: null, problem }),
      state: 'done',
      source: 'attachment',
    },
  ]
  const ext = videoAttachmentExt(file.mime, filename)
  if (!ext) return refuse('Attachment, not a user message. Unsupported video format.')
  try {
    let saved
    if (file.url.startsWith('file://')) {
      const source = videoPathFromFileUrl(file.url)
      if (!source) return refuse('Attachment, not a user message. The path is not a video file.')
      saved = await saveVideoAttachment({ copyFrom: source }, ext, { sessionId: deps.sessionId, name: filename || undefined })
    } else {
      const bytes = decodeDataUrlBytes(file.url)
      if (!bytes) return refuse('Attachment, not a user message. The file could not be read.')
      saved = await saveVideoAttachment({ bytes }, ext, { sessionId: deps.sessionId, name: filename || undefined })
    }
    const probe = await probeVideoAttachment(saved.file)
    if (!probe || probe.video.length === 0) {
      // Não é um vídeo de verdade: não deixa a cópia para trás.
      await fs.rm(saved.file, { force: true })
      return refuse('Attachment, not a user message. The file is not a readable video.')
    }
    // Entra na galeria de mídia (aba Mídia, filtro de vídeo, excluir libera o arquivo).
    const gallery = await addVideoToGallery({
      file: saved.file,
      id: saved.id,
      name: filename || undefined,
      sessionId: deps.sessionId,
      messageId: deps.messageId,
      source: 'user',
      probe,
    }).catch(() => null)
    const poster = gallery?.poster ? await posterDataUrl(gallery.poster) : undefined
    return [
      attachmentChip(file, poster),
      {
        id: newId('prt'),
        type: 'text',
        text: videoAttachmentNote({ filename, id: saved.id, file: saved.file, probe }),
        state: 'done',
        source: 'attachment',
      },
    ]
  } catch (err) {
    return refuse(`Attachment, not a user message. ${errorToText(err)}`)
  }
}

/** Rótulo do tipo na nota que o agente lê para um anexo da galeria. */
const MEDIA_REF_LABEL: Record<string, string> = {
  artifact: 'Artifact',
  document: 'Document',
  motion: 'Motion composition',
  design: 'Design canvas',
}

/**
 * A nota de um anexo que JÁ é um item da galeria (arrastado da aba Mídia).
 * O arquivo está em disco; a nota dá o caminho e como abrir, sem prometer
 * nenhuma cópia — que é justamente o que não acontece.
 */
function mediaRefNote(kind: string, name: string, entry: MediaEntry): string {
  const label = MEDIA_REF_LABEL[kind] ?? 'File'
  const lines = [
    `[${label} attached: ${name} — ref ${entry.id}]`,
    `File: ${entry.path} (already in this app's media library — do not copy it)`,
  ]
  if (kind === 'document') {
    lines.push(`Read or update it with the document tools using id "${entry.id}".`)
  } else if (kind === 'motion') {
    lines.push(
      `Linked to this conversation. Read it with motion_read and change it with motion_edit/motion_write using${entry.motionId ? ` id "${entry.motionId}"` : ' its name'} — no need to recreate it. It is open in the Motion tab.`,
    )
  } else if (kind === 'design') {
    lines.push(
      `Linked to this conversation. Read it with design_read and change it with design_edit/design_write using${entry.designId ? ` id "${entry.designId}"` : ' its name'} — no need to recreate it. It is open in the Design tab.`,
    )
  } else if (kind === 'artifact') {
    lines.push(
      `Linked to this conversation. Read it with read_artifact and rewrite it with update_artifact using artifactId "${entry.id}" — no need to create a second one. It opens in the artifact tab.`,
    )
  }
  return lines.join('\n')
}

/**
 * Anexo que JÁ é um item da galeria (arrastado da aba Mídia). Diferente de todo
 * outro caminho, AQUI NADA É COPIADO: o arquivo existe, e o agente recebe uma
 * referência (`img_/vdo_/aud_…` ou o caminho) com a mesma nota dos anexos por
 * referência. A bolha mostra o chip — a imagem/vídeo só vai para o modelo
 * quando a visão exige os pixels (lidos de disco, sem reescrever).
 */
async function preprocessMediaRefAttachment(
  file: FilePart,
  deps: {
    modelVision: boolean
    visionModel?: { providerId: string; modelId: string }
    sessionId?: string
    messageId?: string
    turnImages?: TurnImage[]
  },
): Promise<MessagePart[]> {
  const id = file.mediaId ?? ''
  const entry = await getMediaEntry(id)
  if (!entry) {
    return [
      attachmentChip(file),
      {
        id: newId('prt'),
        type: 'text',
        text: `[Attachment: ${file.filename ?? id}] (it is no longer in the media library)`,
        state: 'done',
        source: 'attachment',
      },
    ]
  }
  const kind = mediaKind(entry)
  const name = entry.name || file.filename || entry.id
  const mediaUrl = assetUrl(entry)

  if (kind === 'audio') {
    return [
      attachmentChip(file, undefined, undefined, mediaUrl),
      { id: newId('prt'), type: 'text', text: audioAttachmentNote(name, entry.id, entry.path), state: 'done', source: 'attachment' },
    ]
  }

  if (kind === 'video') {
    const probe = await probeVideoAttachment(entry.path)
    return [
      attachmentChip(file, thumbUrl(entry) ?? undefined, undefined, mediaUrl),
      {
        id: newId('prt'),
        type: 'text',
        text: videoAttachmentNote({ filename: name, id: entry.id, file: entry.path, probe }),
        state: 'done',
        source: 'attachment',
      },
    ]
  }

  if (kind === 'image') {
    // A imagem já está em disco: os bytes são lidos só para a VISÃO (o modelo
    // precisa dos pixels) e para o thumbnail do chip — o arquivo NÃO é reescrito.
    const media = await readMedia(entry.id)
    const dataUrl = media ? `data:${media.contentType};base64,${media.buffer.toString('base64')}` : undefined
    const thumb = dataUrl ? await imageThumbDataUrl(dataUrl) : undefined
    const refLine = imageRefLine(mediaUrl, name, file.mime || media?.contentType || 'image/png')
    if (deps.visionModel && dataUrl) {
      const ref = (deps.turnImages?.length ?? 0) + 1
      const partId = newId('prt')
      deps.turnImages?.push({ url: dataUrl, filename: name, partId })
      return [
        attachmentChip(file, thumb, undefined, mediaUrl),
        {
          id: partId,
          type: 'text',
          text:
            `[Image attached: ${name} — ref #${ref}]\n\n` +
            `(Vision mode: the image is not described automatically — use the describe_image tool with ref #${ref} ` +
            'to see it; in "focus" say what you need to know and, if it depends on the conversation, include the necessary context in the request.)' +
            (refLine ? `\n${refLine}` : ''),
          state: 'done',
          source: 'attachment',
        },
      ]
    }
    if (deps.modelVision && dataUrl && media) {
      const withData: FilePart = { ...file, mime: media.contentType, url: dataUrl }
      return refLine
        ? [withData, { id: newId('prt'), type: 'text', text: refLine, state: 'done', source: 'attachment' }]
        : [withData]
    }
    return [
      attachmentChip(file, thumb, undefined, mediaUrl),
      {
        id: newId('prt'),
        type: 'text',
        text:
          `[Image attached: ${name}] — the current model has no vision and no vision model is configured; the image was not sent to the model.` +
          (refLine ? `\n${refLine}` : ''),
        state: 'done',
        source: 'attachment',
      },
    ]
  }

  // Artefato, documento, peça de motion, canvas de design: o arquivo/pasta já
  // vive no app — a nota dá o caminho e como abrir.
  return [
    attachmentChip(file, thumbUrl(entry) ?? undefined),
    { id: newId('prt'), type: 'text', text: mediaRefNote(kind, name, entry), state: 'done', source: 'attachment' },
  ]
}

/** Pré-processa um anexo NOVO antes de persistir: PDF, planilha e skill viram
 *  texto extraído (evita data URLs enormes no histórico) + um chip sem dados
 *  pra UI continuar mostrando o anexo; imagem continua nativa (o modelo lê
 *  melhor via image part). Espelha o mesmo padrão para cada tipo — extrai,
 *  embrulha em TextPart, nunca falha o envio da mensagem. */
async function preprocessAttachment(
  file: FilePart,
  deps: {
    /** O modelo desta execução tem visão nativa? */
    modelVision: boolean
    /** Modelo de visão delegado (modo Visão) — usado quando modelVision é false */
    visionModel?: { providerId: string; modelId: string }
    language?: string
    /** Sessão/mensagem de origem — a print vira registro na galeria de mídia */
    sessionId?: string
    messageId?: string
    /** Registro do turno (modo Visão): onde as imagens ficam para a tool describe_image */
    turnImages?: TurnImage[]
    /** Texto que o usuário escreveu neste turno — o anexo de motion o cola ao
     *  instante apontado (ver formatMotionQuoteText). */
    userText?: string
  },
): Promise<MessagePart[]> {
  const filename = file.filename ?? ''

  // Anexo que já é um item da galeria (arrastado da aba Mídia): nada é copiado,
  // o agente recebe a referência e o caminho. É o primeiro corte porque `url`
  // aqui é só o preview — nenhum dos caminhos abaixo vale para ele.
  if (file.mediaId) return preprocessMediaRefAttachment(file, deps)

  // Elemento selecionado no browser do painel (modo seleção): o renderer
  // serializa o elemento (tag/url/selector/texto/html) como data URL JSON no
  // MIME marcador. Vira chip (badge na bolha do chat) + TextPart com source
  // 'attachment' — mesmo padrão do PDF: o modelo recebe o detalhe completo, a
  // bolha do usuário mostra só o chip.
  if (file.mime === BROWSER_SELECTION_MIME) {
    const raw = decodeDataUrlText(file.url)
    let text = `[Element selected in the panel browser — ${file.filename || 'element'}]`
    if (raw) {
      try {
        const sel = JSON.parse(raw) as { tag?: string; url?: string; selector?: string; text?: string; html?: string }
        text = [
          `[Element selected in the panel browser — <${sel.tag ?? '?'}> on ${sel.url ?? ''}]`,
          `selector: ${sel.selector ?? ''}`,
          `text: ${sel.text || '(no text)'}`,
          `html: ${sel.html ?? ''}`,
        ].join('\n')
      } catch {
        // payload inválido — o filename do chip já dá contexto suficiente
      }
    }
    return [
      attachmentChip(file),
      { id: newId('prt'), type: 'text', text, state: 'done', source: 'attachment' },
    ]
  }

  // Trecho citado no visualizador de documento, ou INSTANTE apontado na aba
  // Motion — os dois chegam pelo mesmo MIME (ver DOCUMENT_QUOTE_MIME) e o
  // `kind` do payload diz qual é. O usuário grifou/apontou e mandou: o modelo
  // recebe o essencial JÁ AQUI, sem precisar de uma ida ao documento ou à
  // composição para responder, e recebe junto a citação clicável para devolver
  // na resposta. A bolha mostra só o chip — o trecho pode ser longo, e
  // repeti-lo na conversa seria mostrar ao usuário o que ele acabou de marcar.
  if (file.mime === DOCUMENT_QUOTE_MIME) {
    const raw = decodeDataUrlText(file.url)
    let text = `[Excerpt quoted by the user — ${file.filename || 'document'}]`
    if (raw) {
      try {
        const quote = JSON.parse(raw) as QuotePayload
        if (quote.kind === 'motion') {
          // O instante: arquivo, quadro e fps (e os segundos com vírgula, que
          // são só exibição), com o texto do usuário colado — ver
          // formatMotionQuoteText.
          text = formatMotionQuoteText(quote, deps.userText)
        } else if (quote.kind === 'design') {
          // O elemento apontado no canvas: artboard, caminho e o HTML dele, com
          // o texto do usuário colado — ver formatDesignQuoteText.
          text = formatDesignQuoteText(quote, deps.userText)
        } else {
          const onde = quote.page
            ? `, page ${quote.page}${
                quote.fromLine
                  ? `, line${quote.toLine && quote.toLine > quote.fromLine ? `s ${quote.fromLine}-${quote.toLine}` : ` ${quote.fromLine}`}`
                  : ''
              }`
            : ''
          const linhas = [`[Excerpt quoted by the user — ${quote.name ?? 'document'}${onde}]`]

          // O ENDEREÇO do que foi citado, na linguagem da ferramenta que o
          // alcança. Sem isto o modelo recebia um nome e um texto, ia procurar
          // o arquivo com as tools que tinha e respondia que não achou — com o
          // documento inteiro a um id de distância. O id vale por si: ler um
          // documento não depende de ele ser fonte da conversa, nem de a
          // conversa ser a mesma em que ele nasceu.
          if (quote.docId) {
            linhas.push(
              quote.kind === 'source'
                ? `Source in this conversation: ${quote.docId} — use doc_read/doc_search with this docId to see the rest.`
                : `Agent document: ${quote.docId} — use read_document with this documentId to see the full text, and update_document to change it (read first: baseRevision comes from the read).`,
            )
          }
          if (quote.docId && quote.page) {
            const alvo = `#orbit-source/${quote.docId}/p${quote.page}${
              quote.fromLine ? `L${quote.fromLine}${quote.toLine ? `-${quote.toLine}` : ''}` : ''
            }`
            linhas.push(`To cite it back in your reply: [${quote.name ?? 'document'}](${alvo})`)
          }
          linhas.push('---', quote.text ?? '')
          text = linhas.join('\n')
        }
      } catch {
        // payload inválido — o filename do chip já dá o contexto mínimo
      }
    }
    return [
      attachmentChip(file),
      { id: newId('prt'), type: 'text', text, state: 'done', source: 'attachment' },
    ]
  }

  // PDF, DOCX e planilha: um caminho só. O texto extraído é guardado na
  // sessão e a mensagem leva apenas o trecho de abertura — o resto o agente
  // alcança com doc_search/doc_read.
  //
  // Antes, os três despejavam o documento inteiro numa TextPart, que o
  // toModelMessages reenvia A CADA TURNO: um PDF grande ocupava a janela de
  // contexto pelo resto da conversa, sendo cobrado de novo em toda mensagem
  // (e o PDF nem tinha teto — só DOCX e planilha cortavam em 30k, perdendo o
  // resto em silêncio).
  const documentKind = attachmentDocumentKind(file.mime, filename)
  if (documentKind) {
    const bytes = decodeDataUrlBytes(file.url)
    if (!bytes) {
      return [
        attachmentChip(file),
        { id: newId('prt'), type: 'text', text: `[Document attached: ${filename}] (could not read the file)`, state: 'done', source: 'attachment' },
      ]
    }
    try {
      const { doc, pages } = await saveSessionDocument(
        deps.sessionId ?? 'sem-sessao',
        Buffer.from(bytes),
        filename || 'documento',
        documentKind,
      )
      return [
        // O chip leva o id do documento: e o que permite clicar no anexo e
        // abrir o arquivo no painel, ja que o conteudo nao vive na mensagem.
        attachmentChip(file, undefined, doc.id),
        {
          id: newId('prt'),
          type: 'text',
          text: documentAttachmentPreview(doc, pages),
          state: 'done',
          source: 'attachment',
        },
      ]
    } catch (err) {
      return [
        attachmentChip(file),
        { id: newId('prt'), type: 'text', text: `[Document attached: ${filename}] (extraction failed: ${errorToText(err)})`, state: 'done', source: 'attachment' },
      ]
    }
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
            `[Skill attached: ${filename}]\n\n${description}\n\n` +
            '(If the user asks to add this as a skill, or the context makes it clear, use the create_skill tool with this content — do not assume it unless the request/context justifies it.)',
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
        { id: newId('prt'), type: 'text', text: `[File attached: ${filename || 'unnamed'}]\n\n${text}`, state: 'done', source: 'attachment' },
      ]
    }
  }

  // Vídeo: guardado no app, o agente recebe a referência e a ficha — nunca o conteúdo.
  if (isVideoFile(file.mime, filename)) return preprocessVideoAttachment(file, deps)

  // Áudio: vai para o acervo de áudio (a bolha toca o anexo pelo chip) e NÃO é
  // transcrito aqui — pode ser uma música ou um efeito para usar em algum
  // lugar. O agente recebe a referência e decide (tool audio_transcribe). A
  // transcrição, quando houver, volta para ESTA nota (ver
  // persistAudioTranscript): é conteúdo do anexo, não fala do usuário.
  if (isAudioFile(file.mime, filename)) {
    const bytes = decodeDataUrlBytes(file.url)
    const ext = audioExt(file.mime, filename)
    if (!bytes || !ext) {
      return [
        attachmentChip(file),
        { id: newId('prt'), type: 'text', text: `[Audio attached: ${filename || 'unnamed'}] (unsupported format or unreadable file)`, state: 'done', source: 'attachment' },
      ]
    }
    const saved = await saveAudio(Buffer.from(bytes), ext, {
      sessionId: deps.sessionId,
      messageId: deps.messageId,
      name: filename || undefined,
      source: 'user',
    })
    // O agente recebe só a referência e o caminho — nunca o conteúdo: o áudio
    // não ocupa o contexto, e ele escolhe o que fazer (transcrever, usar o
    // arquivo num projeto, nada).
    return [
      attachmentChip(file, undefined, undefined, saved.url),
      { id: newId('prt'), type: 'text', text: audioAttachmentNote(filename, saved.id, saved.path), state: 'done', source: 'attachment' },
    ]
  }

  // Imagem: com o modo Visão ativo (visionModel configurado), a imagem NÃO
  // entra no contexto e não é descrita automaticamente — o agente decide ver
  // (tool describe_image, com o contexto que ele quiser passar) e a descrição
  // retornada substitui este placeholder no histórico. Sem modo ativo: visão
  // nativa mantém o image part; sem visão e sem modelo, avisa no histórico que
  // o anexo não foi visto (a UI também mostra o card).
  if (file.mime.startsWith('image/')) {
    // A print colada pelo usuário também entra na galeria de mídia: o
    // original é persistido em disco (source 'user') — o histórico não muda,
    // a mensagem continua com o data URL/thumb de sempre.
    const mediaUrl = await saveUserImage(file, deps.sessionId, deps.messageId)
    // Thumbnail só para a bolha do chat: o chip não leva os bytes originais
    // (o histórico não duplica imagens inteiras), mas a UI mostra a imagem.
    const thumbUrl = await imageThumbDataUrl(file.url)
    const refLine = imageRefLine(mediaUrl, file.filename ?? '', file.mime)
    if (deps.visionModel) {
      const filename = file.filename ?? ''
      const ref = (deps.turnImages?.length ?? 0) + 1
      const partId = newId('prt')
      deps.turnImages?.push({ url: file.url, filename: file.filename, partId })
      return [
        attachmentChip(file, thumbUrl, undefined, mediaUrl),
        {
          id: partId,
          type: 'text',
          text:
            `[Image attached: ${filename || 'unnamed'} — ref #${ref}]\n\n` +
            `(Vision mode: the image is not described automatically — use the describe_image tool with ref #${ref} ` +
            'to see it; in "focus" say what you need to know and, if it depends on the conversation, include the necessary context in the request.)' +
            (refLine ? `\n${refLine}` : ''),
          state: 'done',
          source: 'attachment',
        },
      ]
    }
    if (deps.modelVision) {
      return refLine
        ? [file, { id: newId('prt'), type: 'text', text: refLine, state: 'done', source: 'attachment' }]
        : [file]
    }
    const filename = file.filename ?? ''
    return [
      attachmentChip(file, thumbUrl, undefined, mediaUrl),
      {
        id: newId('prt'),
        type: 'text',
        text:
          `[Image attached: ${filename || 'unnamed'}] — the current model has no vision and no vision model is configured; the image was not sent to the model.` +
          (refLine ? `\n${refLine}` : ''),
        state: 'done',
        source: 'attachment',
      },
    ]
  }

  return [file]
}

/**
 * Modo Visão (agent-driven): persiste a descrição retornada pela tool
 * describe_image no TextPart placeholder da mensagem do usuário. A ToolPart da
 * chamada nunca é reenviada em turnos futuros (ver toModelMessages) — o texto
 * aqui deixa o histórico autossuficiente, como no fluxo antigo de descrição
 * automática. Usa objeto NOVO (o MessageItem é memoizado por referência na UI).
 */
async function persistImageDescription(opts: {
  sessionId: string
  ref: number
  text: string
  history: ChatMessage[]
  win: BrowserWindow
}): Promise<void> {
  const entry = getTurnImages(opts.sessionId)?.[opts.ref - 1]
  if (!entry?.partId || !opts.text.trim()) return
  const userMsg = [...opts.history].reverse().find((m) => m.role === 'user')
  if (!userMsg) return
  const idx = userMsg.parts.findIndex((p) => p.id === entry.partId)
  const part = userMsg.parts[idx]
  if (idx < 0 || part.type !== 'text') return
  const text = entry.persisted
    ? `${part.text}\n\n[Additional information about the image]\n${opts.text}`
    : `[Image attached: ${entry.filename || 'unnamed'}]\n\nDescription generated by the vision model:\n${opts.text}`
  entry.persisted = true
  const updated: ChatMessage = {
    ...userMsg,
    parts: userMsg.parts.map((p, i) => (i === idx ? { ...p, text } : p)),
  }
  opts.history[opts.history.indexOf(userMsg)] = updated
  await saveMessages(opts.sessionId, opts.history)
  emit(opts.win, { type: 'message', sessionId: opts.sessionId, message: updated })
}

/**
 * Transcrição de um anexo de áudio (tool audio_transcribe) gravada na NOTA do
 * anexo, como a descrição do modo Visão: a ToolPart não volta nos próximos
 * turnos, e sem isto o agente teria de transcrever de novo a cada pergunta
 * sobre o mesmo áudio. A nota segue com `source: 'attachment'` — o texto é
 * conteúdo do anexo, nunca aparece como fala do usuário na bolha.
 *
 * Procura em todas as mensagens do usuário: o áudio pode ter chegado vários
 * turnos antes de alguém perguntar o que ele diz.
 */
async function persistAudioTranscript(opts: {
  sessionId: string
  audioId: string
  /** O que entra na nota no lugar das instruções: a transcrição, ou onde ela está. */
  body: string
  history: ChatMessage[]
  win: BrowserWindow
}): Promise<void> {
  const marker = `ref ${opts.audioId}]`
  const isAudioNote = (text: string) => text.startsWith('[Audio attached:') || text.startsWith('[Áudio anexado:')
  for (let m = opts.history.length - 1; m >= 0; m--) {
    const msg = opts.history[m]
    if (msg.role !== 'user') continue
    const idx = msg.parts.findIndex(
      (p) => p.type === 'text' && p.source === 'attachment' && isAudioNote(p.text) && p.text.includes(marker),
    )
    if (idx < 0) continue
    const part = msg.parts[idx] as TextPart
    // Cabeçalho = a linha da referência e a do arquivo; o resto é substituído.
    const lines = part.text.split('\n')
    const head = lines.slice(0, lines[1]?.startsWith('File:') ? 2 : 1).join('\n')
    const text = `${head}\n${opts.body}`
    const updated: ChatMessage = { ...msg, parts: msg.parts.map((p, i) => (i === idx ? { ...part, text } : p)) }
    opts.history[m] = updated
    await saveMessages(opts.sessionId, opts.history)
    emit(opts.win, { type: 'message', sessionId: opts.sessionId, message: updated })
    return
  }
}

/**
 * Cabeçalho das anotações do engine quando elas entram na mensagem do
 * usuário: marca a fronteira entre o que o engine mediu e o que a pessoa
 * escreveu. Usa o prefixo "[SYSTEM:" de propósito — se o modelo copiar a
 * linha na resposta, stripEngineMarkers a remove junto com as demais.
 */
const ENGINE_CONTEXT_HEADER =
  '[SYSTEM: engine bookkeeping about YOUR previous turn — measured from filesystem snapshots, not written by the user. Context only: never quote these lines in your reply.]'

/**
 * Converte o histórico persistido em mensagens para o modelo (texto +
 * anexos do usuário). Havendo compactação, corta no último resumo: envia
 * resumo + mensagens posteriores; o histórico completo continua no storage.
 */
export function toModelMessages(history: ChatMessage[], modelVision = true): ModelMessage[] {
  const lastSummary = findLastSummaryIndex(history)
  const window = lastSummary >= 0 ? history.slice(lastSummary) : history
  const result: ModelMessage[] = []
  // Anotações do engine sobre o turno anterior do assistente (estado da TODO,
  // registro verificado de arquivos, avisos). Ficam PENDENTES aqui e entram na
  // próxima mensagem de usuário — nunca dentro do texto do próprio assistente.
  //
  // Coladas no turno dele, essas linhas viram exemplo do seu próprio formato
  // de resposta: num histórico longo o modelo passa a imitá-las e escreve
  // "[Verified record: ...]" no texto que o usuário lê. Do lado do usuário
  // elas são lidas pelo que são — contexto que o ambiente forneceu.
  let pending: string[] = []
  const takePending = () => {
    if (pending.length === 0) return ''
    const notes = [ENGINE_CONTEXT_HEADER, ...pending].join('\n\n')
    pending = []
    return notes
  }
  for (const message of window) {
    if (message.role === 'assistant') {
      const notes = engineAnnotations(message)
      if (notes) pending.push(notes)
      // stripEngineMarkers cobre o histórico legado: mensagens gravadas antes
      // deste saneamento podem trazer o marcador colado no próprio texto.
      const text = stripEngineMarkers(partText(message.parts, 'text'))
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
    // ToolParts nunca são reenviados ao modelo fora do streaming da chamada
    // que os gerou — o que sobrevive do turno anterior são as anotações.
    const text = [takePending(), partText(message.parts, 'text')]
      .filter((p) => p.trim())
      .join('\n\n')
    // Chips (flag `chip`) são só decoração da UI — o conteúdo real já está no
    // TextPart irmão extraído em preprocessAttachment; incluí-los aqui
    // duplicaria uma nota vazia no lugar do texto já extraído. O `url !== ''`
    // cobre chips antigos persistidos antes da flag existir.
    const files = message.parts.filter(
      (p): p is FilePart => p.type === 'file' && !p.chip && p.url !== '',
    )
    if (message.role === 'user' && files.length > 0) {
      const content: UserContent = files.map((file) => fileToModelContent(file, modelVision))
      if (text.trim()) content.push({ type: 'text', text })
      result.push({ role: 'user', content })
      continue
    }
    if (!text.trim()) continue
    result.push({ role: message.role, content: text })
  }
  // Janela terminada em assistente (sem turno de usuário depois para carregar
  // as anotações): entrega como mensagem de usuário para o registro verificado
  // não sumir — é ele que sustenta a verificação anti-overclaim.
  const trailing = takePending()
  if (trailing.trim()) result.push({ role: 'user', content: trailing })
  return result
}

async function generateTitle(input: SendMessageInput, win: BrowserWindow) {
  try {
    const session = await readJson<SessionInfo>(StorageKeys.session(input.sessionId))
    // Só nomeia sessões que ainda estão com o título padrão: não sobrescreve
    // renomeações do usuário nem sessões de rotina (que nascem com
    // "<rotina> — <horário>").
    if (!session || session.routineId) return
    const isDefaultTitle =
      session.title === 'Nova conversa' || session.title === 'Nova sessão de código'
    if (!isDefaultTitle) return

    const aux = await resolveAuxModel({ providerId: input.providerId, modelId: input.modelId }, { sessionId: input.sessionId })
    const isCommand = input.text.trim().startsWith('/')
    const projectName = input.directory ? basename(input.directory) : null
    const { text } = await generateText({
      model: aux.model,
      providerOptions: aux.providerOptions,
      system:
        "Write a short, descriptive title for the conversation, in plain text, in the language of the user's message. " +
        'Rules: no bold, no asterisks, no quotes, no emojis and no formatting of any kind; at most 50 characters. ' +
        'Reply with ONLY the final title, nothing else.',
      prompt: isCommand
        ? `The code session started with a command (${input.text.trim().slice(0, 100)}) — do not use the command as the title. ` +
          `Write a short generic title in ${input.language ?? 'Portuguese'}${projectName ? ` for the project "${projectName}"` : ''}, ` +
          'such as "Project analysis". Reply with the title only.'
        : input.text.slice(0, 2000),
    })
    // Comando (`/init` etc.) não serve de título; aí a reserva é o projeto.
    const fallback = isCommand ? (projectName ?? '') : titleFromUserText(input.text)
    const title = resolveTitle(text, fallback)
    if (!title) return

    // Persiste no disco ANTES de propagar: os eventos "session" seguintes
    // (bumpSessionActivity) leem a sessão do disco — sem esta escrita o título
    // gerado reverte para o padrão na troca seguinte.
    // Relê antes de gravar: o título leva segundos e a sessão pode ter mudado
    // nesse meio-tempo (ex.: o agente trocou o chat de worktree) — gravar a
    // cópia lida no início desfaria a mudança.
    const atual = (await readJson<SessionInfo>(StorageKeys.session(input.sessionId))) ?? session
    await writeJson(StorageKeys.session(input.sessionId), { ...atual, title })
    await bumpSessionActivity(win, input.sessionId)
    emit(win, { type: 'title', sessionId: input.sessionId, title })
  } catch {
    // título é cosmético; falha silenciosa
  }
}

const SUGGESTION_SYSTEM =
  'You predict the user\'s NEXT message in a conversation with an AI assistant. ' +
  'Write it as the user would type it: short (at most 12 words), concrete, in the same language the user writes in, ' +
  'a natural next step given the assistant\'s last reply (follow-up, verification, next task). ' +
  'No quotes, no explanations, no prefixes — reply ONLY with the message. ' +
  'If there is no obvious next step, reply with an empty line.'

/**
 * Próxima mensagem provável do usuário, com o modelo auxiliar. Cosmética como
 * o título: qualquer falha só significa não mostrar sugestão.
 */
async function generateSuggestion(input: SendMessageInput, reply: ChatMessage, win: BrowserWindow) {
  try {
    const session = await readJson<SessionInfo>(StorageKeys.session(input.sessionId))
    if (!session || session.routineId) return
    const answer = reply.parts
      // Texto com `source` é do engine (nudges, checklist) ou de anexo — não é resposta.
      .filter((p): p is TextPart => p.type === 'text' && !p.source)
      .map((p) => p.text)
      .join('\n')
      .trim()
    if (!answer) return
    const aux = await resolveAuxModel({ providerId: input.providerId, modelId: input.modelId }, { sessionId: input.sessionId })
    const { text } = await generateText({
      model: aux.model,
      providerOptions: aux.providerOptions,
      system: SUGGESTION_SYSTEM,
      prompt: `User's last message:\n${input.text.slice(-1500)}\n\nAssistant's reply:\n${answer.slice(-3000)}`,
    })
    const suggestion = text.trim().split('\n')[0].replace(/^["'“]|["'”]$/g, '').trim().slice(0, 200)
    if (suggestion) emit(win, { type: 'suggestion', sessionId: input.sessionId, text: suggestion })
  } catch {
    // sugestão é cosmética; falha silenciosa
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
  return withProviderSession(input.sessionId, () => runChatTurn(win, input))
}

async function runChatTurn(win: BrowserWindow, input: SendMessageInput): Promise<void> {
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

  // Rotação de modelos: sequência resolvida no momento da chamada (ver
  // model-rotation.ts) — rotação escolhida no seletor para este chat; senão
  // o modelo pinado no chat; senão o default. `primaryModel` abaixo é o
  // primeiro da lista — usado no preprocess de anexos (decisão de visão) e
  // como fallback do loop de tentativas.
  const rotationSequence = resolveRotation(input.sessionId, {
    providerId: input.providerId,
    modelId: input.modelId,
  })
  const primaryModel = rotationSequence[0] ?? { providerId: input.providerId, modelId: input.modelId }

  // Comando /compact — compacta o histórico e não gera resposta do modelo
  if (input.text.trim() === '/compact') {
    try {
      const aux = await resolveAuxModel(
        { providerId: input.providerId, modelId: input.modelId },
        { sessionId, minContext: MIN_COMPACTION_CONTEXT },
      )
      const summary = await compactHistory(history, aux.model, aux.providerOptions)
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

  // A mensagem do usuário é emitida ANTES do pré-processamento dos anexos:
  // o preprocess de imagem com o modo Visão chama o modelo de visão (rede,
  // pode levar dezenas de segundos) — emitir só depois deixava a UI muda
  // (chat novo preso na tela vazia, chat existente sem a mensagem) até o
  // agente responder. O primeiro emit traz os anexos originais (data URL), o
  // segundo (após o preprocess) substitui pelos chips processados.
  const textPart: TextPart = {
    id: newId('prt'),
    type: 'text',
    text: input.text,
    state: 'done',
  }
  const userMessage: ChatMessage = {
    id: newId('msg'),
    role: 'user',
    parts: [...(input.files ?? []), textPart],
    createdAt: Date.now(),
    // Metadados do turno persistidos na mensagem do usuário — a tool
    // session_context os lê para responder "o que foi alterado no turno X?"
    mode: input.mode,
    permissionMode: input.options.permissionMode ?? 'ask',
    // orchestrationRole só é preenchido pelo main: num worker, quem mandou foi
    // o orquestrador. Sem a marca, foi o usuário digitando no chat do worker.
    origin: input.orchestrationRole === 'worker' ? 'orchestrator' : undefined,
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

  // Extrai texto de anexos (PDF, planilha, skill) antes de persistir — evita
  // data URLs enormes no histórico e dá ao agente acesso ao conteúdo real,
  // independente da pasta de trabalho selecionada (as tools read/glob/bash só
  // enxergam o filesystem, nunca os anexos do chat — por isso o conteúdo
  // precisa entrar como texto na própria mensagem). Imagens: modelo sem visão
  // delega para o modelo de visão configurado (modo Visão) — sob demanda, via
  // tool describe_image — ou vira aviso.
  const files = input.files ?? []
  const provider = await getProvider(primaryModel.providerId)
  const modelVision = modelSupportsVision(provider, primaryModel.modelId)
  // Registro das imagens do turno (modo Visão): a tool describe_image lê
  // daqui sob demanda; vive só durante o turno (limpo no finally).
  const turnImages: TurnImage[] = []
  if (files.length > 0) {
    const processedParts: MessagePart[] = []
    for (const file of files) {
      processedParts.push(...(await preprocessAttachment(file, {
        modelVision,
        visionModel: input.visionModel,
        language: input.language,
        sessionId,
        messageId: userMessage.id,
        turnImages,
        userText: input.text,
      })))
    }
    // Substitui a mensagem do usuário (objeto NOVO — o MessageItem é memoizado
    // por referência) pelos anexos processados e re-emite.
    const processedUserMessage: ChatMessage = { ...userMessage, parts: [...processedParts, textPart] }
    history[history.indexOf(userMessage)] = processedUserMessage
    await saveMessages(sessionId, history)
    emit(win, { type: 'message', sessionId, message: processedUserMessage })
  }
  if (input.visionModel && turnImages.length > 0) {
    registerTurnImages(sessionId, turnImages)
  }

  // Ids de stream → id da part. O adaptador de vários provedores reusa os
  // mesmos ids a cada passo do loop de ferramentas ("reasoning-0", "txt-0"), e
  // o upsert por id fazia cada passo SOBRESCREVER a part do anterior: o
  // raciocínio de 38 ações virava um bloco só no topo (o do último passo), e a
  // resposta final ocupava o lugar da primeira narração, antes das ações que
  // vieram depois. Cada start ganha um id próprio quando o do SDK já existe.
  const streamIds = new Map<string, string>()
  const startStreamPart = (sdkId: string): string => {
    let id = sdkId
    for (let n = 1; assistantMessage.parts.some((p) => p.id === id); n++) id = `${sdkId}~${n}`
    streamIds.set(sdkId, id)
    return id
  }
  const streamPartId = (sdkId: string): string => streamIds.get(sdkId) ?? sdkId

  const upsertPart = (part: MessagePart) => {
    const idx = assistantMessage.parts.findIndex((p) => p.id === part.id)
    if (idx >= 0) assistantMessage.parts[idx] = part
    else assistantMessage.parts.push(part)
    emit(win, { type: 'part', sessionId, messageId: assistantMessage.id, part })
  }

  // Imagens inseridas NESTA resposta (show_image/image_edit/svg_*).
  const turnMediaUrls = new Set<string>()
  // Proveniência do turno: filho → pai, e o que o agente marcou como entrega.
  const turnParents = new Map<string, string>()
  const turnKeep = new Set<string>()

  const removeImageParts = (mediaUrls: string[]) => {
    const set = new Set(mediaUrls)
    const before = assistantMessage.parts.length
    assistantMessage.parts = assistantMessage.parts.filter(
      (p) => !(p.type === 'image' && set.has(p.src)),
    )
    for (const url of mediaUrls) turnMediaUrls.delete(url)
    if (assistantMessage.parts.length !== before) {
      emit(win, { type: 'message', sessionId, message: assistantMessage })
    }
    // Imagem apagada de um turno ANTERIOR: sem tirar a parte do histórico, a
    // conversa ficaria com um quadrado quebrado onde havia uma foto.
    let mexeuNoHistorico = false
    for (const msg of history) {
      if (msg.id === assistantMessage.id) continue
      const antes = msg.parts.length
      msg.parts = msg.parts.filter((p) => !(p.type === 'image' && set.has(p.src)))
      if (msg.parts.length !== antes) mexeuNoHistorico = true
    }
    if (mexeuNoHistorico) {
      void saveMessages(sessionId, history)
      emit(win, { type: 'messages', sessionId, messages: history })
    }
  }

  const imageHooks: ImageToolHooks = {
    turnMediaUrls,
    removeImageParts,
    noteDerived: (childUrl, parentUrl, keep) => {
      if (parentUrl) turnParents.set(childUrl, parentUrl)
      if (keep) turnKeep.add(childUrl)
    },
  }

  /**
   * Rascunhos do turno somem no fim da resposta: do disco, da galeria e da
   * conversa. Quem decide é o runtime, porque é ele que tem o grafo das
   * chamadas — pedir ao modelo que limpasse foi o desenho anterior, e ele
   * falha justamente quando mais produz. A regra mora em selectDraftImages,
   * com os dois formatos (escada e leque) e os testes deles.
   */
  const purgeDraftImages = async () => {
    const rascunhos = selectDraftImages({
      produced: turnMediaUrls,
      parents: turnParents,
      keep: turnKeep,
    })
    if (rascunhos.length === 0) return
    const apagadas: string[] = []
    for (const url of rascunhos) {
      const id = mediaIdFromUrl(url)
      if (id && (await deleteMedia(id))) apagadas.push(url)
    }
    if (apagadas.length > 0) removeImageParts(apagadas)
  }

  // Passos concluídos na tentativa em andamento (todas as iterações de
  // auto-continue). Distingue o estouro de contexto do histórico (a primeira
  // chamada já falha) do estouro do trabalho do turno (falha depois de N
  // passos) — os remédios são outros.
  let turnSteps = 0
  // Último tamanho de contexto enviado ao medidor nesta tentativa: a
  // estimativa pré-envio só sai quando passa dele.
  let lastContextInput = 0
  const emitContext = (
    input: number,
    output: number,
    estimated?: boolean,
    cache?: { cacheRead?: number; cacheWrite?: number },
  ) => {
    emit(win, { type: 'context', sessionId, messageId: assistantMessage.id, input, output, estimated, ...cache })
  }

  try {
    // Loop de tentativas da rotação: cada tentativa usa o próximo modelo da
    // sequência. Só rotaciona falha recuperável (rate-limit/rede/moderação/
    // modelo indisponível) ANTES do primeiro token; abort e erros finais caem
    // no catch externo (comportamento atual).
    let attemptIndex = 0
    // Rodadas extras do turno inteiro (sequência da rotação de novo do início)
    // para falha transitória. Acontecem dentro do MESMO turno: a mensagem do
    // usuário não é reenviada, e o chat só mostra o erro se todas falharem.
    const maxRetryRounds = Math.max(0, input.options.retries ?? 0)
    let retryRound = 0
    for (;;) {
      const primary = rotationSequence[attemptIndex] ?? primaryModel
      // Registra o modelo desta tentativa na mensagem (badge "via X" e
      // compactação usam ChatMessage.providerId/modelId) e zera o estado do
      // turno deixado pela tentativa anterior.
      assistantMessage.providerId = primary.providerId
      assistantMessage.modelId = primary.modelId
      assistantMessage.parts = []
      assistantMessage.error = undefined
      assistantMessage.errorKind = undefined
      assistantMessage.tokens = undefined
      assistantMessage.truncated = undefined
      turnSteps = 0
      lastContextInput = 0
      emit(win, { type: 'message', sessionId, message: assistantMessage })
      try {
        const provider = await getProvider(primary.providerId)
        const model = await resolveModel(primary.providerId, primary.modelId)
        const modelVision = modelSupportsVision(provider, primary.modelId)
        const catalogModel = provider?.models[primary.modelId]
        const supportsTools = catalogModel?.tool_call !== false
        // Teto de passos e orçamento de contexto DESTE modelo: a rotação pode
        // cair num modelo de janela menor, e o corte tem que acompanhar.
        const maxSteps = maxStepsFor(catalogModel)
        const turnBudget = contextBudget(catalogModel)

    // Compactação automática: os tokens reais da última resposta indicam que o
    // contexto está perto do limite → resume o trecho antigo uma única vez.
    // O usage reportado é o sinal preferido, mas não é confiável sozinho: há
    // gateway que não devolve usage nenhum, e um turno que falhou não grava
    // `tokens`. A medida do próprio histórico entra como piso — é exatamente o
    // que será enviado, então não depende de o provedor colaborar.
    const lastTokens = [...history].reverse().find((m) => m.role === 'assistant' && m.tokens)?.tokens
    const historyTokens = estimateTokens(toModelMessages(history, modelVision))
    const { autoCompact } = getAppSettings()
    const earlyAt = autoCompact === '75' ? 0.75 : autoCompact === '50' ? 0.5 : undefined
    if (shouldCompact(lastTokens, catalogModel, historyTokens, earlyAt)) {
      try {
        const aux = await resolveAuxModel(
          { providerId: input.providerId, modelId: input.modelId },
          { sessionId, minContext: MIN_COMPACTION_CONTEXT },
        )
        const summary = await compactHistory(history, aux.model, aux.providerOptions)
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
            // Visão do modelo: decide se o panel_screenshot oferece `ver`;
            // visionModel delega a descrição quando o modelo não tem visão
            modelVision,
            visionModel: input.visionModel,
          }
        : null

    // Snapshot start: estado do filesystem antes do stream (revert per-message)
    if (toolContext) {
      // Zera o registro de saves manuais ANTES de capturar. O que a pessoa
      // salvou entre turnos já está dentro do `start` e nunca apareceria no
      // diff; mantê-lo registrado só criaria o erro inverso — o agente editar
      // esse mesmo arquivo agora e a alteração dele ser subtraída do registro.
      clearManualSaves(toolContext.directory)
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
        label: 'Coordenador',
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
        const result = await runProjectInit({
          directory: toolContext.directory,
          providerId: input.providerId,
          modelId: input.modelId,
          workerProviderId: input.workerModel?.providerId,
          workerModelId: input.workerModel?.modelId,
          force: input.text.includes('--force'),
          hooks,
          language: input.language,
          // Sem isto o botão de parar encerrava só a UI: o pipeline continuava
          // rodando os subagents até o fim, invisível.
          signal: controller.signal,
        })
        mainPart.state = 'done'
        mainPart.durationMs = Date.now() - mainStart
        upsertPart(mainPart)

        upsertPart({ id: newId('prt'), type: 'text', text: await initSummary(result), state: 'done' })
      } catch (err) {
        const cancelled = isInitAborted(err) || controller.signal.aborted
        mainPart.state = cancelled ? 'done' : 'error'
        mainPart.durationMs = Date.now() - mainStart
        upsertPart(mainPart)
        for (const part of agentParts.values()) {
          if (part.state === 'running') {
            part.state = cancelled ? 'done' : 'error'
            upsertPart(part)
          }
        }
        upsertPart({
          id: newId('prt'),
          type: 'text',
          // Cancelar é uma escolha do usuário, não uma falha. A árvore só é
          // gravada no fim, depois da revisão, então nada ficou pela metade.
          text: cancelled
            ? await mainT('init.cancelled')
            : `${await mainT('init.failed.title')}\n\n${errorToText(err)}\n\n${await mainT('init.failed.nothingSaved')}`,
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
        // O snapshot é da PASTA, não do agente: o que a pessoa salvou à mão no
        // painel durante o turno também entra no diff. Sem subtrair, o
        // registro verificado credita ao modelo um arquivo que ele nunca
        // tocou — e é essa linha que sustenta a verificação anti-overclaim.
        const manual = manualSavesUnder(toolContext.directory)
        const files = manual.size > 0 ? changes.files.filter((f) => !manual.has(f)) : changes.files
        // Só sobraram arquivos do usuário: do ponto de vista do turno, o
        // agente não escreveu nada — que é exatamente o que 'unchanged' diz.
        if (files.length === 0) return { state: 'unchanged' }
        return {
          state: 'changed',
          end,
          files,
          // O patch não é só bookkeeping: alimenta a aba Diff e a lista de
          // arquivos do card. Filtrar só `files` deixaria o arquivo do usuário
          // fora do registro e ainda visível na tela como obra do agente.
          patch: manual.size > 0 ? stripFilesFromPatch(changes.patch, manual) : changes.patch,
        }
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
          // Turno do seletor global: trocar o modo no meio da resposta vale
          // já na próxima ferramenta. Modo explícito (plano, rotina) fica fixo.
          input.options.followGlobalPermission ? () => modoGlobal(mode) : mode,
          input.sessionId,
          toolContext?.directory ?? null,
          assistantMessage.id,
          controller.signal,
          input.parentSessionId,
          input.workerTitle,
        )
      : undefined

    // Mensagens para a PRIMEIRA chamada da rodada (histórico até a última
    // mensagem do usuário). As continuações usam as mensagens de resposta
    // acumuladas do turno anterior + a instrução de continuar (padrão do
    // opencode: injetar uma "synthetic user message" e re-entrar no loop,
    // com teto de tentativas por turno).
    const initialMessages = normalizeMessages(
      toModelMessages(history.slice(0, -1), modelVision),
      interleavedReasoningField(provider, primary.modelId),
    )
    let autoContinues = 0
    let todoNudges = 0
    let overclaimNudges = 0
    let lastFinishReason: string | undefined
    let previousResponseMessages: ModelMessage[] = []
    let truncatedToolNames = ''

    for (;;) {
      const result = streamText({
        model,
        system: await buildSystemPrompt(input, modelVision),
        messages:
          autoContinues === 0 && todoNudges === 0 && overclaimNudges === 0
            ? initialMessages
            : normalizeMessages(
                [
                  ...initialMessages,
                  ...previousResponseMessages,
                  {
                    role: 'user' as const,
                    content:
                      overclaimNudges > 0
                        ? NO_CHANGES_PROMPT
                        : todoNudges > 0
                        ? TODO_COMPLETION_PROMPT
                        : truncatedToolNames
                          ? AUTO_CONTINUE_TOOL_PROMPT(truncatedToolNames)
                          : AUTO_CONTINUE_PROMPT,
                  },
                ],
                interleavedReasoningField(provider, primary.modelId),
              ),
        tools: supportsTools ? buildToolSet(input, toolContext, imageHooks, modelVision) : undefined,
        toolApproval,
        stopWhen: stepCountIs(maxSteps),
        abortSignal: controller.signal,
        providerOptions: await buildProviderOptions({ ...input, providerId: primary.providerId, modelId: primary.modelId }),
        prepareStep: ({ stepNumber, messages }) => {
          // Corte do acúmulo do tool loop. É AQUI que o contexto do turno é
          // segurado: a compactação só alcança o histórico entre turnos, e o
          // que estoura são as tool calls + resultados que o SDK reenvia a
          // cada step. Sem isto um turno longo pede milhões de tokens e o
          // provedor recusa a requisição inteira.
          const trimmed = trimTurnContext(messages, turnBudget)
          if (trimmed !== messages) {
            console.warn(
              `[context] step ${stepNumber}: contexto do turno cortado para caber em ${turnBudget} tokens`,
            )
          }
          // Medidor ao vivo: o que está prestes a sair, quando cresceu além
          // do último valor real. É o aviso que faltava num turno longo — o
          // número só se mexia no fim da resposta (ou nunca, se ela falhasse).
          const outgoing = estimateTokens(trimmed)
          if (outgoing > lastContextInput) {
            lastContextInput = outgoing
            emitContext(outgoing, 0, true)
          }
          // Reaplica a normalização de reasoning a cada passo do tool loop: o
          // SDK reconstrói as mensagens entre steps e pode descartar o
          // reasoning_content vazio retornado numa chamada de tool (DeepSeek
          // exige o campo de volta em todas as mensagens de assistente).
          const normalized = normalizeMessages(
            trimmed,
            interleavedReasoningField(provider, primary.modelId),
          )
          // Último passo EXECUTADO é maxSteps - 1: o SDK chama o prepareStep com
          // stepNumber = passos já concluídos e o do-while para quando
          // steps.length === maxSteps (isStepCount usa igualdade). Com
          // `stepNumber >= maxSteps` o guard abaixo nunca disparava — era o turno
          // terminar numa tool call sem texto.
          if (stepNumber < maxSteps - 1) return normalized === messages ? {} : { messages: normalized }
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
      // Input das tools de LIVE_OPEN_TOOLS ainda em streaming: o JSON vai
      // chegando em pedaços (tool-input-delta) e o nome do canvas/composição
      // aparece MUITO antes do modelo terminar de transmitir o HTML — abrir a
      // aba ali é o que deixa o usuário ver a peça montar ao vivo.
      const liveOpen = new Map<string, { toolName: string; json: string; opened: boolean }>()
      // Usage do último step (última chamada real ao modelo) — ao contrário do
      // total do turno (soma de todos os steps), reflete o tamanho real do
      // contexto no momento em que a resposta terminou.
      let lastStepUsage: ReturnType<typeof toStepUsage> | undefined
      // Custo somado passo a passo: a faixa de preço depende do tamanho de CADA
      // chamada (ex.: acima de 200k tokens), então o total do turno não basta.
      let turnCost: number | undefined
      let stepCount = 0

      for await (const part of result.fullStream) {
        if (!streaming) {
          streaming = true
          emit(win, { type: 'status', sessionId, status: 'streaming' })
        }

        switch (part.type) {
          case 'finish-step':
            lastStepUsage = toStepUsage(part.usage)
            {
              const price = provider?.models[primary.modelId]?.cost
              if (price) turnCost = (turnCost ?? 0) + costOfUsage(part.usage, price)
            }
            stepCount++
            turnSteps++
            // Provedor sem usage devolve zeros: aí fica valendo a estimativa.
            if (lastStepUsage.input > 0) {
              lastContextInput = lastStepUsage.input
              emitContext(lastStepUsage.input, lastStepUsage.output, false, lastStepUsage)
            }
            break
          case 'text-start':
            // Textos gerados na continuação do nudge de overclaim nascem
            // marcados como internos ('nudge'): a UI os renderiza em cor
            // apagada, nunca como resposta final. No fim do loop: arquivos
            // alterados → marcador removido (a última resposta vale como
            // final); só "nada a corrigir" → vira 'internal' e some do chat.
            //
            // O nudge de fechamento da TODO ganha um marcador próprio
            // ('todo'): o modelo responde a ele com uma linha de bookkeeping
            // ("checklist atualizado"), e sem marcador esse texto passava a
            // ser o ÚLTIMO da mensagem — a UI promovia a linha a resposta
            // final e a resposta de verdade, já escrita, ficava apagada
            // (parecia que o texto final tinha sido substituído). 'todo'
            // nunca é promovido, nem quando o turno grava arquivos.
            upsertPart({
              id: startStreamPart(part.id),
              type: 'text',
              text: '',
              state: 'streaming',
              source: overclaimNudges > 0 ? 'nudge' : todoNudges > 0 ? 'todo' : undefined,
            })
            break
          case 'text-delta': {
            const existing = assistantMessage.parts.find((p) => p.id === streamPartId(part.id))
            if (existing?.type === 'text') {
              existing.text += part.text
              emit(win, {
                type: 'part-delta',
                sessionId,
                messageId: assistantMessage.id,
                partId: existing.id,
                kind: 'text',
                delta: part.text,
              })
            }
            break
          }
          case 'text-end': {
            const existing = assistantMessage.parts.find((p) => p.id === streamPartId(part.id))
            // Saneamento do texto visível: o modelo às vezes copia os
            // marcadores internos que recebeu no contexto ("[Verified
            // record: ...]", "[SYSTEM: ...]"). Aqui a part já está completa,
            // então o upsertPart reemite o texto inteiro limpo — o que a UI
            // mostra e o que é persistido saem sem o marcador.
            if (existing?.type === 'text') {
              upsertPart({ ...existing, text: stripEngineMarkers(existing.text), state: 'done' })
            }
            break
          }
          case 'reasoning-start': {
            const id = startStreamPart(part.id)
            reasoningStart.set(id, Date.now())
            upsertPart({ id, type: 'reasoning', text: '', state: 'streaming' })
            break
          }
          case 'reasoning-delta': {
            const existing = assistantMessage.parts.find((p) => p.id === streamPartId(part.id))
            if (existing?.type === 'reasoning') {
              existing.text += part.text
              emit(win, {
                type: 'part-delta',
                sessionId,
                messageId: assistantMessage.id,
                partId: existing.id,
                kind: 'reasoning',
                delta: part.text,
              })
            }
            break
          }
          case 'reasoning-end': {
            const existing = assistantMessage.parts.find((p) => p.id === streamPartId(part.id))
            if (existing?.type === 'reasoning') {
              const started = reasoningStart.get(existing.id)
              upsertPart({
                ...existing,
                state: 'done',
                durationMs: started ? Date.now() - started : undefined,
              })
            }
            break
          }
          case 'tool-input-start':
            liveOpen.set(part.id, { toolName: part.toolName, json: '', opened: false })
            break
          case 'tool-input-delta': {
            const entry = liveOpen.get(part.id)
            if (!entry || entry.opened) break
            entry.json += part.delta
            const open = LIVE_OPEN_TOOLS[entry.toolName]
            if (!open) break
            const liveName = designNameFromInputJson(entry.json)
            if (liveName) {
              entry.opened = true
              void open(sessionId, liveName).catch(() => {})
            }
            break
          }
          case 'tool-input-end':
            liveOpen.delete(part.id)
            break
          case 'tool-call': {
            // Provedor sem streaming de input: o nome só chega aqui, no tool-call
            // completo — antes do execute, então a aba ainda abre cedo.
            const live = liveOpen.get(part.toolCallId)
            liveOpen.delete(part.toolCallId)
            const openLive = live && !live.opened ? LIVE_OPEN_TOOLS[live.toolName] : undefined
            if (openLive) {
              const name = (part.input as { name?: unknown } | undefined)?.name
              if (typeof name === 'string' && name) void openLive(sessionId, name).catch(() => {})
            }
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
          }
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
            // Modo Visão: a descrição da imagem vira texto no histórico (a
            // ToolPart não é reenviada em turnos futuros — o placeholder na
            // mensagem do usuário é substituído pela descrição real).
            if (part.toolName === 'describe_image') {
              // Só o anexo do turno tem placeholder para substituir. Uma
              // referência da galeria (orbit-media://) descreve imagem que não
              // está em mensagem nenhuma, e não há onde gravar — o número em
              // forma de texto, porém, ainda é o anexo do turno.
              const input = existing?.input as { ref?: number | string } | undefined
              const turnRef =
                typeof input?.ref === 'number'
                  ? input.ref
                  : typeof input?.ref === 'string' && /^\d+$/.test(input.ref.trim())
                    ? Number(input.ref.trim())
                    : null
              if (turnRef !== null) {
                await persistImageDescription({
                  sessionId,
                  ref: turnRef,
                  text: typeof part.output === 'string' ? part.output : JSON.stringify(part.output, null, 2),
                  history,
                  win,
                })
              }
            }
            // Transcrição de um anexo de áudio: volta para a nota do anexo.
            // Duas formas, conforme o destino escolhido pelo agente: o texto
            // (no contexto) ou só onde ele está (documento para o usuário).
            if (part.toolName === 'audio_transcribe') {
              const ref = (existing?.input as { ref?: string } | undefined)?.ref ?? ''
              const audioId = audioIdFrom(ref)
              const output = part.output as { documentId?: string } | string
              const body =
                typeof output === 'string' && output.startsWith('Transcript of the audio')
                  ? `(Attachment, not a user message — already transcribed with audio_transcribe.)\n\n${output}`
                  : typeof output === 'object' && output?.documentId
                    ? `(Attachment, not a user message. Its transcript was delivered to the user as document ${output.documentId} and is NOT in your context — call read_document with that id if you need it.)`
                    : null
              if (audioId && body) await persistAudioTranscript({ sessionId, audioId, body, history, win })
            }
            // Áudio gerado: um player na resposta, como a imagem do show_image.
            if (part.toolName === 'audio_generate') {
              const output = part.output as { audioUrl?: string; title?: string; durationMs?: number } | string
              if (typeof output === 'object' && output?.audioUrl) {
                upsertPart({
                  id: `${part.toolCallId}-audio`,
                  type: 'audio',
                  src: output.audioUrl,
                  title: output.title || undefined,
                  durationMs: output.durationMs,
                })
                // Liga o registro do acervo à mensagem ("abrir no chat" da galeria).
                void attachMediaMessage(output.audioUrl, assistantMessage.id, sessionId)
              }
            }
            // Vídeo renderizado/mostrado: player na resposta. O arquivo segue
            // no projeto; o resultado traz a URL orbit-video:// já registrada.
            if (
              part.toolName === 'video_render' ||
              part.toolName === 'motion_render' ||
              part.toolName === 'browser_record' ||
              part.toolName === 'show_video'
            ) {
              const output = part.output as { videoUrl?: string; title?: string; durationMs?: number; path?: string } | string
              if (typeof output === 'object' && output?.videoUrl) {
                upsertPart({
                  id: `${part.toolCallId}-video`,
                  type: 'video',
                  src: output.videoUrl,
                  title: output.title || undefined,
                  durationMs: output.durationMs,
                  path: output.path,
                })
              }
            }
            // show_image e image_edit: a imagem vira parte da resposta
            // (renderizada pelo ai/image). No image_edit isso é o ponto — uma
            // edição descrita em texto obrigaria o usuário a abrir a galeria
            // para saber se o recorte do fundo ficou bom.
            if (
              part.toolName === 'show_image' ||
              part.toolName === 'image_edit' ||
              part.toolName === 'svg_create' ||
              part.toolName === 'svg_vectorize' ||
              part.toolName === 'svg_edit'
            ) {
              const output = part.output as { mediaUrl?: string; alt?: string } | string
              if (typeof output === 'object' && output?.mediaUrl) {
                upsertPart({
                  id: `${part.toolCallId}-img`,
                  type: 'image',
                  src: output.mediaUrl,
                  alt: output.alt || undefined,
                })
                turnMediaUrls.add(output.mediaUrl)
                // Completa o registro de mídia: a tool não conhece o id da
                // mensagem (roda no meio do turno) — a galeria usa esse
                // vínculo para o "abrir no chat".
                void attachMediaMessage(output.mediaUrl, assistantMessage.id, sessionId)
              }
            }
            // image_import: as imagens que o agente trouxe de um acervo aberto
            // aparecem na resposta, uma parte para cada. Ficam FORA do turnMediaUrls
            // de propósito: aquele conjunto é o dos degraus de uma edição, que
            // somem no fim do turno — e uma foto escolhida não é um degrau.
            if (part.toolName === 'image_import') {
              const output = part.output as { images?: Array<{ mediaUrl: string; alt?: string }> } | string
              if (typeof output === 'object' && Array.isArray(output?.images)) {
                output.images.forEach((image, index) => {
                  upsertPart({
                    id: `${part.toolCallId}-img-${index}`,
                    type: 'image',
                    src: image.mediaUrl,
                    alt: image.alt || undefined,
                  })
                  void attachMediaMessage(image.mediaUrl, assistantMessage.id, sessionId)
                })
              }
            }
            // create_artifact/update_artifact: o HTML vira parte da resposta
            // (renderizada pelo ai/artifact-part). O update emite uma part NOVA
            // no turno atual em vez de mexer na mensagem antiga: o arquivo é o
            // mesmo, então o card antigo passa a mostrar a versão nova sozinho
            // — o que a part nova marca é ONDE na conversa a mudança foi feita.
            if (part.toolName === 'create_artifact' || part.toolName === 'update_artifact') {
              const output = part.output as
                | { artifactId?: string; url?: string; title?: string; thumb?: string; revision?: number }
                | string
              if (typeof output === 'object' && output?.artifactId && output.url) {
                upsertPart({
                  id: `${part.toolCallId}-artifact`,
                  type: 'artifact',
                  src: output.url,
                  artifactId: output.artifactId,
                  title: output.title || output.artifactId,
                  thumb: output.thumb,
                  revision: output.revision,
                })
                void attachArtifactMessage(output.artifactId, assistantMessage.id, sessionId)
              }
            }
            // create_document/update_document: o documento vira parte da
            // resposta (renderizado pelo ai/document-part). Mesmo contrato do
            // artefato: a mensagem persiste a URL do preview, nunca o conteúdo.
            if (
              part.toolName === 'create_document' ||
              part.toolName === 'update_document' ||
              // Transcrição entregue ao usuário: é um documento do chat.
              part.toolName === 'audio_transcribe' ||
              part.toolName === 'docx_edit' ||
              part.toolName === 'pdf_merge' ||
              part.toolName === 'pdf_transform' ||
              part.toolName === 'pdf_form_fill'
            ) {
              const output = part.output as
                | {
                    documentId?: string
                    previewUrl?: string
                    title?: string
                    formats?: ('pdf' | 'docx')[]
                    thumb?: string
                    revision?: number
                  }
                | string
              if (typeof output === 'object' && output?.documentId && output.previewUrl) {
                upsertPart({
                  id: `${part.toolCallId}-document`,
                  type: 'document',
                  documentId: output.documentId,
                  title: output.title || output.documentId,
                  previewSrc: output.previewUrl,
                  formats: output.formats ?? [],
                  thumb: output.thumb,
                  revision: output.revision,
                })
                void attachDocumentMessage(output.documentId, assistantMessage.id, sessionId)
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
              error: takeDenialReason(part.toolCallId) ?? 'Action denied by the permission policy.',
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
              // Com os passos já somados, o custo vem deles; sem nenhum passo
              // (provedor que não reporta), cai no total do turno.
              const price = provider?.models[primary.modelId]?.cost
              const stepTokens = toTokenUsage(part.totalUsage, turnCost === undefined ? price : undefined)
              if (turnCost !== undefined) stepTokens.cost = turnCost
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
            if (stepCount >= maxSteps && part.finishReason !== 'stop') {
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
        autoContinues < getAppSettings().autoContinues
      ) {
        autoContinues++
        for (const pending of pendingToolCalls) {
          upsertPart({
            ...pending,
            state: 'error',
            error: 'Tool call cut off by the output token limit — not executed.',
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

      // Sinal de que a última parte é um texto concluído — usado pelo nudge
      // de overclaim abaixo.
      const lastPart = assistantMessage.parts[assistantMessage.parts.length - 1]
      const lastPartIsDoneText = lastPart?.type === 'text' && lastPart.state === 'done'

      // Nudge de overclaim: a resposta afirma ter feito algo e o snapshot
      // prova que nada foi escrito — cobre o caso em que o agente relata
      // conclusão sem ter tocado em nenhum arquivo.
      //
      // Só cobra em turnos que USARAM ferramentas de escrita: sem nenhuma
      // delas (pergunta informativa respondida só com leitura/texto), verbos
      // de conclusão descrevem trabalho de turnos anteriores — o usuário
      // pediu explicitamente que essa verificação não vire resposta final.
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
          usedFileWritingTools(assistantMessage.parts) &&
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
        if (part.type === 'text') part.text = stripEngineMarkers(part.text)
        part.state = 'done'
      }
      // Backstop: uma tool-call sem resultado que não foi pega pelo ramo de
      // auto-continue acima (ex.: teto de continuações esgotado com
      // finish_reason 'length') ficaria 'running' para sempre — e o acordeon
      // de ações (TaskGroup) lê isso como "ainda trabalhando": shimmer e
      // "Working" eternos mesmo com o turno já encerrado e salvo.
      if (part.type === 'tool' && part.state === 'running') {
        part.state = 'error'
        part.error = 'Tool call has no result — the turn ended before it finished.'
      }
    }
    // Degraus da escada saem antes de a resposta ser gravada: o que fica é o
    // resultado, não o caminho até ele.
    await purgeDraftImages()
    assistantMessage.completedAt = Date.now()
    // TODO não fechada ao final do turno → lembrete persistente para o
    // próximo turno (messageContextText reemite o aviso via todoReminder).
    if (hasTodoInProgress(assistantMessage.parts)) assistantMessage.todoReminder = true
    // Persiste a mensagem primeiro para que o usuário a veja o quanto antes
    await saveMessages(sessionId, history)
    // Veredito do turno: reaproveita o que o loop já calculou (só recaptura se
    // o turno saiu por outro caminho — abort, teto de passos).
    const endSnapshot = verification ?? (await verifyTurn())
    // Textos do nudge de overclaim: se o modelo de fato gravou arquivos depois
    // do aviso, deixam de ser internos — a última resposta volta a ser a
    // resposta final (branca). Sem alterações, dois desfechos: a resposta ao
    // nudge foi só a confirmação de que não havia nada a corrigir (falso
    // positivo do gatilho — ex.: o texto descrevia trabalho de um turno
    // anterior) → vira 'internal' e a UI nem renderiza; ou houve uma correção
    // real ("Correção: …") → permanece 'nudge', visível em cor apagada.
    if (endSnapshot.state === 'changed') {
      // Promove SÓ o último texto do nudge: é ele que carrega a resposta real
      // pós-correção (trabalho feito + "Correção: …"). Os anteriores seguem
      // 'nudge' (apagados) — varrer todos abria caminho para o texto do nudge
      // que não é a resposta final virar branco. Se o último não foi correção
      // de verdade ("Nada a corrigir.") mas o snapshot mudou por outra via
      // (ex.: ferramentas do próprio nudge gravaram algo), também não promove:
      // linha de verificação interna nunca vira resposta final.
      const lastNudgeText = [...assistantMessage.parts]
        .reverse()
        .find((p): p is TextPart => p.type === 'text' && p.source === 'nudge')
      if (lastNudgeText) {
        lastNudgeText.source = isNoCorrectionReply(lastNudgeText.text) ? 'internal' : undefined
      }
    } else if (overclaimNudges > 0) {
      const lastNudgeText = [...assistantMessage.parts]
        .reverse()
        .find((p): p is TextPart => p.type === 'text' && p.source === 'nudge')
      if (lastNudgeText && isNoCorrectionReply(lastNudgeText.text)) {
        for (const part of assistantMessage.parts) {
          if (part.type === 'text' && part.source === 'nudge') part.source = 'internal'
        }
      }
    }
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
    // Notificação nativa (janela fora de foco + prefs habilitada)
    void notifyNewMessage(sessionId, assistantMessage)

    // Workers já nascem com título (task.title) — não sobrescrever
    if (isFirstExchange && input.orchestrationRole !== 'worker') void generateTitle(input, win)
    // Sugestão só faz sentido para quem está conversando: workers e rotinas
    // não têm ninguém digitando a próxima mensagem.
    if (getAppSettings().promptSuggestions && !input.orchestrationRole && !assistantMessage.error) {
      void generateSuggestion(input, assistantMessage, win)
    }
        break
      } catch (err) {
        // Tentativa falhou: rotaciona se a falha é recuperável e ainda não
        // emitiu conteúdo (v1 não reenvia tokens já entregues). Abort e erros
        // finais sobem para o catch externo — comportamento atual.
        const aborted = controller.signal.aborted
        const { kind } = classifyProviderError(err)
        const nextIndex = attemptIndex + 1
        if (
          !aborted &&
          !hasStreamedContent(assistantMessage.parts) &&
          isRecoverableErrorKind(kind) &&
          nextIndex < rotationSequence.length
        ) {
          attemptIndex = nextIndex
          emit(win, {
            type: 'status',
            sessionId,
            status: 'fallback',
            fallback: { current: nextIndex + 1, total: rotationSequence.length },
          })
          continue
        }
        if (
          !aborted &&
          !hasStreamedContent(assistantMessage.parts) &&
          isTransientErrorKind(kind) &&
          retryRound < maxRetryRounds
        ) {
          retryRound++
          attemptIndex = 0
          emit(win, {
            type: 'status',
            sessionId,
            status: 'fallback',
            fallback: { current: retryRound + 1, total: maxRetryRounds + 1, retry: true },
          })
          await waitUnlessAborted(retryDelay(retryRound), controller.signal)
          // Parado durante a espera: cai no catch externo como abort (idle)
          if (controller.signal.aborted) throw err
          continue
        }
        if (retryRound > 0) assistantMessage.attempts = retryRound + 1
        throw err
      }
    }
  } catch (err) {
    const aborted = controller.signal.aborted
    const classified = classifyProviderError(err)
    const message = classified.detail
    // Estouro depois de passos concluídos: o histórico coube na primeira
    // chamada, quem passou da janela foi o acúmulo do turno. Compactar não
    // alcança isso — a orientação certa é outra (ver context-length-turn).
    const kind = classified.kind === 'context-length' && turnSteps > 0 ? 'context-length-turn' : classified.kind
    assistantMessage.error = aborted ? undefined : message
    assistantMessage.errorKind = aborted || kind === 'unknown' ? undefined : kind
    for (const part of assistantMessage.parts) {
      if ((part.type === 'text' || part.type === 'reasoning') && part.state === 'streaming') {
        if (part.type === 'text') part.text = stripEngineMarkers(part.text)
        part.state = 'done'
      }
      // tool-call chegou mas tool-result/tool-error nunca veio — abort no meio
      // da execução, ou a conexão caiu antes do resultado. Sem isto a part
      // fica 'running' para sempre, e o acordeon de ações (TaskGroup) lê isso
      // como "ainda trabalhando": shimmer e "Working" eternos mesmo com o
      // turno já encerrado.
      if (part.type === 'tool' && part.state === 'running') {
        part.state = 'error'
        part.error = aborted ? 'Interrupted.' : (message ?? 'Execution did not finish.')
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
      // Vai junto para o mobile traduzir o aviso: o texto cru é diagnóstico.
      errorKind: aborted ? undefined : assistantMessage.errorKind,
    })
    // Falha real (não aborto manual) → notificação nativa de erro
    if (!aborted) void notifyChatError(sessionId, message ?? '', assistantMessage.errorKind)
  } finally {
    clearTurnImages(sessionId)
    // Fim do turno = fim do controle do computador: some o indicador, solta o
    // atalho de pânico e devolve as flags de acessibilidade dos apps.
    endActivity(sessionId)
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

/**
 * Compactação manual acionada pelo botão na UI.
 *
 * Com um turno da conversa em andamento ela NÃO roda: ela lê o histórico do
 * disco, insere o resumo, grava e reemite a lista inteira — e o turno, que tem
 * a própria cópia do histórico, grava por cima no fim. Era o que acontecia: a
 * lista reemitida não tinha a mensagem que o usuário acabara de mandar (a bolha
 * sumia da tela), o resumo chegava ao renderer como "a resposta" (e o modo
 * chamada o lia em voz alta), e no fim o turno apagava o resumo do disco. A
 * compactação automática roda DENTRO do turno, com a cópia certa.
 */
export async function compactSession(
  win: BrowserWindow,
  sessionId: string,
): Promise<{ compacted: boolean; reason?: 'running' }> {
  if (abortControllers.has(sessionId)) return { compacted: false, reason: 'running' }
  await withProviderSession(sessionId, () => compactSessionTurn(win, sessionId))
  return { compacted: true }
}

async function compactSessionTurn(win: BrowserWindow, sessionId: string): Promise<void> {
  const history = await loadMessages(sessionId)
  const lastAssistant = [...history].reverse().find((m) => m.role === 'assistant' && m.providerId)
  const providerId = lastAssistant?.providerId
  const modelId = lastAssistant?.modelId
  if (!providerId || !modelId) return

  try {
    const aux = await resolveAuxModel({ providerId, modelId }, { sessionId, minContext: MIN_COMPACTION_CONTEXT })
    const summary = await compactHistory(history, aux.model, aux.providerOptions)
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
