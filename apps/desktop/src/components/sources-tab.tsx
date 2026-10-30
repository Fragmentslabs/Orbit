import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  ArrowDownToLine,
  ArrowUpToLine,
  FileCode2,
  FileSpreadsheet,
  FileText,
  FileType2,
  FolderOpen,
  Globe,
  HardDriveIcon,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  StickyNote,
  Film,
  ImageIcon,
  AudioLines,
  Trash2,
  Upload,
} from "lucide-react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Hint } from "@/components/ui/hint"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { SOURCE_DND_MIME } from "@shared/chat"
import { documentOpensAsFile, mediaMime, MEDIA_DND_MIME, type MaterialView } from "@shared/media"
import { docsApi, documentApi, materialsApi, mediaApi, type SourceDocument } from "@/src/lib/ipc"
import { useSessionStore } from "@/src/stores/session-store"
import { ORPHAN_KEY, usePanelStore } from "@/src/stores/panel-store"
import { cn } from "@/lib/utils"
import { Truncate } from "@/components/ui/truncated-text"

/**
 * Sources tab: the documents one CONVERSES with.
 *
 * It is the other side of the media gallery. There go the outputs of the agent (images,
 * artifacts, generated documents); here go the inputs — and the two life
 * cycles are opposite: deleting an artifact frees space, deleting a source
 * changes the following answers. That is why the bulk deletion and the automatic
 * cleanup of the gallery reach nothing in this list.
 *
 * Two areas, because the difference is one of INTENTION:
 *
 * - "Folder sources" is the declared corpus, valid for all the conversations
 *   of that folder.
 * - "From this conversation" are the attachments you threw into the chat to ask one
 *   thing — which is most of the attachments, and does not become corpus by itself.
 *
 * Nothing flows from the bottom up automatically: a wrong source is silent
 * and changes answers in OTHER conversations, while the extra click is visible on
 * the spot. But the attachment appears here as soon as it arrives, with the button next to it — the
 * problem of a gesture nobody guesses is solved by showing, not
 * by sharing by default. Dragging between the areas does the same, and dropping the
 * file straight into the right area already decides the scope.
 *
 * It counts in both modes. In code the repository already is the corpus of the FILES —
 * `read` and `grep` open PDF, DOCX and spreadsheet from there paginating the same, so a
 * committed document does not need to be declared a source. What is not in the
 * repository is the rest: the doc of a lib, an RFC, the pasted ticket, the spec
 * PDF the client sent and nobody wants to commit. For that material the
 * automatic folder of the project becomes what would be an unversioned `docs/`,
 * available in every conversation of that repository.
 */

// Markdown and plain text enter as a TEXT source (see addSessionDocument):
// they are the most common reading material in a repository, and without them the only
// way to bring a .md was to attach it to a message first.
const ACCEPT =
  ".pdf,.docx,.xlsx,.xls,.ods,.csv,.md,.markdown,.mdx,.txt,image/*,video/*,audio/*,.gif,.mp4,.mov,.m4v,.webm,.mkv,.avi"

/** Internal drag of a MATERIAL (photo, GIF, audio, video) between the areas. */
const DRAG_MIME_MATERIAL = "application/x-orbit-material"

