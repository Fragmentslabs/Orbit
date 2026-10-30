import { app, BrowserWindow } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { StorageKeys, type SessionInfo } from '@shared/chat'
import { extractDocument, type DocumentKind, type ExtractedDocument } from './documents'
import { saveExport } from './export-dialog'
import { documentKindOf } from './document-pages'
import { pageThumb, textThumb } from './document-thumb'
import { readJson } from './storage'
import { fetchReadablePage } from './tools/web'
import { t } from './i18n'
import {
  MAX_RASTER_PAGES,
  printFile,
  rasterizePdf,
  type PdfOutlineItem,
  type PdfTextItem,
} from './pdf-raster'

/**
 * Documents the conversation works with — the SOURCES.
 *
 * Chat mode has no `read` and no `bash`: until here, the ONLY way for a
 * document to reach the model was the attachment dumping the whole text into a
 * TextPart — which toModelMessages resends on every turn. A 300-page PDF
 * stayed in the context window forever, being charged again on
 * every message.
 *
 * Now the extracted text is persisted HERE and the message carries only an opening
 * excerpt. The rest the agent reaches through the doc_search/doc_read tools,
 * paying only for the pages it actually uses.
 *
 * Persisting is mandatory, not an optimization: the attachment chip discards the original
 * bytes after the turn (attachmentChip zeroes the url on everything that is not an
 * image). Without this copy, the document would exist only in the turn in which it was
 * sent and any later question would have nothing to read.
 *
 * TWO SCOPES, and the difference is one of INTENTION:
 *
 * - `doc1, doc2…` — attachment of the conversation. You threw in a file to ask
 *   something; that is not a declaration of a corpus. It counts only there, in both modes.
 * - `src1, src2…` — source of the sidebar folder, declared on purpose. It counts
 *   for every conversation in that folder.
 *
 * The id prefix is what says where the file lives, so resolving an id does not
 * have to look in both places. And it never collides: two chats of the same
 * folder can each have their own doc2 without seeing each other, because what is shared
 * lives in the other namespace.
 *
 * Promoting (attachment → source) is an explicit act of the user in the Sources tab. Nothing
 * leaks to the folder on its own: a wrong source is silent and changes answers in
 * OTHER conversations, whereas the extra click is visible right away.
 */

export interface SessionDocument {
  /** Short id used by the model in the tools — readable and cheap. `docN` is a conversation
   *  attachment; `srcN` is a shared source of the folder. */
  id: string
  /** Conversation the document entered. It stays written after being promoted:
   *  it is what lets the tab say where that file came from. */
  sessionId: string
  filename: string
  kind: DocumentKind
  totalPages: number
  totalChars: number
  truncated: boolean
  /** Size of the original file, for the tab to show what it takes on disk. */
  sizeBytes?: number
  createdAt: number
  /** true when it lives in the folder scope (`srcN` id). */
  shared?: boolean
  /** Origin address, in website sources — it is what the user recognizes and
   *  what allows opening the page again. */
  sourceUrl?: string
}

interface StoredDocument extends SessionDocument {
  pages: ExtractedDocument['pages']
}

/** It only accepts the ids we generated ourselves — no path traversal coming from
 *  a tool call the model made up. */
const SAFE_ID = /^(doc|src)[0-9]+$/
const SAFE_SCOPE = /^[a-zA-Z0-9_-]+$/

/** Where an id lives, read from the id itself. */
function isShared(id: string): boolean {
  return id.startsWith('src')
}

function scopeDir(scope: string): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'session-docs', scope)
}

interface Scopes {
  /** Scope of the conversation — always exists. */
  session: string
  /** Scope of the sidebar folder, when the conversation is in one. */
  folder: string | null
}

/**
 * The two scopes visible to this conversation.
 *
 * The folderId is read from the session persisted at the time of use, and not received
 * as a parameter, because it changes when the user drags the chat between
 * folders — same reason as resolveFolderId in the document tools.
 */
async function scopesOf(sessionId: string): Promise<Scopes> {
  // No session yet: it is the DRAFT. The panel opens the source of a new chat with
  // an empty sessionId (the tab lives in the orphan bucket, which carries no session), and without
  // this detour the viewer did not find the document that the Sources tab
  // had just listed — the source existed and clicking it opened "not found".
  const session = SAFE_SCOPE.test(sessionId) ? sessionId : sessionId === '' ? DRAFT_SCOPE : ''
  const folderId = await documentFolderId(sessionId)
  return {
    session,
    folder: folderId && SAFE_SCOPE.test(folderId) ? `folder-${folderId}` : null,
  }
}

/**
 * Where the draft keeps the folder it will belong to.
 *
 * It lives INSIDE the documents scope, and not as a session: a session record
 * called "draft" would show up as a ghost conversation in the sidebar, because
 * the session list is read from storage. Here it is invisible to everything except
 * this resolution, and it disappears with the draft on adoption.
 */
const DRAFT_FOLDER_FILE = 'folder.json'

