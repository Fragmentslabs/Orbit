/**
 * Types shared between the main process (Electron) and the renderer.
 * Data model inspired by opencode: sessions + messages composed of "parts"
 * (text, reasoning and tool calls).
 */

export type SessionMode = "chat" | "code"

export type ChatStatus = "idle" | "submitted" | "streaming" | "cancelling" | "error" | "fallback"

/** Result of the text search in sessions (title + messages). */
export interface SearchHit {
  sessionId: string
  sessionTitle: string
  mode: SessionMode | string
  updatedAt: number
  snippet: string
}

export interface SessionOrchestration {
  role: "orchestrator" | "worker"
  /** Workers only: the orchestrator session that created this worker */
  parentSessionId?: string
  /** Description of the delegated task (workers) */
  task?: string
  /** Modes the orchestrator gave this worker (workers). They stay on the
   *  session because the plan is overwritten by every new plan, and whoever
   *  resumes the conversation later (message_worker) needs the same modes. */
  options?: SendMessageOptions
  /** Worker Vision mode (see OrchestrationTask.vision) */
  vision?: boolean
  /** The model this worker runs on (a member of a routine's team can have its own). */
  model?: { providerId: string; modelId: string }
}

/** Active revert state in a session. The revert truncates the messages
 * starting at `messageId` immediately (both code mode and chat mode),
 * keeping the discarded ones in `discardedMessages` to allow unrevert.
 * In code mode, `snapshot`/`files`/`diff` record the filesystem state
 * prior to the restore. */
export interface SessionRevert {
  messageId: string
  /** Tree hash captured before the restore (code mode) — allows unrevert of the filesystem */
  snapshot?: string
  /** Tree hash AFTER the restore (code mode). The unrevert only gives a
   *  path back if it is still exactly in this state; if another conversation
   *  (or the person) touched it in between, the path is preserved and becomes a conflict. */
  after?: string
  /** Files actually reverted (code mode) */
  files?: string[]
  /** Files the turn changed but that were NOT reverted because they changed
   *  afterwards (another conversation, external edit, manual save in the panel). */
  conflicts?: string[]
  /** Files that changed in the folder DURING the undone turns but that Orbit's
   *  write tools did not write (bash, MCP, something from outside):
   *  uncertain author. They are NOT reverted by default — the bar offers reverting
   *  them too (`session:revertUncertain`). */
  uncertain?: string[]
  /** The undone turns, from the last to the first — what the revert of the
   *  uncertain paths needs to redo the transition. Internal. */
  fileTurns?: RevertFileTurn[]
  /** Unified diff of the reverted changes (code mode) */
  diff?: string
  /** Messages discarded in the truncation — allows unrevert of the conversation */
  discardedMessages?: ChatMessage[]
  /** true when the filesystem was restored (revert in code mode with
   * snapshot). false when the filesystem could not be restored (code
   * mode without a snapshot for the message) — the UI warns explicitly in
   * stead of treating it as a chat revert. Absent in chat mode (no files
   * involved). */
  filesRestored?: boolean
  /** Reason the filesystem was not restored — present when
   * filesRestored === false in code mode. */
  reason?: 'no-snapshot' | 'capture-failed' | 'no-end-snapshot'
  /** What the revert undid OUTSIDE the repository, in both modes: the pieces
   * (motion, design, slides) and the gallery (artifacts, documents, images,
   * audio, videos). Absent when the undone turns did not touch media. */
  media?: SessionMediaRevert
}

/** One turn undone by the revert (code mode): the transition end → start. */
export interface RevertFileTurn {
  /** Tree at the end of the turn. */
  from: string
  /** Tree of the start of the turn. */
  to: string
  /** Paths with confirmed authorship (and manual saves, which become a conflict). */
  paths: string[]
  /** Paths of uncertain author in this turn. */
  uncertain: string[]
  /** Manual saves from the panel during the turn — never reverted. */
  manual: string[]
}

/** Result of the unrevert — what came back and what stayed intact because of a conflict. */
export interface UnrevertResult {
  done: boolean
  /** Code mode: files given back and the ones that were preserved. `error`
   *  when the files could not be given back at all: the post-revert state
   *  was not recorded, or the restore failed. */
  files?: { restored: number; conflicts: string[]; error?: 'no-after' | 'failed' }
  /** Pieces/gallery given back and preserved. */
  media?: SessionMediaRevert
}

/** Summary of the media revert — counts only (the journal stays on the main's disk). */
export interface SessionMediaRevert {
  /** false when the journal could not be applied — the UI warns. */
  restored: boolean
  /** Pieces given back to the previous state (or removed, if the turn created them). */
  pieces: number
  /** Gallery entries given back to the previous state (or removed). */
  items: number
  /** Pieces/items that were NOT undone because they changed after the turn
   *  (another conversation, edit in the panel). They stay intact. */
  conflicts: number
  /** Short labels of the preserved items, for the revert bar. */
  conflictLabels?: string[]
  error?: string
}

import type { UserProfileId } from './agents'

/** The crafts that have a lean, specialist chat. */
export type SpecialistProfile = 'fragment' | 'motion' | 'design'

/** Any profile a chat can run with: a built-in craft or an agent the person made (`agent:<id>`). */
export type ProfileId = SpecialistProfile | UserProfileId

/** Which profile a session runs with (the fragment chat keeps its own field). */
export function specialistProfileOf(session: Pick<SessionInfo, 'fragment' | 'profile'> | null | undefined): ProfileId | null {
  if (!session) return null
  if (session.fragment) return 'fragment'
  return session.profile ?? null
}

export interface SessionInfo {
  id: string
  title: string
  mode: SessionMode
  pinned: boolean
  archived: boolean
  /** When it was archived (null/absent = not archived, or archived before this field existed). */
  archivedAt?: number | null
  folderId: string | null
  /** Main working folder (code mode) */
  directory?: string
  /** Additional folders attached (code mode) */
  extraDirectories?: string[]
  /** Role in the orchestration (orchestrator or worker) */
  orchestration?: SessionOrchestration
  /** Parent session in the sidebar tree (shortcut of orchestration.parentSessionId) */
  parentId?: string
  /**
   * The conversation this one continues (a long chat moved to a fresh context). Not a
   * parent: the new chat is top-level. It is the link both ways — the new chat knows
   * where to look back, the old one lists where the work went.
   */
  continuedFrom?: string
  /** Run of a scheduled routine: the session lives in the "Routines" group of
   *  the sidebar (never in a folder) and is deleted together with the routine. */
  routineId?: string
  /**
   * The routine's MAIN chat — the one conversation that outlives the executions. The runs
   * are child sessions of it and appear in it as cards; only this one is listed in the sidebar.
   */
  routineChat?: boolean
  /**
   * The chat that builds a Fragment. It runs LEAN: a minimal system prompt, only the
   * fragment tools, no memories or skills. It does not show in the chat list; its work is
   * followed from the fragment itself (the activity feed), and the full conversation
   * opens on demand in the side panel. `kind` is where the person asked it to live.
   */
  fragment?: { kind: 'screen' | 'panel' }
  /**
   * A specialist chat: it runs with the lean profile of its craft (a focused prompt, only the
   * tools of the craft, none of the usual memory/skills blocks). The Fragment chat is the
   * same thing with its own field (`fragment`) when it is embedded in a fragment; a fragment
   * agent picked for a new chat uses `profile: 'fragment'`. Use `specialistProfileOf` to read both.
   * An agent the person made is `agent:<id>`; it is fixed when the chat starts.
   */
  profile?: ProfileId
  /**
   * Marks a chat made inside an artifact (see artifacts.ts). `id` is the artifact it was made
   * for; absent while the artifact does not exist yet (the first chat of a new fragment).
   */
  artifact?: { kind: SpecialistProfile; id?: string }
  /** Active revert (code mode) — cleared when undoing or sending a new message */
  revert?: SessionRevert
  createdAt: number
  updatedAt: number
}

export interface FolderInfo {
  id: string
  name: string
  mode: SessionMode
  pinned: boolean
  /** Archived folder: it leaves the "Folders" group and goes to "Archived" with its
   *  chats (archived along). Chats removed from an archived folder fall back
   *  to the recent ones, without unarchiving. */
  archived: boolean
  /** Project workspace, recorded by the FIRST chat that entered the folder
   *  (main repository + extras). The chats say where the folder is being
   *  used NOW; this field is its memory: with the folder empty (all the
   *  chats deleted), the "+" goes back to the same repository instead of inheriting the
   *  workspace of the screen. It is only born in a code folder. */
  workspace?: string[]
  createdAt: number
}

/** Folder name from the project path: "my-app" → "My App". */
export function normalizeFolderName(directoryPath: string): string {
  const baseName = directoryPath.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? directoryPath
  return baseName
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ")
}

/** Comparison key for folder names: ignores case, extra spaces and
 *  accents — "café", "Cafe" and "CAFÉ" are the same folder. */
export function folderKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
}

/**
 * Activity of each session for the sidebar ORDERING.
 *
 * The activity of a chat is its own OR the one of the most recent sub-chat/worker nested in it:
 * touching a child raises the whole block (parent + children) to the top. Without this the
 * position of the parent would depend only on the parent's own activity, and a
 * recently used side conversation stayed hidden under a stalled parent.
 *
 * Archived children do not count — they leave the visible tree (they stay in the
 * "Archived" group), so they cannot move the parent.
 */
export function sessionActivityMap(sessions: SessionInfo[]): Map<string, number> {
  const childrenByParent = new Map<string, SessionInfo[]>()
  for (const session of sessions) {
    if (!session.parentId || session.archived) continue
    const siblings = childrenByParent.get(session.parentId)
    if (siblings) siblings.push(session)
    else childrenByParent.set(session.parentId, [session])
  }

  const activity = new Map<string, number>()
  const computing = new Set<string>()
  const compute = (session: SessionInfo): number => {
    const cached = activity.get(session.id)
    if (cached !== undefined) return cached
    // A parentId cycle should not exist, but it cannot become infinite
    // recursion if some corrupted record shows up.
    if (computing.has(session.id)) return session.updatedAt
    computing.add(session.id)
    let latest = session.updatedAt
    for (const child of childrenByParent.get(session.id) ?? []) {
      latest = Math.max(latest, compute(child))
    }
    computing.delete(session.id)
    activity.set(session.id, latest)
    return latest
  }
  for (const session of sessions) compute(session)
  return activity
}