/** Photo, GIF, audio and video are not documents: they follow the path of materials. */
function materialKindOf(file: File): "image" | "audio" | "video" | null {
  const type = file.type.toLowerCase()
  if (type.startsWith("video/") || /\.(mp4|m4v|mov|webm|mkv|avi)$/i.test(file.name)) return "video"
  if (type.startsWith("audio/") || /\.(wav|mp3|m4a|aac|ogg|oga|opus|flac)$/i.test(file.name)) return "audio"
  if (type.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(file.name)) return "image"
  return null
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = String(total % 60).padStart(2, "0")
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`
}

/** Type of internal drag — it distinguishes moving a document between the areas from
 *  a file coming from outside the app. */
const DRAG_MIME = "application/x-orbit-document"

/** Ceiling per file — a barrier against a pathological file, not a usage limit. */
const MAX_FILE_BYTES = 100 * 1024 * 1024
/** A video WITHOUT a file on disk (pasted) only exists as bytes in memory. */
const MAX_PASTED_VIDEO_BYTES = 150 * 1024 * 1024

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const KIND_ICONS = {
  spreadsheet: FileSpreadsheet,
  docx: FileType2,
  pdf: FileText,
  text: StickyNote,
  web: Globe,
} as const

/** Markdown stored as `text` (the path of the attached .md) — it is a document,
 *  not a pasted excerpt, and the icon says so. */
const MARKDOWN_FILE = /\.(md|markdown|mdx)$/i

/** Icon of the TYPE of the source. The `.md` gets its own icon because it is the case in which
 *  the content is text but the file is a document. */
function docIcon(doc: SourceDocument) {
  if (doc.kind === "text" && MARKDOWN_FILE.test(doc.filename)) return FileCode2
  return KIND_ICONS[doc.kind] ?? FileText
}

/**
 * Type of the source as the list shows it.
 *
 * The extension in uppercase when the name has one — it is the label the person
 * recognizes ("PDF", "MD", "XLSX") and that was missing: the row said only
 * "src1 · 12 pages", so a .md next to a .pdf was indistinguishable
 * until opening. Without an extension (pasted text, site) the type word counts.
 */
function sourceType(doc: SourceDocument): string | null {
  // A site has no extension: its "name" is the page title, and a title
  // like "Example.com" would come out labeled "COM". Then the type word counts.
  if (doc.kind === "web") return null
  // A real extension: it starts with a letter. "Sales 2026.1" would end in "1"
  // and the type would appear as a loose number.
  const ext = /\.([a-z][a-z0-9]{0,4})$/i.exec(doc.filename.trim())?.[1]
  return ext ? ext.toUpperCase() : null
}

/**
 * Cover of the document in the list.
 *
 * It loads on demand and starts with the icon: the PDF one is rendered in the main process, and
 * making the list wait for it would leave the tab blank on the first drawing.
 * When there is no thumbnail (failure, or a type with nothing to draw) the icon
 * simply stays — it is the state that existed before this cover.
 */
function DocumentThumb({ scope, doc }: { scope: string; doc: SourceDocument }) {
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setSrc(null)
    void docsApi
      .thumb(scope, doc.id)
      .then((url) => {
        if (alive) setSrc(url)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [scope, doc.id])

  const Icon = docIcon(doc)

  return (
    <div className="relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-sm border border-border/60 bg-background">
      {src ? (
        <>
          <img src={src} alt="" className="size-full object-cover object-top" draggable={false} />
          {/* With a cover, the type still needs to be read — the badge is the same drawing
              as the gallery tile and the video in the material row. */}
          <Icon className="absolute bottom-0.5 right-0.5 size-3 rounded-sm bg-background/85 p-0.5 text-foreground" />
        </>
      ) : (
        <Icon className="size-4 text-muted-foreground" />
      )}
    </div>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}

/** Reads the file as base64 — it is the format the attachment IPC already uses. */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? "")
      // The data URL comes as "data:<mime>;base64,<data>"; the main process only wants the data.
      resolve(result.slice(result.indexOf(",") + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error("failed to read the file"))
    reader.readAsDataURL(file)
  })
}

function DocumentRow({
  doc,
  scope,
  originLabel,
  moveLabel,
  MoveIcon,
  onMove,
  onOpen,
  onRemove,
}: {
  doc: SourceDocument
  scope: string
  originLabel?: string
  moveLabel?: string
  MoveIcon?: typeof ArrowUpToLine
  onMove?: () => void
  onOpen: () => void
  onRemove: () => void
}) {
  const { t, i18n } = useTranslation()
  const unit =
    doc.kind === "spreadsheet"
      ? t("sources.unitSheets", { count: doc.totalPages })
      : doc.kind === "docx"
        ? t("sources.unitBlocks", { count: doc.totalPages })
        : t("sources.unitPages", { count: doc.totalPages })
  const type = sourceType(doc) ?? t(`sources.kind.${doc.kind}`)

  return (
    <li
      draggable
      onDragStart={(e) => {
        // Two destinations in the SAME drag, as in the gallery tile: dropping in
        // the other area moves the source (docs:setShared), dropping in the composer attaches the
        // reference to this message (see SOURCE_DND_MIME). Whoever reads the payload
        // is the destination — the row does not need to know where it is going.
        e.dataTransfer.setData(SOURCE_DND_MIME, JSON.stringify({ id: doc.id, name: doc.filename, kind: doc.kind, type }))
        e.dataTransfer.setData(DRAG_MIME, doc.id)
        e.dataTransfer.effectAllowed = "copyMove"
      }}
      className="group flex cursor-grab items-center gap-2.5 rounded-md px-2 py-2 active:cursor-grabbing hover:bg-accent/50"
    >
      <DocumentThumb scope={scope} doc={doc} />
      {/* The body of the row opens the file; the buttons on the right stay outside it
          so the remove click does not open what is being removed. */}
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") onOpen()
        }}
        className="min-w-0 flex-1 cursor-pointer text-left"
      >
        <Truncate text={doc.filename}>
          <p className="truncate text-xs font-medium text-foreground">{doc.filename}</p>
        </Truncate>
        
          <Truncate>
            <p className="truncate text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground/75">{type}</span>
            {" · "}
            {doc.id} · {unit}
            {doc.sourceUrl ? ` · ${hostOf(doc.sourceUrl)}` : ""}
            {doc.sizeBytes ? ` · ${formatBytes(doc.sizeBytes)}` : ""}
            {" · "}
            {new Date(doc.createdAt).toLocaleDateString(i18n.language, {
              day: "2-digit",
              month: "2-digit",
            })}
            {originLabel ? ` · ${originLabel}` : ""}
            {doc.truncated ? ` · ${t("sources.truncated")}` : ""}
          </p>
          </Truncate>
      </div>
      {onMove && MoveIcon && (
        <Hint label={moveLabel ?? ""}>
          <button
            type="button"
            onClick={onMove}
            className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-accent hover:text-foreground"
          >
            <MoveIcon className="size-3.5" />
          </button>
        </Hint>
      )}
      <Hint label={t("sources.remove")}>
        <button
          type="button"
          onClick={onRemove}
          className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="size-3.5" />
        </button>
      </Hint>
    </li>
  )
}

const MATERIAL_ICON = { image: ImageIcon, audio: AudioLines, video: Film } as const

/**
 * A MATERIAL row: photo, GIF, audio or video. It shows the cover (a frame, in the
 * video), the name, the reference the agent uses and the size. Deleting erases the
 * file for real — it is the same item of the media gallery.
 */
function MaterialRow({
  material,
  moveLabel,
  MoveIcon,
  onMove,
  onOpen,
  onRemove,
}: {
  material: MaterialView
  moveLabel?: string
  MoveIcon?: typeof ArrowUpToLine
  onMove?: () => void
  onOpen: () => void
  onRemove: () => void
}) {
  const { t, i18n } = useTranslation()
  const Icon = MATERIAL_ICON[material.kind]
  return (
    <li
      draggable
      onDragStart={(e) => {
        // The material IS a gallery item, so the drag to the composer is the
        // SAME one as the Media tab: the reference goes as an attachment and nothing is copied.
        // Without this, the material was the only file of the tab that did not become a chip.
        e.dataTransfer.setData(
          MEDIA_DND_MIME,
          JSON.stringify({
            id: material.id,
            name: material.name,
            kind: material.kind,
            mime: mediaMime({ id: material.id, kind: material.kind }),
            url: material.thumbUrl ?? material.playUrl ?? undefined,
          }),
        )
        e.dataTransfer.setData(DRAG_MIME_MATERIAL, material.id)
        e.dataTransfer.effectAllowed = "copyMove"
      }}
      className="group flex cursor-grab items-center gap-2.5 rounded-md px-2 py-2 active:cursor-grabbing hover:bg-accent/50"
    >
      <div className="relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-sm border border-border/60 bg-background">
        {material.thumbUrl ? (
          <img src={material.thumbUrl} alt="" className="size-full object-cover" draggable={false} />
        ) : (
          <Icon className="size-4 text-muted-foreground" />
        )}
        {material.kind === "video" && material.thumbUrl && (
          <Film className="absolute bottom-0.5 right-0.5 size-3 rounded-sm bg-background/80 p-0.5 text-foreground" />
        )}
      </div>
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") onOpen()
        }}
        className="min-w-0 flex-1 cursor-pointer text-left"
      >
        <Truncate text={material.name}>
          <p className="truncate text-xs font-medium text-foreground">{material.name}</p>
        </Truncate>
        <Truncate>
          <p className="truncate text-[11px] text-muted-foreground">
          {material.id} · {t(`media.kind.${material.animated ? "gif" : material.kind}`)}
          {material.durationMs ? ` · ${formatDuration(material.durationMs)}` : ""}
          {material.width && material.height ? ` · ${material.width}×${material.height}` : ""}
          {` · ${formatBytes(material.sizeBytes)}`}
          {" · "}
          {new Date(material.createdAt).toLocaleDateString(i18n.language, { day: "2-digit", month: "2-digit" })}
        </p>
        </Truncate>
      </div>
      {onMove && MoveIcon && (
        <Hint label={moveLabel ?? ""}>
          <button
            type="button"
            onClick={onMove}
            className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-accent hover:text-foreground"
          >
            <MoveIcon className="size-3.5" />
          </button>
        </Hint>
      )}
      <Hint label={t("sources.removeMaterial")}>
        <button
          type="button"
          onClick={onRemove}
          className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="size-3.5" />
        </button>
      </Hint>
    </li>
  )
}

/** The viewer of a material: the enlarged photo/GIF, the video and the audio with controls. */
function MaterialViewer({ material, onClose }: { material: MaterialView | null; onClose: () => void }) {
  if (!material?.playUrl) return null
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl p-2">
        <DialogTitle className="sr-only">{material.name}</DialogTitle>
        {material.kind === "video" ? (
          <video key={material.id} src={material.playUrl} controls autoPlay className="max-h-[76vh] w-full rounded-md bg-black object-contain" />
        ) : material.kind === "audio" ? (
          <div className="flex flex-col gap-2 p-4">
            <Truncate text={material.name}>
              <p className="truncate text-sm font-medium">{material.name}</p>
            </Truncate>
            <audio key={material.id} src={material.playUrl} controls autoPlay className="w-full" />
          </div>
        ) : (
          <img src={material.playUrl} alt={material.name} className="max-h-[76vh] w-full rounded-md object-contain" />
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * Scope of the chat that has not become a session yet. It needs to match the DRAFT_SCOPE
 * of the main process: it is the same folder on disk, and the draft is adopted by the session on the
 * first message.
 */
const DRAFT_SCOPE = "draft"

export function SourcesTab({ sessionId }: { sessionId?: string }) {
  // With no session yet (new chat): the sources go to the draft scope, in-
  // stead of the tab staying inert asking the user to send a message before
  // being able to bring the material.
  const scope = sessionId ?? DRAFT_SCOPE
  const isDraft = !sessionId
  const { t } = useTranslation()
  const [shared, setShared] = useState<SourceDocument[]>([])
  const [own, setOwn] = useState<SourceDocument[]>([])
  const [sharedMaterials, setSharedMaterials] = useState<MaterialView[]>([])
  const [ownMaterials, setOwnMaterials] = useState<MaterialView[]>([])
  const [materialBytes, setMaterialBytes] = useState(0)
  const [viewing, setViewing] = useState<MaterialView | null>(null)
  const [folderId, setFolderId] = useState<string | null>(null)
  const [usage, setUsage] = useState(0)
  const [busy, setBusy] = useState(false)
  const [dropZone, setDropZone] = useState<"shared" | "own" | null>(null)
  const [dialog, setDialog] = useState<{ kind: "text" | "web"; shared: boolean } | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const sharedInput = useRef<HTMLInputElement>(null)
  const ownInput = useRef<HTMLInputElement>(null)

  const openSourceTab = usePanelStore((s) => s.openSourceTab)

  /**
   * Clicking a source opens what it IS.
   *
   * A source promoted from an agent document keeps being
   * that document: it has to open in the canvas, with the edit toggle,
   * as when one clicks it in the chat. Opening the file viewer there
   * showed a paginated Markdown as if it were a PDF. What decides is
   * openDocumentInPanel, the same point the gallery and the conversation card
   * use — and it knows how to send back to the viewer the document that was
   * requested as a file.
   *
   * In the NEW CHAT there is no session yet, and that is precisely where the source is opened most
   * — the material is brought before the first question. The tab falls into the orphan
   * bucket, the same as the other draft ones, and the main process resolves the draft
   * scope from the empty sessionId (see scopesOf in session-documents).
   */
  const openSource = useCallback(
    async (doc: SourceDocument) => {
      const key = sessionId ?? ORPHAN_KEY
      const origin = await documentApi.forSource(doc.id)
      if (origin) {
        const info = await documentApi.info(origin.documentId)
        // Same decision as openDocumentInPanel — living document in the canvas,
        // document requested as a file in the viewer —, but the path of the
        // file keeps being the SOURCE, whose id is at hand here. Sending the
        // document id would be depending on a resolution this screen does not
        // need to do.
        if (info && !documentOpensAsFile(info)) {
          usePanelStore
            .getState()
            .openDocumentTab(key, { documentId: origin.documentId, title: origin.title })
          return
        }
      }
      openSourceTab(key, { docId: doc.id, page: 1, title: doc.filename })
    },
    [sessionId, openSourceTab],
  )
  const folders = useSessionStore((s) => s.folders)
  const sessions = useSessionStore((s) => s.sessions)
  // The folder the new chat is going to inherit, chosen in the sidebar "+". It only
  // matters in the draft: after the session is born, the folder comes from it.
  const pendingFolderId = useSessionStore((s) => s.pendingFolderId)
  const folderName = useMemo(
    () => folders.find((f) => f.id === folderId)?.name ?? null,
    [folders, folderId],
  )

  const refresh = useCallback(async () => {
    // The draft has no session to read the folder from: it notes it down before
    // listing, otherwise the shared area would come out empty in a chat opened through the
    // "+" of a folder — precisely where it should appear the most.
    if (isDraft) await docsApi.setDraftFolder(pendingFolderId)
    const [result, materials] = await Promise.all([docsApi.list(scope), materialsApi.list(scope)])
    setShared(result.shared)
    setOwn(result.own)
    setFolderId(result.folderId)
    setUsage(result.usage)
    setSharedMaterials(materials.shared)
    setOwnMaterials(materials.own)
    setMaterialBytes(materials.bytes)
  }, [scope, isDraft, pendingFolderId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // The attachment also arrives through the conversation (and from another chat of the same folder): without
  // this notice, the tab open alongside would show the previous list.
  useEffect(() => docsApi.onChanged(() => void refresh()), [refresh])
  // A material is a gallery item: deleted from there (or brought by a message),
  // the list of this tab changes along.
  useEffect(() => mediaApi.onChanged(() => void refresh()), [refresh])

  const addFiles = useCallback(
    async (files: File[], toShared: boolean) => {
      if (files.length === 0) return
      setBusy(true)
      setErrors([])
      const payload: { filename: string; data: string }[] = []
      const materials: { filename: string; mime: string; data?: string; path?: string }[] = []
      const failed: string[] = []
      for (const file of files) {
        const materialKind = materialKindOf(file)
        if (materialKind) {
          try {
            // A file video goes BY PATH: the main process copies it, and the film never
            // goes whole through the renderer memory.
            const diskPath = materialKind === "video" ? window.getPathForFile?.(file) || undefined : undefined
            if (materialKind === "video" && !diskPath && file.size > MAX_PASTED_VIDEO_BYTES) {
              failed.push(t("attachments.errorPastedVideo", { name: file.name }))
              continue
            }
            materials.push({
              filename: file.name,
              mime: file.type,
              ...(diskPath ? { path: diskPath } : { data: await readAsBase64(file) }),
            })
          } catch (err) {
            failed.push(`${file.name}: ${(err as Error).message}`)
          }
          continue
        }
        if (file.size > MAX_FILE_BYTES) {
          failed.push(t("sources.tooBig", { name: file.name, size: formatBytes(MAX_FILE_BYTES) }))
          continue
        }
        try {
          payload.push({ filename: file.name, data: await readAsBase64(file) })
        } catch (err) {
          failed.push(`${file.name}: ${(err as Error).message}`)
        }
      }
      if (payload.length > 0) {
        const result = await docsApi.add(scope, payload, toShared)
        failed.push(...result.errors)
      }
      if (materials.length > 0) {
        const result = await materialsApi.add(scope, materials, toShared)
        failed.push(...result.errors)
      }
      setErrors(failed)
      setBusy(false)
      await refresh()
    },
    [scope, refresh, t],
  )

  const addText = useCallback(
    async (title: string, text: string, shared: boolean) => {
      setBusy(true)
      const result = await docsApi.addText(scope, title, text, shared)
      setErrors(result.ok ? [] : [result.error])
      setBusy(false)
      await refresh()
    },
    [scope, refresh],
  )

  const addUrl = useCallback(
    async (url: string, shared: boolean) => {
      setBusy(true)
      const result = await docsApi.addUrl(scope, url, shared)
      setErrors(result.ok ? [] : [result.error])
      setBusy(false)
      await refresh()
    },
    [scope, refresh],
  )

  const move = useCallback(
    async (docId: string, toShared: boolean) => {
      const result = await docsApi.setShared(scope, docId, toShared)
      setErrors(result.ok ? [] : [result.error])
      await refresh()
    },
    [scope, refresh],
  )

  const remove = useCallback(
    async (docId: string) => {
      await docsApi.remove(scope, docId)
      await refresh()
    },
    [scope, refresh],
  )

  const moveMaterial = useCallback(
    async (id: string, toShared: boolean) => {
      const result = await materialsApi.setShared(scope, id, toShared)
      setErrors(result.ok ? [] : [result.error])
      await refresh()
    },
    [scope, refresh],
  )

  /** Deleting a material erases the FILE (it is the gallery item): it frees the space. */
  const removeMaterial = useCallback(
    async (id: string) => {
      await mediaApi.remove([id])
      await refresh()
    },
    [refresh],
  )

  /** Dropping in the area decides the scope: a file from outside enters there, a document
   *  dragged from the other area changes side. */
  const handleDrop = useCallback(
    (e: React.DragEvent, toShared: boolean) => {
      e.preventDefault()
      setDropZone(null)
      const draggedMaterial = e.dataTransfer.getData(DRAG_MIME_MATERIAL)
      if (draggedMaterial) {
        void moveMaterial(draggedMaterial, toShared)
        return
      }
      const dragged = e.dataTransfer.getData(DRAG_MIME)
      if (dragged) {
        void move(dragged, toShared)
        return
      }
      void addFiles(Array.from(e.dataTransfer.files), toShared)
    },
    [addFiles, move, moveMaterial],
  )

  const section = (
    kind: "shared" | "own",
    title: string,
    hint: string,
    docs: SourceDocument[],
    materials: MaterialView[],
    input: React.RefObject<HTMLInputElement>,
  ) => {
    const isShared = kind === "shared"
    return (
      <section
        onDragOver={(e) => {
          e.preventDefault()
          setDropZone(kind)
        }}
        onDragLeave={() => setDropZone((z) => (z === kind ? null : z))}
        onDrop={(e) => handleDrop(e, isShared)}
        className={cn(
          "flex flex-col rounded-lg border border-transparent px-2 py-2 transition-colors",
          dropZone === kind && "border-dashed border-primary/60 bg-primary/5",
        )}
      >
        <div className="flex items-center gap-2 px-1 pb-1">
          <p className="flex flex-1 items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {isShared ? <FolderOpen className="size-3" /> : <MessageSquare className="size-3" />}
            {title}
          </p>
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={busy}
              className="flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-60"
            >
              {busy ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
              {t("sources.add")}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => input.current?.click()}>
                <Upload className="size-3.5" />
                {t("sources.addFile")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setDialog({ kind: "text", shared: isShared })}>
                <StickyNote className="size-3.5" />
                {t("sources.addText")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setDialog({ kind: "web", shared: isShared })}>
                <Globe className="size-3.5" />
                {t("sources.addSite")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          multiple
          className="hidden"
          onChange={(e) => {
            void addFiles(Array.from(e.target.files ?? []), isShared)
            e.target.value = ""
          }}
        />
        {docs.length + materials.length === 0 ? (
          <p className="px-1 py-2 text-[11px] text-muted-foreground/80">{hint}</p>
        ) : (
          <ul className="flex flex-col">
            {docs.map((doc) => (
              <DocumentRow
                key={doc.id}
                doc={doc}
                scope={scope}
                originLabel={
                  isShared && doc.sessionId !== sessionId
                    ? sessions.find((s) => s.id === doc.sessionId)?.title
                    : undefined
                }
                moveLabel={isShared ? t("sources.unshare") : t("sources.share")}
                MoveIcon={isShared ? ArrowDownToLine : ArrowUpToLine}
                onMove={folderId ? () => void move(doc.id, !isShared) : undefined}
                onOpen={() => void openSource(doc)}
                onRemove={() => void remove(doc.id)}
              />
            ))}
            {materials.map((material) => (
              <MaterialRow
                key={material.id}
                material={material}
                moveLabel={isShared ? t("sources.unshare") : t("sources.share")}
                MoveIcon={isShared ? ArrowDownToLine : ArrowUpToLine}
                onMove={folderId ? () => void moveMaterial(material.id, !isShared) : undefined}
                onOpen={() => setViewing(material)}
                onRemove={() => void removeMaterial(material.id)}
              />
            ))}
          </ul>
        )}
      </section>
    )
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
        <p className="flex-1 text-sm font-medium text-foreground">{t("sources.title")}</p>
        <Hint label={t("sources.refresh")}>
          <button
            type="button"
            onClick={() => void refresh()}
            className="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <RefreshCw className="size-3.5" />
          </button>
        </Hint>
      </div>

      {errors.length > 0 && (
        <div className="border-b border-border/60 bg-destructive/10 px-4 py-2 text-[11px] text-destructive">
          {errors.map((error) => (
            <p key={error}>{error}</p>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-2">
        {/*
          No loading state: the list arrives in milliseconds and swapping it
          for a spinner makes it DISAPPEAR and come back on every reload — and the tab reloads
          by itself when an attachment arrives. While there is no answer yet, what
          appears is the empty one, which is what the tab shows even when there is no source.
        */}
        {(
          <div className="flex flex-col gap-1">
            {folderName &&
              section(
                "shared",
                t("sources.sharedTitle", { folder: folderName }),
                t("sources.sharedHint"),
                shared,
                sharedMaterials,
                sharedInput,
              )}
            {section(
              "own",
              isDraft ? t("sources.draftTitle") : t("sources.ownTitle"),
              isDraft ? t("sources.draftHint") : t("sources.ownHint"),
              own,
              ownMaterials,
              ownInput,
            )}
            {!folderName && !isDraft && (
              <p className="px-3 py-2 text-[11px] text-muted-foreground/80">
                {t("sources.noFolderHint")}
              </p>
            )}
          </div>
        )}
      </div>

      {shared.length + own.length + sharedMaterials.length + ownMaterials.length > 0 && (
        <div className="flex items-center gap-1.5 border-t border-border/60 px-4 py-2 text-[11px] text-muted-foreground">
          <HardDriveIcon className="size-3" />
          {t("sources.usage", {
            count: shared.length + own.length + sharedMaterials.length + ownMaterials.length,
            size: formatBytes(usage + materialBytes),
          })}
        </div>
      )}

      <MaterialViewer material={viewing} onClose={() => setViewing(null)} />

      <AddSourceDialog
        request={dialog}
        busy={busy}
        onClose={() => setDialog(null)}
        onSubmitText={(title, text, toShared) => void addText(title, text, toShared)}
        onSubmitUrl={(url, toShared) => void addUrl(url, toShared)}
      />
    </div>
  )
}

/**
 * Paste an excerpt or point at an address — the two sources that do not come from
 * a file. The same dialog serves both because the difference is only the field; the
 * destination (folder or conversation) already came decided from where the menu was opened.
 */
function AddSourceDialog({
  request,
  busy,
  onClose,
  onSubmitText,
  onSubmitUrl,
}: {
  request: { kind: "text" | "web"; shared: boolean } | null
  busy: boolean
  onClose: () => void
  onSubmitText: (title: string, text: string, shared: boolean) => void
  onSubmitUrl: (url: string, shared: boolean) => void
}) {
  const { t } = useTranslation()
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")

  // Clears on opening: the dialog is reused between the two types and between the
  // two areas, and reappearing with the previous text would be confusing.
  useEffect(() => {
    if (request) {
      setTitle("")
      setBody("")
    }
  }, [request])

  if (!request) return null
  const isText = request.kind === "text"
  const canSubmit = isText ? body.trim().length > 0 : body.trim().length > 0

  const submit = () => {
    if (!canSubmit || busy) return
    if (isText) onSubmitText(title, body, request.shared)
    else onSubmitUrl(body.trim(), request.shared)
    onClose()
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogTitle>{isText ? t("sources.addText") : t("sources.addSite")}</DialogTitle>
        <div className="flex flex-col gap-3">
          {isText && (
            <Input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("sources.textTitlePlaceholder")}
            />
          )}
          {isText ? (
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={t("sources.textPlaceholder")}
              className="min-h-40 resize-none"
            />
          ) : (
            <Input
              autoFocus
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit()
              }}
              placeholder="https://"
            />
          )}
          <p className="text-[11px] text-muted-foreground">
            {isText ? t("sources.textHint") : t("sources.siteHint")}
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="cursor-pointer rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              disabled={!canSubmit || busy}
              onClick={submit}
              className="flex cursor-pointer items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              {busy && <Loader2 className="size-3 animate-spin" />}
              {t("sources.add")}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