/**
 * The folder the new chat will inherit when it is born.
 *
 * A chat created by the "+" of a folder already belongs to it before the first
 * message — the user chose the folder when clicking. Without this the draft would
 * have no folder at all, and the Sources tab would show the empty shared area
 * precisely in the conversation that was opened from a folder.
 */
export async function setDraftFolder(folderId: string | null): Promise<void> {
  const file = path.join(scopeDir(DRAFT_SCOPE), DRAFT_FOLDER_FILE)
  if (!folderId || !SAFE_SCOPE.test(folderId)) {
    await fsp.rm(file, { force: true })
    return
  }
  await fsp.mkdir(scopeDir(DRAFT_SCOPE), { recursive: true })
  await fsp.writeFile(file, JSON.stringify({ folderId }), 'utf8')
}

/** The conversation's folder, when it is in one. */
export async function documentFolderId(sessionId: string): Promise<string | null> {
  if (sessionId === DRAFT_SCOPE) {
    try {
      const raw = await fsp.readFile(path.join(scopeDir(DRAFT_SCOPE), DRAFT_FOLDER_FILE), 'utf8')
      return (JSON.parse(raw) as { folderId?: string }).folderId ?? null
    } catch {
      return null
    }
  }
  try {
    const session = await readJson<SessionInfo>(StorageKeys.session(sessionId))
    return session?.folderId ?? null
  } catch {
    return null
  }
}

/** Directory in which an id lives, or null when that scope does not exist. */
function dirForId(scopes: Scopes, id: string): string | null {
  const scope = isShared(id) ? scopes.folder : scopes.session
  return scope ? scopeDir(scope) : null
}

async function readStoredAt(dir: string | null, id: string): Promise<StoredDocument | null> {
  if (!dir || !SAFE_ID.test(id)) return null
  try {
    const raw = await fsp.readFile(path.join(dir, `${id}.json`), 'utf8')
    const parsed = JSON.parse(raw) as StoredDocument
    if (!Array.isArray(parsed.pages)) return null
    return { ...parsed, id, shared: isShared(id) }
  } catch {
    return null
  }
}

/**
 * Trace left in place of an id that changed area (`doc1.moved.json`).
 *
 * The id is the ADDRESS of the document and also says where it lives, so dragging the
 * file from "attachments of this conversation" to "sources of the folder" swaps doc1 for
 * src1 — and every citation already written in the conversation starts pointing to an id that
 * no longer exists. For the agent that was acceptable (it redoes the doc_list),
 * but what is written in the conversation belongs to the USER: the click that opened the
 * cited excerpt simply stopped opening, with nothing explaining why.
 *
 * The trace is what keeps the old address valid. It stays in the origin
 * scope, next to where the file was, and it is followed when reading.
 */
const TRAIL_SUFFIX = '.moved.json'

interface Trail {
  to: string
  scope: string
}

async function readTrail(dir: string, id: string): Promise<Trail | null> {
  try {
    const raw = await fsp.readFile(path.join(dir, `${id}${TRAIL_SUFFIX}`), 'utf8')
    const parsed = JSON.parse(raw) as Trail
    return SAFE_ID.test(parsed.to ?? '') && SAFE_SCOPE.test(parsed.scope ?? '') ? parsed : null
  } catch {
    return null
  }
}

/** Where a document is TODAY, for an id that may be old. */
interface ResolvedDoc {
  id: string
  dir: string
}

/**
 * The document that an id addresses now — following the trace when it changed
 * area.
 *
 * Every read goes through here, and not only the panel: doc_read of an id cited
 * in a previous turn has the same problem, and returning the right text is better
 * than telling the agent to redo the list.
 *
 * The loop exists because the file may have gone and come back (doc1 → src1 → doc2),
 * and the ceiling is against a circular trace from a corrupted disk.
 */
async function resolveDoc(sessionId: string, docId: string): Promise<ResolvedDoc | null> {
  if (!SAFE_ID.test(docId)) return null
  const scopes = await scopesOf(sessionId)
  let id = docId
  for (let hop = 0; hop < 4; hop += 1) {
    const dir = dirForId(scopes, id)
    if (!dir) break
    if (await exists(path.join(dir, `${id}.json`))) return { id, dir }
    const trail = await readTrail(dir, id)
    // It only follows to an area that THIS conversation already reaches. A document
    // demoted to another chat's scope stays out of this one's reach —
    // the trace returns the address, not permission.
    if (!trail || (trail.scope !== scopes.session && trail.scope !== scopes.folder)) break
    id = trail.to
  }
  return promotedBeforeTrails(scopes, sessionId, docId)
}

async function exists(file: string): Promise<boolean> {
  try {
    await fsp.access(file)
    return true
  } catch {
    return false
  }
}

/**
 * Rescue of the files promoted BEFORE the trace existed.
 *
 * Without this, the fix would only count for future moves, and the conversations
 * that already lost the reference would keep the dead click forever —
 * which is exactly the state to be fixed.
 *
 * Three conditions, all necessary so as not to open the wrong file under a
 * citation (which would be worse than opening nothing):
 *
 * - the requested id is an attachment (`docN`): only that direction loses the address like
 *   this;
 * - the conversation counter confirms that the id was at some point issued
 *   here — the system prompt example uses `doc1`, so an id made up
 *   by the model is not a remote hypothesis;
 * - there is a SINGLE folder source coming from this conversation. With two there is no
 *   way to know which was which, and then the click goes back to opening nothing.
 */