export type TextPartState = "streaming" | "done"

export interface TextPart {
  id: string
  type: "text"
  text: string
  state: TextPartState
  /**
   * "attachment" = generated by extraction of an attachment (PDF/spreadsheet/DOCX/skill),
   * not typed by the user. The model still receives that text normally
   * (toModelMessages/partText do not filter by origin) — only the visible bubble
   * of the chat hides these parts, showing only what the person wrote.
   * "vision" = transient indicator of Vision mode ("Analyzing image…"),
   * emitted while the vision model describes an attachment; never persists.
   * "nudge" = text generated in an INTERNAL continuation of the engine (check
   * nudge/anti-overclaim — see NO_CHANGES_PROMPT in chat-engine.ts),
   * not in direct response to the user. The UI always renders it in a dimmed color
   * (never as a white final answer); when the turn does write files
   * after the nudge, the engine promotes to normal only the LAST text of the
   * nudge — the post-correction answer — keeping the previous ones dimmed.
   * "internal" = text of the nudge that ended as confirmation that there
   * was nothing to correct (false positive of the trigger): it is pure internal
   * verification — the UI does NOT render it in any way.
   * "todo" = text generated in the continuation of the TODO closing nudge
   * (TODO_COMPLETION_PROMPT): checklist bookkeeping, not the answer to the
   * user. It renders like the "nudge" (always dimmed, never the final answer),
   * but it is never promoted to normal — otherwise that short line would steal the place
   * of the final answer the model had already written.
   */
  source?: "attachment" | "vision" | "nudge" | "internal" | "todo"
}

export interface ReasoningPart {
  id: string
  type: "reasoning"
  text: string
  state: TextPartState
  durationMs?: number
}

export type ToolPartState = "running" | "done" | "error"

export type PieceKind = "motion" | "design" | "slides"

/**
 * The piece the tool has just written, already addressable.
 *
 * Whoever fills it is the companion (`companion-media`): the phone receives the signed
 * http URL ready and never builds one — the `orbit-motion://` scheme that the desktop
 * uses inside Electron does not exist outside it.
 *
 * `url` is not always the same kind of resource, and that is on purpose:
 * motion and slides point to the HTML of the piece (the `index.html`, which is what gets
 * drawn); design points to the `canvas.json`, because a canvas has several
 * screens and whoever chooses which one to open is the phone's viewer.
 */
export interface PieceRef {
  kind: PieceKind
  id: string
  /** Absolute and signed http URL of the main resource of the piece. */
  url: string
  /** Absolute http URL of the cover (frame, first screen). Without it the card uses the type icon. */
  cover?: string
  title?: string
  /** Motion: duration in seconds. Design: number of screens. Slides: number of slides. */
  count?: number
}

export interface ToolPart {
  id: string
  type: "tool"
  tool: string
  state: ToolPartState
  title?: string
  input?: Record<string, unknown>
  output?: string
  error?: string
  /**
   * Filled only by the piece tools (`motion_*`, `design_*`, `slides_*`), and only
   * on the companion path. It is what makes the phone conversation show a card
   * instead of a tool line.
   */
  piece?: PieceRef
}

/** Image the assistant includes in the answer (tool show_image) */
export interface ImagePart {
  id: string
  type: "image"
  /** orbit-media:// URL served by the main's protocol (file in orbit-data/media) */
  src: string
  alt?: string
  /**
   * Set when the image comes from a web page (web_image_show): where the user can
   * see it for real. `src` is then an orbit-web:// copy kept in the app's cache (not in
   * the gallery) and this is the credit the lightbox shows.
   */
  source?: ImageSource
}

/** Where a web image came from — shown in the lightbox, always. */
export interface ImageSource {
  /** Page the image was found on (what the user opens to see it in context) */
  pageUrl: string
  /** Direct address of the image file */
  imageUrl: string
  /** Host of the page, without "www." */
  host: string
  title?: string
}

/**
 * Audio produced by the agent (tool audio_generate): the answer shows a
 * player. The file lives in orbit-data/audio and is served by orbit-audio://.
 */
export interface AudioPart {
  id: string
  type: "audio"
  /** URL orbit-audio://aud_xxx.wav */
  src: string
  title?: string
  durationMs?: number
}

/**
 * Video produced by the agent (video_render, motion_render, show_video): the
 * answer shows a player. The file stays in the user's project; the URL
 * orbit-video://vid_xxx points to it through the main's registry (video-store.ts).
 */
export interface VideoPart {
  id: string
  type: "video"
  /** URL orbit-video://vid_xxx */
  src: string
  title?: string
  durationMs?: number
  /** File path on disk (for "show in folder"). */
  path?: string
}

/** File attached by the user to the message (data URL coming from the input) */
export interface FilePart {
  id: string
  type: "file"
  /** MIME type (image/png, text/plain, application/pdf…) */
  mime: string
  filename?: string
  /** Data URL with the content of the file */
  url: string
  /**
   * UI chip: an attachment already pre-processed by the engine (content extracted as
   * text in the sibling TextPart or described by the vision model). The model does NOT
   * receive the file (toModelMessages ignores chips). For images, `url`
   * carries a reduced thumbnail only for the chat bubble; in the other
   * formats it stays empty.
   */
  chip?: boolean
  /**
   * Conversation document this attachment became (doc1, doc2…). It is what makes the
   * chip open the file in the panel: without it, the chip knows the file name
   * but has no way to reach the content, which lives in the sources store and not
   * in the message. Absent in an attachment that is not a document (image, loose text) and
   * in the attachments before this field existed.
   */
  documentId?: string
  /**
   * Original image in the gallery (`orbit-media://…`), when the chip carries only
   * a thumbnail.
   *
   * The chat bubble shows the thumbnail on purpose — it is already in the message
   * and it is light. But enlarging, copying or saving have to reach the real
   * bytes: without this field the viewer would stretch 320px to the whole screen
   * and the save button would hand over the miniature instead of the photo. Absent in the
   * attachments before this field existed (then the thumbnail is all there is).
   */
  mediaUrl?: string
  /**
   * The attachment ALREADY IS a gallery item (dragged from the Media tab): the file exists
   * on disk, and the engine does NOT copy anything — the agent receives the reference and the
   * path, and the bubble shows the chip. `url` is only the preview (thumbnail), not the
   * content. Absent in ordinary attachments (pasted/chosen), which become their own
   * copy in the gallery.
   */
  mediaId?: string
  /**
   * The attachment is a SOURCE of the conversation (`doc1`, `src2`…), dragged from the Sources tab:
   * the content is already stored and addressed, so nothing is copied and `url` stays
   * empty. The agent receives the id and the name in the attachment note, and reads the document with
   * doc_read/doc_search as it would read any other source — the chip in the bubble is only
   * the gesture of saying "it is THIS document", not a second file.
   */
  sourceId?: string
  /**
   * The content of this attachment is worth only in the TURN IT ARRIVED (native vision).
   *
   * The part stays in the message — the bubble shows the image —, but the model
   * stops receiving it in the following turns: the history keeps the reference line in
   * text, and the agent goes back to the image through it when it needs to
   * (describe_image/image_edit). Without this, a pasted photo was resent in
   * EVERY turn, forever — the most expensive attachment of the conversation was precisely the
   * oldest one. It is only marked when the stable reference exists: without it,
   * losing the image would be worse than paying for it.
   */
  turnOnly?: boolean
}

/** MIME marker of an element selected in the panel browser (selection
 * mode). The renderer serializes the element (tag/url/selector/text/html)
 * as a data URL in this MIME; the engine's preprocessAttachment turns it into
 * a chip (badge in the bubble) + TextPart with source "attachment" — the model receives
 * the complete detail, the user bubble shows only the chip. */
export const BROWSER_SELECTION_MIME = "application/x-orbit-browser-selection"

/** MIME marker of a passage quoted in a panel. Same contract as
 * BROWSER_SELECTION_MIME: the renderer serializes the payload (the `kind` says whether it is
 * a document passage — page, lines and text — or an INSTANT of a motion composition
 * — file, frame and fps) as a data URL in this MIME, and the engine's
 * preprocessAttachment turns it into a chip (badge in the bubble) +
 * TextPart with source "attachment". The model receives the passage/instant and the
 * clickable citation; the user bubble shows only the chip.
 *
 * Both kinds share the MIME because the gesture is one — pointing at something in a panel
 * and attaching it to the next message. A parallel path only for the motion instant
 * would duplicate chip, serialization and cleanup for them to diverge later. */
export const DOCUMENT_QUOTE_MIME = "application/x-orbit-document-quote"

/**
 * MIME of a SOURCE dragged from the Sources tab to the composer.
 *
 * The payload is only the identity of the document ({ id, name, kind, type }): the
 * content is already stored in the conversation scope and is reached by the id. The
 * attachment that is born from it is a REFERENCE (`FilePart.sourceId`) — nothing is copied,
 * like the drag from the Media tab (MEDIA_DND_MIME), and the bubble shows a chip with
 * the exact name of the document instead of a loose "src3".
 */
export const SOURCE_DND_MIME = "application/x-orbit-source"

/** What the drag of a source carries. `type` is the short label the list
 *  already shows ("PDF", "MD"), so the chip does not need to reopen the id. */
export interface SourceDndPayload {
  id: string
  name?: string
  kind?: string
  type?: string
}

/** What the citation chip carries. `page`/`fromLine`/`toLine` only exist
 * where the source has that notion (PDF, DOCX, spreadsheet — everything that goes through
 * text extracted in pages). A live Markdown document quotes only the
 * passage: it has no page, and inventing one would be worse than not having it. */
export interface DocumentQuotePayload {
  /**
   * Where the passage came from, because it decides what the agent can do with it:
   * "document" is an agent document (read_document/update_document, id
   * doc_….md) and "source" is a source of the conversation (doc_read/doc_search, id
   * doc1/src1). Without this distinction the id reaches the model without an address, and it
   * goes off looking for the file that was in its hand.
   */
  kind: "document" | "source"
  docId: string
  name: string
  page?: number
  fromLine?: number
  toLine?: number
  text: string
}

