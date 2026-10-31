import { generateText, stepCountIs, streamText, type ModelMessage, type UserContent } from 'ai'
import fs from 'node:fs/promises'
import { basename } from 'node:path'
import type { BrowserWindow } from 'electron'
import type {
  AgentPart,
  ChatEvent,
  CatalogModel,
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
  modelFileParts,
  StorageKeys,
  toolLimitFor,
  type QuotePayload,
} from '@shared/chat'
import { isRoutineSessionId } from '@shared/routines'
import { getProvider, modelSupportsVision } from './catalog'
import { resolveTitle, titleFromAttachmentNames, titleFromUserText, truncateTitle } from './chat-title'
import {
  compactHistory,
  countSummaries,
  findLastSummaryIndex,
  generateContinuationBrief,
  shouldCompact,
  SUMMARY_PREFIX,
} from './compaction'
import { estimateTokens, maxStepsFor } from './context-budget'
import { createStepPreparer } from './agent-step'
import { manualSavesUnder, stripFilesFromPatch } from './manual-saves'
import { createToolApproval, takeDenialReason } from './permission'
import { MESSAGES, t as mainT } from './i18n'
import { classifyProviderError, errorToText, isRecoverableErrorKind, isTransientErrorKind } from './errors'
import { selectDraftImages } from './image-drafts'
import { hasStreamedContent, resolveRotation, retryDelay, waitUnlessAborted } from './model-rotation'
import { buildSystemPrompt, ensureSkillsBlock, promptMemoryIds, promptSkillSlugs, skillDeltaTurnBlock } from './prompts'
import { createTurnEmbedder, type TurnEmbedder } from './memory/embedding'
import { loadSkills } from './skills'
import { skillHash, slugsUsedInSession, usageScope } from './skills/meta'
import { snapshotOf } from './skills/mention'
import { renderSkillHints, resolveHintMode, skillHintsForTurn, skillMentionTurnBlock } from './skills/turn'
import { subchatsTurnBlock } from './subchats'
import { retrieveForTurn } from './memory/service'
import { renderMemorySuggestions } from './memory/retrieval'
import { buildProviderOptions, interleavedReasoningField, normalizeMessages } from './reasoning'
import { resolveModel } from './providers'
import { withProviderSession } from './provider-session'
import { bindMediaJournal, closeMediaJournal, runWithMediaJournal } from './session/media-journal'
import { retryContextNote } from './session/retry-note'
import { coveredBy, currentTurnWrites, runWithWriteScope } from './session/write-journal'
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
import { stripLeakedReasoning } from '@shared/leaked-reasoning'
import sharp from 'sharp'
import { claimsCompletion, claimsImageLook, claimsScreenWork, isNoCorrectionReply } from './overclaim'
import { describeFrontScreen, prefetchedScreenBlock, readFrontWindowText, recentOverlayHistory, wantsScreen } from './overlay/turn-context'
import {
  documentKindOf,
  pageLabel,
  type DocumentKind,
  type DocumentPage,
} from './document-pages'
import { readSessionDocument, saveSessionDocument, type SessionDocument } from './session-documents'
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
import { agentMayControlComputer, getAppSettings } from './app-settings'
import { COMPACT_SUGGEST_AFTER } from '@shared/app-settings'
import { isComputerAvailable } from './computer'
import { audioExt, audioIdFrom, isAudioFile, saveAudio } from './audio-store'
import { isVideoFile, saveVideoAttachment, videoAttachmentExt, videoPathFromFileUrl } from './attachment-ref'
import { imageRefLine, posterDataUrl, probeVideoAttachment, videoAttachmentNote } from './video/attachment-note'
import { addVideoToGallery } from './video/video-gallery'
import { MIN_COMPACTION_CONTEXT, resolveAuxModel } from './aux-model'
import { notifyChatError, notifyNewMessage } from './notifications'
import type { ImageToolHooks, ToolContext, TurnSnapshot } from './tools'
import { buildCatalog } from './tools/catalog-turn'
import { DEFAULT_ACTIVE_FAMILIES, buildMap, type ToolFamily } from './tools/catalog'
import { deriveActive, familiesMentionedInText, priorToolCalls } from './tools/active'
import { queryFamily } from './tools/load'
import { recordTurn } from './tools/metrics'
import { hoistToolImages } from './tool-images'
import { endActivity } from './computer/session'
import { designNameFromInputJson, openDesignLive } from './tools/design'
import { openMotionLive } from './tools/motion'
import { reopenMotion } from './video/motion-open'
import { registerMotionCover } from './video/motion-gallery'
import { MAX_PROJECT_ZIP_BYTES, importMotionProject, readMotionProject } from './video/motion-project'
import { addTokenUsage, costOfUsage, toStepUsage, toTokenUsage } from './usage'
import { engineAnnotations, stripEngineMarkers } from './todo-context'
import { forwardChatEvent } from './companion-server'
import { forwardToOverlay, getOverlayWindow } from './overlay/window'
import { globalMode } from './permission/global-mode'
import { perfSpan } from './perf'

// Tools whose input (still streaming) opens the matching tab LIVE, as
// soon as the `name` field shows up in the JSON — before the model ends
// streaming the payload (the artboards' or the composition's HTML). The
// tool's final report() stays as it is; this only brings the opening forward.
const LIVE_OPEN_TOOLS: Record<string, (sessionId: string, name: string) => Promise<void>> = {
  design_write: openDesignLive,
  design_edit: (sessionId, name) => openDesignLive(sessionId, name, { placeholder: false }),
  motion_write: openMotionLive,
  motion_edit: (sessionId, name) => openMotionLive(sessionId, name, { placeholder: false }),
}

/**
 * Chat engine ported from opencode's session processor: turns the persisted
 * history into model messages, runs the streamText loop with tools and emits
 * incremental events to the renderer over IPC.
 */

// Safety ceiling, not a normal operational limit — opencode (where this
// engine was ported from) runs with no ceiling by default (agent.steps ?? Infinity)
// and only stops when the model decides (finishReason === 'stop'). 50 was
// too low: real coding tasks go past that and the stream cut mid-way,
// indistinguishable from a normal conclusion. The ceiling now comes from
// `maxStepsFor` (context-budget), which scales it by the model's context:
// one with a small window has nothing to do with 300 trips to the provider.
// It exists only so a pathological loop does not run forever — the context
// overflow is held by trimTurnContext in prepareStep.
// Nudge on the last allowed step — same idea as opencode's MAX_STEPS_PROMPT
// (packages/core/src/session/runner/max-steps.ts): instead of
// cutting the stream in the middle of a tool call, it disables the tools and forces the
// model to summarize in text what it did and what is left. `truncated` (below)
// becomes a rare backstop, not the common path.
const MAX_STEPS_PROMPT = `MAXIMUM STEPS REACHED for this turn. Tools are now disabled — respond with text ONLY.

Your response must:
- State that the step limit was reached
- Summarize what was accomplished so far
- List any remaining pending items
- Suggest what to do next (the user can say "continue" to resume)`

// Auto-continue when the model hits the OUTPUT TOKEN limit
// (finish_reason "length") — opencode's default (#17471/#18108): the
// answer was CUT, not finished; the turn runs again with a request for
// continuation and the full context, capped per turn. Without this, the stream
// cut in the middle of a text/tool call silently, indistinguishable from
// a normal conclusion — the root cause of the "answers interrupted out of nowhere".
const AUTO_CONTINUE_PROMPT = `[SYSTEM: the previous reply was cut off by the model's output token limit (finish_reason "length") — this is NOT the end of the turn. Continue exactly from where you left off: resume mid-sentence if the cut happened mid-sentence, do NOT repeat what was already written, do NOT restart the answer, and do NOT append a closing summary — the text you produce now is displayed as the direct continuation of the previous text, together forming one single answer. If you were mid-task, complete it.]`
const AUTO_CONTINUE_TOOL_PROMPT = (toolNames: string) => `[SYSTEM: the previous reply was cut off by the model's output token limit (finish_reason "length") in the middle of a ${toolNames} tool call. That tool call was NOT executed. Do NOT retry it as one giant operation — split it into smaller operations (smaller file writes, shorter commands, less data per call) and continue from where you left off.]`
// TODO-closing nudge: the turn ended on 'stop' but the model did not
// send the list back marking the items as completed (the checkboxes stay with
// an endless spinner in the UI). We re-enter the loop with a synthetic user
// message asking to settle the state — same pattern as auto-continue,
// with a per-turn cap so it does not become a loop.
const MAX_TODO_NUDGES = 2
const TODO_COMPLETION_PROMPT = `[SYSTEM: your reply ended, but the last TODO list still has items marked as "in_progress". If you actually completed them, re-send the TODO list marking those items as "completed" (do NOT repeat the work summary — just update the checklist). If they are truly still not finished, say so briefly. Do not end the turn again without resolving the TODO state.]`
/**
 * Overclaim nudge: the turn ended claiming work done, but the
 * snapshot proves that NO file changed — the classic overclaim is the turn
 * that reports completion without having called write/edit at all and still
 * claims to have done something.
 */
const MAX_OVERCLAIM_NUDGES = 1

/**
 * The screen has no filesystem snapshot that proves anything: what proves it is the tool
 * call. A turn that talks about having looked at or acted on the screen without calling
 * any of these made it up — seen in a fast model in voice mode, which
 * answered "I opened TextEdit and wrote hi" with no tool call at all.
 */
const SCREEN_TOOL_PREFIXES = ['cu_', 'see_']
const SCREEN_TOOL_NAMES = new Set(['computer_task'])
function usedScreenTools(parts: MessagePart[]): boolean {
  return parts.some(
    (p) => p.type === 'tool' && (SCREEN_TOOL_NAMES.has(p.tool) || SCREEN_TOOL_PREFIXES.some((prefix) => p.tool.startsWith(prefix))),
  )
}

const NO_SCREEN_TOOL_PROMPT = `[SYSTEM: automatic verification — you called NO screen tool in this turn (no see_screen, see_window_text, see_selection, cu_* or computer_task). Anything your reply says you saw on the screen, or did in an app (opened, clicked, typed, sent), did not happen, and anything it says about how a capture came out is a guess. Either do it now with the tools and answer from their results, or correct the claim in one short sentence. If your reply made no such claim, reply ONLY with the single line: NOTHING_TO_FIX — nothing else.]`
const NO_CHANGES_PROMPT = `[SYSTEM: automatic verification — NO file was modified in this turn. The filesystem snapshot taken before your response is identical to the one taken now; this is measured by the engine, not inferred. If your reply claims you created, edited, fixed, removed or refactored anything, that claim is false. Either do the work now with the write/edit tools (then end with your normal final answer), or correct the claim briefly in 1-2 sentences, in the language of the conversation. Do not repeat the full answer and do not produce a new concluding text unless you actually changed files. If your reply made no false claim (e.g. it only described work from previous turns or answered a question), reply ONLY with the single line: NOTHING_TO_FIX — nothing else.]`

/**
 * Tools that can write to the working directory — verifyTurn's snapshot
 * covers that directory, so charging overclaim only makes sense in
 * turns that used them. A conclusion text in a turn without any of them (e.g.
 * an informative question answered with reading only or plain text) describes
 * work from previous turns, not from this one — charging would be noise. MCP is in
 * out of conservatism: the engine does not know each server's capabilities.
 */
const WRITE_TOOL_NAMES = new Set(['write', 'edit', 'bash', 'bash_background', 'panel_screenshot'])
function usedFileWritingTools(parts: MessagePart[]): boolean {
  return parts.some(
    (p) => p.type === 'tool' && (WRITE_TOOL_NAMES.has(p.tool) || p.tool.startsWith('mcp__')),
  )
}

/** Verdict of the turn's snapshot comparison (see verifyTurn in runChat). */
type TurnVerification =
  | { state: 'changed'; end: string; files: string[]; patch: string }
  // `end` present when the folder CHANGED (panel manual saves only): the
  // verdict is "the agent did not write", but the revert still needs the final
  // tree to undo without touching what the person saved.
  | { state: 'unchanged'; end?: string }
  | { state: 'unknown'; error?: string }
const abortControllers = new Map<string, AbortController>()
// Active bash command per session (diagnostics): filled on the tool-call and
// cleared on the tool-result/error — abortChat logs the command that was running
// when the user pressed stop, and the finally reports whether it may have stayed alive.
const activeBashCommands = new Map<string, string>()

/** true when the message's last todowrite has "in_progress" items —
 * the task card would keep an endless spinner if the turn ends like this. */
function hasTodoInProgress(parts: MessagePart[]): boolean {
  const todo = [...parts]
    .reverse()
    .find((p): p is ToolPart => p.type === 'tool' && p.tool === 'todowrite' && p.state === 'done')
  const items = (todo?.input?.items ?? []) as { status?: string }[]
  return items.some((i) => i.status === 'in_progress')
}

/** Final message of /init: what was written to the tree, or why nothing was.
 *  It is product text for the user, so it follows the app's language. */
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

/** Decodes the payload of a data URL as UTF-8 text. */
function decodeDataUrlText(url: string): string | null {
  const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(url)
  if (!match) return null
  try {
    return match[2] ? Buffer.from(match[3], 'base64').toString('utf8') : decodeURIComponent(match[3])
  } catch {
    return null
  }
}