async function promotedBeforeTrails(
  scopes: Scopes,
  sessionId: string,
  docId: string,
): Promise<ResolvedDoc | null> {
  if (isShared(docId) || !scopes.folder) return null
  if (!(await wasAllocated(scopes.session, docId))) return null
  const fromHere = (await readScope(scopes.folder)).filter((doc) => doc.sessionId === sessionId)
  return fromHere.length === 1 ? { id: fromHere[0].id, dir: scopeDir(scopes.folder) } : null
}

/** Whether an id was at some point issued in this scope, by the counter. */
async function wasAllocated(scope: string, id: string): Promise<boolean> {
  if (!scope || !SAFE_SCOPE.test(scope)) return false
  const n = Number(id.slice(3))
  if (!Number.isFinite(n)) return false
  try {
    const saved = JSON.parse(
      await fsp.readFile(path.join(scopeDir(scope), COUNTER_FILE), 'utf8'),
    ) as { next?: number }
    if (typeof saved.next === 'number') return n < saved.next
  } catch {
    // Scope from before the counter: there is nothing to contradict the id.
  }
  return true
}

/** Documents of a scope, in order of attachment. */
async function readScope(scope: string | null): Promise<SessionDocument[]> {
  if (!scope || !SAFE_SCOPE.test(scope)) return []
  const dir = scopeDir(scope)
  let files: string[]
  try {
    files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  const docs: SessionDocument[] = []
  for (const file of files) {
    const stored = await readStoredAt(dir, file.replace(/\.json$/, ''))
    if (stored) docs.push({ ...stored, pages: undefined } as SessionDocument)
  }
  return docs.sort((a, b) => a.createdAt - b.createdAt)
}

/**
 * Everything this conversation reaches: the folder's sources and its own attachments.
 *
 * The sources come first because they are the declared corpus — when the agent
 * walks the list to decide where to look, that is where it should start.
 */
export async function listSessionDocuments(sessionId: string): Promise<SessionDocument[]> {
  const scopes = await scopesOf(sessionId)
  const [shared, own] = await Promise.all([readScope(scopes.folder), readScope(scopes.session)])
  return [...shared, ...own]
}

/** The view of the Sources tab: the two groups separated, with what the UI needs
 *  to label the scope and show the disk usage. */
export async function listSessionSources(sessionId: string): Promise<{
  shared: SessionDocument[]
  own: SessionDocument[]
  folderId: string | null
  usage: number
}> {
  const scopes = await scopesOf(sessionId)
  const [shared, own] = await Promise.all([readScope(scopes.folder), readScope(scopes.session)])
  const [sharedBytes, ownBytes] = await Promise.all([
    scopeUsage(scopes.folder),
    scopeUsage(scopes.session),
  ])
  return {
    shared,
    own,
    folderId: await documentFolderId(sessionId),
    usage: sharedBytes + ownBytes,
  }
}

/**
 * Scope of the chat that does not exist yet.
 *
 * A new chat is a DRAFT: the session is only born when the first message is sent.
 * Without a scope of its own, attaching before that would be impossible — and forcing the user to
 * send a message just to be able to attach inverts the natural order of "I bring the
 * material, then I ask".
 *
 * It is a fixed scope, and not one per draft, for the same reason as the input's
 * text draft (draft-input.ts): the UI has one new chat at a time.
 */
export const DRAFT_SCOPE = 'draft'

/** Counter per scope. The file is what guarantees the id never comes back. */
const COUNTER_FILE = 'counter.json'

/**
 * Next id of the scope, from a counter that only grows.
 *
 * Looking only at what is on disk is not enough: deleting the highest-numbered document and
 * attaching another would return the same id, and the conversation already said before that "doc1 is
 * the contract" — the agent would read the wrong file thinking it read the right one. The
 * highest existing id enters as a floor for scopes created before the counter.
 */
async function allocateId(scope: string, prefix: 'doc' | 'src'): Promise<string> {
  const dir = scopeDir(scope)
  let next = 1
  try {
    const saved = JSON.parse(await fsp.readFile(path.join(dir, COUNTER_FILE), 'utf8')) as {
      next?: number
    }
    if (typeof saved.next === 'number' && saved.next > 0) next = saved.next
  } catch {
    // New scope, or from before the counter: the floor comes from what is written.
  }
  for (const doc of await readScope(scope)) {
    const n = Number(doc.id.slice(3))
    if (Number.isFinite(n) && n >= next) next = n + 1
  }
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, COUNTER_FILE), JSON.stringify({ next: next + 1 }), 'utf8')
  return `${prefix}${next}`
}

/**
 * Extracts and stores a document. Returns the record without the pages — whoever
 * calls builds the opening excerpt with what comes in `pages`.
 *
 * `shared` is only honored when the conversation is in a folder; without a folder there is no
 * larger scope to share and the document stays in the conversation.
 */