/**
 * Instant pointed at in the Motion tab — the user freezes the frame and asks for an adjustment
 * at that point ("at 2.30 s, make the title bigger") without the model having to
 * guess which frame the sentence refers to.
 *
 * The FRAME is the truth. The time unit of the system is the whole frame (it is what
 * the preview runtime and the render consume); the seconds exist for the human eye
 * and come out of `motionSeconds` when displaying. Storing both would be
 * creating a second truth, which diverges in the rounding.
 */
export interface MotionQuotePayload {
  kind: "motion"
  /** Path of the entry INSIDE the registered folder (e.g. `index.html`). */
  file: string
  /** Displayable name of the composition. */
  name: string
  /** Whole frame of the playhead at the moment of the click. */
  frame: number
  /** fps of the composition — it is what converts the frame into seconds. */
  fps: number
  /** Absolute path of the entry — the address the agent edits. */
  path?: string
  /** Layer selected by the user in the layers strip. */
  layer?: string
  /** SOUND track selected, when the focus is a sound and not an element of the DOM.
   *  The audio of the piece plays outside the stage (see motion-audio.ts), so it is not a
   *  layer — calling it a layer would send the agent looking in the wrong place. */
  audio?: string
  /** Layers on stage at that frame (measured, not declared). */
  onScreen?: string[]
}

/**
 * Element pointed at in the Design tab — the user selects something on the canvas and asks
 * for an adjustment on that element ("make this button bigger") without the model having to
 * guess which of the artboards, and which piece of it, the sentence is about.
 *
 * The address is the same one the tab uses to edit: the artboard (`file`) and the
 * path of children from the <body> (`elementPath`). The HTML snippet goes
 * along because it is what the model looks for in the source to edit.
 */
export interface DesignQuotePayload {
  kind: "design"
  /** Canvas name (the folder) — the `name` of the design_* tools in chat mode. */
  name: string
  /** Absolute folder of the canvas — the address in code mode (design_preview). */
  path?: string
  /** Artboard file inside the canvas (e.g. `Main.html`). */
  file: string
  /** Artboard title, when it has one. */
  boardTitle?: string
  /** Path of child elements from the <body>; absent = the whole artboard. */
  elementPath?: number[]
  tag?: string
  label?: string
  text?: string
  html?: string
}

/**
 * Widget of a fragment pointed at in the Widgets tab — the user asks for a change on THAT
 * widget ("this one is cramped at 2x1") without the model having to guess which of the
 * fragment's widgets the sentence is about. The address is the fragment and the widget id,
 * which is what the fragment tools edit; the size travels along because the complaint is
 * usually about one of them.
 */
export interface WidgetQuotePayload {
  kind: "widget"
  /** Fragment that owns the widget (frag-…). */
  fragmentId: string
  /** Display name of the fragment. */
  fragmentName?: string
  /** Widget id inside the fragment manifest. */
  widgetId: string
  /** Widget name, as the fragment declares it. */
  name: string
  /** Size the widget has on the board (`2x1`) — the one the request is about. */
  size: string
  /** Every size the widget declares. */
  sizes?: string[]
}

/** What an attachment of a citation carries: document passage (document|source),
 *  composition instant (motion), design element or fragment widget. See DOCUMENT_QUOTE_MIME. */
export type QuotePayload = DocumentQuotePayload | MotionQuotePayload | DesignQuotePayload | WidgetQuotePayload

/**
 * The text the model reads when it receives a pointed design element. In English
 * because the recipient is the model; the user's text comes pasted, as in
 * motion (see formatMotionQuoteText).
 */
export function formatDesignQuoteText(quote: DesignQuotePayload, userText?: string): string {
  const board = quote.boardTitle ? `${quote.file} ("${quote.boardTitle}")` : quote.file
  const lines = [`[Design element selected by the user — canvas "${quote.name}", artboard ${board}]`]
  lines.push(
    quote.path
      ? `Canvas folder: ${quote.path} — edit ${quote.file} there (or with design_edit, name "${quote.name}", if it is a canvas of this chat).`
      : `Edit it with design_edit({ name: "${quote.name}", file: "${quote.file}" }) — read it first with design_read.`,
  )
  if (quote.elementPath && quote.elementPath.length > 0) {
    lines.push(
      `Element: <${quote.tag ?? "?"}>${quote.label ? ` ${quote.label}` : ""} — child path from <body>: ${quote.elementPath.join(" > ")}`,
    )
    if (quote.text) lines.push(`Text: ${quote.text}`)
    if (quote.html) lines.push(`HTML: ${quote.html}`)
  } else {
    lines.push("Selection: the whole artboard.")
  }
  const note = userText?.trim()
  if (note) lines.push("---", note)
  return lines.join("\n")
}

/** The text the model reads when it receives a widget pointed at in the Widgets tab. In
 *  English because the recipient is the model; the user's note comes pasted, as in the other
 *  citations. */
export function formatWidgetQuoteText(quote: WidgetQuotePayload, userText?: string): string {
  const lines = [
    `[Fragment widget — "${quote.name}" at ${quote.size}${quote.fragmentName ? `, from the fragment "${quote.fragmentName}"` : ""}]`,
    `Fragment id: ${quote.fragmentId} — the widget is declared in its manifest (fragment_set_widgets changes the declaration).`,
  ]
  if (quote.sizes?.length) {
    lines.push(
      `Sizes it declares: ${quote.sizes.join(", ")} — the page draws it with ?widget=<id>&size=<size>, and it has to work at every one of them.`,
    )
  }
  lines.push("Edit the fragment it belongs to with fragment_read_file / fragment_edit_file (or fragment_write_file).")
  const note = userText?.trim()
  if (note) lines.push("---", note)
  return lines.join("\n")
}

/** fps assumed when the composition declared none — the same as the runtime. */
export const MOTION_FALLBACK_FPS = 30

const pad2 = (n: number) => String(n).padStart(2, "0")

/** `mm:ss:ff` timecode of the frame — the composition speaks in frames, the eye in
 *  mm:ss:ff. Shares the calculation with the panel so the chip and the model text do not
 *  disagree at the same instant. */
export function motionTimecode(frame: number, fps: number): string {
  const rate = fps > 0 ? fps : MOTION_FALLBACK_FPS
  const total = Math.max(0, Math.round(frame))
  return `${pad2(Math.floor(total / (rate * 60)))}:${pad2(Math.floor(total / rate) % 60)}:${pad2(total % rate)}`
}

/** The seconds with a comma (`2,30 s`) — that is how the user types it in the chat. */
export function motionSeconds(frame: number, fps: number): string {
  const rate = fps > 0 ? fps : MOTION_FALLBACK_FPS
  return `${(Math.max(0, frame) / rate).toFixed(2).replace(".", ",")} s`
}

/**
 * The text the model reads when it receives a pointed instant.
 *
 * In English because the recipient is the model. The user text comes attached to the
 * instant on purpose: in a separate part, "make the title bigger" would arrive
 * without saying WHICH point of the composition is meant, and the model would have to
 * figure it out alone — which is precisely the ambiguity this attachment exists to kill.
 * Without text (the user only pointed the frame), nothing is added: no `---` and no
 * empty line left at the end.
 */
export function formatMotionQuoteText(quote: MotionQuotePayload, userText?: string): string {
  const frame = Math.max(0, Math.round(quote.frame))
  const lines = [
    `[Motion composition — ${quote.name || quote.file}]`,
    `File: ${quote.path || quote.file}`,
    `Frame ${frame} at ${quote.fps} fps — ${motionSeconds(quote.frame, quote.fps)} (${motionTimecode(quote.frame, quote.fps)})`,
  ]
  if (quote.layer) lines.push(`Selected layer: ${quote.layer}`)
  if (quote.audio) lines.push(`Selected audio track: ${quote.audio}`)
  if (quote.onScreen?.length) lines.push(`On screen at this frame: ${quote.onScreen.join(", ")}`)
  const note = userText?.trim()
  if (note) lines.push("---", note)
  return lines.join("\n")
}

/**
 * Replied message ("reply", as in WhatsApp).
 *
 * Unlike the document quote (DOCUMENT_QUOTE_MIME), which travels as an
 * attachment, here the quoted snippet enters the TEXT of the sent message, as a
 * Markdown quote (`> …`) with a marker of who wrote it:
 *
 *     > [assistant] first line of the snippet
 *     > second line
 *
 *     user answer
 *
 * The reason to go in the text, and not in an attachment: the answer is about the conversation
 * itself — it has to show up in the bubble, in the stored history and in the copy of the
 * message, which are precisely the things an attachment does not reach. The
 * marker is `[user]`/`[assistant]`, and not the translated label, because the
 * interface language changes and the stored text cannot change along.
 */
export interface MessageReplyQuote {
  role: "user" | "assistant"
  /** The quoted snippet, already clipped by whoever creates the reply. */
  text: string
}

/** Cap of the quoted snippet. The whole message is already in the model history —
 *  what the quote needs is to POINT to it, not to repeat it in full in
 *  every following message of the conversation. */
export const MESSAGE_REPLY_MAX_CHARS = 1200

const REPLY_HEADER = /^\[(user|assistant)\]\s?/

/** Clips the snippet that becomes the reply. */
export function replyExcerpt(text: string, max: number = MESSAGE_REPLY_MAX_CHARS): string {
  const trimmed = text.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed
}

/** The snippet as a Markdown quote. Empty lines become `>` so the quote
 *  is not cut in two in the middle. */
export function formatMessageReply(reply: MessageReplyQuote): string {
  const [first = "", ...rest] = reply.text.split("\n")
  return [
    `> [${reply.role}] ${first}`,
    ...rest.map((line) => (line.trim() === "" ? ">" : `> ${line}`)),
  ].join("\n")
}

/** What is prepended to the sent text (with the blank line that separates the
 *  quote from the answer). */
export function messageReplyPrefix(reply: MessageReplyQuote | null | undefined): string {
  if (!reply) return ""
  return `${formatMessageReply(reply)}\n\n`
}

/**
 * Separates the quote from the body of the message.
 *
 * Text that does not start with `>` — or whose quoted block does not carry the marker — has no
 * reply: it returns the text intact and `reply: null`. That is the case of the user
 * who wrote a quote of their own.
 */