/** Decodes the payload of a data URL as bytes (for binary formats: ZIP, spreadsheets). */
function decodeDataUrlBytes(url: string): Buffer | null {
  const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(url)
  if (!match) return null
  try {
    return match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]), 'utf8')
  } catch {
    return null
  }
}

/**
 * Is the attachment a composition PROJECT exported from the Motion tab? The `.zip` is the
 * hint (name or mime); what confirms it is the manifest inside, in
 * `readMotionProject`. Above the import ceiling it does not even try: decoding a
 * base64 that size costs the whole app's memory.
 */
function isMotionProjectAttachment(file: FilePart, filename: string): boolean {
  const zip = /\.zip$/i.test(filename) || /zip/i.test(file.mime ?? '')
  if (!zip) return false
  // base64 grows ~4/3: above the ceiling it is not even worth decoding.
  return file.url.length <= Math.ceil(MAX_PROJECT_ZIP_BYTES * 1.4) + 1024
}

const PDF_EXT = /\.pdf$/i
const TEXT_MIME = /^(text\/|application\/(json|xml|javascript|typescript|yaml|toml|x-sh|sql))/
// Fallback by extension: browsers sometimes report an empty mime or
// "application/octet-stream" for .md/.skill/.csv on Windows.
const TEXT_EXT_FALLBACK = /\.(md|markdown|txt|log|csv|yaml|yml|toml|env|ini|conf|skill)$/i
const SPREADSHEET_MIME = /^application\/(vnd\.ms-excel|vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|vnd\.oasis\.opendocument\.spreadsheet)$/
const SPREADSHEET_EXT = /\.(xlsx?|ods)$/i
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const DOCX_EXT = /\.docx$/i
const SKILL_LIKE_EXT = /\.(skill|md|markdown)$/i

/**
 * Below this size the document goes WHOLE into the message, as before.
 * Paginating a two-page attachment would only trade cheap context for a round
 * trip of the tool — the cost of pagination only pays off when the document is
 * big enough to weigh on every following turn.
 */
const INLINE_DOC_CHARS = 8000
/** Pages of the opening excerpt of a large document. */
const PREVIEW_PAGES = 2

/** Is the attachment a pageable document? It combines the MIME (when the browser
 *  reports it) with the extension (when it sends octet-stream). */
function attachmentDocumentKind(mime: string, filename: string): DocumentKind | null {
  if (mime === 'application/pdf' || PDF_EXT.test(filename)) return 'pdf'
  if (mime === DOCX_MIME || DOCX_EXT.test(filename)) return 'docx'
  if (SPREADSHEET_MIME.test(mime) || SPREADSHEET_EXT.test(filename)) return 'spreadsheet'
  return documentKindOf(filename)
}

/**
 * Text that represents the document in the message. Small goes whole; large
 * goes as an opening excerpt plus the instruction on how to reach the rest.
 *
 * This text is persisted and resent on every turn, so it is exactly what
 * needs to stay small — this is where the saving happens.
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

/** Converts an attachment (FilePart) into model content: image/PDF native,
 * text files become inline text; the rest becomes just a note. Used only
 * for persisted HISTORY — new attachments are preprocessed in
 * `preprocessAttachment` before reaching here (see runChat). */
function fileToModelContent(file: FilePart, modelVision: boolean): Exclude<UserContent, string>[number] {
  if (file.mime.startsWith('image/')) {
    // A `file` part, not `image`: the ai-sdk deprecated the `image` type and warns in
    // the terminal on every attachment. The `file` part with an image mediaType is the
    // replacement, and the providers receive it the same way.
    if (modelVision) return { type: 'file', data: file.url, mediaType: file.mime }
    // Model without vision (history): text note — the description, when
    // it exists, is already in the sibling TextPart generated in preprocessAttachment.
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

/** Text that the user/model wrote in a message (no attachment chips). */
function turnText(message: ChatMessage): string {
  return message.parts
    .filter((p): p is TextPart => p.type === 'text' && !p.source)
    .map((p) => p.text)
    .join('\n')
    .trim()
}

/**
 * What the turn adds about skills, in the user message and never the system prompt (which
 * is frozen for the cache prefix): the body of what `@slug` cited, the note when the set of
 * skills changed after the prompt was built, and the spontaneous hints. Workers only get
 * the `@slug` body. Never throws: skills are auxiliary context.
 */
async function skillsTurnBlock(
  input: SendMessageInput,
  recent: Array<{ role: 'user' | 'assistant'; text: string }>,
  embed: TurnEmbedder,
): Promise<string> {
  try {
    // Loaded once: the mention needs the bodies and the frozen index is built from this list.
    const skills = await loadSkills(input.mode === 'code' ? input.directory : undefined)
    // A worker's use belongs to the main conversation, never to its own session.
    const sessionId = input.parentSessionId ?? input.sessionId
    const scope = await usageScope(input.mode, input.directory)
    const mention = await skillMentionTurnBlock(input.text, skills, { sessionId, scope })
    if (input.orchestrationRole === 'worker') return mention.block
    // The index freezes on the first turn; the hints need to know what level 1 already shows.
    await ensureSkillsBlock(input, skills)
    const delta = skillDeltaTurnBlock(input.sessionId, input.mode, input.directory, snapshotOf(skills, skillHash))
    const hints = renderSkillHints(
      await skillHintsForTurn({
        text: input.text,
        recent,
        skills,
        indexed: promptSkillSlugs(input.sessionId, input.mode, input.directory),
        mentioned: mention.slugs,
        opened: slugsUsedInSession(sessionId),
        sessionId,
        mode: resolveHintMode(input.options.skillHints),
        embed,
      }),
    )
    return [mention.block, delta, hints].filter(Boolean).join('\n\n')
  } catch (err) {
    console.error('[skills] turn block failed:', err)
    return ''
  }
}

/** Last turns of the conversation, to disambiguate a short message. */
function recentTurns(history: ChatMessage[]): Array<{ role: 'user' | 'assistant'; text: string }> {
  return history
    // The last two are the CURRENT turn (the question and the still-empty assistant).
    .slice(0, -2)
    .slice(-6)
    .map((m) => ({ role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const), text: turnText(m) }))
    .filter((turn) => turn.text.length > 0)
}

/**
 * Glues the memory block at the END of the last user message.
 *
 * At the end, and not at the beginning, because the user's question is what the model
 * needs to read last before answering; and in the message, and not in the system
 * prompt, because the system is frozen per session and the providers' prefix cache
 * depends on that.
 */
function withMemoryBlock(messages: ModelMessage[], block: string): ModelMessage[] {
  if (!block) return messages
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'user') return messages
  if (typeof last.content === 'string') {
    return [...messages.slice(0, -1), { ...last, content: `${last.content}\n\n${block}` }]
  }
  const parts = Array.isArray(last.content) ? last.content : []
  return [
    ...messages.slice(0, -1),
    { ...last, content: [...parts, { type: 'text' as const, text: block }] } as ModelMessage,
  ]
}

/** Attachment chip without the original data URL (avoids duplicating large bytes in
 * the history — the content already goes as text in the TextPart that accompanies
 * this chip). For images, `thumbUrl` carries a reduced thumbnail just for the chat
 * bubble (the model still does not receive the file: toModelMessages ignores
 * chips through the `chip` flag). */
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
    // The attached source remains a reference after being written: the chip
    // in the bubble shows the document name, and not an attachment without content.
    ...(file.sourceId ? { sourceId: file.sourceId } : {}),
  }
}

/** Thumbnail (WebP, max 320px) of an image data URL — only for display in the
 * chat bubble; the history stores the thumbnail instead of the original bytes.
 * Silent failure → undefined (the chip stays without a url, as before). */
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
    console.error('[attachment] thumbnail failed:', err)
    return undefined
  }
}

const IMAGE_MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/** File extension to persist an attached image (mime → ext, with
 * fallback by the filename and, finally, png). */
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
 * Registers the screenshot pasted by the user in the media gallery (source 'user'):
 * the original gets a file on disk + a record in the index — with Vision mode,
 * today the original bytes get lost (the history keeps only the thumbnail).
 * Best effort: silent failure — sending the message never breaks because
 * of the record.
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
    console.error('[attachment] registering the image in the gallery failed:', err)
    return undefined
  }
}

/**
 * Note that the agent receives for an audio attachment. With transcription on,
 * the reference and when to use it; off, what to tell the user.
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
    `${head}\n(Attachment, not a user message. NOT transcribed: if what is SPOKEN in it matters for the request, call transcribe with sources [{ path: "${id}" }]. ` +
    'If it is music, a sound effect or audio to be used somewhere, do not transcribe it.)'
  )
}

/**
 * An attached video becomes: the file saved in the app (the agent only receives the
 * REFERENCE and a line of metadata), a thumbnail for the bubble and the note.
 *
 * The video arrives in two ways. Chosen or dragged from the disk, the renderer sends
 * only the PATH (`file://…`) and the file is copied here, by clone when the
 * filesystem allows it — it never goes wholly through memory. Pasted from the
 * clipboard there is no path, and the bytes come (data URL).
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
      // Not a real video: it does not leave the copy behind.
      await fs.rm(saved.file, { force: true })
      return refuse('Attachment, not a user message. The file is not a readable video.')
    }
    // It goes into the media gallery (Media tab, video filter, deleting frees the file).
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

/** Type label in the note that the agent reads for a gallery attachment. */
const MEDIA_REF_LABEL: Record<string, string> = {
  artifact: 'Artifact',
  document: 'Document',
  motion: 'Motion composition',
  design: 'Design canvas',
}

/**
 * The note of an attachment that already IS a gallery item (dragged from the Media tab).
 * The file is on disk; the note gives the path and how to open it, without promising
 * any copy — which is exactly what does not happen.
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
 * Attachment that already IS a gallery item (dragged from the Media tab). Unlike every
 * other path, HERE NOTHING IS COPIED: the file exists, and the agent receives a
 * reference (`img_/vdo_/aud_…` or the path) with the same note as the attachments by
 * reference. The bubble shows the chip — the image/video only goes to the model
 * when vision demands the pixels (read from disk, without rewriting).
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
    // The image is already on disk: the bytes are read only for VISION (the model
    // needs the pixels) and for the chip thumbnail — the file is NOT rewritten.
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
      // Native vision: the model sees the pixels IN THE TURN THE IMAGE ARRIVES.
      // In the following ones only the reference line stays — the image is already in the
      // gallery, with an id, and the agent goes back to it with describe_image/image_edit
      // if it needs to. The empty `refLine` disarms the mark: without a reference, losing
      // the image would be worse than paying for it on every turn.
      const withData: FilePart = {
        ...file,
        mime: media.contentType,
        url: dataUrl,
        ...(refLine ? { turnOnly: true } : {}),
      }
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

  // Artifact, document, motion piece, design canvas: the file/folder already
  // lives in the app — the note gives the path and how to open it.
  return [
    attachmentChip(file, thumbUrl(entry) ?? undefined),
    { id: newId('prt'), type: 'text', text: mediaRefNote(kind, name, entry), state: 'done', source: 'attachment' },
  ]
}

/**
 * Source of the conversation dragged from the Sources tab into the composer.
 *
 * Nothing is copied: the document already IS stored and has an id (`doc1`, `src2`), so
 * the attachment is a reference — the chip in the bubble shows the exact document name and
 * the agent receives the note with the address its tools understand. Before, the
 * drag died half-way (the composer did not know the MIME) and citing
 * a source required writing "the src2" and hoping the model guessed which one it was.
 */
async function sourceRefAttachment(file: FilePart, sessionId: string | undefined): Promise<MessagePart[]> {
  const id = file.sourceId ?? ''
  const name = file.filename || id
  const found = await readSessionDocument(sessionId ?? '', id).catch(() => null)
  if (!found) {
    return [
      attachmentChip(file),
      {
        id: newId('prt'),
        type: 'text',
        text: `[Source attached: ${name} (${id})] (it is no longer in this conversation's sources — it was removed, or moved to another chat)`,
        state: 'done',
        source: 'attachment',
      },
    ]
  }
  const doc = found.doc
  const unit =
    doc.kind === 'spreadsheet' ? 'sheets' : doc.kind === 'docx' ? 'blocks' : 'pages'
  return [
    attachmentChip(file),
    {
      id: newId('prt'),
      type: 'text',
      text: [
        `[Source of this conversation: ${doc.filename} — ${doc.id} (${doc.kind}, ${unit}: ${doc.totalPages})]`,
        `The user pointed at THIS document on purpose — the file itself is already stored here, so nothing was copied and you should not ask for it again.`,
        `Find things in it with doc_search({ docId: "${doc.id}", pattern }) — it answers with page and line — and read around a hit with doc_read({ docId: "${doc.id}", offset: <page> }).`,
        `To cite it back in your reply: [${doc.filename}](#orbit-source/${doc.id}/p1)`,
      ].join('\n'),
      state: 'done',
      source: 'attachment',
    },
  ]
}

/** Preprocesses a NEW attachment before persisting: PDF, spreadsheet and skill become
 *  extracted text (avoids huge data URLs in the history) + a chip without data
 *  so the UI keeps showing the attachment; image stays native (the model reads it
 *  better through an image part). Mirrors the same pattern for each type — extracts,
 *  wraps in a TextPart, never fails the message send. */