export async function saveSessionDocument(
  sessionId: string,
  bytes: Buffer,
  filename: string,
  kind: DocumentKind,
  options: { shared?: boolean; sourceUrl?: string } = {},
): Promise<{ doc: SessionDocument; pages: ExtractedDocument['pages'] }> {
  const scopes = await scopesOf(sessionId)
  const toFolder = Boolean(options.shared && scopes.folder)
  const scope = toFolder ? (scopes.folder as string) : scopes.session
  const extracted = await extractDocument(bytes, kind)
  const doc: SessionDocument = {
    id: await allocateId(scope, toFolder ? 'src' : 'doc'),
    sessionId,
    filename,
    kind,
    totalPages: extracted.totalPages,
    totalChars: extracted.totalChars,
    truncated: extracted.truncated,
    sizeBytes: bytes.length,
    createdAt: Date.now(),
    shared: toFolder,
    ...(options.sourceUrl ? { sourceUrl: options.sourceUrl } : {}),
  }
  await writeDocument(scopeDir(scope), doc, extracted.pages, kind === 'spreadsheet' || kind === 'pdf' || kind === 'docx' ? bytes : null)
  notifyDocumentsChanged()
  return { doc, pages: extracted.pages }
}

/**
 * Writes the record and, when the type asks for it, the ORIGINAL FILE next to it.
 *
 * Spreadsheet, PDF and DOCX keep the original for different reasons. In the spreadsheet,
 * the extracted text serves to read but not to calculate: there the value already comes
 * formatted as the app displays it, and adding from that would force reparsing
 * "1,234.56" — where the silent locale error lives. In the PDF, the reason is
 * rasterizing: a scan has no text layer, and the only way to
 * read it is to render the page and look. The DOCX enters for the same reason with
 * another purpose: editing while preserving formatting is only possible starting from the
 * original file.
 */
async function writeDocument(
  dir: string,
  doc: SessionDocument,
  pages: ExtractedDocument['pages'],
  original: Buffer | null,
): Promise<void> {
  const stored: StoredDocument = { ...doc, pages }
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, `${doc.id}.json`), JSON.stringify(stored), 'utf8')
  if (original) await fsp.writeFile(path.join(dir, `${doc.id}.bin`), original)
}

/**
 * Passes the draft's sources to the session that was just born.
 *
 * Called when the first message creates the session — the same moment the
 * app adopts the input text, the Brain toggle and the model chosen in the
 * draft. After that the draft scope stays empty for the next new
 * chat.
 *
 * The ids are reassigned by the session counter instead of renaming the
 * directory: the session may already have documents (rare, but possible if something
 * attached before), and a `doc1` arriving over another `doc1` would erase what
 * was already there.
 */
export async function adoptDraftDocuments(sessionId: string): Promise<number> {
  if (!SAFE_SCOPE.test(sessionId) || sessionId === DRAFT_SCOPE) return 0
  const from = scopeDir(DRAFT_SCOPE)
  let files: string[]
  try {
    files = (await fsp.readdir(from)).filter(
      (file) => file.endsWith('.json') && SAFE_ID.test(file.replace(/\.json$/, '')),
    )
  } catch {
    return 0
  }
  if (files.length === 0) {
    await fsp.rm(from, { recursive: true, force: true })
    return 0
  }

  const target = scopeDir(sessionId)
  await fsp.mkdir(target, { recursive: true })
  let adopted = 0
  for (const file of files.sort()) {
    const oldId = file.replace(/\.json$/, '')
    try {
      const raw = await fsp.readFile(path.join(from, file), 'utf8')
      const stored = JSON.parse(raw) as StoredDocument
      const id = await allocateId(sessionId, 'doc')
      await fsp.writeFile(
        path.join(target, `${id}.json`),
        JSON.stringify({ ...stored, id, sessionId }),
        'utf8',
      )
      // When the numbering does not match, the chip of the first message was already
      // written with the draft id: the trace is what keeps its click
      // alive. It stays in the session scope because the draft's is deleted here.
      if (id !== oldId) {
        await fsp
          .writeFile(
            path.join(target, `${oldId}${TRAIL_SUFFIX}`),
            JSON.stringify({ to: id, scope: sessionId }),
            'utf8',
          )
          .catch(() => {})
      }
      // The original file goes along: without it the document would lose the
      // rasterization, sheet_query and editing while preserving formatting.
      await fsp.rename(path.join(from, `${oldId}.bin`), path.join(target, `${id}.bin`)).catch(() => {})
      // The thumbnail too, under the new id: it was already rendered while the
      // user was assembling the draft, and redoing it would open a hidden window
      // precisely at the moment the first turn is starting.
      await fsp
        .rename(path.join(from, `${oldId}.thumb.webp`), path.join(target, `${id}.thumb.webp`))
        .catch(() => {})
      adopted += 1
    } catch {
      // An unreadable file cannot prevent the adoption of the others.
    }
  }
  await fsp.rm(from, { recursive: true, force: true })
  notifyDocumentsChanged()
  return adopted
}