export function parseMessageReply(text: string): { reply: MessageReplyQuote | null; body: string } {
  const lines = text.split("\n")
  if (!lines[0]?.startsWith(">")) return { reply: null, body: text }

  let end = 0
  while (end < lines.length && lines[end].startsWith(">")) end++
  const quoted = lines.slice(0, end).map((line) => line.replace(/^>\s?/, ""))
  const header = quoted[0]?.match(REPLY_HEADER)
  if (!header) return { reply: null, body: text }

  const quotedText = [quoted[0].slice(header[0].length), ...quoted.slice(1)].join("\n").trim()
  let bodyStart = end
  while (bodyStart < lines.length && lines[bodyStart].trim() === "") bodyStart++
  return {
    reply: { role: header[1] as MessageReplyQuote["role"], text: quotedText },
    body: lines.slice(bodyStart).join("\n"),
  }
}

/** The snippet in a single line, for the preview (composer bar, bubble). */
export function replySnippet(text: string, max = 140): string {
  const oneLine = text.replace(/\s+/g, " ").trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

/** /init pipeline agent shown as an accordion (thinking style): the
 * main one narrates the review; each worker shows its exploration in streaming. */
export interface AgentPart {
  id: string
  type: "agent"
  /** Displayed label (e.g. "Design System", "Main agent") */
  label: string
  role: "main" | "worker"
  text: string
  state: "running" | "done" | "error"
  durationMs?: number
}

/**
 * HTML artifact the assistant includes in the answer (tool create_artifact):
 * a renderable page — dashboard, prototype, diagram, report — that
 * lives in a file of its own in orbit-data/artifacts and is served by the
 * orbit-artifact:// protocol.
 *
 * The HTML NEVER enters the part: the message persists only the URL (the same contract
 * as the ImagePart), otherwise every conversation would carry kilobytes of markup in
 * storage and in the sync with the companion.
 */
export interface ArtifactPart {
  id: string
  type: "artifact"
  /** orbit-artifact://<id>.html URL served by the main process protocol */
  src: string
  /** Registry id in the gallery (the file name) — used to open in the
   *  panel, update and delete */
  artifactId: string
  title: string
  /** Thumbnail captured on creation (orbit-artifact://<id>.png), when there was one */
  thumb?: string
  /** Revision: increments on every update_artifact. The UI uses it as a cache-buster of the
   *  iframe — the URL does not change when the artifact is rewritten in the same file. */
  revision?: number
}

/**
 * Document authored by the agent (tool create_document): report, proposal,
 * minutes, documentation. The source is Markdown — and the document IS the Markdown; PDF and
 * DOCX are renderings made when someone asks for the file.
 *
 * The preview shown in the conversation is HTML and not the PDF — Electron does not ship
 * Chrome's PDF viewer, and the .docx is not renderable in the browser.
 * Since the PDF is generated FROM that HTML, what one sees is what comes out printed.
 */
export interface DocumentPart {
  id: string
  type: "document"
  /** Registry id in the gallery (doc_xxx.md) — the Markdown source */
  documentId: string
  title: string
  /** orbit-artifact:// URL of the preview HTML */
  previewSrc: string
  /** Renderings ALREADY on disk. Empty is the norm: the document is born only in
   *  Markdown, and the PDF/DOCX is generated on the first download. */
  formats: ("pdf" | "docx")[]
  thumb?: string
  /** Increments on every update_document — iframe cache-buster */
  revision?: number
}

/**
 * One execution of a routine, inside the routine's OWN chat.
 *
 * The routine has a single conversation (the one the person talks to); every execution is
 * written into it as one of these cards instead of becoming a chat of its own. The work still
 * ran in a session of its own (`sessionId` — it is what "ver detalhes" opens), so the model
 * that executes never carries the history of the previous months.
 */
export interface RoutineRunPart {
  id: string
  type: "routine-run"
  /** The execution this card speaks for (`RoutineRun.sessionId`). */
  runId: string
  /** Session the execution ran in — the workers' parent. */
  sessionId: string
  status: "running" | "ok" | "error"
  startedAt: number
  finishedAt?: number
  /** What the execution delivered (the final text, condensed). */
  summary?: string
  error?: string
  cost?: number
  /** How it started: the calendar, the person, or a script/webhook. */
  reason?: "schedule" | "manual" | "event"
  /** Team members that took part, in order (the avatar group). */
  agents?: string[]
}

export type MessagePart =
  | TextPart
  | ReasoningPart
  | ToolPart
  | ImagePart
  | AudioPart
  | VideoPart
  | FilePart
  | AgentPart
  | ArtifactPart
  | DocumentPart
  | RoutineRunPart

/**
 * The file parts that go TO THE MODEL in a user message.
 *
 * In chat, the model never receives the bytes of an attachment: it receives a text —
 * the opening snippet of the document, the note of the image/audio/video, or the gallery
 * reference line. What arrives as a file part is only when it REALLY needs
 * the pixels (native vision), and even then only on the first turn of a
 * `turnOnly` attachment — after that, the indicator is the text.
 *
 * Chip is UI decoration (the content is already in the sibling TextPart), and an empty `url`
 * is the leftover of chips written before the flag existed.
 */
export function modelFileParts(parts: MessagePart[], isCurrentTurn: boolean): FilePart[] {
  return parts.filter(
    (p): p is FilePart =>
      p.type === "file" && !p.chip && p.url !== "" && (isCurrentTurn || !p.turnOnly),
  )
}

export interface TokenUsage {
  /** Sum of all steps of the turn (tool loop) — reflects cost/billing, NOT
   * the size of the current context (a turn with N tool round-trips resends
   * the history N times, so this value can be a multiple of the real context). */
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  /** USD, calculated with the catalog prices (when available) */
  cost?: number
  /** Usage of the LAST step of the turn only — that one is the correct metric of
   * "size of the current context", used by the context meter and by the
   * compaction trigger. Absent in messages persisted before this field existed. */
  lastStep?: {
    input: number
    output: number
    /** Of the input of this call, how much came from the provider cache. Absent in old messages. */
    cacheRead?: number
    /** Of the input of this call, how much was written to the cache. Absent in old messages. */
    cacheWrite?: number
    /** Of the output of this call, how much was reasoning (already included in the output). Absent in old messages. */
    reasoning?: number
  }
}

/** Filesystem snapshots captured around an assistant answer
 * (code mode): they allow per-message revert. */
export interface AssistantSnapshot {
  /** Tree hash before the stream starts. Absent when the initial capture
   * failed (see `failed`) — it signals that there is no previous state to
   * diff/revert. */
  start?: string
  /** Tree hash after all tools run */
  end?: string
  /** Files changed between start and end */
  files?: string[]
  /** Unified diff between start and end (truncated at ~200kB) */
  patch?: string
  /** Paths the PERSON saved by hand through the panel during the turn (relative
   *  to the folder, with '/'). The turn does not revert them — they are their work, not the
   *  agent's; the revert reports them as kept. */
  manual?: string[]
  /** Paths (relative, '/'; a folder covers what is inside it) that the write
   *  tools of the turn wrote — the authorship the revert uses.
   *  Absent in turns prior to the journal: there the whole diff counts as the
   *  turn's. */
  authored?: string[]
  /** Paths that the tools of OTHER conversations wrote in this folder
   *  while the turn was running — outside its revert. */
  others?: string[]
  /** true when the filesystem tracking failed in this turn (start/end
   *  not captured) — the UI warns that the changes were not recorded. */
  failed?: boolean
  /** Reason for the failure of the initial capture (start) — for diagnosis and for the UI
   * to explain why no diff/revert is available. */
  captureError?: string
  /**
   * Verdict of the end-of-turn check, calculated by the engine comparing
   * the snapshots (it is not a claim of the model):
   * - `changed`: files changed (files/patch filled)
   * - `unchanged`: the turn wrote NOTHING to the filesystem
   * - `unknown`: no snapshot or the capture failed — nothing can be asserted
   *
   * It is the only hard evidence of what the turn did that survives to the
   * following turns: ToolParts never go back to the model (see todo-context.ts), so
   * without this the history keeps only the agent's NARRATIVE about its own
   * work — and a false claim becomes a "fact" in later turns.
   */
  verified?: 'changed' | 'unchanged' | 'unknown'
}

/**
 * Cause of a turn failure, when recognizable.
 * - `moderation`: the provider blocked the answer by content filter. It is
 *   server-side (e.g. DashScope/Qwen) — there is no way to turn it off in the request.
 * - `model-unavailable`: the model does not exist/is not served by the provider.
 * - `rate-limit`: usage/request limit of the provider (429, FreeUsageLimit).
 * - `network`: network failure/endpoint unavailability (timeout, 5xx...).
 * - `context-length`: the request became larger than the model window.
 * - `context-length-turn`: same, but what overflowed was the work of the turn
 *   itself (accumulated tool results), not the history.
 * `moderation`, `model-unavailable`, `rate-limit` and `network` are solved
 * by switching models — it is what the model rotation does automatically (see
 * `resolveRotation` in the main process). `provider-config` (unknown provider/SDK,
 * missing key) and `unknown` are NOT: switching models does not fix
 * configuration. `context-length` neither: the payload that overflowed is the same
 * in any model — what solves it is compacting the conversation. In
 * `context-length-turn` not even that: compacting only reaches the history, which
 * fitted; what solves it is a new turn, which does not resend the tool
 * results of this one.
 */
export type MessageErrorKind =
  | "moderation"
  | "model-unavailable"
  | "rate-limit"
  | "network"
  /** Request larger than the model context window. Not rotatable. */
  | "context-length"
  /** Same, but it overflowed mid-turn — the history fitted, the accumulation of
   *  tool results of the turn is what went past the window. */
  | "context-length-turn"
  /** Our configuration, not a provider failure: missing key, unknown provider/SDK. */
  | "provider-config"
  /** The provider refused the REQUEST for too many tools (Groq refuses above
   *  128 and the whole call fails). It is not rotatable: the ceiling belongs to the endpoint,
   *  and another model of the same provider inherits the same limit. What solves it is
   *  sending fewer tools — the on-demand catalog already does that (see aplicarFreio). */
  | "tool-limit"
  | "unknown"

export interface ChatMessage {
  id: string
  role: "user" | "assistant"
  parts: MessagePart[]
  /** When the message was created — for the assistant, it is the start of the turn (before the model answers). */
  createdAt: number
  /** When the assistant finished answering (stream completed, error or abort). Absent while still generating. */
  completedAt?: number
  providerId?: string
  modelId?: string
  error?: string
  /** Classification of the failure — the UI uses it to explain the cause and offer the right
   *  action (e.g. provider moderation can only be worked around by switching models). */
  errorKind?: MessageErrorKind
  /** How many times the turn was attempted before giving up — only when > 1 */
  attempts?: number
  /** Generated in simple mode: lean UI (no tool/reasoning views); text still in markdown */
  simple?: boolean
  /** Active mode of the turn in which the message was sent (user) — metadata
   *  read by the session_context tool. Absent in old messages. */
  mode?: SessionMode
  /** Permission mode in force in the turn (user) — metadata read by the
   *  session_context tool. Absent in old messages. */
  permissionMode?: PermissionMode
  /** Tokens consumed in the generation of this message (assistant) */
  tokens?: TokenUsage
  /** Synthetic compaction message: summary of the previous history */
  summary?: boolean
  /** OPENING summary of a chat that continues another one (compaction card):
   *  same mechanics as summary, but it is the brief of the previous conversation, not a
   *  compaction of this one — the UI uses it to label the card. */
  continuation?: boolean
  /** start/end snapshots of the filesystem (assistant, code mode) */
  snapshot?: AssistantSnapshot
  /** true when the generation stopped on reaching the step ceiling (MAX_STEPS)
   * instead of the model concluding naturally — it signals to the UI and to the
   * model itself (in the next turn) that the work may have been left incomplete. */
  truncated?: boolean
  /** true when the answer ended with TODO items still "in_progress"
   * (the model did not mark them as done). It becomes a reminder for the model in the
   * next turn (via messageContextText) and for the UI to explain the spinner. */
  todoReminder?: boolean
  /** User message written by the orchestrator into a worker (not by the
   *  person). Absent = the user typed it in the worker's chat — that is how the
   *  orchestrator tells that you stepped into a worker and gave it a command.
   *  "subchat" = the result of a subchat that woke its parent up (subchat-wake.ts). */
  origin?: "orchestrator" | "subchat"
}

export interface ModelVariant {
  /** Unique ID used in the communication (e.g. "high", "max", "medium") */
  id: string
  /** Display label in the dropdown */
  label: string
  /** Short description for the tooltip (optional) */
  description?: string
}

export interface ReasoningConfig {
  /** On/off toggle of thinking */
  enabled: boolean
  /** ID of the selected variant — undefined uses the model baseline */
  variantId?: string
}

export type PermissionMode = "ask" | "approve" | "full"
export type PermissionDecision = "allow" | "always_chat" | "always" | "deny"

/** Sensitive action a tool wants to execute (bash, write, edit, MCP) */
export interface PermissionClaim {
  tool: string
  /** Short title shown in the UI (e.g. "bash: git push --force") */
  title: string
  detail?: string
  /** Critical action (deny level) — the UI highlights the warning */
  critical?: boolean
  /** Asks even in unrestricted mode (e.g. removing a worktree): switching the mode
   *  to unrestricted does not approve this request by itself. */
  alwaysAsk?: boolean
  /**
   * How many times this same rule was already approved, across turns and chats.
   * It arrives only when the count is worth mentioning, and it is what the card
   * uses to say so and to make "Always" visible.
   */
  learned?: { count: number }
}

/** Structured question of the question tool */
export interface Question {
  id: string
  text: string
  options?: string[]
  multi?: boolean
}

/**
 * Answer of a question as text (the tool receives `answers: string[]`).
 * Checked option and free text stay on separate lines, with the text labeled:
 * joined by commas the agent could not tell "A, B" (two options) from "A, but
 * only in the backend" (one option with a caveat). With no option checked, the text IS the
 * answer and goes without a label. The label comes translated from whoever answered.
 */
export function formatAskAnswer(picks: string[], note: string | undefined, noteLabel: string): string {
  const text = note?.trim() ?? ""
  const chosen = picks.join(", ")
  if (!chosen) return text
  if (!text) return chosen
  return `${chosen}\n${noteLabel}: ${text}`
}

/** One question and its answer in the text returned to the agent (and in the resume
 *  message): the extra lines of the answer stay aligned under the arrow. */
export function formatAskLine(index: number, question: string, answer: string): string {
  return `${index + 1}. ${question}\n   → ${answer.replace(/\n/g, "\n     ")}`
}

/** Warning that opens the result of the subagent tool when code mode was
 *  requested without a working folder. In English because the recipient is the model. */
export const SUBAGENT_NO_FOLDER_NOTICE =
  "[Notice: there is no working folder in this conversation — the subagent ran in chat mode, without file access.]"

/** Result of the subagent tool when the subagent returned no text. */
export const SUBAGENT_EMPTY_OUTPUT = "(the subagent returned no text)"

// Portuguese versions: old conversations on disk still carry them.
const SUBAGENT_NO_FOLDER_PREFIXES = ["[Notice: there is no working folder", "[Aviso: não há pasta de trabalho"]
const SUBAGENT_EMPTY_OUTPUTS = [SUBAGENT_EMPTY_OUTPUT, "(o subagente não retornou texto)"]

/**
 * Separates the result of the subagent tool for the card: the "no folder" warning and the
 * empty result are text for the model, and the UI replaces them with i18n. The rest
 * (the subagent answer) goes as it is.
 */
export function parseSubagentOutput(output: string): { noFolder: boolean; empty: boolean; text: string } {
  let text = output
  const noFolder = SUBAGENT_NO_FOLDER_PREFIXES.some((prefix) => output.startsWith(prefix))
  if (noFolder) {
    const end = text.indexOf("]")
    text = end >= 0 ? text.slice(end + 1).replace(/^\s+/, "") : ""
  }
  const empty = SUBAGENT_EMPTY_OUTPUTS.includes(text.trim())
  return { noFolder, empty, text: empty ? "" : text }
}

/** Origin of a request coming from a worker (shown in the orchestrator's chat) */
export interface AskOrigin {
  workerSessionId: string
  workerTitle: string
}

/** Pending request item (permission or question) — individual events, batch and UI */
export interface AskItem {
  requestId: string
  kind: "permission" | "question" | "subchat"
  claim?: PermissionClaim
  questions?: Question[]
  origin?: AskOrigin
  /** Suggestion to open a separate conversation: the title and the brief it would have.
   *  The answer is "new" (opens it and starts working right away), "here" (does it in this one) or
   *  "deny" (sets it aside). It never opens by itself — the user decides. */
  subchat?: {
    title: string
    brief: string
    /**
     * Where the suggestion is going: "subchat" (attached to this conversation — another subject,
     * another folder) or "chat" (a NEW top-level conversation, for when the reason is this
     * conversation itself being long: a fresh context continuing the work, not another compaction).
     * Absent = "subchat".
     */
    scope?: "subchat" | "chat"
    /** The agent this suggestion would open — a built-in craft or `agent:<id>`: the card offers
     *  "a Motion chat" (or the agent's name) instead of a plain subchat. */
    profile?: ProfileId
    /** For a fragment suggestion: the kind the agent asked for, carried into the new chat. */
    fragmentKind?: "screen" | "panel"
  }
}

export interface PlanReview {
  status: "proposed" | "implementing" | "rejected" | "revising"
  messageId: string
  /** Content of the plan shown in the chat; not persisted as a file by default. */
  content?: string
  permissionMode?: PermissionMode
}

export interface SendMessageOptions {
  /** Set by the main process (never the UI) for a specialist chat: the lean profile of
   *  its craft — focused prompt, the craft's tools only, no memory/skills blocks. */
  profile?: ProfileId
  /** Deep research mode (deep research prompt + web tools) */
  research?: boolean
  /** Enables native browser tools */
  browser?: boolean
  /** Computer control in this conversation (only effective with the
   *  Preferences → Computer switch on). Never comes from the phone nor from routines. */
  computer?: boolean
  /** Plan mode: read-only tools, output in plan format */
  plan?: boolean
  /** On accepting a plan: signals the backend to use the implementation prompt */
  planReview?: PlanReview
  /** Simple mode: direct answers in plain text, no formatting */
  simple?: boolean
  /** Call mode (voice conversation): the answer will be READ aloud, so
   *  it comes short, direct and without formatting. */
  voiceCall?: boolean
  /**
   * Turn born in the overlay (⇧⌘space): short answer and tools to see the
   * screen and the selection of the app that was in front. It does not imply speaking — the overlay
   * in text mode sends `overlay` without `voiceCall`.
   */
  overlay?: boolean
  /** Reasoning/thinking configuration of the model when supported */
  reasoning?: ReasoningConfig
  /** Subagents mode: exposes the subagent tool (ephemeral workers in the background) */
  subagents?: boolean
  /** Brain mode: persistent memory (memory_* tools) */
  brain?: boolean
  /** Injects relevant memories automatically into the prompt */
  brainContext?: boolean
  /** Injects the per-turn skill suggestion line: a pointer, never the body. It is the
   *  user's preference (Preferences → skill suggestions), already resolved against the
   *  per-conversation Memory toggle. */
  skillHints?: boolean
  /** Orchestra mode: splits into a task plan + workers in child sessions */
  orchestrate?: {
    plan?: OrchestrationPlan
    /**
     * A run nobody watches (a routine with a team): the plan starts without waiting for the
     * card's "Approve", and the workers stop starting once `tokenBudget` is spent. A worker that
     * fails never stops the others; only what depends on it is dropped.
     */
    unattended?: {
      tokenBudget?: number
      maxParallel?: number
      /** The routine opted in to the model reviewing each worker; absent = no review, whatever the global setting. */
      review?: boolean
    }
  }
  /** Loop mode: the agent reviews and iterates until the task is complete (configurable max N iterations) */
  loop?: boolean
  /**
   * Slice of MCP servers of this conversation (names). `undefined` = all
   * servers enabled in the app, which is the default; the slice is the same one the
   * prompt describes, so the model does not see in the list a server that has no
   * tool available in the turn.
   */
  toolsServers?: string[]
  /** Permission mode (code mode and workers): effective default "ask" */
  permissionMode?: PermissionMode
  /**
   * The mode above came from the global selector (desktop or phone), and not from an
   * explicit choice (accepting a plan with a mode, a routine). Only those turns
   * follow the selector change mid-answer.
   */
  followGlobalPermission?: boolean
  /** /init: runs the project analysis pipeline instead of generating text */
  initMode?: boolean
  /** Sent by the full-screen browser chat: the user opened the browser
   *  and is asking from there, so the agent may use it even with the browser
   *  tools turned off in Preferences → Browser. */
  fromBrowser?: boolean
  /** Extra rounds, in the background, when the turn fails for a transient
   *  reason (network, rate-limit) before the first token. It is the same turn:
   *  nothing new appears in the chat between one attempt and the next. */
  retries?: number
}

export interface OrchestrationTask {
  id: string
  title: string
  /** Self-contained prompt sent to the worker */
  prompt: string
  /** Modes the orchestrator chose for this worker (research, browser,
   *  plan/readonly, simple...). Never `orchestrate`: a worker does not orchestrate. */
  options: SendMessageOptions
  /** Vision mode: outside SendMessageOptions because vision is switched on by
   *  the presence of a visionModel, not by an option flag. */
  vision?: boolean
  /** The model this task runs on; absent = the orchestrator's worker model. */
  model?: { providerId: string; modelId: string }
  /** Child session created during execution */
  workerSessionId?: string
  status: ChatStatus
  /** How many review rounds the orchestrator has already sent this worker. */
  revisions?: number
  /**
   * Step in the orchestrator's follow-up. `status` remains the state of the
   * worker's chat (what older apps read); `phase` says what the orchestrator
   * did with it.
   */
  phase?: OrchestrationTaskPhase
  /** Ids of the tasks that must be accepted before this one starts */
  dependsOn?: string[]
  /** Files/folders the task will touch, as declared by the orchestrator. It is
   *  the "ownership" that lets workers run in parallel without stepping on
   *  each other. */
  files?: string[]
  /** The agent (`agent:<id>`) that runs this worker instead of the general setup. */
  agent?: ProfileId
  /** Created by the orchestrator during the review (it was not in the approved plan) */
  extra?: boolean
  /** Last note from the review: what the adjustment asked for, or why it failed */
  reviewNote?: string
  /** The worker's own worktree (orchestra with "Isolate workers in worktrees") */
  worktree?: { path: string; folder: string; branch: string; base: string }
  /** The worker's branch has already been merged into the chat */
  merged?: boolean
}

export type OrchestrationTaskPhase =
  /** Waiting its turn (dependencies or the simultaneous-worker cap) */
  | "queued"
  | "running"
  /** Finished and in the orchestrator's hands */
  | "review"
  /** Back to work with an adjustment request */
  | "adjustment"
  | "accepted"
  | "failed"

/** Orchestra behavior after splitting (Orchestra settings). */
export interface OrchestrationSettings {
  /**
   * `orchestrate`: splits, runs and synthesizes, with no review.
   * `supervise`: reviews each worker as it finishes, asks for adjustments,
   * creates extra workers and runs the integration review at the end.
   * `rigorous`: supervise + only accepts after running the project's checks
   * (typecheck, tests, lint).
   */
  behavior: "orchestrate" | "supervise" | "rigorous"
  /** Adjustments each worker may get; the global cap is this × the plan's workers */
  adjustmentsPerWorker: number
  /** Each worker in its own git worktree, merged at the end */
  worktrees: boolean
  /** A single-task plan starts without waiting for the card's "Approve" */
  approveSingleTask: boolean
  /** Every plan starts without waiting for the card's "Approve" (the orchestra does not ask to run) */
  autoApprove: boolean
}

export const DEFAULT_ORCHESTRATION_SETTINGS: OrchestrationSettings = {
  behavior: "supervise",
  adjustmentsPerWorker: 2,
  worktrees: false,
  approveSingleTask: false,
  autoApprove: false,
}

export const MAX_ADJUSTMENTS_PER_WORKER = 5

/**
 * Keys and values persisted before the domain was renamed. They still arrive
 * from the renderer's localStorage, from the companion mirror and from plans
 * approved by an older build, so the normalization below translates them
 * instead of silently falling back to the default. Idempotent: current keys
 * and values pass straight through.
 */
const LEGACY_BEHAVIOR: Record<string, OrchestrationSettings["behavior"]> = {
  orquestrar: "orchestrate",
  acompanhar: "supervise",
  rigoroso: "rigorous",
}

function normalizeBehavior(raw: unknown): OrchestrationSettings["behavior"] {
  const d = DEFAULT_ORCHESTRATION_SETTINGS.behavior
  if (raw === "orchestrate" || raw === "supervise" || raw === "rigorous") return raw
  if (typeof raw === "string" && Object.prototype.hasOwnProperty.call(LEGACY_BEHAVIOR, raw)) {
    return LEGACY_BEHAVIOR[raw]
  }
  return d
}

/** Fills in / sanitizes what came from the renderer or the phone. Never throws. */
export function normalizeOrchestrationSettings(raw: unknown): OrchestrationSettings {
  const v = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  const d = DEFAULT_ORCHESTRATION_SETTINGS
  // Settings written before the rename still carry the Portuguese keys.
  const rawAdjustments = v.adjustmentsPerWorker ?? v.ajustesPorWorker
  const adjustments = typeof rawAdjustments === "number" && Number.isInteger(rawAdjustments)
    ? Math.min(MAX_ADJUSTMENTS_PER_WORKER, Math.max(0, rawAdjustments))
    : d.adjustmentsPerWorker
  const rawSingleTask = v.approveSingleTask ?? v.aprovarTarefaUnica
  return {
    behavior: normalizeBehavior(v.behavior ?? v.comportamento),
    adjustmentsPerWorker: adjustments,
    worktrees: typeof v.worktrees === "boolean" ? v.worktrees : d.worktrees,
    approveSingleTask: typeof rawSingleTask === "boolean" ? rawSingleTask : d.approveSingleTask,
    autoApprove: typeof v.autoApprove === "boolean" ? v.autoApprove : d.autoApprove,
  }
}

export interface OrchestrationPlan {
  id: string
  tasks: OrchestrationTask[]
  status: "proposed" | "approved" | "running" | "done" | "rejected"
  /** Settings in force when the plan was approved */
  config?: OrchestrationSettings
  /** Follow-up in progress: the adjustment budget and what the orchestrator is doing */
  review?: {
    adjustmentsUsed: number
    maxAdjustments: number
    /** E.g. "Reviewing: STT engines" — empty when it is not doing anything */
    activity?: string
    /** Result of merging the workers' worktrees, when there was one */
    merge?: {
      ok: boolean
      detail: string
      /** Accepted work is still unmerged — the card offers "Merge again" */
      pending?: boolean
    }
  }
  /** Accumulated tokens/cost: planning + workers + synthesis */
  usage?: TokenUsage
  /** Card closed by the user. The plan STAYS stored — tasks, prompts and
   *  accumulated usage are the orchestrator's history and context if the
   *  conversation goes on; the mark only says the card must not come back. A new
   *  plan overwrites it and does not inherit the mark. */
  dismissed?: boolean
  /**
   * The run was cut short by the app closing (a crash, a force quit): the file
   * kept saying `running` with tasks in an open phase, and the card would show
   * "in progress" forever with no way to close it. Written at boot by
   * `recoverInterruptedPlans` — which closes the plan as `done` — and cleared
   * when the plan is resumed. It is what makes the card offer "Continue".
   */
  interrupted?: boolean
}

/**
 * Phases persisted before the domain was renamed to English. A plan approved by
 * an older build still carries them, so the normalization below translates the
 * value instead of dropping the phase (which would make the card fall back to
 * the raw chat status). Idempotent: current values pass straight through.
 */
const LEGACY_PHASE: Record<string, OrchestrationTaskPhase> = {
  fila: "queued",
  rodando: "running",
  revisao: "review",
  ajuste: "adjustment",
  aceita: "accepted",
  falhou: "failed",
}

const PHASES: readonly OrchestrationTaskPhase[] = ["queued", "running", "review", "adjustment", "accepted", "failed"]

const PLAN_STATUS: readonly OrchestrationPlan["status"][] = ["proposed", "approved", "running", "done", "rejected"]

const TASK_STATUS: readonly ChatStatus[] = ["idle", "submitted", "streaming", "cancelling", "error", "fallback"]

function normalizePhase(raw: unknown): OrchestrationTaskPhase | undefined {
  if (typeof raw !== "string") return undefined
  if ((PHASES as readonly string[]).includes(raw)) return raw as OrchestrationTaskPhase
  return Object.prototype.hasOwnProperty.call(LEGACY_PHASE, raw) ? LEGACY_PHASE[raw] : undefined
}

/** First value found among the current key and the legacy one. */
function pick(raw: Record<string, unknown>, next: string, legacy: string): unknown {
  return raw[next] ?? raw[legacy]
}

function asStrings(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : []
}

function normalizePlanWorktree(raw: unknown): OrchestrationTask["worktree"] {
  if (!raw || typeof raw !== "object") return undefined
  const w = raw as Record<string, unknown>
  const dir = pick(w, "path", "caminho")
  if (typeof dir !== "string" || !dir) return undefined
  const folder = pick(w, "folder", "pasta")
  return {
    path: dir,
    folder: typeof folder === "string" && folder ? folder : dir,
    branch: typeof w.branch === "string" ? w.branch : "",
    base: typeof w.base === "string" ? w.base : "",
  }
}

function normalizePlanTask(raw: unknown): OrchestrationTask | null {
  if (!raw || typeof raw !== "object") return null
  const t = raw as Record<string, unknown>
  if (t.id === undefined) return null
  const phase = normalizePhase(t.phase ?? t.fase)
  const dependsOnRaw = pick(t, "dependsOn", "dependeDe")
  const filesRaw = pick(t, "files", "arquivos")
  const reviewNote = pick(t, "reviewNote", "notaRevisao")
  const merged = pick(t, "merged", "juntada")
  const worktree = normalizePlanWorktree(t.worktree)
  return {
    id: String(t.id),
    title: typeof t.title === "string" ? t.title : "",
    prompt: typeof t.prompt === "string" ? t.prompt : "",
    options: (t.options && typeof t.options === "object" ? t.options : {}) as SendMessageOptions,
    ...(t.vision !== undefined ? { vision: Boolean(t.vision) } : {}),
    ...(t.workerSessionId !== undefined ? { workerSessionId: String(t.workerSessionId) } : {}),
    status: (TASK_STATUS as readonly string[]).includes(t.status as string) ? (t.status as ChatStatus) : "idle",
    ...(t.revisions !== undefined ? { revisions: Number(t.revisions) } : {}),
    ...(phase ? { phase } : {}),
    ...(dependsOnRaw !== undefined ? { dependsOn: asStrings(dependsOnRaw) } : {}),
    ...(filesRaw !== undefined ? { files: asStrings(filesRaw) } : {}),
    ...(t.extra !== undefined ? { extra: Boolean(t.extra) } : {}),
    ...(reviewNote !== undefined ? { reviewNote: String(reviewNote) } : {}),
    ...(worktree ? { worktree } : {}),
    ...(merged !== undefined ? { merged: Boolean(merged) } : {}),
  }
}

function normalizePlanReview(raw: unknown): OrchestrationPlan["review"] {
  if (!raw || typeof raw !== "object") return undefined
  const r = raw as Record<string, unknown>
  const used = Number(pick(r, "adjustmentsUsed", "ajustesUsados") ?? 0)
  const max = Number(pick(r, "maxAdjustments", "tetoAjustes") ?? 0)
  const activity = pick(r, "activity", "atividade")
  const mergeRaw = r.merge && typeof r.merge === "object" ? (r.merge as Record<string, unknown>) : undefined
  const detail = mergeRaw ? pick(mergeRaw, "detail", "detalhe") : undefined
  const pending = mergeRaw ? pick(mergeRaw, "pending", "pendente") : undefined
  return {
    adjustmentsUsed: Number.isFinite(used) ? used : 0,
    maxAdjustments: Number.isFinite(max) ? max : 0,
    ...(typeof activity === "string" ? { activity } : {}),
    ...(mergeRaw
      ? {
          merge: {
            ok: Boolean(mergeRaw.ok),
            detail: typeof detail === "string" ? detail : "",
            ...(pending !== undefined ? { pending: Boolean(pending) } : {}),
          },
        }
      : {}),
  }
}

/**
 * Fills in / migrates a persisted plan. Plans stored before the domain was
 * renamed to English carry Portuguese keys and phase values; they are translated
 * here, at the read edge. Idempotent: a plan already in the current shape comes
 * back unchanged, and an unusable value falls back to the default instead of
 * throwing.
 */
export function normalizeOrchestrationPlan(raw: unknown): OrchestrationPlan | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const p = raw as Record<string, unknown>
  if (p.id === undefined) return undefined
  const review = normalizePlanReview(p.review ?? p.revisao)
  return {
    id: String(p.id),
    tasks: Array.isArray(p.tasks)
      ? p.tasks.map(normalizePlanTask).filter((t): t is OrchestrationTask => !!t)
      : [],
    status: (PLAN_STATUS as readonly string[]).includes(p.status as string)
      ? (p.status as OrchestrationPlan["status"])
      : "proposed",
    ...(p.config !== undefined ? { config: normalizeOrchestrationSettings(p.config) } : {}),
    ...(review ? { review } : {}),
    ...(p.usage !== undefined ? { usage: p.usage as TokenUsage } : {}),
    ...(p.dismissed !== undefined ? { dismissed: Boolean(p.dismissed) } : {}),
    ...(p.interrupted !== undefined ? { interrupted: Boolean(p.interrupted) } : {}),
  }
}