async function preprocessAttachment(
  file: FilePart,
  deps: {
    /** Does the model of this execution have native vision? */
    modelVision: boolean
    /** Delegated vision model (Vision mode) — used when modelVision is false */
    visionModel?: { providerId: string; modelId: string }
    language?: string
    /** Source session/message — the screenshot becomes a record in the media gallery */
    sessionId?: string
    messageId?: string
    /** Turn record (Vision mode): where the images stay for the describe_image tool */
    turnImages?: TurnImage[]
    /** Text that the user wrote in this turn — the motion attachment glues it to
     *  the pointed instant (see formatMotionQuoteText). */
    userText?: string
  },
): Promise<MessagePart[]> {
  const filename = file.filename ?? ''

  // Attachment that is already a gallery item (dragged from the Media tab): nothing is copied,
  // the agent receives the reference and the path. It is the first cut because `url`
  // here is only the preview — none of the paths below applies to it.
  if (file.mediaId) return preprocessMediaRefAttachment(file, deps)

  // Conversation source (Sources tab): same idea as the gallery — a reference, not a
  // copy. The content is already stored and addressed in the conversation scope.
  if (file.sourceId) return sourceRefAttachment(file, deps.sessionId)

  // Motion composition PROJECT (.zip with `orbit.json` at the root, which
  // "Save project" in the Motion tab generates). Dragging the file here is the way
  // back: the piece is recreated in a NEW folder of this conversation — same name,
  // new id, nothing overwritten —, it enters the record and the tab opens on it. The agent
  // receives a note saying the piece exists and how to reach it by id; the
  // content (HTML, media, fonts) is already on disk, it does not go into the context.
  //
  // A `.zip` WITHOUT the manifest is not this business: it follows the usual
  // attachment flow. And a `.skill` (which is also a zip) arrives in its flow right below.
  if (isMotionProjectAttachment(file, filename)) {
    const bytes = decodeDataUrlBytes(file.url)
    if (bytes) {
      const manifest = readMotionProject(bytes)
      if (manifest) {
        if (!deps.sessionId) return [attachmentChip(file)]
        try {
          const imported = await importMotionProject(bytes, { sessionId: deps.sessionId })
          // Gallery and tab: the imported piece must appear where the others
          // appear — and already open, because importing is for working on it.
          void registerMotionCover(imported.id, { title: imported.name, sessionId: deps.sessionId }).catch(() => false)
          void reopenMotion(imported.id).catch(() => false)
          const note = [
            `[Motion project imported — "${imported.name}" (id ${imported.id})]`,
            `The whole composition was restored from the .zip: ${imported.files} file${imported.files === 1 ? '' : 's'} (HTML, media, fonts, audio.json) are in its folder, unchanged. It is registered as a NEW piece of this conversation — the same .zip can be imported again without touching this one — and its tab is open.`,
            `Work on it by id: motion_read({ id: "${imported.id}" }) to see the HTML, motion_edit({ id: "${imported.id}" }) to change it, motion_preview({ id: "${imported.id}" }) to bring the tab back. The media files are already in the folder — reference them by relative path, no motion_asset needed.`,
          ].join('\n')
          return [
            attachmentChip(file),
            { id: newId('prt'), type: 'text', text: note, state: 'done', source: 'attachment' },
          ]
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          return [
            attachmentChip(file),
            {
              id: newId('prt'),
              type: 'text',
              text: `[Motion project could not be imported — ${message}]\nThe .zip was left untouched. Nothing in the app changed; tell the user what the error says.`,
              state: 'done',
              source: 'attachment',
            },
          ]
        }
      }
    }
  }

  // Element selected in the panel browser (selection mode): the renderer
  // serializes the element (tag/url/selector/text/html) as a JSON data URL in the
  // marker MIME. It becomes a chip (badge in the chat bubble) + a TextPart with source
  // 'attachment' — same pattern as the PDF: the model receives the full detail, the
  // user's bubble shows only the chip.
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
        // invalid payload — the chip filename already gives enough context
      }
    }
    return [
      attachmentChip(file),
      { id: newId('prt'), type: 'text', text, state: 'done', source: 'attachment' },
    ]
  }

  // Excerpt quoted in the document viewer, or INSTANT pointed at in the Motion
  // tab — both arrive through the same MIME (see DOCUMENT_QUOTE_MIME) and the
  // payload's `kind` says which one. The user highlighted/pointed and sent it: the model
  // receives the essential RIGHT HERE, without a trip to the document or the
  // composition to answer, and receives along the clickable citation to return
  // in the answer. The bubble shows only the chip — the excerpt can be long, and
  // repeating it in the conversation would show the user what they just marked.
  if (file.mime === DOCUMENT_QUOTE_MIME) {
    const raw = decodeDataUrlText(file.url)
    let text = `[Excerpt quoted by the user — ${file.filename || 'document'}]`
    if (raw) {
      try {
        const quote = JSON.parse(raw) as QuotePayload
        if (quote.kind === 'motion') {
          // The instant: file, frame and fps (and the seconds with a comma, which
          // are display only), with the user's text glued — see
          // formatMotionQuoteText.
          text = formatMotionQuoteText(quote, deps.userText)
        } else if (quote.kind === 'design') {
          // The element pointed at in the canvas: artboard, path and its HTML, with
          // the user's text glued — see formatDesignQuoteText.
          text = formatDesignQuoteText(quote, deps.userText)
        } else {
          const where = quote.page
            ? `, page ${quote.page}${
                quote.fromLine
                  ? `, line${quote.toLine && quote.toLine > quote.fromLine ? `s ${quote.fromLine}-${quote.toLine}` : ` ${quote.fromLine}`}`
                  : ''
              }`
            : ''
          const lines = [`[Excerpt quoted by the user — ${quote.name ?? 'document'}${where}]`]

          // The ADDRESS of what was quoted, in the language of the tool that
          // reaches it. Without this the model received a name and a text, went looking for
          // the file with the tools it had and answered that it did not find it — with the
          // whole document one id away. The id is worth on its own: reading a
          // document does not depend on it being a source of the conversation, nor on the
          // conversation being the same one it was born in.
          if (quote.docId) {
            lines.push(
              quote.kind === 'source'
                ? `Source in this conversation: ${quote.docId} — use doc_read/doc_search with this docId to see the rest.`
                : `Agent document: ${quote.docId} — use read_document with this documentId to see the full text, and update_document to change it (read first: baseRevision comes from the read).`,
            )
          }
          if (quote.docId && quote.page) {
            const target = `#orbit-source/${quote.docId}/p${quote.page}${
              quote.fromLine ? `L${quote.fromLine}${quote.toLine ? `-${quote.toLine}` : ''}` : ''
            }`
            lines.push(`To cite it back in your reply: [${quote.name ?? 'document'}](${target})`)
          }
          lines.push('---', quote.text ?? '')
          text = lines.join('\n')
        }
      } catch {
        // invalid payload — the chip filename already gives the minimum context
      }
    }
    return [
      attachmentChip(file),
      { id: newId('prt'), type: 'text', text, state: 'done', source: 'attachment' },
    ]
  }

  // PDF, DOCX and spreadsheet: a single path. The extracted text is stored in the
  // session and the message carries only the opening excerpt — the rest the agent
  // reaches with doc_search/doc_read.
  //
  // Before, all three dumped the whole document into a TextPart, which
  // toModelMessages resends ON EVERY TURN: a large PDF took up the context
  // window for the rest of the conversation, being charged again on every message
  // (and the PDF did not even have a ceiling — only DOCX and spreadsheet cut at 30k, losing the
  // rest silently).
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
        deps.sessionId ?? 'no-session',
        Buffer.from(bytes),
        filename || 'document',
        documentKind,
      )
      return [
        // The chip carries the document id: it is what allows clicking the attachment and
        // opening the file in the panel, since the content does not live in the message.
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

  // Attached skill (.skill text/ZIP, or .md with skill frontmatter) — the
  // agent reads the content and MAY propose one with the create_skill tool if it
  // makes sense; if it is not a valid skill, it falls back to plain text handling.
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

  // Attached text (.md, .txt, .json, code, the text pasted into the composer):
  // SAME path as the PDF — it becomes a document of the conversation, and the message carries only the
  // opening excerpt. Before, the whole file was dumped into a TextPart,
  // which toModelMessages resends on every turn: a 200 KB .md stayed in the
  // context forever, while the PDF next to it was already paginated. Small
  // content keeps coming whole (see INLINE_DOC_CHARS in
  // documentAttachmentPreview) — what changes is that it also starts to exist
  // in the Sources tab, reachable after the turn in which it arrived.
  if (TEXT_MIME.test(file.mime) || TEXT_EXT_FALLBACK.test(filename)) {
    const text = decodeDataUrlText(file.url)
    if (text != null) {
      try {
        const { doc, pages } = await saveSessionDocument(
          deps.sessionId ?? 'no-session',
          Buffer.from(text, 'utf8'),
          filename || 'text',
          'text',
        )
        return [
          attachmentChip(file, undefined, doc.id),
          { id: newId('prt'), type: 'text', text: documentAttachmentPreview(doc, pages), state: 'done', source: 'attachment' },
        ]
      } catch {
        // Without a document (disk unavailable) the text can still travel: it is the
        // behavior from before, and losing the attachment would be worse.
        return [
          attachmentChip(file),
          { id: newId('prt'), type: 'text', text: `[File attached: ${filename || 'unnamed'}]\n\n${text}`, state: 'done', source: 'attachment' },
        ]
      }
    }
  }

  // Video: saved in the app, the agent receives the reference and the metadata card — never the content.
  if (isVideoFile(file.mime, filename)) return preprocessVideoAttachment(file, deps)

  // Audio: it goes to the audio store (the bubble plays the attachment from the chip) and is NOT
  // transcribed here — it may be a song or a sound effect to use somewhere.
  // The agent receives the reference and decides (transcribe tool). The
  // transcript, when there is one, comes back to THIS note (see
  // persistAudioTranscript): it is attachment content, not the user's speech.
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
    // The agent receives only the reference and the path — never the content: the audio
    // does not take up context, and it chooses what to do (transcribe, use the
    // file in a project, nothing).
    return [
      attachmentChip(file, undefined, undefined, saved.url),
      { id: newId('prt'), type: 'text', text: audioAttachmentNote(filename, saved.id, saved.path), state: 'done', source: 'attachment' },
    ]
  }

  // Image: with Vision mode on (visionModel configured), the image does NOT
  // enter the context and is not described automatically — the agent decides to see
  // it (describe_image tool, with whatever context it wants to pass) and the description
  // returned replaces this placeholder in the history. Without active mode: native
  // vision keeps the image part; without vision and without a model, it warns in the history that
  // the attachment was not seen (the UI also shows the card).
  if (file.mime.startsWith('image/')) {
    // The screenshot pasted by the user also enters the media gallery: the
    // original is persisted on disk (source 'user') — the history does not change,
    // the message keeps the usual data URL/thumb.
    const mediaUrl = await saveUserImage(file, deps.sessionId, deps.messageId)
    // Thumbnail only for the chat bubble: the chip does not carry the original bytes
    // (the history does not duplicate whole images), but the UI shows the image.
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
      // Same rule as the attachment by reference: the pixels count in this turn; in the
      // following ones, the indicator is the gallery reference line (see
      // FilePart.turnOnly and modelFileParts).
      const firstLook: FilePart = refLine ? { ...file, turnOnly: true } : file
      return refLine
        ? [firstLook, { id: newId('prt'), type: 'text', text: refLine, state: 'done', source: 'attachment' }]
        : [firstLook]
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
 * Vision mode (agent-driven): persists the description returned by the
 * describe_image tool in the message's placeholder TextPart. The call's
 * ToolPart is never resent in future turns (see toModelMessages) — the text
 * here leaves the history self-sufficient, as in the old automatic description
 * flow. Uses a NEW object (the MessageItem is memoized by reference in the UI).
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
 * Transcript of an audio attachment (transcribe tool) written into the
 * attachment's NOTE, as with the Vision mode description: the ToolPart does not come back in the
 * next turns, and without this the agent would have to transcribe again on every question
 * about the same audio. The note keeps `source: 'attachment'` — the text is
 * attachment content, it never shows up as the user's speech in the bubble.
 *
 * It searches every user message: the audio may have arrived several
 * turns before someone asks what it says.
 */
async function persistAudioTranscript(opts: {
  sessionId: string
  audioId: string
  /** What goes into the note instead of the instructions: the transcript, or where it is. */
  body: string
  history: ChatMessage[]
  win: BrowserWindow
}): Promise<void> {
  // What identifies the note is the structural MARK (`source: attachment` + the audio
  // ref), not the text: comparing the start of the message with a hand-written
  // prefix tied the rule to a language.
  const marker = `ref ${opts.audioId}]`
  for (let m = opts.history.length - 1; m >= 0; m--) {
    const msg = opts.history[m]
    if (msg.role !== 'user') continue
    const idx = msg.parts.findIndex(
      (p) => p.type === 'text' && p.source === 'attachment' && p.text.includes(marker),
    )
    if (idx < 0) continue
    const part = msg.parts[idx] as TextPart
    // Header = the reference line and the file line; the rest is replaced.
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
 * Header of the engine notes when they enter the user's
 * message: it marks the boundary between what the engine measured and what the person
 * wrote. It uses the "[SYSTEM:" prefix on purpose — if the model copies the
 * line in the answer, stripEngineMarkers removes it along with the others.
 */
const ENGINE_CONTEXT_HEADER =
  '[SYSTEM: engine bookkeeping about YOUR previous turn — measured from filesystem snapshots, not written by the user. Context only: never quote these lines in your reply.]'

/**
 * Turns the persisted history into messages for the model (text +
 * the user's attachments). When there is compaction, it cuts at the last summary: it sends
 * summary + later messages; the full history stays in storage.
 */
export function toModelMessages(history: ChatMessage[], modelVision = true): ModelMessage[] {
  const lastSummary = findLastSummaryIndex(history)
  const window = lastSummary >= 0 ? history.slice(lastSummary) : history
  const result: ModelMessage[] = []
  // Engine notes about the assistant's previous turn (TODO state,
  // verified record of files, warnings). They stay PENDING here and enter the
  // next user message — never inside the assistant's own text.
  //
  // Glued to its turn, those lines become an example of its own answer
  // format: in a long history the model starts imitating them and writes
  // "[Verified record: ...]" in the text the user reads. On the user's side
  // they are read for what they are — context the environment provided.
  let pending: string[] = []
  const takePending = () => {
    if (pending.length === 0) return ''
    const notes = [ENGINE_CONTEXT_HEADER, ...pending].join('\n\n')
    pending = []
    return notes
  }
  // The current turn is the LAST user message: it is only in it that a
  // `turnOnly` attachment (native vision image) still goes as a file — in the
  // following turns it has already been seen, and what still counts is the text
  // reference line (see modelFileParts in @shared/chat).
  const currentTurn = window.map((m) => m.role).lastIndexOf('user')
  for (const [index, message] of window.entries()) {
    if (message.role === 'assistant') {
      const notes = engineAnnotations(message)
      if (notes) pending.push(notes)
      // stripEngineMarkers covers the legacy history: messages written before
      // this cleanup may carry the marker glued to the text itself.
      const text = stripEngineMarkers(partText(message.parts, 'text'))
      // Resends the assistant's reasoning to the model: providers with
      // reasoning_content (e.g. DeepSeek) require the text back in the
      // following turns. The field is injected via providerOptions by
      // normalizeMessages (interleaved) — here we only preserve the parts.
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
    // ToolParts are never resent to the model outside the streaming of the call
    // that generated them — what survives from the previous turn are the notes.
    const text = [takePending(), partText(message.parts, 'text')]
      .filter((p) => p.trim())
      .join('\n\n')
    // Chips (`chip` flag) are only UI decoration — the real content is already in
    // the sibling TextPart extracted in preprocessAttachment; including them here
    // would duplicate an empty note in place of the already extracted text. `url !== ''`
    // covers old chips persisted before the flag existed, and `turnOnly` stops
    // resending the image after the turn in which it arrived.
    const files = modelFileParts(message.parts, index === currentTurn)
    if (message.role === 'user' && files.length > 0) {
      const content: UserContent = files.map((file) => fileToModelContent(file, modelVision))
      if (text.trim()) content.push({ type: 'text', text })
      result.push({ role: 'user', content })
      continue
    }
    if (!text.trim()) continue
    result.push({ role: message.role, content: text })
  }
  // Window ended on assistant (with no user turn after it to carry
  // the notes): deliver it as a user message so the verified record
  // does not disappear — it is what sustains the anti-overclaim check.
  const trailing = takePending()
  if (trailing.trim()) result.push({ role: 'user', content: trailing })
  return result
}

const NAMING_SYSTEM =
  "Write a short, descriptive title for the conversation, in plain text, in the language of the user's message. " +
  'Rules: no bold, no asterisks, no quotes, no emojis and no formatting of any kind; at most 50 characters. ' +
  'Reply with ONLY the final title, nothing else.'

/** Titles every session is born with — the sign that nobody named it yet. */
function isDefaultTitle(title: string): boolean {
  // Every language counts: the title was written in the language of the moment and
  // the session may predate a language switch.
  return (['chat.defaultTitle.chat', 'chat.defaultTitle.code'] as const).some((key) =>
    (Object.values(MESSAGES[key]) as string[]).includes(title),
  )
}

/**
 * Title that appears BEFORE any model answers: the message itself already
 * says what it is about, and a command (`/init`) does not serve as a title — then the
 * hint is the project name. Without text, the attachment name is left.
 */
function provisionalTitle(input: SendMessageInput): string {
  if (input.text.trim().startsWith('/')) {
    return input.directory ? truncateTitle(basename(input.directory)) : ''
  }
  return titleFromUserText(input.text) || titleFromAttachmentNames(input.files)
}

/**
 * What goes to the title model. Only the user message enters here — the
 * answer never did, and that is exactly why the title can be generated
 * in parallel with the turn instead of waiting for it to end.
 */
function namingPrompt(input: SendMessageInput, projectName: string | null): string {
  const text = input.text.trim()
  if (text.startsWith('/')) {
    return (
      `The code session started with a command (${text.slice(0, 100)}) — do not use the command as the title. ` +
      `Write a short generic title in ${input.language ?? 'Portuguese'}${projectName ? ` for the project "${projectName}"` : ''}, ` +
      'such as "Project analysis". Reply with the title only.'
    )
  }
  const names = (input.files ?? [])
    .filter((file) => !file.chip && file.filename)
    .map((file) => file.filename as string)
    .slice(0, 5)
  const attached = names.length > 0 ? `\n\nAttached files: ${names.join(', ')}` : ''
  // Attachment only: with the empty prompt the chat stayed on the default title forever.
  if (!text) {
    return names.length > 0
      ? `The user sent files with no message yet. Name the conversation after what the files are about.${attached}`
      : ''
  }
  return text.slice(0, 2000) + attached
}

/** Writes the title and propagates. The write comes BEFORE the event: the following
 *  `session` ones re-read from disk and, without it, the title reverts on the next switch. */
async function applySessionTitle(win: BrowserWindow, sessionId: string, title: string) {
  // Re-reads before writing: the title takes seconds and the session may have changed
  // in the meantime (e.g. the agent moved the chat to another worktree) — writing the
  // copy read earlier would undo the change.
  const session = await readJson<SessionInfo>(StorageKeys.session(sessionId))
  if (!session) return
  await writeJson(StorageKeys.session(sessionId), { ...session, title })
  await bumpSessionActivity(win, sessionId)
  emit(win, { type: 'title', sessionId, title })
}

/**
 * Names the conversation at the START of the first turn, in two layers:
 *
 * 1. the provisional title comes from the message itself, without a model, in milliseconds
 *    — the sidebar stops saying "New conversation" before the agent starts;
 * 2. the auxiliary model refines it in the background, along with the turn.
 *
 * Before, this ran at the END of the turn (`void generateTitle(...)` after
 * `status: idle`): in a turn of several minutes the chat stayed the whole time without
 * a name, even though the prompt never used the answer.
 */
export async function startSessionNaming(
  win: BrowserWindow,
  input: SendMessageInput,
  knownSession?: SessionInfo | null,
): Promise<void> {
  try {
    const session =
      knownSession ?? (await readJson<SessionInfo>(StorageKeys.session(input.sessionId)))
    if (!session) return
    // A routine session is born with "<routine> — <time>" and a worker with the
    // task title: neither is a conversation the person is naming.
    if (session.routineId || isRoutineSessionId(session.id) || session.orchestration?.role === 'worker') return
    // Title already decided (model or manual rename): it is no longer the first.
    if (!isDefaultTitle(session.title)) return

    const provisional = provisionalTitle(input)
    if (provisional) await applySessionTitle(win, input.sessionId, provisional)
    void refineSessionTitle(win, input, provisional)
  } catch {
    // the title is cosmetic; silent failure
  }
}

/** Layer 2: the auxiliary model, in parallel with the turn. */
async function refineSessionTitle(
  win: BrowserWindow,
  input: SendMessageInput,
  provisional: string,
): Promise<void> {
  try {
    const prompt = namingPrompt(input, input.directory ? basename(input.directory) : null)
    if (!prompt) return
    const aux = await resolveAuxModel(
      { providerId: input.providerId, modelId: input.modelId },
      { sessionId: input.sessionId },
    )
    const { text } = await generateText({
      model: aux.model,
      providerOptions: aux.providerOptions,
      system: NAMING_SYSTEM,
      prompt,
    })
    const projectName = input.directory ? basename(input.directory) : null
    const isCommand = input.text.trim().startsWith('/')
    // A command (`/init` etc.) does not serve as a title; then the fallback is the project.
    const fallback = isCommand
      ? (projectName ?? '')
      : titleFromUserText(input.text) || titleFromAttachmentNames(input.files) || provisional
    const title = resolveTitle(text, fallback)
    if (!title) return

    // Comparison before writing: while the model was thinking, the person may have
    // renamed the chat. If the title on disk is no longer the provisional one we
    // wrote (nor the default), the decision is theirs — it does not overwrite.
    const current = await readJson<SessionInfo>(StorageKeys.session(input.sessionId))
    if (!current || current.title === title) return
    if (current.title !== provisional && !isDefaultTitle(current.title)) return
    await applySessionTitle(win, input.sessionId, title)
  } catch {
    // the title is cosmetic; silent failure
  }
}

const SUGGESTION_SYSTEM =
  'You predict the user\'s NEXT message in a conversation with an AI assistant. ' +
  'Write it as the user would type it: short (at most 12 words), concrete, in the same language the user writes in, ' +
  'a natural next step given the assistant\'s last reply (follow-up, verification, next task). ' +
  'No quotes, no explanations, no prefixes — reply ONLY with the message. ' +
  'If there is no obvious next step, reply with an empty line.'

/**
 * Continuity suggestion at the END of the turn.
 *
 * Automatic compaction runs at the START of the turn, before the answer — a
 * card there would appear in place of what the person just asked for. Here the turn's
 * real usage is already known and there is no turn running, which is exactly what
 * manual compaction requires (compactSession refuses during a turn).
 *
 * It only suggests from COMPACT_SUGGEST_AFTER compactions on: one or two work well;
 * from the third on the summary is already a summary of a summary and the beginning of
 * the conversation is lost. The count alone is not enough — the context has to be about
 * to force the next compaction, or the card would appear with plenty of room left. It is
 * an OFFER — ignored, the automatic compaction of the next turn runs as always. Not a
 * preference: a card nobody is forced to click is cheaper than a setting nobody calibrates.
 */
async function maybeSuggestCompaction(
  win: BrowserWindow,
  sessionId: string,
  history: ChatMessage[],
  catalogModel: CatalogModel | undefined,
  modelVision: boolean,
) {
  // A routine has nobody to decide anything: the card would just sit there.
  const session = await readJson<SessionInfo>(StorageKeys.session(sessionId))
  if (!session || session.routineId || isRoutineSessionId(session.id)) return
  const summaries = countSummaries(history)
  if (summaries < COMPACT_SUGGEST_AFTER) return
  const lastTokens = [...history].reverse().find((m) => m.role === 'assistant' && m.tokens)?.tokens
  const historyTokens = estimateTokens(toModelMessages(history, modelVision))
  if (!shouldCompact(lastTokens, catalogModel, historyTokens)) return
  emit(win, { type: 'compaction:suggest', sessionId, summaries })
}

/**
 * Continuity brief for a new chat (from the compaction card).
 * It reads the history from disk — the renderer does not have the copy — and returns the
 * text already with the summary header, which is how the new chat receives it: a
 * `summary: true` message generated by the agent, not a line of the user.
 */
export async function continuationBrief(
  sessionId: string,
): Promise<{ title: string; text: string } | null> {
  // A running turn would have its own copy of the history and would overwrite it.
  if (abortControllers.has(sessionId)) return null
  const history = await loadMessages(sessionId)
  const lastAssistant = [...history].reverse().find((m) => m.role === 'assistant' && m.providerId)
  const providerId = lastAssistant?.providerId
  const modelId = lastAssistant?.modelId
  if (!providerId || !modelId) return null
  const session = await readJson<SessionInfo>(StorageKeys.session(sessionId))
  try {
    const aux = await resolveAuxModel(
      { providerId, modelId },
      { sessionId, minContext: MIN_COMPACTION_CONTEXT },
    )
    const brief = await generateContinuationBrief(history, aux.model, aux.providerOptions)
    if (!brief) return null
    return {
      title: `${session?.title ?? 'Conversation'} — continuation`,
      text: `${SUMMARY_PREFIX}\n\n${brief}`,
    }
  } catch (err) {
    console.error('[continuation] brief failed:', err)
    return null
  }
}

/**
 * Next likely user message, with the auxiliary model. Cosmetic like
 * the title: any failure only means not showing a suggestion.
 */
async function generateSuggestion(input: SendMessageInput, reply: ChatMessage, win: BrowserWindow) {
  try {
    const session = await readJson<SessionInfo>(StorageKeys.session(input.sessionId))
    if (!session || session.routineId) return
    const answer = reply.parts
      // Text with `source` is from the engine (nudges, checklist) or from an attachment — it is not an answer.
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
    // the suggestion is cosmetic; silent failure
  }
}

function emit(win: BrowserWindow, event: ChatEvent) {
  if (!win.isDestroyed()) win.webContents.send('chat:event', event)
  // The overlay is a separate window: without this forwarding, a turn requested by the
  // panel (⇧⌘space) would stream only to the main window, and the panel
  // would stay mute waiting for the answer. It avoids the double send when the origin
  // is itself.
  if (win !== getOverlayWindow()) forwardToOverlay('chat:event', event)
  forwardChatEvent(event)
}

export function abortChat(sessionId: string) {
  const cmd = activeBashCommands.get(sessionId)
  console.log(
    `[chat] abort of session ${sessionId}${cmd ? ` — active bash command: ${cmd}` : ''}`,
  )
  abortControllers.get(sessionId)?.abort()
}

/** Sessions with a runChat in progress — the main re-emits the status after a
 *  renderer reload, so the UI goes back to showing the spinner/stop button. */
/** Sessions whose LAST turn ended stopped (by the user, or replaced by a newer send). */
const abortedTurns = new Set<string>()

/** Did this session's last turn end stopped? A subchat the user stopped must not wake its parent. */
export function lastTurnAborted(sessionId: string): boolean {
  return abortedTurns.has(sessionId)
}

export function getRunningSessionIds(): string[] {
  return [...abortControllers.keys()]
}

/** Sending a message = activity: it updates the session's updatedAt and propagates the
 *  "session" event to every window and to mobile. Without that event the renderer
 *  store never sees the new updatedAt and the sidebar does not reorder — the chat
 *  does not rise to the top of recents (nor does the folder that contains it). */
async function bumpSessionActivity(win: BrowserWindow, sessionId: string): Promise<void> {
  const session = await readJson<SessionInfo>(StorageKeys.session(sessionId))
  if (!session) return
  const updated = { ...session, updatedAt: Date.now() }
  await writeJson(StorageKeys.session(sessionId), updated)
  emit(win, { type: 'session', sessionId, session: updated })
}

export async function runChat(win: BrowserWindow, input: SendMessageInput): Promise<void> {
  // The turn's media journal (pieces and gallery) is what lets the message
  // revert undo what the agent produced outside the working folder.
  // The write journal records what the turn's tools wrote in the working
  // folder: it is the ownership the revert uses, without depending on any other
  // turn being stopped. Two conversations in the same folder run in parallel.
  return runWithWriteScope(() =>
    withProviderSession(input.sessionId, () =>
      runWithMediaJournal(input.sessionId, () => runChatTurn(win, input)),
    ),
  )
}

async function runChatTurn(win: BrowserWindow, input: SendMessageInput): Promise<void> {
  const { sessionId } = input
  // Instrumentation (ORBIT_PERF=1): one record per turn with its duration, the
  // steps it took and the memory peak seen while it was open. A turn of a worker
  // is a single 30-70 minute window, so the peak — not the average — is the number
  // that explains the machine.
  const perf = perfSpan('turn', {
    sessionId,
    role: input.orchestrationRole ?? 'user',
    mode: input.mode,
    rounds: input.options.retries ?? 0,
  })
  abortControllers.get(sessionId)?.abort()
  const controller = new AbortController()
  abortControllers.set(sessionId, controller)

  /**
   * Is this turn still the one that owns the session? The map holds the CURRENT
   * controller, swapped at the top of every new turn: a turn already replaced by a
   * newer send must not emit its ENDING status. The 'idle' would land after the
   * newer turn's 'submitted', the composer would read "free" and the next Enter
   * would start yet another turn (killing the one in progress, and leaving an empty
   * reply behind) instead of queueing behind it.
   */
  const ownsSession = () => abortControllers.get(sessionId) === controller

  emit(win, { type: 'status', sessionId, status: 'submitted' })
  await bumpSessionActivity(win, sessionId)

  // Revert active: a new message consolidates the revert — it discards the messages
  // after the reverted point before loading the history
  try {
    await cleanupRevert(sessionId)
  } catch (err) {
    console.error('[revert] cleanup failed:', err)
  }

  const history = await loadMessages(sessionId)

  // Retry ("try again"): the turn runs AGAIN over the same user
  // message, instead of sending a new one. The answer that failed leaves the history
  // — the error already showed in the card, and keeping it left the conversation with a
  // repeated bubble and a permanent error card (each retry stacked one more).
  // What the model needs to know about the previous attempt goes in the note, not in
  // the history (see session/retry-note.ts).
  let retriedUser: ChatMessage | null = null
  let retriedFailed: ChatMessage | null = null
  let retryNote = ''
  if (input.retryOf) {
    const failedIndex = history.findIndex((m) => m.id === input.retryOf)
    const failed = failedIndex >= 0 ? history[failedIndex] : undefined
    // Only the last answer can be redone: redoing one in the middle would discard
    // what came after it, which the user wanted to keep.
    if (failed?.role === 'assistant' && failedIndex === history.length - 1) {
      retriedUser = [...history.slice(0, failedIndex)].reverse().find((m) => m.role === 'user') ?? null
      // Without the user message there is no turn to redo: it falls back to the normal send.
      if (retriedUser) {
        retriedFailed = failed
        retryNote = retryContextNote(failed)
        history.splice(failedIndex, 1)
        await saveMessages(sessionId, history)
        emit(win, { type: 'messages', sessionId, messages: history })
      }
    }
  }

  // Model rotation: the sequence is resolved at call time (see
  // model-rotation.ts) — the rotation chosen in the selector for this chat; otherwise
  // the model pinned in the chat; otherwise the default. `primaryModel` below is the
  // first of the list — used in attachment preprocessing (vision decision) and
  // as a fallback of the attempts loop.
  const rotationSequence = resolveRotation(input.sessionId, {
    providerId: input.providerId,
    modelId: input.modelId,
  })
  const primaryModel = rotationSequence[0] ?? { providerId: input.providerId, modelId: input.modelId }

  // /compact command — compacts the history and does not generate a model answer
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
      console.error('[compaction] /compact failed:', err)
    }
    return
  }

  // The user message is emitted BEFORE the attachment preprocessing:
  // the image preprocess with Vision mode calls the vision model (network,
  // can take tens of seconds) — emitting only afterwards left the UI mute
  // (a new chat stuck on the empty screen, an existing chat without the message) until the
  // agent answered. The first emit carries the original attachments (data URL), the
  // second (after the preprocess) replaces them with the processed chips.
  const textPart: TextPart = {
    id: newId('prt'),
    type: 'text',
    text: input.text,
    state: 'done',
  }
  // Retry reuses the user message that is already in the history: it is what avoids the
  // duplicated bubble and gives the turn back the original attachments (the retry sends only
  // the text — the processed parts still count as the same ones).
  let userMessage: ChatMessage
  if (retriedUser) {
    userMessage = retriedUser
  } else {
    userMessage = {
      id: newId('msg'),
      role: 'user',
      parts: [...(input.files ?? []), textPart],
      createdAt: Date.now(),
      // Turn metadata persisted in the user message — the
      // session_context tool reads them to answer "what changed in turn X?"
      mode: input.mode,
      permissionMode: input.options.permissionMode ?? 'ask',
      // orchestrationRole is only filled by the main process: in a worker, what
      // sent it was the orchestrator. Without the mark, it was the user typing in
      // the worker's chat.
      origin: input.orchestrationRole === 'worker' ? 'orchestrator' : input.messageOrigin,
    }
    history.push(userMessage)
    emit(win, { type: 'message', sessionId, message: userMessage })
  }

  const assistantMessage: ChatMessage = {
    id: newId('msg'),
    role: 'assistant',
    parts: [],
    createdAt: Date.now(),
    providerId: input.providerId,
    modelId: input.modelId,
    // Retry keeps the presentation of the original turn: the retry send does not
    // carry the options (text only), and switching style midway would be surprising.
    simple: (retriedFailed?.simple || input.options.simple) || undefined,
  }
  history.push(assistantMessage)
  bindMediaJournal(assistantMessage.id)
  await saveMessages(sessionId, history)
  emit(win, { type: 'message', sessionId, message: assistantMessage })

  // Extracts text from attachments (PDF, spreadsheet, skill) before persisting — it avoids
  // huge data URLs in the history and gives the agent access to the real content,
  // regardless of the selected working folder (the read/glob/bash tools only
  // see the filesystem, never the chat attachments — that is why the content
  // has to enter as text in the message itself). Images: a model without vision
  // delegates to the configured vision model (Vision mode) — on demand, through the
  // describe_image tool — or becomes a warning.
  const files = input.files ?? []
  const provider = await getProvider(primaryModel.providerId)
  const modelVision = modelSupportsVision(provider, primaryModel.modelId)
  // Record of the turn's images (Vision mode): the describe_image tool reads
  // from here on demand; it lives only during the turn (cleared in the finally).
  const turnImages: TurnImage[] = []
  // In a retry the attachments were already processed in the original turn: reprocessing
  // would swap the chips for data URLs again and duplicate the extracted note.
  if (!retriedUser && files.length > 0) {
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
    // Replaces the user message (a NEW object — the MessageItem is memoized
    // by reference) with the processed attachments and re-emits.
    const processedUserMessage: ChatMessage = { ...userMessage, parts: [...processedParts, textPart] }
    history[history.indexOf(userMessage)] = processedUserMessage
    await saveMessages(sessionId, history)
    emit(win, { type: 'message', sessionId, message: processedUserMessage })
  }
  if (input.visionModel && turnImages.length > 0) {
    registerTurnImages(sessionId, turnImages)
  }

  // Stream ids → part id. The multi-provider adapter reuses the
  // same ids on every step of the tool loop ("reasoning-0", "txt-0"), and
  // the upsert by id made each step OVERWRITE the previous part: the
  // reasoning of 38 actions became a single block at the top (the last step's), and the
  // final answer took the place of the first narration, before the actions that
  // came later. Each start gets its own id when the SDK's already exists.
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

  // Images inserted in THIS answer (show_image/image_edit/svg_*).
  const turnMediaUrls = new Set<string>()
  // Turn provenance: child → parent, and what the agent marked as a delivery.
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
    // Image deleted from a PREVIOUS turn: without removing the part from the history, the
    // conversation would keep a broken square where there was a photo.
    let touchedHistory = false
    for (const msg of history) {
      if (msg.id === assistantMessage.id) continue
      const before = msg.parts.length
      msg.parts = msg.parts.filter((p) => !(p.type === 'image' && set.has(p.src)))
      if (msg.parts.length !== before) touchedHistory = true
    }
    if (touchedHistory) {
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
   * Drafts of the turn vanish at the end of the answer: from disk, from the gallery and
   * from the conversation. The runtime is what decides, because it has the graph of the
   * calls — asking the model to clean up was the previous design, and it
   * fails exactly when it produces the most. The rule lives in selectDraftImages,
   * with both formats (ladder and fan) and their tests.
   */
  const purgeDraftImages = async () => {
    const drafts = selectDraftImages({
      produced: turnMediaUrls,
      parents: turnParents,
      keep: turnKeep,
    })
    if (drafts.length === 0) return
    const deleted: string[] = []
    for (const url of drafts) {
      const id = mediaIdFromUrl(url)
      if (id && (await deleteMedia(id))) deleted.push(url)
    }
    if (deleted.length > 0) removeImageParts(deleted)
  }

  // Completed steps in the attempt in progress (all the iterations of
  // auto-continue). It distinguishes the context overflow of the history (the first
  // call already fails) from the overflow of the turn's work (it fails after N
  // steps) — the remedies are different.
  let turnSteps = 0
  // Last context size sent to the meter in this attempt: the
  // pre-send estimate only goes out when it passes it.
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
    // Rotation attempts loop: each attempt uses the next model of the
    // sequence. It only rotates a recoverable failure (rate-limit/network/moderation/
    // model unavailable) BEFORE the first token; abort and final errors fall
    // into the outer catch (current behavior).
    let attemptIndex = 0
    // Extra rounds of the whole turn (rotation sequence from the start again)
    // for a transient failure. They happen inside the SAME turn: the user
    // message is not resent, and the chat only shows the error if all of them fail.
    const maxRetryRounds = Math.max(0, input.options.retries ?? 0)
    let retryRound = 0
    for (;;) {
      const primary = rotationSequence[attemptIndex] ?? primaryModel
      // Records this attempt's model in the message (the "via X" badge and
      // compaction use ChatMessage.providerId/modelId) and resets the turn
      // state left by the previous attempt.
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
        // Step ceiling and per-step preparation (context trimming, reasoning,
        // cache — see agent-step.ts) for THIS model: the rotation may land on a
        // model with a smaller window, and the trimming has to follow. One preparer
        // per attempt: the trimming memory holds for the whole turn, including
        // the continuations below, which resend the same tool calls.
        const maxSteps = maxStepsFor(catalogModel)
        const stepPreparer = createStepPreparer(provider, primary.modelId, { directory: input.directory })

    // Automatic compaction: the real tokens of the last answer indicate that the
    // context is near the limit → it summarizes the old stretch a single time.
    // The reported usage is the preferred signal, but it is not reliable on its own: there are
    // gateways that return no usage at all, and a turn that failed does not record
    // `tokens`. The measure of the history itself enters as a floor — it is exactly what
    // will be sent, so it does not depend on the provider cooperating.
    const lastTokens = [...history].reverse().find((m) => m.role === 'assistant' && m.tokens)?.tokens
    const historyTokens = estimateTokens(toModelMessages(history, modelVision))
    if (shouldCompact(lastTokens, catalogModel, historyTokens)) {
      try {
        const aux = await resolveAuxModel(
          { providerId: input.providerId, modelId: input.modelId },
          { sessionId, minContext: MIN_COMPACTION_CONTEXT },
        )
        const summary = await compactHistory(history, aux.model, aux.providerOptions)
        if (summary) {
          // Clears .tokens of the messages after the summary — the old tokens
          // reflected the full context (pre-compaction) and would inflate the meter
          const lastSummary = findLastSummaryIndex(history)
          for (let i = lastSummary + 1; i < history.length; i++) {
            history[i].tokens = undefined
          }
          await saveMessages(sessionId, history)
          emit(win, { type: 'messages', sessionId, messages: history })
        }
      } catch (err) {
        // compaction is an optimization — it never brings the turn down
        console.error('[compaction] failed:', err)
      }
    }

    // Snapshot of the turn in progress: filled by the initial capture below and
    // exposed to the tools via getTurnSnapshot — read through a closure because the
    // capture happens AFTER the creation of the context (verify_changes diffs the
    // current state against this start).
    let turnSnapshot: TurnSnapshot | undefined
    let turnStartedAt = Date.now()
    const toolContext: ToolContext | null =
      input.mode === 'code' && input.directory
        ? {
            sessionId,
            directory: input.directory,
            extraDirectories: input.extraDirectories ?? [],
            abort: controller.signal,
            getTurnSnapshot: () => turnSnapshot,
            // Model vision: it decides whether panel_screenshot offers `ver`;
            // visionModel delegates the description when the model has no vision
            modelVision,
            visionModel: input.visionModel,
          }
        : null

    // Snapshot start: filesystem state before the stream (per-message revert)
    if (toolContext) {
      // Manual saves count from HERE on: what the person saved before is already
      // inside the `start` and would never show up in the diff.
      turnStartedAt = Date.now()
      try {
        turnSnapshot = { start: await capture(toolContext.directory) }
        assistantMessage.snapshot = { start: turnSnapshot.start }
      } catch (err) {
        // Do not hide the failure: it records a snapshot marked as failed (no start,
        // reason in captureError) — the filesystem revert is unavailable and
        // the UI/tools need to know why, instead of a turn that
        // looks like it had a snapshot normally.
        const reason = errorToText(err)
        turnSnapshot = { failed: true, error: reason }
        assistantMessage.snapshot = { failed: true, captureError: reason }
        console.error('[snapshot] initial capture failed:', reason, {
          directory: toolContext.directory,
        })
      }
    }

    // initMode: project analysis pipeline rendered as accordions —
    // the main agent (review narration) on top and one accordion per
    // subagent streaming the exploration; in the end they all close and the summary stays
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
          // Incremental persistence: each completed area is not lost in a crash
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
          // Without this the stop button only ended the UI: the pipeline kept
          // running the subagents to the end, invisible.
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
          // Canceling is the user's choice, not a failure. The tree is only
          // written at the end, after the review, so nothing was left half-done.
          text: cancelled
            ? await mainT('init.cancelled')
            : `${await mainT('init.failed.title')}\n\n${errorToText(err)}\n\n${await mainT('init.failed.nothingSaved')}`,
          state: 'done',
        })
      }
      await saveMessages(sessionId, history)
      emit(win, { type: 'message', sessionId, message: assistantMessage })
      if (ownsSession()) emit(win, { type: 'status', sessionId, status: 'idle' })
      return
    }

    /**
     * End-of-turn check: it compares the filesystem against the initial
     * snapshot. The result is DISCRIMINATED on purpose — before, "nothing changed" and
     * "the capture failed" both returned undefined, and a git error was
     * indistinguishable from a turn that wrote nothing. Since this now
     * feeds the record sent to the model, confusing the two would make the engine
     * claim "no file changed" without having checked.
     */
    const verifyTurn = async (): Promise<TurnVerification> => {
      const start = assistantMessage.snapshot?.start
      if (!toolContext || !start) return { state: 'unknown' }
      try {
        const end = await capture(toolContext.directory)
        if (end === start) return { state: 'unchanged' }
        const changes = await diff(toolContext.directory, start, end)
        // The snapshot is of the FOLDER, not of the agent: what the person saved by hand in
        // the panel during the turn also enters the diff. Without subtracting it, the
        // verified record credits to the model a file it never
        // touched — and that is the line that sustains the anti-overclaim check.
        const notAgent = manualSavesUnder(toolContext.directory, turnStartedAt)
        // And what the tools of ANOTHER conversation wrote in this folder in the same
        // interval — turns no longer wait for each other, so the folder's diff
        // may bring their work.
        const others = currentTurnWrites(toolContext.directory)?.others ?? []
        for (const file of changes.files) if (coveredBy(file, others)) notAgent.add(file)
        const files = notAgent.size > 0 ? changes.files.filter((f) => !notAgent.has(f)) : changes.files
        // Only the user's files were left: from the turn's point of view, the
        // agent wrote nothing — which is exactly what 'unchanged' says.
        // The `end` goes along because the folder CHANGED (manual saves): the revert of
        // a previous turn needs this tree so as not to restore in bulk.
        if (files.length === 0) return { state: 'unchanged', end }
        return {
          state: 'changed',
          end,
          files,
          // The patch is not just bookkeeping: it feeds the Diff tab and the list of
          // files in the card. Filtering only `files` would leave the user's file
          // out of the record and still visible on screen as the agent's work.
          patch: notAgent.size > 0 ? stripFilesFromPatch(changes.patch, notAgent) : changes.patch,
        }
      } catch (err) {
        console.error('[snapshot] final capture failed:', err)
        return { state: 'unknown', error: errorToText(err) }
      }
    }
    /** Verdict of the last iteration of the loop — reused after the break so as
     *  not to capture the snapshot twice. */
    let verification: TurnVerification | null = null

    const mode: PermissionMode = input.options.permissionMode ?? 'ask'
    const toolApproval = supportsTools
      ? createToolApproval(
          // Global selector turn: switching the mode mid-answer applies from
          // the next tool on. Explicit mode (plan, routine) stays fixed.
          input.options.followGlobalPermission ? () => globalMode(input.sessionId, mode) : mode,
          input.sessionId,
          toolContext?.directory ?? null,
          assistantMessage.id,
          controller.signal,
          input.parentSessionId,
          input.workerTitle,
        )
      : undefined

    // Messages for the FIRST call of the round (history up to the last
    // user message). The continuations use the accumulated answer messages
    // of the previous turn + the instruction to continue (opencode's
    // pattern: inject a "synthetic user message" and re-enter the loop,
    // with a cap of attempts per turn).
    // The turn's memories enter the SAME user message, never the system
    // prompt: the system is frozen per session for the providers' prefix
    // cache, and changing it on every question would throw that cache away. The block is
    // retrieved with the current message (and, if it does not explain itself, with the
    // previous turn) — see memory/retrieval.ts.
    // One query vector per message, shared by the memory and the skills search.
    const turnEmbed = createTurnEmbedder()
    const memoryBlock =
      input.options.brainContext && input.orchestrationRole !== 'worker'
        ? renderMemorySuggestions(
            await retrieveForTurn({
              embed: turnEmbed,
              text: input.text,
              mode: input.mode,
              directory: toolContext?.directory,
              recent: recentTurns(history),
              // What is already in the prompt's fixed block is not repeated here.
              exclude: promptMemoryIds(input.sessionId, input.mode, input.directory),
            }),
          )
        : ''
    // Shortcut panel: a request about the screen already arrives with the window read as
    // text, and the conversation goes with only the recent thread (see overlay/turn-context.ts).
    const overlayScreen =
      input.options.overlay && wantsScreen(input.text) ? await readFrontWindowText(input.sessionId).catch(() => null) : null
    const goodWindowText = overlayScreen && 'text' in overlayScreen && !overlayScreen.poor ? overlayScreen.text : null
    // Poor text (frame only) or an unreadable window: the image is what is left, and it goes
    // described as text — the shortcut's model does not decide to call the tool on its own.
    const screenDescription =
      input.options.overlay && overlayScreen && !goodWindowText && input.visionModel
        ? await describeFrontScreen(input.visionModel, input.text, input.language).catch(() => null)
        : null
    const prefetchedScreen = goodWindowText || screenDescription
    // Subchats' latest results and the chats that continue this one: they change between
    // turns, so they ride in the message like the memories (see subchats.ts).
    const subchatsBlock =
      input.orchestrationRole !== 'worker' ? await subchatsTurnBlock(input.sessionId).catch(() => '') : ''
    const skillsBlock = await skillsTurnBlock(input, recentTurns(history), turnEmbed)
    const turnBlock = [
      memoryBlock,
      skillsBlock,
      subchatsBlock,
      prefetchedScreen
        ? prefetchedScreenBlock({
            windowText: goodWindowText ?? (overlayScreen && 'text' in overlayScreen ? overlayScreen.text : null),
            description: screenDescription,
          })
        : '',
      // Last on purpose: it is what the model needs to have read most
      // recently before answering (see session/retry-note.ts).
      retryNote,
    ]
      .filter(Boolean)
      .join('\n\n')
    const modelHistory = input.options.overlay ? recentOverlayHistory(history.slice(0, -1)) : history.slice(0, -1)
    const initialMessages = normalizeMessages(
      withMemoryBlock(toModelMessages(modelHistory, modelVision), turnBlock),
      interleavedReasoningField(provider, primary.modelId),
    )
    let autoContinues = 0
    const filterLeaks = input.options.overlay === true || input.options.voiceCall === true
    const rawTexts = new Map<string, string>()
    let todoNudges = 0
    let overclaimNudges = 0
    let screenNudges = 0
    let lastFinishReason: string | undefined
    let previousResponseMessages: ModelMessage[] = []
    let truncatedToolNames = ''

    // Tool catalog on demand: the real ToolSet + the families. `null`
    // when the model does not accept tools — then nothing is trimmed, the turn goes
    // as before (it is also the fallback if the trimming is rejected).
    const catalog = supportsTools
      ? buildCatalog(input, toolContext, imageHooks, modelVision, win)
      : null
    // A worker's catalog has no bridges: it is the static set, sent whole.
    const onDemand = catalog?.onDemand ? catalog : null
    const existingNames = catalog ? new Set(Object.keys(catalog.tools)) : new Set<string>()
    // Deterministic self-activation (`@mcp:<server>` in the message). The
    // plan's fragile heuristics (attachment, "folder with video") only enter afterwards
    // of measurement — without a number, they give tools back on a "hi" for free.
    const autoFamilies = [
      ...familiesMentionedInText(input.text ?? '', onDemand?.families ?? []),
      // Families the prompt asks for by name: without them declared, the
      // instruction exists and the tool does not.
      ...(onDemand ? DEFAULT_ACTIVE_FAMILIES : []),
    ]
    // The model history carries no tool parts of previous turns: what keeps a
    // family loaded in turn N active in N+1 are the ToolParts of the chat itself,
    // in the same window the model sees (a compaction takes them along).
    const lastSummary = findLastSummaryIndex(modelHistory)
    const priorCalls = onDemand ? priorToolCalls(lastSummary >= 0 ? modelHistory.slice(lastSummary) : modelHistory) : []
    const deriveOptions = onDemand
      ? {
          auto: autoFamilies,
          cap: toolLimitFor(input.providerId),
          resolveQuery: (family: ToolFamily, query: string) => queryFamily(onDemand.tools, family, query),
        }
      : {}
    const deriveTurn = (messages: readonly unknown[]) =>
      onDemand ? deriveActive([...priorCalls, ...messages], onDemand.families, existingNames, deriveOptions) : null
    const initialActive = deriveTurn(initialMessages)
    // Largest set declared in a step — what the telemetry calls "offered".
    let offeredTools = initialActive?.names.length ?? 0
    // The map is the index: families, what each one solves, what is ACTIVE and
    // what is DISABLED — with the reason.
    const promptMap = onDemand
      ? buildMap(onDemand.families, { active: initialActive?.families }).text
      : undefined

    for (;;) {
      const result = streamText({
        model,
        system: await buildSystemPrompt(input, modelVision, promptMap),
        messages:
          autoContinues === 0 && todoNudges === 0 && overclaimNudges === 0 && screenNudges === 0
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
                        : screenNudges > 0
                        ? NO_SCREEN_TOOL_PROMPT
                        : todoNudges > 0
                        ? TODO_COMPLETION_PROMPT
                        : truncatedToolNames
                          ? AUTO_CONTINUE_TOOL_PROMPT(truncatedToolNames)
                          : AUTO_CONTINUE_PROMPT,
                  },
                ],
                interleavedReasoningField(provider, primary.modelId),
              ),
        tools: catalog?.tools,
        // The active set counts already in step 0 (the prepareStep only runs from
        // step 1); in the others, the value returned by it is what rules. A call to
        // an inactive tool still runs — the SDK parses against the whole ToolSet —
        // and its use activates the family from the next step on.
        activeTools: initialActive?.names,
        toolApproval,
        stopWhen: stepCountIs(maxSteps),
        abortSignal: controller.signal,
        providerOptions: await buildProviderOptions({ ...input, providerId: primary.providerId, modelId: primary.modelId }),
        prepareStep: ({ stepNumber, messages }) => {
          // Trimming of the tool loop accumulation. It is HERE that the turn's context is
          // held: compaction only reaches the history between turns, and what
          // overflows are the tool calls + results that the SDK resends on
          // every step. Without this a long turn asks for millions of tokens and the
          // provider refuses the whole request.
          const droppedBefore = stepPreparer.dropped
          const prepared = stepPreparer.prepare(messages)
          // An image returned by a tool does not reach the model in the
          // openai-compatible adapter (it becomes base64 in a string): it leaves the result and
          // travels as a user message — see tool-images.ts. Before the
          // meter, because the base64 in the result inflated the bill without serving
          // any purpose.
          const hoisted = hoistToolImages(prepared)
          const preparedWithImages = hoisted.messages
          if (stepPreparer.dropped > droppedBefore) {
            console.warn(
              `[context] step ${stepNumber}: ${stepPreparer.dropped - droppedBefore} tool result(s) dropped (working ceiling ${stepPreparer.workingBudget}, safety ${stepPreparer.budget} tokens)`,
            )
          }
          // Live meter: what is about to go out, when it grew past
          // the last real value. It is the warning that was missing in a long turn — the
          // number only moved at the end of the answer (or never, if it failed).
          const outgoing = estimateTokens(preparedWithImages)
          if (outgoing > lastContextInput) {
            lastContextInput = outgoing
            emitContext(outgoing, 0, true)
          }
          // The last step EXECUTED is maxSteps - 1: the SDK calls prepareStep with
          // stepNumber = steps already completed and the do-while stops when
          // steps.length === maxSteps (isStepCount uses equality). With
          // `stepNumber >= maxSteps` the guard below never fired — it was the turn
          // ending on a tool call without text.
          if (stepNumber < maxSteps - 1) {
            // Recomputed on every step from the history: it is what makes the
            // family loaded NOW count in the next step, without state.
            const active = deriveTurn(preparedWithImages)
            if (!active) return preparedWithImages === messages ? {} : { messages: preparedWithImages }
            offeredTools = Math.max(offeredTools, active.names.length)
            if (active.dropped.length > 0) {
              console.warn(
                `[tools] active set cap: ${active.dropped.join(', ')} dropped for lack of use`,
              )
            }
            return { messages: preparedWithImages, activeTools: active.names }
          }
          return {
            activeTools: [],
            toolChoice: 'none' as const,
            messages: [...preparedWithImages, { role: 'user' as const, content: MAX_STEPS_PROMPT }],
          }
        },
        onError: () => {
          // errors are handled in the fullStream loop
        },
      })

      let streaming = false
      let sawFinish = false
      let lastSave = Date.now()
      const reasoningStart = new Map<string, number>()
      // Input of the LIVE_OPEN_TOOLS tools still streaming: the JSON arrives
      // in pieces (tool-input-delta) and the canvas/composition name
      // shows up LONG before the model finishes streaming the HTML — opening the
      // tab there is what lets the user watch the piece assemble live.
      const liveOpen = new Map<string, { toolName: string; json: string; opened: boolean }>()
      // Usage of the last step (last real call to the model) — unlike the
      // turn total (sum of all steps), it reflects the real size of the
      // context at the moment the answer ended.
      let lastStepUsage: ReturnType<typeof toStepUsage> | undefined
      // Cost added up step by step: the price tier depends on the size of EACH
      // call (e.g. above 200k tokens), so the turn total is not enough.
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
            // A provider without usage returns zeros: then the estimate still counts.
            if (lastStepUsage.input > 0) {
              lastContextInput = lastStepUsage.input
              emitContext(lastStepUsage.input, lastStepUsage.output, false, lastStepUsage)
            }
            break
          case 'text-start':
            // Texts generated in the overclaim nudge continuation are born
            // marked as internal ('nudge'): the UI renders them in a faded
            // color, never as the final answer. At the end of the loop: files
            // changed → marker removed (the last answer counts as
            // final); only "nothing to fix" → becomes 'internal' and disappears from the chat.
            //
            // The TODO-closing nudge gets a marker of its own
            // ('todo'): the model answers it with a bookkeeping line
            // ("checklist updated"), and without a marker that text became
            // the LAST one of the message — the UI promoted the line to the final
            // answer and the real answer, already written, stayed faded
            // (it looked like the final text had been replaced). 'todo'
            // is never promoted, not even when the turn writes files.
            upsertPart({
              id: startStreamPart(part.id),
              type: 'text',
              text: '',
              state: 'streaming',
              source: overclaimNudges > 0 || screenNudges > 0 ? 'nudge' : todoNudges > 0 ? 'todo' : undefined,
            })
            break
          case 'text-delta': {
            const existing = assistantMessage.parts.find((p) => p.id === streamPartId(part.id))
            if (existing?.type === 'text') {
              if (filterLeaks) {
                // Shortcut panel and spoken call: the text goes to the screen and
                // to the voice, so the reasoning that the model writes in the
                // answer is cut BEFORE it goes out (see leaked-reasoning.ts).
                const raw = (rawTexts.get(existing.id) ?? existing.text) + part.text
                rawTexts.set(existing.id, raw)
                const cleaned = stripLeakedReasoning(raw, input.language)
                if (cleaned.startsWith(existing.text)) {
                  const delta = cleaned.slice(existing.text.length)
                  existing.text = cleaned
                  if (delta) {
                    emit(win, { type: 'part-delta', sessionId, messageId: assistantMessage.id, partId: existing.id, kind: 'text', delta })
                  }
                } else {
                  // A sentence that had already gone out became a thought: it re-emits the whole text.
                  upsertPart({ ...existing, text: cleaned })
                }
                break
              }
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
            // Cleanup of the visible text: the model sometimes copies the
            // internal markers it received in the context ("[Verified
            // record: ...]", "[SYSTEM: ...]"). Here the part is already complete,
            // so upsertPart re-emits the whole text clean — what the UI
            // shows and what is persisted go out without the marker.
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
            // A worker does not open a tab: the panel belongs to the session that talks to the user.
            if (input.orchestrationRole !== 'worker') {
              liveOpen.set(part.id, { toolName: part.toolName, json: '', opened: false })
            }
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
            // Provider without input streaming: the name only arrives here, on the complete
            // tool-call — before execute, so the tab still opens early.
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
            // Vision mode: the image description becomes text in the history (the
            // ToolPart is not resent in future turns — the placeholder in the
            // user message is replaced by the real description).
            if (part.toolName === 'describe_image') {
              // Only the turn's attachment has a placeholder to replace. A
              // gallery reference (orbit-media://) describes an image that is not
              // in any message, and there is nowhere to write it — the number as
              // text, however, is still the turn's attachment.
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
            // Transcript of an audio attachment: it goes back to the attachment's note.
            // Two forms, according to the destination chosen by the agent: the text
            // (in the context) or only where it is (a document for the user).
            if (part.toolName === 'transcribe') {
              // The unified tool receives `sources`; only the transcript of ONE attached
              // audio (aud_…) goes back to the attachment's note — a video already has its
              // own note, with the cache.
              const sources = (existing?.input as { sources?: { path?: string }[] } | undefined)?.sources
              const ref = sources?.length === 1 ? (sources[0]?.path ?? '') : ''
              const audioId = audioIdFrom(ref)
              const output = part.output as { documentId?: string } | string
              const body =
                typeof output === 'string' && output.startsWith('Transcript of ')
                  ? `(Attachment, not a user message — already transcribed with transcribe.)\n\n${output}`
                  : typeof output === 'object' && output?.documentId
                    ? `(Attachment, not a user message. Its transcript was delivered to the user as document ${output.documentId} and is NOT in your context — call read_document with that id if you need it.)`
                    : null
              if (audioId && body) await persistAudioTranscript({ sessionId, audioId, body, history, win })
            }
            // Generated audio (or compressed/extracted): a player in the answer,
            // like the image from show_image.
            if (
              part.toolName === 'audio_generate' ||
              part.toolName === 'media_compress' ||
              // Download by link: the audio extracted from a video plays here.
              part.toolName === 'ytdlp_download'
            ) {
              const output = part.output as { audioUrl?: string; title?: string; durationMs?: number } | string
              if (typeof output === 'object' && output?.audioUrl) {
                upsertPart({
                  id: `${part.toolCallId}-audio`,
                  type: 'audio',
                  src: output.audioUrl,
                  title: output.title || undefined,
                  durationMs: output.durationMs,
                })
                // Links the store record to the message ("open in chat" in the gallery).
                void attachMediaMessage(output.audioUrl, assistantMessage.id, sessionId)
              }
            }
            // Rendered/shown video: player in the answer. The file stays
            // in the project; the result carries the already registered orbit-video:// URL.
            if (
              part.toolName === 'video_render' ||
              part.toolName === 'motion_render' ||
              part.toolName === 'media_compress' ||
              part.toolName === 'browser_record' ||
              part.toolName === 'cu_record_stop' ||
              // Video downloaded from a link: player in the answer, like a render.
              part.toolName === 'ytdlp_download' ||
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
            // show_image and image_edit: the image becomes part of the answer
            // (rendered by ai/image). In image_edit that is the point — an
            // edit described in text would force the user to open the gallery
            // to know whether the background crop came out well.
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
                // Completes the media record: the tool does not know the
                // message id (it runs in the middle of the turn) — the gallery uses that
                // link for "open in chat".
                void attachMediaMessage(output.mediaUrl, assistantMessage.id, sessionId)
              }
            }
            // video_timeline: the sheet ALWAYS goes to the gallery (it is what
            // allows showing it later with show_image), but it only enters the
            // answer when the tool was called with show: true — the default is the
            // internal look at the decision points. Without this the image existed
            // only in the model's context and the user never saw anything.
            if (part.toolName === 'video_timeline') {
              const output = part.output as { mediaUrl?: string; alt?: string; shown?: boolean } | string
              if (typeof output === 'object' && output?.mediaUrl && output.shown === true) {
                upsertPart({
                  id: `${part.toolCallId}-img`,
                  type: 'image',
                  src: output.mediaUrl,
                  alt: output.alt || undefined,
                })
                // Completes the media record (same reason as show_image): the
                // tool runs in the middle of the turn and does not know the message id.
                void attachMediaMessage(output.mediaUrl, assistantMessage.id, sessionId)
              }
            }
            // image_import: the images the agent brought from an open collection
            // appear in the answer, one part for each. They stay OUT of turnMediaUrls
            // on purpose: that set is the ladder steps of an edit, which
            // vanish at the end of the turn — and a chosen photo is not a step.
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
            // create_artifact/update_artifact: the HTML becomes part of the answer
            // (rendered by ai/artifact-part). The update emits a NEW part
            // in the current turn instead of touching the old message: the file is the
            // same, so the old card starts showing the new version on its own
            // — what the new part marks is WHERE in the conversation the change was made.
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
            // create_document/update_document: the document becomes part of the
            // answer (rendered by ai/document-part). Same contract as the
            // artifact: the message persists the preview URL, never the content.
            if (
              part.toolName === 'create_document' ||
              part.toolName === 'update_document' ||
              // Transcript delivered to the user: it is a chat document.
              part.toolName === 'transcribe' ||
              // Transcript of a video by link, with deliver "user".
              part.toolName === 'ytdlp_transcript' ||
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
            // Execution denied by the permission gate (policy or user)
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
            // Aggregated usage of the generation (all steps) + cost via the catalog;
            // lastStep keeps the real context size on the last call.
            // In auto-continue, it adds up on every iteration of the loop (the message is the
            // same, but each call to the model has its own usage).
            {
              // With the steps already summed, the cost comes from them; without any step
              // (a provider that does not report), it falls back to the turn total.
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
            // Rare backstop: the prepareStep above already forces a text summary
            // on the last step (finishReason should come as 'stop'). This only
            // fires if the model still does not close cleanly — without it,
            // that case would be indistinguishable from a normal conclusion both
            // for the UI and for the model in the next turn.
            if (stepCount >= maxSteps && part.finishReason !== 'stop') {
              assistantMessage.truncated = true
            }
            break
          case 'error':
            throw part.error instanceof Error ? part.error : new Error(errorToText(part.error))
          default:
            break
        }

        // Incremental persistence: it guarantees that a crash does not lose the answer
        if (assistantMessage.parts.length > 0 && Date.now() - lastSave > 2000) {
          lastSave = Date.now()
          await saveMessages(sessionId, history)
        }
      }

      // Some providers/gateways end the stream without emitting `finish` (or
      // return a non-standard reason) when the connection is interrupted.
      // Without this diagnostic the turn looked normally completed and the agent
      // stopped midway. We do not try to repeat automatically — that could
      // duplicate tool calls — but we persist the state as truncated and let
      // the next turn receive the continuation reminder.
      if (!sawFinish && !controller.signal.aborted) {
        assistantMessage.truncated = true
        console.warn(`[chat] stream ended without finish for session ${sessionId}`)
      }

      // Auto-continue on the OUTPUT TOKEN limit (finish_reason 'length'):
      // the answer was cut midway, not finished — same as opencode
      // (#17471/#18108), we re-enter the loop with a "synthetic user message"
      // asking to continue from the exact cut point, with a cap per turn.
      // If the last tool call was left half-done (a part without result), the tool
      // is marked as not executed and the model is instructed to split the
      // operation into smaller pieces.
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
        // The continuation cap ran out: it signals truncation (the UI shows the
        // warning and the next turn receives the continue nudge via
        // messageContextText) — never a silent end.
        assistantMessage.truncated = true
      }

      // TODO-closing nudge: the turn ended naturally ('stop')
      // but the last todowrite still has "in_progress" items — the model
      // answered without marking the tasks as done, and the card stays with
      // an endless spinner. It re-enters the loop with the synthetic user message
      // (auto-continue pattern) asking for the closing, capped per turn.
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

      // Sign that the last part is a completed text — used by the
      // overclaim nudge below.
      const lastPart = assistantMessage.parts[assistantMessage.parts.length - 1]
      const lastPartIsDoneText = lastPart?.type === 'text' && lastPart.state === 'done'

      // Overclaim nudge: the answer claims to have done something and the snapshot
      // proves that nothing was written — it covers the case where the agent reports
      // completion without having touched any file.
      //
      // It only charges in turns that USED write tools: without any of them
      // (an informative question answered with reading/text only), conclusion
      // verbs describe work from previous turns — the user
      // explicitly asked that this check not become the final answer.
      //
      // The verdict is computed here (and not after the loop) so that the
      // correction can be charged still inside the turn; it is stored in `verification` and
      // is reused at the end, without capturing the snapshot twice.
      // In plan mode writing is off and the deliverable (PLAN.md) is
      // written outside the turn — "I wrote the plan" there is not overclaim.
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
          console.warn('[overclaim] turn claimed completion without changing files', { sessionId })
          overclaimNudges++
          verification = null // the turn continues: the current verdict is not the final one
          previousResponseMessages = await result.responseMessages
          continue
        }
      }
      // Screen: the tools exist in this turn, none was called, and the answer
      // talks as if it had looked or acted — it charges once, as above.
      if (
        lastFinishReason === 'stop' &&
        !controller.signal.aborted &&
        screenNudges < MAX_OVERCLAIM_NUDGES &&
        overclaimNudges === 0 &&
        lastPartIsDoneText &&
        (input.options.overlay === true || agentMayControlComputer(input, isComputerAvailable())) &&
        !usedScreenTools(assistantMessage.parts) &&
        // With the screen already described, there is nothing to charge; with only the text, it charges the
        // promise to look at the image without calling the tool.
        (!prefetchedScreen || (!screenDescription && claimsImageLook(partText(assistantMessage.parts, 'text')))) &&
        claimsScreenWork(partText(assistantMessage.parts, 'text'))
      ) {
        console.warn('[overclaim] turn talked about the screen without calling a screen tool', { sessionId })
        screenNudges++
        verification = null // the turn continues: the current verdict is not the final one
        previousResponseMessages = await result.responseMessages
        continue
      }
      break
    }

    // Finishes parts that were left streaming (e.g. abort)
    for (const part of assistantMessage.parts) {
      if ((part.type === 'text' || part.type === 'reasoning') && part.state === 'streaming') {
        if (part.type === 'text') part.text = stripEngineMarkers(part.text)
        part.state = 'done'
      }
      // Backstop: a tool-call without result that was not caught by the
      // auto-continue branch above (e.g. continuation cap exhausted with
      // finish_reason 'length') would stay 'running' forever — and the action
      // accordion (TaskGroup) reads that as "still working": shimmer and
      // "Working" forever even with the turn already ended and saved.
      if (part.type === 'tool' && part.state === 'running') {
        part.state = 'error'
        part.error = 'Tool call has no result — the turn ended before it finished.'
      }
    }
    // The ladder steps leave before the answer is written: what stays is the
    // result, not the path to it.
    await purgeDraftImages()
    // Screen charge that worked: after the warning the model did look
    // (it called a screen tool) and corrected it. The correction is the answer; the text
    // before the warning was said without looking and leaves the conversation — in the shortcut
    // panel it sat on top of the right answer.
    if (screenNudges > 0 && usedScreenTools(assistantMessage.parts)) {
      const correction = [...assistantMessage.parts]
        .reverse()
        .find((p): p is TextPart => p.type === 'text' && p.source === 'nudge')
      if (correction && !isNoCorrectionReply(correction.text)) {
        for (const part of assistantMessage.parts) {
          if (part.type === 'text' && part !== correction && part.source !== 'internal') part.source = 'internal'
        }
        correction.source = undefined
      }
    }
    assistantMessage.completedAt = Date.now()
    // TODO not closed at the end of the turn → persistent reminder for the
    // next turn (messageContextText re-emits the warning via todoReminder).
    if (hasTodoInProgress(assistantMessage.parts)) assistantMessage.todoReminder = true
    // Persists the message first so the user sees it as soon as possible
    await saveMessages(sessionId, history)
    // Turn verdict: it reuses what the loop already computed (it only recaptures if
    // the turn left by another path — abort, step ceiling).
    const endSnapshot = verification ?? (await verifyTurn())
    // Texts of the overclaim nudge: if the model did in fact write files after
    // the warning, they stop being internal — the last answer goes back to being the
    // final answer (white). Without changes, two outcomes: the answer to the
    // nudge was only the confirmation that there was nothing to fix (a false
    // positive of the trigger — e.g. the text described work from a previous
    // turn) → it becomes 'internal' and the UI does not even render it; or there was a real
    // correction ("Correction: …") → it stays 'nudge', visible in a faded color.
    if (endSnapshot.state === 'changed') {
      // Promotes ONLY the last text of the nudge: it is the one that carries the real answer
      // after the correction (work done + "Correction: …"). The previous ones stay
      // 'nudge' (faded) — scanning all of them opened the way for the nudge text
      // that is not the final answer turning white. If the last one was not a real
      // correction ("Nothing to fix.") but the snapshot changed by another route
      // (e.g. the nudge's own tools wrote something), it does not promote either:
      // an internal verification line never becomes the final answer.
      const lastNudgeText = [...assistantMessage.parts]
        .reverse()
        .find((p): p is TextPart => p.type === 'text' && p.source === 'nudge')
      if (lastNudgeText) {
        lastNudgeText.source = isNoCorrectionReply(lastNudgeText.text) ? 'internal' : undefined
      }
    } else if (overclaimNudges > 0 || screenNudges > 0) {
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
      // What the person saved by hand in the panel during the turn is not the agent's:
      // the revert preserves those paths instead of undoing them.
      if (toolContext) {
        assistantMessage.snapshot.manual = [...manualSavesUnder(toolContext.directory, turnStartedAt)]
        // Ownership for the revert: what this turn's tools wrote, and what
        // those of other conversations wrote while it ran.
        const writes = currentTurnWrites(toolContext.directory)
        if (writes) {
          assistantMessage.snapshot.authored = writes.authored
          assistantMessage.snapshot.others = writes.others
        }
      }
      if (endSnapshot.state === 'changed') {
        assistantMessage.snapshot.end = endSnapshot.end
        assistantMessage.snapshot.files = endSnapshot.files
        assistantMessage.snapshot.patch = endSnapshot.patch
      } else if (endSnapshot.state === 'unchanged' && endSnapshot.end) {
        // Folder changed only by a manual save: it keeps the final tree so the revert
        // can isolate what belongs to the turn (the `manual` above) from what does not.
        assistantMessage.snapshot.end = endSnapshot.end
      }
      await saveMessages(sessionId, history)
    }

    await bumpSessionActivity(win, sessionId)

    // Outcome telemetry, at the end: only now the turn's ToolParts say what was
    // called and what failed.
    if (onDemand) {
      void recordTurn({ families: onDemand.families, offered: offeredTools, parts: assistantMessage.parts })
    }

    emit(win, { type: 'message', sessionId, message: assistantMessage })
    if (ownsSession()) emit(win, { type: 'status', sessionId, status: 'idle' })
    // Turn finished: this is where the next compaction can become an offer
    // of a new chat (see maybeSuggestCompaction). A worker has nobody to decide.
    if (input.orchestrationRole !== 'worker') {
      void maybeSuggestCompaction(win, sessionId, history, catalogModel, modelVision)
    }
    // Native notification (window out of focus + preference enabled)
    void notifyNewMessage(sessionId, assistantMessage)

    // Title: generated at the START of the turn, in dispatchSend (see
    // startSessionNaming) — here it showed up a long time ago.
    // A suggestion only makes sense for someone chatting: workers and routines
    // have nobody typing the next message.
    if (getAppSettings().promptSuggestions && !input.orchestrationRole && !assistantMessage.error) {
      void generateSuggestion(input, assistantMessage, win)
    }
        break
      } catch (err) {
        // Attempt failed: it rotates if the failure is recoverable and it has not
        // emitted content yet (v1 does not resend tokens already delivered). Abort and final
        // errors go up to the outer catch — current behavior.
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
          // Stopped during the wait: it falls into the outer catch as an abort (idle)
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
    // Overflow after completed steps: the history fit in the first
    // call, what went past the window was the turn's accumulation. Compacting does not
    // reach that — the right guidance is another one (see context-length-turn).
    const kind = classified.kind === 'context-length' && turnSteps > 0 ? 'context-length-turn' : classified.kind
    assistantMessage.error = aborted ? undefined : message
    assistantMessage.errorKind = aborted || kind === 'unknown' ? undefined : kind
    // What the turn wrote BEFORE failing. The success path records it in
    // `authored` (near the end of the try); the failure never recorded it — and it is
    // exactly the turn that failed that needs ownership, because it is about it
    // that the next retry warns the model (see session/retry-note.ts) and it is what
    // the revert would have to isolate.
    if (input.mode === 'code' && input.directory) {
      const writes = currentTurnWrites(input.directory)
      if (writes) {
        assistantMessage.snapshot = {
          ...(assistantMessage.snapshot ?? {}),
          authored: writes.authored,
          others: writes.others,
        }
      }
    }
    for (const part of assistantMessage.parts) {
      if ((part.type === 'text' || part.type === 'reasoning') && part.state === 'streaming') {
        if (part.type === 'text') part.text = stripEngineMarkers(part.text)
        part.state = 'done'
      }
      // tool-call arrived but tool-result/tool-error never came — abort in the middle
      // of the execution, or the connection dropped before the result. Without this the part
      // stays 'running' forever, and the action accordion (TaskGroup) reads that
      // as "still working": shimmer and "Working" forever even with the
      // turn already ended.
      if (part.type === 'tool' && part.state === 'running') {
        part.state = 'error'
        part.error = aborted ? 'Interrupted.' : (message ?? 'Execution did not finish.')
      }
    }
    assistantMessage.completedAt = Date.now()
    await saveMessages(sessionId, history)
    emit(win, { type: 'message', sessionId, message: assistantMessage })
    // A replaced turn reports nothing: the newer send already owns the status (see
    // ownsSession). Its empty reply stays in the history — the UI shows no bubble for it.
    if (ownsSession()) {
      emit(win, {
        type: 'status',
        sessionId,
        status: aborted ? 'idle' : 'error',
        error: aborted ? undefined : message,
        // It goes along so the mobile can translate the warning: the raw text is diagnostic.
        errorKind: aborted ? undefined : assistantMessage.errorKind,
      })
      // Real failure (not a manual abort) → native error notification
      if (!aborted) void notifyChatError(sessionId, message ?? '', assistantMessage.errorKind)
    }
  } finally {
    // Writes the FINAL state of each journal path: it is what the revert uses
    // to know whether the turn still owns the current state (see media-journal).
    await closeMediaJournal()
    clearTurnImages(sessionId)
    // End of the turn = end of computer control: the indicator goes away, the panic
    // shortcut is released and the apps' accessibility flags are given back.
    endActivity(sessionId)
    if (controller.signal.aborted) abortedTurns.add(sessionId)
    else abortedTurns.delete(sessionId)
    if (abortControllers.get(sessionId) === controller) abortControllers.delete(sessionId)
    const activeCmd = activeBashCommands.get(sessionId)
    activeBashCommands.delete(sessionId)
    if (controller.signal.aborted && activeCmd) {
      console.warn(
        `[chat] turn of session ${sessionId} aborted with an active bash command — ` +
          'if it did not finish, it is still running (see the processes panel): ' +
          `${activeCmd}`,
      )
    }
    perf.end({
      steps: turnSteps,
      tools: assistantMessage.parts.filter((p) => p.type === 'tool').length,
      aborted: controller.signal.aborted,
      ...(assistantMessage.error ? { error: assistantMessage.error.slice(0, 160) } : {}),
    })
  }
}

/**
 * Manual compaction triggered by the button in the UI.
 *
 * With a turn of the conversation in progress it does NOT run: it reads the history from
 * disk, inserts the summary, writes and re-emits the whole list — and the turn, which has
 * its own copy of the history, writes over it at the end. That is what happened: the
 * re-emitted list did not have the message the user had just sent (the bubble vanished
 * from the screen), the summary arrived in the renderer as "the answer" (and call mode
 * read it aloud), and in the end the turn erased the summary from disk. Automatic
 * compaction runs INSIDE the turn, with the right copy.
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
    console.error('[compaction] manual failed:', err)
  }
}