/** Rebuilds the ExtractedDocument of a stored document. */
export async function readSessionDocument(
  sessionId: string,
  docId: string,
): Promise<{ doc: SessionDocument; extracted: ExtractedDocument } | null> {
  const resolved = await resolveDoc(sessionId, docId)
  if (!resolved) return null
  const stored = await readStoredAt(resolved.dir, resolved.id)
  if (!stored) return null
  return {
    doc: stored,
    extracted: {
      kind: stored.kind,
      pages: stored.pages,
      totalPages: stored.totalPages,
      totalChars: stored.totalChars,
      truncated: stored.truncated,
    },
  }
}

export interface DocumentHit {
  docId: string
  filename: string
  page: number
  /** Line inside the page (1-indexed) — it is what the citation points to. */
  lineNumber: number
  line: string
  /** Page type and label, so the result says "tab3 (Costs)" instead of
   *  "p3" — in a spreadsheet the number is a tab index, not a page. */
  kind: DocumentKind
  label?: string
}

/**
 * Searches the documents the conversation reaches. Returns AT MOST one
 * match per page: the goal is to locate where to read, not to bring the text —
 * bringing every match would recreate, by another route, the dump that this
 * layer exists to avoid.
 */
export async function searchSessionDocuments(
  sessionId: string,
  pattern: RegExp,
  docId: string | undefined,
  maxHits: number,
): Promise<DocumentHit[]> {
  const docs = docId ? [] : await listSessionDocuments(sessionId)
  const targets = docId ? [docId] : docs.map((d) => d.id)
  const hits: DocumentHit[] = []

  for (const id of targets) {
    const found = await readSessionDocument(sessionId, id)
    if (!found) continue
    for (const page of found.extracted.pages) {
      const lines = page.text.split('\n')
      for (let i = 0; i < lines.length; i += 1) {
        if (!pattern.test(lines[i])) continue
        hits.push({
          docId: id,
          filename: found.doc.filename,
          page: page.num,
          lineNumber: i + 1,
          line: lines[i].trim().slice(0, 250),
          kind: found.doc.kind,
          label: page.label,
        })
        break
      }
      if (hits.length >= maxHits) return hits
    }
  }
  return hits
}


/** Extension of the original file per type — only the ones with a stored file. */
const ORIGINAL_EXT: Partial<Record<DocumentKind, string>> = {
  pdf: 'pdf',
  docx: 'docx',
}

/**
 * Path of the ORIGINAL file of a source, for the protocol to serve it to the
 * panel. null when the type does not keep an original (pasted text, website) or
 * when the file is no longer there.
 */
export async function sessionDocumentFile(
  sessionId: string,
  docId: string,
): Promise<{ path: string; ext: string } | null> {
  const resolved = await resolveDoc(sessionId, docId)
  if (!resolved) return null
  const stored = await readStoredAt(resolved.dir, resolved.id)
  const ext = stored && ORIGINAL_EXT[stored.kind]
  if (!ext) return null
  const file = path.join(resolved.dir, `${resolved.id}.bin`)
  if (!(await exists(file))) return null
  return { path: file, ext }
}

async function originalOf(
  sessionId: string,
  docId: string,
  kind: DocumentKind,
): Promise<{ hasOriginal: boolean; originalKind?: 'pdf' | 'docx' }> {
  if (kind !== 'pdf' && kind !== 'docx') return { hasOriginal: false }
  const file = await sessionDocumentFile(sessionId, docId)
  return file ? { hasOriginal: true, originalKind: kind } : { hasOriginal: false }
}

/**
 * All pages in text, for the panel to scroll the whole document.
 *
 * It goes all at once, and not page by page: the MODEL's reading is paginated
 * because each page costs context, but whoever is looking at the screen wants to scroll.
 * The global ceiling of the extraction (8MB) already limits the worst case.
 */
/** The document as the side panel consumes it, wherever it comes from. */
export interface SessionDocumentView {
  /** Id where the request ended up — it may not be the requested one, when the file
   *  changed area after the citation. */
  id: string
  /** The OLD id, when there was a detour. The panel shows both: the cited
   *  address and where the file is now, so the change does not look like a bug. */
  movedFrom?: string
  filename: string
  kind: DocumentKind
  totalPages: number
  pages: { num: number; label?: string; lines: string[] }[]
  sourceUrl?: string
  /** true when there is a displayable original file — it is what decides whether the
   *  Original mode shows up. */
  hasOriginal: boolean
  /** HOW the original is drawn: the PDF as image pages, the .docx as a
   *  document in HTML. It only exists together with hasOriginal. */
  originalKind?: 'pdf' | 'docx'
}

export async function readSessionText(
  sessionId: string,
  docId: string,
): Promise<SessionDocumentView | null> {
  const found = await readSessionDocument(sessionId, docId)
  if (!found) return null
  return {
    id: found.doc.id,
    ...(found.doc.id !== docId ? { movedFrom: docId } : {}),
    filename: found.doc.filename,
    kind: found.doc.kind,
    totalPages: found.extracted.totalPages,
    pages: found.extracted.pages.map((page) => ({
      num: page.num,
      label: page.label,
      lines: page.text.split('\n'),
    })),
    sourceUrl: found.doc.sourceUrl,
    // The Original mode exists for what has a form beyond text: the PDF is
    // drawn as pages, and the .docx becomes an HTML document (docx-view.ts).
    // Before, only the PDF entered, and an attached .docx opened as a list of lines.
    ...(await originalOf(sessionId, docId, found.doc.kind)),
  }
}