export interface WorkerModelConfig {
  providerId: string
  modelId: string
  reasoning?: ReasoningConfig
}

/** Model of a rotation slot — same shape as the renderer's `SelectedModel`. */
export interface RotationModel {
  providerId: string
  modelId: string
}

/** Named rotation: ordered list of models (1..4 slots). If a model
 *  fails with a recoverable error, the turn tries the next one in the list. */
export interface ModelRotation {
  id: string
  name: string
  models: RotationModel[]
}

/** Full state of the model rotation (renderer → main via IPC
 *  `rotation:sync`). There is no global toggle and no "active" rotation: the rotation is
 *  merely created and CHOSEN PER CHAT in the model selector, like a model
 *  (`sessionOverrides` = session → rotation; "draft" = new chat). */
export interface RotationConfig {
  rotations: ModelRotation[]
  sessionOverrides: Record<string, string>
}

export interface RotationFallbackInfo {
  /** Index (1-based) of the current attempt within the sequence */
  current: number
  /** Total size of the sequence */
  total: number
  /** true when it is not a model switch, but a new round of the turn after
   *  a transient failure (see SendMessageOptions.retries) */
  retry?: boolean
}

export interface SendMessageInput {
  sessionId: string
  text: string
  /**
   * Set by the routines scheduler on the execution of a routine that has scripts: the scripts the
   * agent may call with `run_script`, and the folders they may read. Never typed by the person.
   */
  routineContext?: { id: string; folder?: string; folders: string[]; scripts: import('./routines').RoutineScript[] }
  /** Files attached to the user message */
  files?: FilePart[]
  /**
   * Id of the answer that failed, when this send is a "try again".
   * The turn runs AGAIN over the same user message (no duplicated
   * bubble): the attempt that failed leaves the history and becomes the
   * resume note the model receives (see session/retry-note.ts).
   */
  retryOf?: string
  providerId: string
  modelId: string
  mode: SessionMode
  options: SendMessageOptions
  directory?: string
  extraDirectories?: string[]
  /** Model of the workers (subagents/orchestra), coming from the configuration modal */
  workerModel?: WorkerModelConfig
  /**
   * Model that conducts the orchestra (planning and synthesis). Absent = the
   * chat's own model. Workers do not use it: they follow workerModel.
   */
  orchestratorModel?: WorkerModelConfig
  /** Delegated vision model (Vision mode) — describes images for models without vision */
  visionModel?: WorkerModelConfig
  /** Filled by the main process in worker runs — never by the renderer */
  orchestrationRole?: "orchestrator" | "worker"
  /** The user message of this turn was not typed by the person: a subchat finished and
   *  woke its parent up with its result (see subchat-wake.ts). */
  messageOrigin?: "subchat"
  /** Session of the orchestrator that created this worker (filled by the main process) */
  parentSessionId?: string
  /** Short title of the worker task, for origin badges (filled by the main process) */
  workerTitle?: string
  /** Loop mode configuration (sent from the renderer) */
  loopConfig?: { maxIterations: number }
  /** Preferred language of the user (name in English, e.g. "Portuguese", "English") —
   * used in the system prompts to instruct the model to answer in that language
   * by default. The model may still follow the language of the user's own message
   * when it clearly differs from this (see IDENTITY in prompts.ts). */
  language?: string
}