/**
 * PDF pages rendered as images, with the cited excerpt marked.
 *
 * It is what allows highlighting INSIDE the PDF: Chromium's native viewer is
 * closed — you cannot reach its content nor its search — so the
 * page is drawn by us and the highlight goes on top, at the coordinates that
 * pdfjs gives for the text.
 *
 * In batches because each call opens a hidden window: asking five at a time
 * is one window per five pages, instead of one per scrolled page.
 */
export async function renderSessionPages(
  sessionId: string,
  docId: string,
  from: number,
  count: number,
  options: { scale?: number; includeText?: boolean; includeOutline?: boolean } = {},
): Promise<{
  total: number
  outline: PdfOutlineItem[]
  pages: { page: number; dataUrl: string; width: number; height: number; items: PdfTextItem[] }[]
} | null> {
  const found = await readSessionDocument(sessionId, docId)
  if (!found || found.doc.kind !== 'pdf') return null
  const bytes = await readSessionDocumentBytes(sessionId, docId)
  if (!bytes) return null

  const start = Math.max(1, Math.round(from) || 1)
  const wanted: number[] = []
  for (let n = start; n < start + Math.min(Math.max(count, 1), MAX_RASTER_PAGES); n += 1) wanted.push(n)

  const rendered = await rasterizePdf(bytes, {
    pages: wanted,
    scale: options.scale,
    includeText: options.includeText,
    includeOutline: options.includeOutline,
  })
  return {
    total: rendered.total,
    outline: rendered.outline,
    pages: rendered.pages.map((p) => ({
      page: p.pageNumber,
      dataUrl: `data:image/png;base64,${p.png.toString('base64')}`,
      width: p.width,
      height: p.height,
      items: p.items,
    })),
  }
}

/**
 * Sends the source to the printer. Only the ones with a file: a pasted excerpt
 * has nothing to print beyond the text, which comes out through download.
 */
export async function printSessionDocument(
  sessionId: string,
  docId: string,
): Promise<{ ok: boolean; error?: string }> {
  const source = await sessionDocumentFile(sessionId, docId)
  if (!source) return { ok: false, error: await t('sources.error.noFileToPrint') }
  // Same rule as the gallery document: Chromium only paginates PDF. With .docx
  // it would download the file instead of opening the print dialog.
  if (source.ext !== 'pdf') {
    return { ok: false, error: await t('sources.error.onlyPdfPrint') }
  }
  const found = await readSessionDocument(sessionId, docId)
  return printFile(source.path, found?.doc.filename)
}

/**
 * Saves the source to disk, where the user chooses.
 *
 * For sources with a file it is a copy of the ORIGINAL, byte for byte — not of what the
 * panel shows. For the ones that were born as text (pasted excerpt, downloaded page) the
 * extracted text is what exists, and it comes out as .txt.
 */