export type ChatEvent =
  | {
      type: "status"
      sessionId: string
      status: ChatStatus
      error?: string
      /** Classification of the error — the `error` text is diagnostic and is not translated. */
      errorKind?: MessageErrorKind
      fallback?: RotationFallbackInfo
    }
  | { type: "message"; sessionId: string; message: ChatMessage }
  /** Full replacement of the history (e.g. compaction inserts a summary in the middle) */
  | { type: "messages"; sessionId: string; messages: ChatMessage[] }
  | { type: "part"; sessionId: string; messageId: string; part: MessagePart }
  | {
      type: "part-delta"
      sessionId: string
      messageId: string
      partId: string
      kind: "text" | "reasoning" | "agent"
      delta: string
    }
  | { type: "title"; sessionId: string; title: string }
  /**
   * Size of the context DURING the turn, so the meter moves on every step of the
   * tool loop instead of waiting for the end of the answer. `estimated`: measured in the
   * request before sending (no tokenizer, no system prompt) — it arrives when
   * it goes past the last real value, which is precisely the warning that the next
   * send is going to grow. The real value comes from the provider at the end of each step.
   *
   * A separate event, and not `tokens` in the message: the UI reads `tokens` as "the turn
   * is over" and unlocks the input.
   */
  | {
      type: "context"
      sessionId: string
      messageId: string
      input: number
      output: number
      estimated?: boolean
      /** Cache read/written in this call (only in the measured value, not in the estimate). */
      cacheRead?: number
      cacheWrite?: number
    }
  /** Next likely message of the user — the input shows it greyed out and Tab completes it */
  | { type: "suggestion"; sessionId: string; text: string }
  /**
   * The next compaction would go past the summary limit: the UI offers to continue
   * in a new chat (with a summary of the current state) or to compact here. It arrives only
   * at the END of a turn — that is when the real usage is known and there is no turn
   * running, which is what manual compaction requires (see compactSession).
   * It is an offer, not a block: ignored, the automatic compaction at the
   * start of the next turn runs as always.
   */
  | {
      type: "compaction:suggest"
      sessionId: string
      /** Summaries already in the history (= compactions made) */
      summaries: number
    }
  | { type: "orchestration:plan"; sessionId: string; plan: OrchestrationPlan }
  | { type: "plan:review"; sessionId: string; review: PlanReview }
  /** Session created/updated by the main process (orchestration workers) */
  | { type: "session"; sessionId: string; session: SessionInfo }
  /** Permission request awaiting an answer (inline card; origin = came from a worker) */
  | { type: "permission"; sessionId: string; requestId: string; claim: PermissionClaim; origin?: AskOrigin }
  /** Questions of the question tool awaiting an answer */
  | { type: "question"; sessionId: string; requestId: string; questions: Question[]; origin?: AskOrigin }
  /** Suggestion to take a subject to another conversation — the card decides the destination
   *  ("subchat" = attached; "chat" = a new top-level conversation, see AskItem.subchat) */
  | {
      type: "subchat"
      sessionId: string
      requestId: string
      title: string
      brief: string
      scope?: "subchat" | "chat"
      profile?: ProfileId
      origin?: AskOrigin
    }
  /** Batch of worker requests grouped in a batching window (single card) */
  | { type: "ask:batch"; sessionId: string; batchId: string; items: AskItem[] }
  /** Request resolved/canceled — removes the card from the UI */
  | { type: "ask:done"; sessionId: string; requestId: string }
  /** Session deleted (desktop or companion) — removes it from the UI on every client */
  | { type: "session:deleted"; sessionId: string }
  /** Folder list changed (created/renamed/pinned/removed) — full replacement */
  | { type: "folders"; folders: FolderInfo[] }
  /** Click on a native notification — the renderer opens the corresponding session */
  | { type: "notifications:open"; sessionId: string }

/** Modalities supported by a model (models.dev): text, image, audio, video, pdf */
export interface ModelModalities {
  input: string[]
  output: string[]
}

/** models.dev catalog model (same format used by opencode) */
export interface CatalogModel {
  id: string
  name: string
  reasoning: boolean
  /** The model always thinks (no level control) — e.g. DeepSeek R1 */
  reasoningAlwaysOn?: boolean
  /** Available reasoning levels (metadata generated in the main process) */
  variants?: ModelVariant[]
  tool_call: boolean
  attachment: boolean
  /** Accepted input/output types (text, image, audio, video, pdf) */
  modalities?: ModelModalities
  release_date?: string
  limit?: { context: number; output: number }
  /** Price per 1M tokens (models.dev). The cache fields may be missing in models without cache. */
  cost?: {
    input: number
    output: number
    cache_read?: number
    cache_write?: number
    /** Ranges by context size (e.g. above 200k tokens, another price). */
    tiers?: {
      input: number
      output: number
      cache_read?: number
      cache_write?: number
      tier?: { type: string; size: number }
    }[]
  }
  /** Catalog status (models.dev): `deprecated` = removed from the provider backend */
  status?: 'deprecated' | 'beta'
  /** Family in models.dev (e.g. "deepseek-flash"). When an id is renamed,
   *  the old id usually becomes the family of the successors — see findCatalogModel. */
  family?: string
  /** Package and endpoint of the model itself, when they differ from the provider's
   *  (models.dev). A gateway such as OpenCode serves Claude over the Anthropic
   *  protocol and GPT over /responses, under the same provider. */
  provider?: { npm?: string; api?: string }
  /** Reasoning controls that models.dev declares for the model. `effort`
   *  lists the levels the provider accepts; `toggle` is on/off;
   *  `budget_tokens` is a budget in tokens, with optional limits. */
  reasoning_options?: Array<
    | { type: 'effort'; values: Array<string | null> }
    | { type: 'toggle' }
    | { type: 'budget_tokens'; min?: number; max?: number }
  >
}