export async function exportSessionDocument(
  sessionId: string,
  docId: string,
): Promise<{ ok: true; path: string } | { ok: false; canceled?: true; error?: string }> {
  const found = await readSessionDocument(sessionId, docId)
  if (!found) return { ok: false, error: await t('sources.error.notFound') }
  const source = await sessionDocumentFile(sessionId, docId)
  const ext = source?.ext ?? 'txt'
  const base = found.doc.filename.replace(/\.[a-z0-9]+$/i, '')

  const target = await saveExport(null, {
    fileName: `${base || (await t('sources.defaultFileName'))}.${ext}`,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  })
  if (!target) return { ok: false, canceled: true }

  try {
    if (source) await fsp.copyFile(source.path, target)
    else {
      await fsp.writeFile(
        target,
        found.extracted.pages.map((p) => p.text).join('\n\n'),
        'utf8',
      )
    }
    return { ok: true, path: target }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/**
 * Original bytes of the document — the typed source of sheet_query, the source of the
 * rasterization of pdf_view_page and the base of the edited copy of docx_edit. null
 * when the type does not keep an original or when the attachment predates this copy
 * existing; in that case the caller warns instead of returning a wrong result.
 */
export async function readSessionDocumentBytes(
  sessionId: string,
  docId: string,
): Promise<Buffer | null> {
  const resolved = await resolveDoc(sessionId, docId)
  if (!resolved) return null
  try {
    return await fsp.readFile(path.join(resolved.dir, `${resolved.id}.bin`))
  } catch {
    return null
  }
}

/**
 * Thumbnail of the first page, as a data URL — what the Sources tab puts in
 * place of the type icon.
 *
 * Generated once and stored in `<id>.thumb.webp`, because the PDF path
 * goes through rasterizing the page in a hidden window: too expensive to repeat
 * every time the tab mounts. The document is immutable after being saved, so the
 * cache never needs to be invalidated — only followed when the file changes
 * scope or is deleted.
 *
 * Best-effort from end to end: any failure returns null and the list row
 * goes back to showing the icon, which is exactly the state before this existed.
 */
export async function sessionDocumentThumb(sessionId: string, docId: string): Promise<string | null> {
  const resolved = await resolveDoc(sessionId, docId)
  if (!resolved) return null
  const { dir, id } = resolved
  const cached = path.join(dir, `${id}.thumb.webp`)
  const asDataUrl = (buffer: Buffer) => `data:image/webp;base64,${buffer.toString('base64')}`

  try {
    return asDataUrl(await fsp.readFile(cached))
  } catch {
    // No cache yet — goes on to generate it.
  }

  const stored = await readStoredAt(dir, id)
  if (!stored) return null

  let thumb: Buffer | null = null
  try {
    if (stored.kind === 'pdf') {
      const bytes = await fsp.readFile(path.join(dir, `${id}.bin`)).catch(() => null)
      if (bytes) {
        // Low scale on purpose: the result is reduced to 160px of width
        // right after, so rendering large would only waste time.
        const { pages } = await rasterizePdf(bytes, { pages: [1], scale: 0.6 })
        if (pages[0]) thumb = await pageThumb(pages[0].png)
      }
    }
    // It also works as a plan B for the PDF: an old attachment may not have the original
    // stored, and the extracted text is always there.
    if (!thumb) thumb = await textThumb(stored.pages.map((p) => p.text).join('\n'))
  } catch {
    return null
  }

  if (!thumb) return null
  await fsp.writeFile(cached, thumb).catch(() => {})
  return asDataUrl(thumb)
}

/**
 * Plain text file that the Sources tab accepts as a TEXT document.
 *
 * Outside `EXTENSIONS` on purpose: `.md`/`.txt` are not "extractable"
 * documents for `read` in code mode, which has to keep delivering
 * those files raw. Here the destination is another — becoming a paginated source of the
 * conversation —, and the only requirement is that the content be real text.
 */
const TEXT_SOURCE_EXT = /\.(md|markdown|mdx|txt)$/i

/** Is a Buffer readable text? NUL is the most reliable sign of binary. */
function looksLikeText(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false
  return true
}

/** Adds a file through the Sources tab, without going through a message. */
export async function addSessionDocument(
  sessionId: string,
  filename: string,
  bytes: Buffer,
  shared: boolean,
): Promise<{ ok: true; doc: SessionDocument } | { ok: false; error: string }> {
  const documentKind = documentKindOf(filename)
  const kind: DocumentKind | null =
    documentKind ?? (TEXT_SOURCE_EXT.test(filename) && looksLikeText(bytes) ? 'text' : null)
  if (!kind) {
    return { ok: false, error: await t('sources.error.unsupportedKind', { filename }) }
  }
  try {
    const { doc } = await saveSessionDocument(sessionId, bytes, filename, kind, { shared })
    return { ok: true, doc }
  } catch (err) {
    return { ok: false, error: `${filename}: ${(err as Error).message}` }
  }
}

/**
 * Adds a pasted excerpt of text as a source.
 *
 * It exists because not every source is a file: the email someone sent, the
 * piece of a regulation, the transcript of a meeting. Pasting that into a message
 * would throw the whole text into the context of every turn; as a source, it is
 * paginated and read on demand like the others.
 */
export async function addSessionText(
  sessionId: string,
  title: string,
  text: string,
  shared: boolean,
): Promise<{ ok: true; doc: SessionDocument } | { ok: false; error: string }> {
  const content = text.trim()
  if (!content) return { ok: false, error: await t('sources.error.emptyText') }
  try {
    const { doc } = await saveSessionDocument(
      sessionId,
      Buffer.from(content, 'utf8'),
      title.trim() || 'Texto colado',
      'text',
      { shared },
    )
    return { ok: true, doc }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/**
 * Adds a web page as a source: downloads it, extracts the readable text and
 * stores it like any other document.
 *
 * It is a SNAPSHOT of the moment, not a live link — the page may change later,
 * and what the agent reads remains what was captured. That is what is wanted in a
 * research source (the citation has to keep counting), and it is the
 * opposite of webfetch, which serves precisely to see the current state.
 */
export async function addSessionUrl(
  sessionId: string,
  url: string,
  shared: boolean,
): Promise<{ ok: true; doc: SessionDocument } | { ok: false; error: string }> {
  try {
    const page = await fetchReadablePage(url)
    if (!page.text.trim()) {
      return { ok: false, error: await t('sources.error.noReadableText', { url }) }
    }
    const { doc } = await saveSessionDocument(
      sessionId,
      Buffer.from(page.text, 'utf8'),
      page.title,
      'web',
      { shared, sourceUrl: url },
    )
    return { ok: true, doc }
  } catch (err) {
    return { ok: false, error: `${url}: ${(err as Error).message}` }
  }
}

/**
 * Moves a document between the two scopes — it is the dragging from one area to the
 * other in the Sources tab.
 *
 * The id CHANGES along with the scope (doc5 → src2), because it is the prefix that says where
 * the file lives. In place of the old id a TRACE stays: without it, the citations
 * already written in the conversation — and the attachment chip, which keeps the id — would point
 * to an empty address, and the user's click would stop opening the document
 * with nothing explaining why.
 */
export async function setSessionDocumentShared(
  sessionId: string,
  docId: string,
  shared: boolean,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (!SAFE_ID.test(docId)) return { ok: false, error: await t('sources.error.invalidId') }
  if (isShared(docId) === shared) return { ok: true, id: docId }
  const scopes = await scopesOf(sessionId)
  if (!scopes.folder) {
    return { ok: false, error: await t('sources.error.noFolder') }
  }
  const from = dirForId(scopes, docId)
  const target = shared ? (scopes.folder as string) : scopes.session
  if (!from) return { ok: false, error: await t('sources.error.notFound') }

  const stored = await readStoredAt(from, docId)
  if (!stored) return { ok: false, error: await t('sources.error.notFound') }

  const id = await allocateId(target, shared ? 'src' : 'doc')
  const dir = scopeDir(target)
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(
    path.join(dir, `${id}.json`),
    JSON.stringify({ ...stored, id, shared }),
    'utf8',
  )
  // The original goes along: without it the document would lose sheet_query, the
  // rasterization and the editing while preserving formatting just for having changed area.
  await fsp.rename(path.join(from, `${docId}.bin`), path.join(dir, `${id}.bin`)).catch(() => {})
  // The thumbnail goes along under the NEW id. Leaving it behind would not only waste
  // the rendering — the id is reusable inside the old scope, and the orphan
  // cache would become the cover of another document.
  await fsp
    .rename(path.join(from, `${docId}.thumb.webp`), path.join(dir, `${id}.thumb.webp`))
    .catch(() => {})
  await fsp.rm(path.join(from, `${docId}.json`), { force: true })
  // The old address keeps counting: it is what is written in the citations of the
  // conversation, which are not rewritten on disk.
  await fsp
    .writeFile(
      path.join(from, `${docId}${TRAIL_SUFFIX}`),
      JSON.stringify({ to: id, scope: target }),
      'utf8',
    )
    .catch(() => {})
  notifyDocumentsChanged()
  return { ok: true, id }
}

/** Removes a document from the scope in which it is. */
export async function removeSessionDocument(sessionId: string, docId: string): Promise<boolean> {
  if (!SAFE_ID.test(docId)) return false
  const dir = dirForId(await scopesOf(sessionId), docId)
  if (!dir) return false
  try {
    await fsp.rm(path.join(dir, `${docId}.json`))
  } catch {
    return false
  }
  await fsp.rm(path.join(dir, `${docId}.bin`), { force: true })
  await fsp.rm(path.join(dir, `${docId}.thumb.webp`), { force: true })
  notifyDocumentsChanged()
  return true
}

async function scopeUsage(scope: string | null): Promise<number> {
  if (!scope || !SAFE_SCOPE.test(scope)) return 0
  const dir = scopeDir(scope)
  let total = 0
  try {
    for (const file of await fsp.readdir(dir)) {
      // The thumbnail is a cache we generate, not the user's material: counting it
      // would make a pasted text of 2KB show up as twice what it is.
      if (file.endsWith('.thumb.webp')) continue
      // Nor the folder the draft recorded: it is our marker, not material.
      if (file === DRAFT_FOLDER_FILE) continue
      // Nor the trace of an id that changed area — they are dozens of bytes of
      // our own bookkeeping, and the file is already counted in the destination scope.
      if (file.endsWith(TRAIL_SUFFIX)) continue
      const stat = await fsp.stat(path.join(dir, file)).catch(() => null)
      if (stat?.isFile()) total += stat.size
    }
  } catch {
    return 0
  }
  return total
}

/**
 * Deletes the attachments of a deleted chat — only its OWN scope.
 *
 * Whatever it promoted to a folder source stays: that was declared a corpus
 * and is shared with the other conversations, which cannot lose the research
 * base because one of the participants left.
 */
export async function deleteSessionDocuments(sessionId: string): Promise<void> {
  if (!SAFE_SCOPE.test(sessionId)) return
  await fsp.rm(scopeDir(sessionId), { recursive: true, force: true })
}

/**
 * Deletes the sources of a deleted folder. The chats go back to the root with their
 * own attachments intact, but the folder scope stops being reachable by
 * any of them — keeping the files would be exactly the orphan garbage that
 * this cleanup exists to avoid.
 */
export async function deleteFolderDocuments(folderId: string): Promise<void> {
  if (!SAFE_SCOPE.test(folderId)) return
  await fsp.rm(scopeDir(`folder-${folderId}`), { recursive: true, force: true })
}

/**
 * Warns the windows that the set of sources changed. The Sources tab is the only
 * subscriber: without this, attaching a PDF from the conversation would leave the tab open
 * next to it showing the old list.
 *
 * Emitted straight from here, like artifact:updated in media.ts, to avoid creating
 * an import cycle with the broadcast layer.
 */
function notifyDocumentsChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('documents:changed')
  }
}