/**
 * Wire dialect of a provider OUTSIDE models.dev (custom provider).
 * In the catalog the `npm` decides the SDK; here the user chooses the protocol,
 * because a gateway that speaks Anthropic Messages does not work through the
 * openai-compatible adapter.
 */
export type ProviderProtocol = 'openai-completions' | 'openai-responses' | 'anthropic-messages'

/**
 * Gateway adjustments that models.dev has no way to describe. All optional:
 * when absent, the protocol defaults apply.
 */
export interface ProviderCompat {
  /** Field that carries the output token ceiling (OpenAI-like APIs). */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  /**
   * `deepseek`: the reasoning comes back in `reasoning_content` and has to be
   * resent in all assistant messages (DeepSeek returns 400 on a
   * multi-turn conversation without it). `none`: never injects the field.
   */
  thinkingFormat?: 'deepseek' | 'none'
}

export interface CatalogProvider {
  id: string
  name: string
  env: string[]
  npm?: string
  api?: string
  models: Record<string, CatalogModel>
  /** Only in custom providers (see ProviderProtocol). */
  protocol?: ProviderProtocol
  /** Only in custom providers (see ProviderCompat). */
  compat?: ProviderCompat
  /**
   * Only in custom providers, and only in the `list` response: the key is
   * saved (auth.json) or the environment variable exists. It is not persisted in the
   * providers file.
   */
  hasKey?: boolean
}

/**
 * Ceiling of tools per request in providers that impose one. Groq refuses above
 * 128 and the whole call fails ("too many tools") — it is not a model
 * limit, it is a policy of the endpoint, which is why it lives here and not in the
 * models.dev catalog. `undefined` = no known ceiling.
 */
const TOOL_LIMIT_PER_PROVIDER: Record<string, number> = { groq: 128 }

export function toolLimitFor(providerId: string): number | undefined {
  return TOOL_LIMIT_PER_PROVIDER[providerId]
}

/** Model declared in a custom provider — models.dev does not know it. */
export interface CustomModelInput {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  /** Absent = inferred from the id (see inferReasoning in custom-providers.ts). */
  reasoning?: boolean
}

/** Custom provider created by the user (outside the models.dev listing). */
export interface CustomProviderInput {
  /** Slug without the `custom:` prefix (e.g. "my-gateway"). */
  id: string
  name: string
  baseURL: string
  /** Goes to auth.json; never comes back over IPC. */
  apiKey?: string
  /** Instead of storing the key, reads it from an environment variable. */
  keyEnv?: string
  protocol?: ProviderProtocol
  compat?: ProviderCompat
  models?: CustomModelInput[]
}

/** Change to a custom provider — an absent field stays as it is. */
export interface CustomProviderPatch {
  name?: string
  baseURL?: string
  apiKey?: string
  /** `null`/empty = stops using an environment variable. */
  keyEnv?: string | null
  protocol?: ProviderProtocol
  compat?: ProviderCompat | null
  /** Replaces the whole list when present. */
  models?: CustomModelInput[]
}

/** Model found when querying the `GET /models` of a server. */
export interface DiscoveredModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
}

export type Catalog = Record<string, CatalogProvider>

/**
 * Finds the model in the catalog, following renames. models.dev sometimes changes
 * the id of a model (e.g. "deepseek-flash" → "deepseek-v4.1-flash") and the old
 * id becomes the family of the successors. A choice saved with the old id
 * disappeared from the catalog, and the engine stopped sending the reasoning level
 * without warning anyone — the model answered without thinking.
 *
 * Without the exact id, it looks in the SAME provider for the models whose family is the
 * requested id and keeps the most recent one. `renamed` says whether there was a swap.
 */
export function findCatalogModel(
  catalog: Catalog,
  providerId: string,
  modelId: string,
): { modelId: string; model: CatalogModel; renamed: boolean } | undefined {
  const models = catalog[providerId]?.models
  if (!models) return undefined
  const exact = models[modelId]
  if (exact) return { modelId, model: exact, renamed: false }
  const successors = Object.entries(models)
    .filter(([, m]) => m.family === modelId && m.status !== 'deprecated')
    .sort(([, a], [, b]) => (b.release_date ?? '').localeCompare(a.release_date ?? ''))
  const [id, model] = successors[0] ?? []
  return id && model ? { modelId: id, model, renamed: true } : undefined
}

/** Reasoning levels from weakest to strongest — `closestVariant` uses the
 *  order to swap a level the model does not have for the closest neighbor. */
export const REASONING_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * The level that actually applies to a model. A saved level that the model does not
 * offer (e.g. "medium" in a model that only has low/high/max) was discarded in
 * silence, and the turn came out with no reasoning at all. Here it becomes the next
 * strongest available; if there is none, the strongest below. With no level requested, or
 * with one that is not in the scale, it stays `undefined`.
 */
export function closestVariant(available: string[], wanted: string | undefined): string | undefined {
  if (!wanted || available.length === 0) return undefined
  if (available.includes(wanted)) return wanted
  const rank = REASONING_LEVELS.indexOf(wanted)
  if (rank < 0) return undefined
  const ranked = available
    .map((id) => ({ id, rank: REASONING_LEVELS.indexOf(id) }))
    .filter((v) => v.rank >= 0)
    .sort((a, b) => a.rank - b.rank)
  return (ranked.find((v) => v.rank > rank) ?? ranked[ranked.length - 1])?.id
}

/** Does the model accept images as input? Uses the models.dev modalities
 * (input includes 'image'); without modalities, falls back to the `attachment` flag. */
export function modelSupportsVision(provider: CatalogProvider | undefined, modelId: string): boolean {
  const model = provider?.models[modelId]
  if (!model) return false
  const input = model.modalities?.input
  if (input && input.length > 0) return input.includes('image')
  return model.attachment === true
}

export interface ProviderCredential {
  type: "api"
  key: string
}

/** Keys used in the generic storage (main process) */
/** Message queued for later sending (queue or scheduled) */
export interface QueuedMessage {
  id: string
  text: string
  /** Attached files (data URLs) */
  files?: FilePart[]
  options: SendMessageOptions
  mode: SessionMode
  sessionId?: string
  /**
   * Model the message was written under. It travels with the item because the queue
   * is sent by whoever owns it on the desktop, and a chat born on the phone has no
   * per-chat override there — without this the message would leave with the desktop
   * default instead of the model shown in the app.
   */
  providerId?: string
  modelId?: string
  directory?: string
  extraDirectories?: string[]
  /** MS timestamp for scheduled sending; undefined = sends as soon as possible */
  scheduledAt?: number
  createdAt: number
}

/** Extra rounds a queue message gets on a transient failure
 *  (SendMessageOptions.retries) — the person is not watching when it fires. */
export const MAX_QUEUE_RETRIES = 3

export const StorageKeys = {
  session: (id: string) => `session/${id}`,
  sessionPrefix: "session/",
  messages: (sessionId: string) => `messages/${sessionId}`,
  folders: "folders",
  orchestration: (orchestratorSessionId: string) => `orchestration/${orchestratorSessionId}`,
  planReview: (sessionId: string) => `plan-review/${sessionId}`,
  /** The crafts whose specialist offer the person already answered in this conversation. */
  specialistOffers: (sessionId: string) => `specialist-offers/${sessionId}`,
  pendingAsks: (sessionId: string) => `pendingAsks/${sessionId}`,
  memory: (id: string) => `memory/items/${id}`,
  memoryItemsPrefix: "memory/items/",
  memoryIndex: "memory/_index",
  /** Effective app language, published by the renderer for the main process.
   *  The routine scheduler runs with no renderer in the loop and needs it. */
  appLanguage: "app-language",
  queuedMessages: "message-queue",
  /** Model selected on the desktop. Read by whoever answers without a conversation in the
   *  loop: the companion HTTP and the sampling of a connected app (lib/mcp). */
  selectedModel: "companion/selected-model",
  /** The chats that worked on one artifact (see artifacts.ts); `kind` and `id` are already validated. */
  artifactChats: (kind: string, id: string) => `artifactChats/${kind}/${id}`,
  /** The way back: the artifacts one chat has worked on. */
  artifactsOfChat: (sessionId: string) => `artifactsOfChat/${sessionId}`,
} as const
