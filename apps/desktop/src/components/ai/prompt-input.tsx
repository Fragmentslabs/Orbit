import { SOURCE_DND_MIME, type ChatStatus } from "@shared/chat"
import { MEDIA_DND_MIME } from "@shared/media"
import type { FileUIPart } from "ai"
import { useTranslation } from "react-i18next"
import {
  CornerDownLeftIcon,
  FileTextIcon,
  ImageIcon,
  Loader2Icon,
  MicIcon,
  PaperclipIcon,
  PlusIcon,
  SquareIcon,
  XIcon,
} from "lucide-react"
import { nanoid } from "nanoid"
import {
  type ChangeEvent,
  type ChangeEventHandler,
  Children,
  type ClipboardEventHandler,
  type ComponentProps,
  createContext,
  type FormEvent,
  type FormEventHandler,
  Fragment,
  type HTMLAttributes,
  isValidElement,
  type KeyboardEventHandler,
  type MutableRefObject,
  type PropsWithChildren,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { Button } from "@/components/ui/button"
import { ImageLightbox } from "@/src/components/ai/image"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import i18n from "@/src/i18n"
import { historyKeyInput, type HistoryInput } from "@/src/lib/input-history"
import { nextArmedField } from "@/src/lib/template-fields"
import {
  MAX_PASTED_VIDEO_BYTES,
  blobUrlsToDataUrls,
  isLargeMediaType,
  rememberAttachmentPath,
} from "@/src/lib/message-utils"
import { Truncate } from "@/components/ui/truncated-text"

// ============================================================================
// Provider Context & Types
// ============================================================================

/**
 * A composer attachment. Same as FileUIPart + id, with `mediaId` for the attachment
 * that is a REFERENCE to the gallery (dragged from the Media tab): in that case `url` is only
 * the preview and the bytes never go through the renderer.
 */
export type PromptInputFile = FileUIPart & {
  id: string
  mediaId?: string
  /** Conversation source attached by reference (dragged from the Sources tab) —
   *  see FilePart.sourceId. `url` stays empty: there are no bytes to load. */
  sourceId?: string
  /**
   * Source text when the attachment was born from a large PASTE (see
   * PASTE_AS_SOURCE_CHARS). Lives only in the composer, for the hover preview: the
   * message carries the file, not this field (toFileParts does not pass it on).
   */
  pastedText?: string
}

/**
 * From here on, text pasted into the field becomes an ATTACHMENT instead of entering the text.
 *
 * A paste of that size is material, not a sentence: as an attachment it becomes a source of the
 * conversation on send — the main process stores the text and the message carries only the opening
 * excerpt (see preprocessAttachment) —, instead of staying in the history being
 * resent to the model on every turn. The cut is low enough to catch a
 * pasted document and high enough not to turn three lines into an
 * attachment.
 */
export const PASTE_AS_SOURCE_CHARS = 1500

/** How much of the text appears in the hover preview (the rest is in the source). */
const PASTED_PREVIEW_CHARS = 1200

/** Source text of each synthetic paste file, by the `File` itself. */
const pastedTexts = new WeakMap<File, string>()

/** "1,4 KB" — for the attachment name (the size in BYTES, not in characters:
 *  a text in Portuguese takes more bytes than the letter count suggests). */
function pastedSize(text: string): string {
  const bytes = new TextEncoder().encode(text).length
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  return `${kb.toLocaleString(i18n.language, { maximumFractionDigits: kb < 10 ? 1 : 0 })} KB`
}

/** The `File` that represents a pasted text — the name becomes the title of the source.
 *  `.txt` on purpose: `.md` falls into the engine's skill path (frontmatter),
 *  and a pasted text is not a skill. */
function pastedTextFile(text: string): File {
  return new File([text], i18n.t("attachments.pastedTextName", { size: pastedSize(text) }), {
    type: "text/plain",
  })
}

/** A composer attachment from a chosen, dragged or pasted file. */
function fileAttachment(file: File): PromptInputFile {
  const pasted = pastedTexts.get(file)
  return {
    id: nanoid(),
    type: "file" as const,
    url: objectUrlFor(file),
    mediaType: file.type,
    filename: file.name,
    ...(pasted !== undefined ? { pastedText: pasted } : {}),
  }
}

/**
 * Does the drag bring something this composer knows how to receive? File from disk, item
 * from the gallery (Media tab) or conversation source (Sources tab) — each one by its own
 * MIME. It is what decides the preventDefault of dragover: without it the browser treats
 * the drop as text and the handler never runs.
 */
function isAttachmentDrag(types: readonly string[] | undefined): boolean {
  return (
    !!types?.includes("Files") ||
    !!types?.includes(MEDIA_DND_MIME) ||
    !!types?.includes(SOURCE_DND_MIME)
  )
}

/** What the Media tab tile sends on drop — the identity of the item, never bytes. */
export interface MediaAttachmentRef {
  id: string
  name?: string
  mime?: string
  /** Preview URL (thumbnail) of the item in the gallery. */
  url?: string
}

/**
 * What the Sources tab row sends on drop: the identity of a conversation
 * source (`doc1`, `src2`). It is the same principle as MediaAttachmentRef — no
 * bytes —, but the destination is another: the source is already stored and is reached
 * by the id, and that is what the agent receives.
 */
export interface SourceAttachmentRef {
  id: string
  name?: string
  kind?: string
  /** Short label of the type ("PDF", "MD") for the chip. */
  type?: string
}

export interface AttachmentsContext {
  files: PromptInputFile[]
  add: (files: File[] | FileList) => void
  /** Attaches a gallery item BY REFERENCE — no File and no copying bytes. */
  addMedia: (ref: MediaAttachmentRef) => void
  /** Attaches a conversation SOURCE by reference (dragged from the Sources tab). */
  addSource: (ref: SourceAttachmentRef) => void
  remove: (id: string) => void
  clear: () => void
  openFileDialog: () => void
  fileInputRef: RefObject<HTMLInputElement | null>
}

export interface TextInputContext {
  value: string
  setInput: (v: string) => void
  clear: () => void
}

export interface PromptInputControllerProps {
  textInput: TextInputContext
  attachments: AttachmentsContext
  /** The message field, for focusing and selecting from outside it. */
  textareaRef: MutableRefObject<HTMLTextAreaElement | null>
  /** INTERNAL: Allows PromptInput to register its file textInput + "open" callback */
  __registerFileInput: (ref: RefObject<HTMLInputElement | null>, open: () => void) => void
}

const PromptInputController = createContext<PromptInputControllerProps | null>(null)
const ProviderAttachmentsContext = createContext<AttachmentsContext | null>(null)

export const usePromptInputController = () => {
  const ctx = useContext(PromptInputController)
  if (!ctx) {
    throw new Error(
      "Wrap your component inside <PromptInputProvider> to use usePromptInputController().",
    )
  }
  return ctx
}

// Optional variants (do NOT throw). Useful for dual-mode components.
const useOptionalPromptInputController = () => useContext(PromptInputController)

export const useProviderAttachments = () => {
  const ctx = useContext(ProviderAttachmentsContext)
  if (!ctx) {
    throw new Error(
      "Wrap your component inside <PromptInputProvider> to use useProviderAttachments().",
    )
  }
  return ctx
}

const useOptionalProviderAttachments = () => useContext(ProviderAttachmentsContext)

export type PromptInputProviderProps = PropsWithChildren<{
  initialInput?: string
}>

/**
 * Optional global provider that lifts PromptInput state outside of PromptInput.
 * If you don't use it, PromptInput stays fully self-managed.
 */
/**
 * Blob URL of an attachment, keeping the file path on disk when it exists.
 * A file video goes to the main process BY PATH (see blobUrlsToDataUrls): that is
 * what avoids turning a film into base64 inside the renderer.
 */
function objectUrlFor(file: File): string {
  const url = URL.createObjectURL(file)
  if (isLargeMediaType(file.type, file.name)) {
    try {
      rememberAttachmentPath(url, window.getPathForFile?.(file) ?? "")
    } catch {
      // no path (pasted file): falls into the size limit of readableAttachments
    }
  }
  return url
}

/**
 * A video WITHOUT a path (pasted from the clipboard) only exists as bytes, and
 * bytes become base64 in the renderer's memory — above a limit that brings the
 * app down. Those are refused with a warning; the file ones go by path.
 */
function readableAttachments(files: File[]): File[] {
  const kept: File[] = []
  for (const file of files) {
    if (isLargeMediaType(file.type, file.name) && file.size > MAX_PASTED_VIDEO_BYTES) {
      let path = ""
      try {
        path = window.getPathForFile?.(file) ?? ""
      } catch {
        path = ""
      }
      if (!path) {
        window.alert(i18n.t("attachments.errorPastedVideo", { name: file.name }))
        continue
      }
    }
    kept.push(file)
  }
  return kept
}

export function PromptInputProvider({
  initialInput: initialTextInput = "",
  children,
}: PromptInputProviderProps) {
  // ----- textInput state
  const [textInput, setTextInput] = useState(initialTextInput)
  const clearInput = useCallback(() => setTextInput(""), [])

  // ----- attachments state (global when wrapped)
  const [attachmentFiles, setAttachmentFiles] = useState<PromptInputFile[]>([])
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const openRef = useRef<() => void>(() => {})
  // The field of this provider, so whoever puts a template in the input (DraftInputBridge) can
  // select its first [field] without hunting the textarea in the page.
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  const add = useCallback((files: File[] | FileList) => {
    const incoming = readableAttachments(Array.from(files))
    if (incoming.length === 0) {
      return
    }

    setAttachmentFiles(prev => prev.concat(incoming.map(fileAttachment)))
  }, [])

  const addMedia = useCallback((ref: MediaAttachmentRef) => {
    if (!ref.id) {
      return
    }
    setAttachmentFiles(prev => prev.concat({
      id: nanoid(),
      type: "file" as const,
      url: ref.url ?? "",
      mediaType: ref.mime ?? "",
      filename: ref.name,
      mediaId: ref.id,
    }))
  }, [])

  const addSource = useCallback((ref: SourceAttachmentRef) => {
    if (!ref.id) {
      return
    }
    setAttachmentFiles(prev => prev.concat({
      id: nanoid(),
      type: "file" as const,
      // No bytes: an empty `url` is what tells the main process "this is a reference"
      // (see FilePart.sourceId) — the content is already stored in the conversation.
      url: "",
      mediaType: "",
      filename: ref.name ?? ref.id,
      sourceId: ref.id,
    }))
  }, [])

  const remove = useCallback((id: string) => {
    setAttachmentFiles(prev => {
      const found = prev.find(f => f.id === id)
      if (found?.url) {
        URL.revokeObjectURL(found.url)
      }
      return prev.filter(f => f.id !== id)
    })
  }, [])

  const clear = useCallback(() => {
    setAttachmentFiles(prev => {
      for (const f of prev) {
        if (f.url) {
          URL.revokeObjectURL(f.url)
        }
      }
      return []
    })
  }, [])

  // Keep a ref to attachments for cleanup on unmount (avoids stale closure)
  const attachmentsRef = useRef(attachmentFiles)
  attachmentsRef.current = attachmentFiles

  // Cleanup blob URLs on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      for (const f of attachmentsRef.current) {
        if (f.url) {
          URL.revokeObjectURL(f.url)
        }
      }
    }
  }, [])

  const openFileDialog = useCallback(() => {
    openRef.current?.()
  }, [])

  const attachments = useMemo<AttachmentsContext>(
    () => ({
      files: attachmentFiles,
      add,
      addMedia,
      addSource,
      remove,
      clear,
      openFileDialog,
      fileInputRef,
    }),
    [attachmentFiles, add, addMedia, addSource, remove, clear, openFileDialog],
  )

  const __registerFileInput = useCallback(
    (ref: RefObject<HTMLInputElement | null>, open: () => void) => {
      fileInputRef.current = ref.current
      openRef.current = open
    },
    [],
  )

  const controller = useMemo<PromptInputControllerProps>(
    () => ({
      textInput: {
        value: textInput,
        setInput: setTextInput,
        clear: clearInput,
      },
      attachments,
      textareaRef,
      __registerFileInput,
    }),
    [textInput, clearInput, attachments, __registerFileInput],
  )

  return (
    <PromptInputController.Provider value={controller}>
      <ProviderAttachmentsContext.Provider value={attachments}>
        {children}
      </ProviderAttachmentsContext.Provider>
    </PromptInputController.Provider>
  )
}

// ============================================================================
// Component Context & Hooks
// ============================================================================

const LocalAttachmentsContext = createContext<AttachmentsContext | null>(null)

export const usePromptInputAttachments = () => {
  // Dual-mode: prefer provider if present, otherwise use local
  const provider = useOptionalProviderAttachments()
  const local = useContext(LocalAttachmentsContext)
  const context = provider ?? local
  if (!context) {
    throw new Error(
      "usePromptInputAttachments must be used within a PromptInput or PromptInputProvider",
    )
  }
  return context
}

export type PromptInputAttachmentProps = HTMLAttributes<HTMLDivElement> & {
  data: PromptInputFile
  className?: string
}

export function PromptInputAttachment({ data, className, ...props }: PromptInputAttachmentProps) {
  const attachments = usePromptInputAttachments()
  const { t } = useTranslation()
  const [lightboxOpen, setLightboxOpen] = useState(false)

  const filename = data.filename || ""

  const mediaType = data.mediaType?.startsWith("image/") && data.url ? "image" : "file"
  const isImage = mediaType === "image"

  const attachmentLabel = filename || (isImage ? t("attachments.image") : t("attachments.file"))

  return (
    <>
      <PromptInputHoverCard>
        <HoverCardTrigger render={
          <div className={cn(
                          // max-w: the chip grows with the file name, and a long
                          // name (a pasted text, a downloaded PDF) became a
                          // bar crossing the composer. With the ceiling, the
                          // label's `truncate` finally has somewhere to cut.
                          "group relative flex h-8 max-w-64 cursor-pointer select-none items-center gap-1.5 rounded-md border border-border px-1.5 font-medium text-sm transition-all hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
                          className,
                        )} key={data.id} {...props} onClick={(e) => { props.onClick?.(e); if (isImage) setLightboxOpen(true) }} />}><div className="relative size-5 shrink-0">
                          <div className="absolute inset-0 flex size-5 items-center justify-center overflow-hidden rounded bg-background transition-opacity group-hover:opacity-0">
                            {isImage ? (
                              <img
                                alt={filename || t("attachments.attachment")}
                                className="size-5 object-cover"
                                height={20}
                                src={data.url}
                                width={20}
                              />
                            ) : data.pastedText !== undefined || data.sourceId ? (
                              // Conversation source: document icon, as in the
                              // pasted text — the chip carries no bytes, what
                              // is seen is the NAME of the cited document.
                              <div className="flex size-5 items-center justify-center text-muted-foreground">
                                <FileTextIcon className="size-3" />
                              </div>
                          ) : (
                            <div className="flex size-5 items-center justify-center text-muted-foreground">
                              <PaperclipIcon className="size-3" />
                            </div>
                          )}
                        </div>
                        <Button
                          aria-label={t("attachments.remove")}
                          className="pointer-events-none absolute inset-0 size-5 cursor-pointer rounded p-0 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 [&>svg]:size-2.5"
                          onClick={e => {
                            e.stopPropagation()
                            attachments.remove(data.id)
                          }}
                          type="button"
                          variant="ghost"
                        >
                          <XIcon />
                          <span className="sr-only">{t("attachments.remove")}</span>
                        </Button>
                      </div><Truncate text={attachmentLabel}>
                        <span className="flex-1 truncate">{attachmentLabel}</span>
                      </Truncate></HoverCardTrigger>
      {/* `w-auto` with no ceiling + title with `truncate`: the title is nowrap, so the
          card grew to the width of the whole name (and the preview, of fixed
          width, stayed small inside it). With max-w, the truncate cuts. */}
      <PromptInputHoverCardContent className="w-auto max-w-80 p-2">
        <div className="w-auto space-y-3">
          {isImage && (
            <div className="flex max-h-36 w-36 items-center justify-center overflow-hidden rounded-md border">
              <img
                alt={filename || t("attachments.preview")}
                className="max-h-full max-w-full object-contain"
                height={144}
                src={data.url}
                width={144}
              />
            </div>
          )}
          <div className="flex items-center gap-2.5">
            <div className="min-w-0 flex-1 space-y-1 px-0.5">
              <h4 className="truncate font-semibold text-sm leading-none">
                {filename || (isImage ? t("attachments.image") : t("attachments.file"))}
              </h4>
              {data.mediaType && (
                <Truncate text={data.mediaType}>
                  <p className="truncate font-mono text-muted-foreground text-xs">{data.mediaType}</p>
                </Truncate>
              )}
            </div>
          </div>
          {/* Large paste: the chip keeps the text, and the hover shows the beginning —
              the rest stays in the source, after sending. */}
          {data.pastedText !== undefined && (
            <pre className="max-h-40 w-72 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-background p-2 font-mono text-[11px] leading-snug text-muted-foreground">
              {data.pastedText.slice(0, PASTED_PREVIEW_CHARS)}
            </pre>
          )}
        </div>
      </PromptInputHoverCardContent>
      </PromptInputHoverCard>
      {isImage && data.url && (
        <ImageLightbox src={data.url} alt={filename} open={lightboxOpen} onOpenChange={setLightboxOpen} />
      )}
    </>
  )
}

export type PromptInputAttachmentsProps = Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  children: (attachment: PromptInputFile) => ReactNode
  /** Element that enters the SAME line as the badges, before them (e.g. the badge of the
   *  quoted reply). */
  leading?: ReactNode
}

export function PromptInputAttachments({
  children,
  className,
  leading,
  ...props
}: PromptInputAttachmentsProps) {
  const attachments = usePromptInputAttachments()

  // The row exists if there is an attachment OR something that travels with them (the badge of the
  // quoted reply, for example): without that, replying with no attachment at all
  // would hide the pending quote.
  if (!attachments.files.length && !leading) {
    return null
  }

  return (
    <div className={cn("flex flex-wrap items-center gap-2 p-3 w-full", className)} {...props}>
      {leading}
      {attachments.files.map(file => (
        <Fragment key={file.id}>{children(file)}</Fragment>
      ))}
    </div>
  )
}

export type PromptInputActionAddAttachmentsProps = ComponentProps<typeof DropdownMenuItem> & {
  label?: string
}

export const PromptInputActionAddAttachments = ({
  label,
  ...props
}: PromptInputActionAddAttachmentsProps) => {
  const attachments = usePromptInputAttachments()
  const { t } = useTranslation()

  return (
    <DropdownMenuItem
      {...props}
      onClick={() => {
        attachments.openFileDialog()
      }}
    >
      <ImageIcon className="mr-2 size-4" /> {label ?? t("input.attachFiles")}
    </DropdownMenuItem>
  )
}

export interface PromptInputMessage {
  text: string
  files: FileUIPart[]
}

export type PromptInputProps = Omit<HTMLAttributes<HTMLFormElement>, "onSubmit" | "onError"> & {
  accept?: string // e.g., "image/*" or leave undefined for any
  multiple?: boolean
  // When true, accepts drops anywhere on document. Default false (opt-in).
  globalDrop?: boolean
  // Render a hidden input with given name and keep it in sync for native form posts. Default false.
  syncHiddenInput?: boolean
  // Minimal constraints
  maxFiles?: number
  maxFileSize?: number // bytes
  onError?: (err: { code: "max_files" | "max_file_size" | "accept"; message: string }) => void
  onSubmit: (message: PromptInputMessage, event: FormEvent<HTMLFormElement>) => void | Promise<void>
}

export const PromptInput = ({
  className,
  accept,
  multiple,
  globalDrop,
  syncHiddenInput,
  maxFiles,
  maxFileSize,
  onError,
  onSubmit,
  children,
  ...props
}: PromptInputProps) => {
  // Declared at the top of the body: the callbacks below use `t` and need to
  // cite it in their own deps (at the end of the body that would fall into the TDZ).
  const { t } = useTranslation()
  // Try to use a provider controller if present
  const controller = useOptionalPromptInputController()
  const usingProvider = !!controller

  // Refs
  const inputRef = useRef<HTMLInputElement | null>(null)
  const formRef = useRef<HTMLFormElement | null>(null)

  // ----- Local attachments (only used when no provider)
  const [items, setItems] = useState<PromptInputFile[]>([])
  const files = usingProvider ? controller.attachments.files : items

  // Keep a ref to files for cleanup on unmount (avoids stale closure)
  const filesRef = useRef(files)
  filesRef.current = files

  const openFileDialogLocal = useCallback(() => {
    inputRef.current?.click()
  }, [])

  const matchesAccept = useCallback(
    (f: File) => {
      if (!accept || accept.trim() === "") {
        return true
      }

      const patterns = accept
        .split(",")
        .map(s => s.trim())
        .filter(Boolean)

      return patterns.some(pattern => {
        if (pattern.endsWith("/*")) {
          const prefix = pattern.slice(0, -1) // e.g: image/* -> image/
          return f.type.startsWith(prefix)
        }
        return f.type === pattern
      })
    },
    [accept],
  )

  const addLocal = useCallback(
    (fileList: File[] | FileList) => {
      const incoming = Array.from(fileList)
      const accepted = incoming.filter(f => matchesAccept(f))
      if (incoming.length && accepted.length === 0) {
        onError?.({
          code: "accept",
          message: t("attachments.errorAccept"),
        })
        return
      }
      const withinSize = (f: File) => (maxFileSize ? f.size <= maxFileSize : true)
      const sized = accepted.filter(withinSize)
      if (accepted.length > 0 && sized.length === 0) {
        onError?.({
          code: "max_file_size",
          message: t("attachments.errorMaxFileSize"),
        })
        return
      }

      setItems(prev => {
        const capacity =
          typeof maxFiles === "number" ? Math.max(0, maxFiles - prev.length) : undefined
        const capped = typeof capacity === "number" ? sized.slice(0, capacity) : sized
        if (typeof capacity === "number" && sized.length > capacity) {
          onError?.({
            code: "max_files",
            message: t("attachments.errorMaxFiles"),
          })
        }
        const next: PromptInputFile[] = capped.map(fileAttachment)
        return prev.concat(next)
      })
    },
    [matchesAccept, maxFiles, maxFileSize, onError, t],
  )

  const addMediaLocal = useCallback((ref: MediaAttachmentRef) => {
    if (!ref.id) {
      return
    }
    setItems(prev => prev.concat({
      id: nanoid(),
      type: "file" as const,
      url: ref.url ?? "",
      mediaType: ref.mime ?? "",
      filename: ref.name,
      mediaId: ref.id,
    }))
  }, [])

  const addSourceLocal = useCallback((ref: SourceAttachmentRef) => {
    if (!ref.id) {
      return
    }
    setItems(prev => prev.concat({
      id: nanoid(),
      type: "file" as const,
      url: "",
      mediaType: "",
      filename: ref.name ?? ref.id,
      sourceId: ref.id,
    }))
  }, [])

  const removeLocal = useCallback(
    (id: string) =>
      setItems(prev => {
        const found = prev.find(file => file.id === id)
        if (found?.url) {
          URL.revokeObjectURL(found.url)
        }
        return prev.filter(file => file.id !== id)
      }),
    [],
  )

  const clearLocal = useCallback(
    () =>
      setItems(prev => {
        for (const file of prev) {
          if (file.url) {
            URL.revokeObjectURL(file.url)
          }
        }
        return []
      }),
    [],
  )

  const add = usingProvider ? controller.attachments.add : addLocal
  const addMedia = usingProvider ? controller.attachments.addMedia : addMediaLocal
  const addSource = usingProvider ? controller.attachments.addSource : addSourceLocal
  const remove = usingProvider ? controller.attachments.remove : removeLocal
  const clear = usingProvider ? controller.attachments.clear : clearLocal
  const openFileDialog = usingProvider ? controller.attachments.openFileDialog : openFileDialogLocal

  // Let provider know about our hidden file input so external menus can call openFileDialog()
  useEffect(() => {
    if (!usingProvider) {
      return
    }
    controller.__registerFileInput(inputRef, () => inputRef.current?.click())
  }, [usingProvider, controller])

  // Note: File input cannot be programmatically set for security reasons
  // The syncHiddenInput prop is no longer functional
  useEffect(() => {
    if (syncHiddenInput && inputRef.current && files.length === 0) {
      inputRef.current.value = ""
    }
  }, [files, syncHiddenInput])

  /**
   * Media tab tile dragged to the composer: becomes an attachment BY REFERENCE.
   * The payload brings only the identity (id, name, type and preview) — the bytes stay
   * where they are, in the gallery, and the main process copies NOTHING on send (see
   * preprocessAttachment). It serves any type: image, video, audio, motion,
   * artifact, document, design canvas.
   */
  const attachMediaDrag = useCallback(
    (payload: string) => {
      try {
        const parsed = JSON.parse(payload) as {
          id?: unknown
          name?: unknown
          mime?: unknown
          url?: unknown
        }
        if (typeof parsed.id !== "string" || !parsed.id) {
          return
        }
        addMedia({
          id: parsed.id,
          name: typeof parsed.name === "string" ? parsed.name : undefined,
          mime: typeof parsed.mime === "string" ? parsed.mime : undefined,
          url: typeof parsed.url === "string" ? parsed.url : undefined,
        })
      } catch {
        // invalid payload — ignores the drop
      }
    },
    [addMedia],
  )

  /**
   * Source dragged from the Sources tab: same idea as the gallery tile, with another
   * destination. The payload is only the identity (`doc1`, the name, the type); the content
   * stays stored in the conversation and the attachment is a reference — the agent reads the
   * document by the id, and the bubble shows the exact name of what was cited instead
   * of a loose "src3".
   */
  const attachSourceDrag = useCallback(
    (payload: string) => {
      try {
        const parsed = JSON.parse(payload) as {
          id?: unknown
          name?: unknown
          kind?: unknown
          type?: unknown
        }
        if (typeof parsed.id !== "string" || !parsed.id) {
          return
        }
        addSource({
          id: parsed.id,
          name: typeof parsed.name === "string" ? parsed.name : undefined,
          kind: typeof parsed.kind === "string" ? parsed.kind : undefined,
          type: typeof parsed.type === "string" ? parsed.type : undefined,
        })
      } catch {
        // invalid payload — ignores the drop
      }
    },
    [addSource],
  )

  /**
   * A drop can bring a file from disk, a gallery item or a source. The order
   * matters: the two references come by their own MIME, and only what is left is
   * `Files`.
   */
  const dropAttachments = useCallback(
    (dataTransfer: DataTransfer | null) => {
      if (!dataTransfer) return false
      const source = dataTransfer.getData(SOURCE_DND_MIME)
      if (source) {
        attachSourceDrag(source)
        return true
      }
      const media = dataTransfer.getData(MEDIA_DND_MIME)
      if (media) {
        attachMediaDrag(media)
        return true
      }
      if (dataTransfer.files && dataTransfer.files.length > 0) {
        add(dataTransfer.files)
        return true
      }
      return false
    },
    [add, attachMediaDrag, attachSourceDrag],
  )

  // Attach drop handlers on nearest form and document (opt-in)
  useEffect(() => {
    const form = formRef.current
    if (!form) {
      return
    }
    if (globalDrop) {
      return // when global drop is on, let the document-level handler own drops
    }

    const onDragOver = (e: DragEvent) => {
      // Also holds back the drag of a REFERENCE (gallery or source): without the
      // preventDefault the browser treats the drop as text and does not let the
      // handler run.
      if (isAttachmentDrag(e.dataTransfer?.types)) {
        e.preventDefault()
      }
    }
    const onDrop = (e: DragEvent) => {
      // Gallery item or conversation source: attaches (over the native drop
      // of the <textarea>, which would paste the URL text into the field).
      if (dropAttachments(e.dataTransfer ?? null)) {
        e.preventDefault()
      }
    }
    form.addEventListener("dragover", onDragOver)
    form.addEventListener("drop", onDrop)
    return () => {
      form.removeEventListener("dragover", onDragOver)
      form.removeEventListener("drop", onDrop)
    }
  }, [dropAttachments, globalDrop])

  useEffect(() => {
    if (!globalDrop) {
      return
    }

    const onDragOver = (e: DragEvent) => {
      if (isAttachmentDrag(e.dataTransfer?.types)) {
        e.preventDefault()
      }
    }
    const onDrop = (e: DragEvent) => {
      if (dropAttachments(e.dataTransfer ?? null)) {
        e.preventDefault()
      }
    }
    document.addEventListener("dragover", onDragOver)
    document.addEventListener("drop", onDrop)
    return () => {
      document.removeEventListener("dragover", onDragOver)
      document.removeEventListener("drop", onDrop)
    }
  }, [dropAttachments, globalDrop])

  useEffect(
    () => () => {
      if (!usingProvider) {
        for (const f of filesRef.current) {
          if (f.url) {
            URL.revokeObjectURL(f.url)
          }
        }
      }
    },
    // Cleanup only on unmount; filesRef is always current.
    [usingProvider],
  )

  const handleChange: ChangeEventHandler<HTMLInputElement> = event => {
    if (event.currentTarget.files) {
      add(event.currentTarget.files)
    }
    // Reset input value to allow selecting files that were previously removed
    event.currentTarget.value = ""
  }

  const ctx = useMemo<AttachmentsContext>(
    () => ({
      files: files.map(item => ({ ...item, id: item.id })),
      add,
      addMedia,
      addSource,
      remove,
      clear,
      openFileDialog,
      fileInputRef: inputRef,
    }),
    [files, add, addMedia, addSource, remove, clear, openFileDialog],
  )

  const handleSubmit: FormEventHandler<HTMLFormElement> = event => {
    event.preventDefault()

    const form = event.currentTarget
    const text = usingProvider
      ? controller.textInput.value
      : (() => {
          const formData = new FormData(form)
          return (formData.get("message") as string) || ""
        })()

    // Clears the TEXT immediately (synchronous) to avoid it being saved as
    // a draft if the user switches chats before the reply. The attachments are NOT
    // cleared here: clear() revokes the blob URLs (URL.revokeObjectURL), and the
    // blob→dataURL conversion below still needs to read them via fetch — revoking
    // before that creates a race in which the fetch fails and a dead blob URL leaks
    // to the backend (which then rejects it as an invalid data URL).
    if (usingProvider) {
      controller.textInput.clear()
    }

    // Convert blob URLs to data URLs asynchronously
    blobUrlsToDataUrls(files).then((convertedFiles: FileUIPart[]) => {
      // Conversion done — now it is safe to revoke the blob URLs and clear the
      // attachment chips of the input.
      clear()
      // Calls submit (async — the result is deliberately ignored:
      // the input was already cleared and errors appear in the chat via the store)
      const result = onSubmit({ text, files: convertedFiles }, event)
      if (result instanceof Promise) {
        result.catch(() => {})
      }
    })
  }

  // Render with or without local provider
  const inner = (
    <>
      <input
        accept={accept}
        aria-label={t("input.uploadFiles")}
        className="hidden"
        multiple={multiple}
        onChange={handleChange}
        ref={inputRef}
        title={t("input.uploadFiles")}
        type="file"
      />
      {(() => {
        const att: ReactNode[] = []
        const rest: ReactNode[] = []
        Children.forEach(children, (child) => {
          if (isValidElement(child) && child.type === PromptInputAttachments) {
            att.push(child)
          } else {
            rest.push(child)
          }
        })
        return (
          <>
            {att.length > 0 && <div>{att}</div>}
            <form className={cn("w-full", className)} onSubmit={handleSubmit} ref={formRef} {...props}>
              <InputGroup>{rest}</InputGroup>
            </form>
          </>
        )
      })()}
    </>
  )

  return usingProvider ? (
    inner
  ) : (
    <LocalAttachmentsContext.Provider value={ctx}>{inner}</LocalAttachmentsContext.Provider>
  )
}

export type PromptInputBodyProps = HTMLAttributes<HTMLDivElement>

export const PromptInputBody = ({ className, ...props }: PromptInputBodyProps) => (
  <div className={cn("contents", className)} {...props} />
)

export type PromptInputTextareaProps = ComponentProps<typeof InputGroupTextarea> & {
  /** Suggested next message: with the field empty, it appears in place of the
   *  placeholder and Tab puts it in the field. */
  suggestion?: string
  /** ↑/↓ of the history of sent messages (see useInputHistory): returns the
   *  text to put in the field, already with the reply armed, or `null` when the
   *  key belongs to the caret and not to the history. */
  onHistory?: (direction: "older" | "newer", input: HistoryInput) => string | null
}

export const PromptInputTextarea = ({
  onChange,
  className,
  placeholder,
  suggestion,
  onHistory,
  ...props
}: PromptInputTextareaProps) => {
  const { t } = useTranslation()
  const controller = useOptionalPromptInputController()
  const attachments = usePromptInputAttachments()
  const [isComposing, setIsComposing] = useState(false)

  // The textarea components of the UI kit do not forward refs (React 18), so the element is
  // found by a unique attribute and handed to the provider (see textareaRef).
  const fieldId = useId()
  const textareaRef = controller?.textareaRef
  useLayoutEffect(() => {
    if (!textareaRef) return
    textareaRef.current = document.querySelector<HTMLTextAreaElement>(`textarea[data-field-id="${fieldId}"]`)
    return () => {
      textareaRef.current = null
    }
  }, [textareaRef, fieldId])

  const empty = (controller?.textInput.value ?? "") === ""
  const showSuggestion = Boolean(suggestion && controller && empty)

  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = e => {
    // With no suggestion Tab follows the default (move the focus) — it is only captured
    // when there is something to complete.
    if (e.key === "Tab" && !e.shiftKey && showSuggestion && suggestion && controller) {
      e.preventDefault()
      controller.textInput.setInput(suggestion)
      return
    }
    // Tab walks through the [fields] of a ready-made message. Past the last one it gives up,
    // so the key goes back to moving the focus.
    if (e.key === "Tab" && !e.shiftKey && controller) {
      const node = e.currentTarget
      const field = nextArmedField(node)
      if (field) {
        e.preventDefault()
        node.setSelectionRange(field.start, field.end)
        return
      }
    }
    // ↑/↓ bring back what was already sent (useInputHistory), but only at the
    // EDGE of the field: in any other position the arrow belongs to the caret — including
    // in a text with no line break that merely WRAPPED into several lines on screen.
    // A modifier (Shift+↑ selects) and IME are never history.
    if (
      onHistory &&
      controller &&
      (e.key === "ArrowUp" || e.key === "ArrowDown") &&
      !e.shiftKey &&
      !e.altKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      !isComposing &&
      !e.nativeEvent.isComposing
    ) {
      const node = e.currentTarget
      // From the textarea, not from the state: what counts is what is on screen.
      const field = historyKeyInput(node)
      if (field) {
        const direction = e.key === "ArrowUp" ? "older" : "newer"
        const text = onHistory(direction, field)
        if (text !== null) {
          e.preventDefault()
          controller.textInput.setInput(text)
          // The caret goes to the edge that gives continuity to the navigation: ↑ leaves it
          // at the first position (from where one goes up again), ↓ at the last. After
          // React's commit, which is what swaps the field value.
          requestAnimationFrame(() => {
            const caret = direction === "older" ? 0 : node.value.length
            node.setSelectionRange(caret, caret)
          })
          return
        }
      }
    }

    if (e.key === "Enter") {
      if (isComposing || e.nativeEvent.isComposing) {
        return
      }
      if (e.shiftKey) {
        return
      }
      e.preventDefault()

      // Check if the submit button is disabled before submitting
      const form = e.currentTarget.form
      const submitButton = form?.querySelector('button[type="submit"]') as HTMLButtonElement | null
      if (submitButton?.disabled) {
        return
      }

      form?.requestSubmit()
    }

    // Remove last attachment when Backspace is pressed and textarea is empty
    if (e.key === "Backspace" && e.currentTarget.value === "" && attachments.files.length > 0) {
      e.preventDefault()
      const lastAttachment = attachments.files.at(-1)
      if (lastAttachment) {
        attachments.remove(lastAttachment.id)
      }
    }
  }

  const handlePaste: ClipboardEventHandler<HTMLTextAreaElement> = event => {
    const items = event.clipboardData?.items

    if (!items) {
      return
    }

    const files: File[] = []

    for (const item of items) {
      if (item.kind === "file") {
        const file = item.getAsFile()
        if (file) {
          files.push(file)
        }
      }
    }

    if (files.length > 0) {
      event.preventDefault()
      attachments.add(files)
      return
    }

    // LARGE pasted text becomes an attachment, not text: the field is for the message, and
    // a whole document there would be resent to the model on every turn. It becomes
    // a chip like any file — and, on send, a conversation source
    // (preprocessAttachment stores the text and sends only the opening to the model).
    const text = event.clipboardData?.getData("text/plain") ?? ""
    if (text.trim().length >= PASTE_AS_SOURCE_CHARS) {
      event.preventDefault()
      const file = pastedTextFile(text)
      pastedTexts.set(file, text)
      attachments.add([file])
    }
  }

  const controlledProps = controller
    ? {
        value: controller.textInput.value,
        onChange: (e: ChangeEvent<HTMLTextAreaElement>) => {
          controller.textInput.setInput(e.currentTarget.value)
          onChange?.(e)
        },
      }
    : {
        onChange,
      }

  return (
    <InputGroupTextarea
      className={cn("field-sizing-content max-h-48 min-h-16", className)}
      name="message"
      onCompositionEnd={() => setIsComposing(false)}
      onCompositionStart={() => setIsComposing(true)}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      data-field-id={fieldId}
      placeholder={showSuggestion ? `${suggestion}  ⇥ Tab` : (placeholder ?? t("input.placeholderDefault"))}
      {...props}
      {...controlledProps}
    />
  )
}

export type PromptInputHeaderProps = Omit<ComponentProps<typeof InputGroupAddon>, "align">

export const PromptInputHeader = ({ className, ...props }: PromptInputHeaderProps) => (
  <InputGroupAddon
    align="block-end"
    className={cn("order-first flex-wrap gap-1", className)}
    {...props}
  />
)

export type PromptInputFooterProps = Omit<ComponentProps<typeof InputGroupAddon>, "align">

export const PromptInputFooter = ({ className, ...props }: PromptInputFooterProps) => (
  <InputGroupAddon
    align="block-end"
    className={cn("justify-between gap-1", className)}
    {...props}
  />
)

export type PromptInputToolsProps = HTMLAttributes<HTMLDivElement>

export const PromptInputTools = ({ className, ...props }: PromptInputToolsProps) => (
  <div className={cn("flex items-center gap-1", className)} {...props} />
)

export type PromptInputButtonProps = ComponentProps<typeof InputGroupButton>

export const PromptInputButton = ({
  variant = "ghost",
  className,
  size,
  ...props
}: PromptInputButtonProps) => {
  const newSize = size ?? (Children.count(props.children) > 1 ? "sm" : "icon-sm")

  return (
    <InputGroupButton
      className={cn(className)}
      size={newSize}
      type="button"
      variant={variant}
      {...props}
    />
  )
}

export type PromptInputActionMenuProps = ComponentProps<typeof DropdownMenu>
export const PromptInputActionMenu = (props: PromptInputActionMenuProps) => (
  <DropdownMenu {...props} />
)

export type PromptInputActionMenuTriggerProps = PromptInputButtonProps

export const PromptInputActionMenuTrigger = ({
  className,
  children,
  ...props
}: PromptInputActionMenuTriggerProps) => (
  <DropdownMenuTrigger render={<PromptInputButton className={className} {...props} />}>{children ?? <PlusIcon className="size-4" />}</DropdownMenuTrigger>
)

export type PromptInputActionMenuContentProps = ComponentProps<typeof DropdownMenuContent>
export const PromptInputActionMenuContent = ({
  className,
  ...props
}: PromptInputActionMenuContentProps) => (
  <DropdownMenuContent align="start" className={cn(className)} {...props} />
)

export type PromptInputActionMenuItemProps = ComponentProps<typeof DropdownMenuItem>
export const PromptInputActionMenuItem = ({
  className,
  ...props
}: PromptInputActionMenuItemProps) => <DropdownMenuItem className={cn(className)} {...props} />

// Note: Actions that perform side-effects (like opening a file dialog)
// are provided in opt-in modules (e.g., prompt-input-attachments).

export type PromptInputSubmitProps = ComponentProps<typeof InputGroupButton> & {
  status?: ChatStatus
}

export const PromptInputSubmit = ({
  className,
  variant = "default",
  size = "icon-sm",
  status,
  children,
  ...props
}: PromptInputSubmitProps) => {
  const { t } = useTranslation()
  let Icon = <CornerDownLeftIcon className="size-4" />

  if (status === "submitted" || status === "fallback") {
    Icon = <Loader2Icon className="size-4 animate-spin" />
  } else if (status === "streaming") {
    Icon = <SquareIcon className="size-4" />
  } else if (status === "error") {
    Icon = <XIcon className="size-4" />
  }

  return (
    <InputGroupButton
      aria-label={t("input.submit")}
      className={cn(className)}
      size={size}
      type="submit"
      variant={variant}
      {...props}
    >
      {children ?? Icon}
    </InputGroupButton>
  )
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  start(): void
  stop(): void
  onstart: ((this: SpeechRecognition, ev: Event) => void) | null
  onend: ((this: SpeechRecognition, ev: Event) => void) | null
  onresult: ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => void) | null
  onerror: ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => void) | null
}

interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList
  resultIndex: number
}

interface SpeechRecognitionResultList {
  readonly length: number
  item(index: number): SpeechRecognitionResult
  [index: number]: SpeechRecognitionResult
}

interface SpeechRecognitionResult {
  readonly length: number
  item(index: number): SpeechRecognitionAlternative
  [index: number]: SpeechRecognitionAlternative
  isFinal: boolean
}

interface SpeechRecognitionAlternative {
  transcript: string
  confidence: number
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string
}

declare global {
  interface Window {
    SpeechRecognition: {
      new (): SpeechRecognition
    }
    webkitSpeechRecognition: {
      new (): SpeechRecognition
    }
  }
}

export type PromptInputSpeechButtonProps = ComponentProps<typeof PromptInputButton> & {
  textareaRef?: RefObject<HTMLTextAreaElement | null>
  onTranscriptionChange?: (text: string) => void
}

export const PromptInputSpeechButton = ({
  className,
  textareaRef,
  onTranscriptionChange,
  ...props
}: PromptInputSpeechButtonProps) => {
  const [isListening, setIsListening] = useState(false)
  const [recognition, setRecognition] = useState<SpeechRecognition | null>(null)
  const recognitionRef = useRef<SpeechRecognition | null>(null)

  useEffect(() => {
    if (
      typeof window !== "undefined" &&
      ("SpeechRecognition" in window || "webkitSpeechRecognition" in window)
    ) {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
      const speechRecognition = new SpeechRecognition()

      speechRecognition.continuous = true
      speechRecognition.interimResults = true
      speechRecognition.lang = "en-US"

      speechRecognition.onstart = () => {
        setIsListening(true)
      }

      speechRecognition.onend = () => {
        setIsListening(false)
      }

      speechRecognition.onresult = event => {
        let finalTranscript = ""

        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i]
          if (result.isFinal) {
            finalTranscript += result[0]?.transcript ?? ""
          }
        }

        if (finalTranscript && textareaRef?.current) {
          const textarea = textareaRef.current
          const currentValue = textarea.value
          const newValue = currentValue + (currentValue ? " " : "") + finalTranscript

          textarea.value = newValue
          textarea.dispatchEvent(new Event("input", { bubbles: true }))
          onTranscriptionChange?.(newValue)
        }
      }

      speechRecognition.onerror = event => {
        console.error("Speech recognition error:", event.error)
        setIsListening(false)
      }

      recognitionRef.current = speechRecognition
      setRecognition(speechRecognition)
    }

    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.stop()
      }
    }
  }, [textareaRef, onTranscriptionChange])

  const toggleListening = useCallback(() => {
    if (!recognition) {
      return
    }

    if (isListening) {
      recognition.stop()
    } else {
      recognition.start()
    }
  }, [recognition, isListening])

  return (
    <PromptInputButton
      className={cn(
        "relative transition-all duration-200",
        isListening && "animate-pulse bg-accent text-accent-foreground",
        className,
      )}
      disabled={!recognition}
      onClick={toggleListening}
      {...props}
    >
      <MicIcon className="size-4" />
    </PromptInputButton>
  )
}

export type PromptInputSelectProps = ComponentProps<typeof Select>

export const PromptInputSelect = (props: PromptInputSelectProps) => <Select {...props} />

export type PromptInputSelectTriggerProps = ComponentProps<typeof SelectTrigger>

export const PromptInputSelectTrigger = ({
  className,
  ...props
}: PromptInputSelectTriggerProps) => (
  <SelectTrigger
    className={cn(
      "border-none bg-transparent font-medium text-muted-foreground shadow-none transition-colors",
      "hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground",
      className,
    )}
    {...props}
  />
)

export type PromptInputSelectContentProps = ComponentProps<typeof SelectContent>

export const PromptInputSelectContent = ({
  className,
  ...props
}: PromptInputSelectContentProps) => <SelectContent className={cn(className)} {...props} />

export type PromptInputSelectItemProps = ComponentProps<typeof SelectItem>

export const PromptInputSelectItem = ({ className, ...props }: PromptInputSelectItemProps) => (
  <SelectItem className={cn(className)} {...props} />
)

export type PromptInputSelectValueProps = ComponentProps<typeof SelectValue>

export const PromptInputSelectValue = ({ className, ...props }: PromptInputSelectValueProps) => (
  <SelectValue className={cn(className)} {...props} />
)

export type PromptInputHoverCardProps = ComponentProps<typeof HoverCard>

export const PromptInputHoverCard = (props: PromptInputHoverCardProps) => (
  <HoverCard {...props} />
)

export type PromptInputHoverCardTriggerProps = ComponentProps<typeof HoverCardTrigger>

export const PromptInputHoverCardTrigger = (props: PromptInputHoverCardTriggerProps) => (
  <HoverCardTrigger {...props} />
)

export type PromptInputHoverCardContentProps = ComponentProps<typeof HoverCardContent>

export const PromptInputHoverCardContent = ({
  align = "start",
  ...props
}: PromptInputHoverCardContentProps) => <HoverCardContent align={align} {...props} />

export type PromptInputTabsListProps = HTMLAttributes<HTMLDivElement>

export const PromptInputTabsList = ({ className, ...props }: PromptInputTabsListProps) => (
  <div className={cn(className)} {...props} />
)

export type PromptInputTabProps = HTMLAttributes<HTMLDivElement>

export const PromptInputTab = ({ className, ...props }: PromptInputTabProps) => (
  <div className={cn(className)} {...props} />
)

export type PromptInputTabLabelProps = HTMLAttributes<HTMLHeadingElement>

export const PromptInputTabLabel = ({ className, ...props }: PromptInputTabLabelProps) => (
  <h3 className={cn("mb-2 px-3 font-medium text-muted-foreground text-xs", className)} {...props} />
)

export type PromptInputTabBodyProps = HTMLAttributes<HTMLDivElement>

export const PromptInputTabBody = ({ className, ...props }: PromptInputTabBodyProps) => (
  <div className={cn("space-y-1", className)} {...props} />
)

export type PromptInputTabItemProps = HTMLAttributes<HTMLDivElement>

export const PromptInputTabItem = ({ className, ...props }: PromptInputTabItemProps) => (
  <div
    className={cn("flex items-center gap-2 px-3 py-2 text-xs hover:bg-accent", className)}
    {...props}
  />
)

export type PromptInputCommandProps = ComponentProps<typeof Command>

export const PromptInputCommand = ({ className, ...props }: PromptInputCommandProps) => (
  <Command className={cn(className)} {...props} />
)

export type PromptInputCommandInputProps = ComponentProps<typeof CommandInput>

export const PromptInputCommandInput = ({ className, ...props }: PromptInputCommandInputProps) => (
  <CommandInput className={cn(className)} {...props} />
)

export type PromptInputCommandListProps = ComponentProps<typeof CommandList>

export const PromptInputCommandList = ({ className, ...props }: PromptInputCommandListProps) => (
  <CommandList className={cn(className)} {...props} />
)

export type PromptInputCommandEmptyProps = ComponentProps<typeof CommandEmpty>

export const PromptInputCommandEmpty = ({ className, ...props }: PromptInputCommandEmptyProps) => (
  <CommandEmpty className={cn(className)} {...props} />
)

export type PromptInputCommandGroupProps = ComponentProps<typeof CommandGroup>

export const PromptInputCommandGroup = ({ className, ...props }: PromptInputCommandGroupProps) => (
  <CommandGroup className={cn(className)} {...props} />
)

export type PromptInputCommandItemProps = ComponentProps<typeof CommandItem>

export const PromptInputCommandItem = ({ className, ...props }: PromptInputCommandItemProps) => (
  <CommandItem className={cn(className)} {...props} />
)

export type PromptInputCommandSeparatorProps = ComponentProps<typeof CommandSeparator>

export const PromptInputCommandSeparator = ({
  className,
  ...props
}: PromptInputCommandSeparatorProps) => <CommandSeparator className={cn(className)} {...props} />

/** Demo component for preview */
export default function PromptInputDemo() {
  return (
    <div className="size-full">
      <PromptInput
        multiple
        onSubmit={message => {
          console.log("Submitting message:", message)
        }}
      >
        <PromptInputAttachments>
          {attachment => <PromptInputAttachment data={attachment} />}
        </PromptInputAttachments>
        <PromptInputBody>
          <PromptInputTextarea />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools>
            <PromptInputActionMenu>
              <PromptInputActionMenuTrigger />
              <PromptInputActionMenuContent>
                <PromptInputActionAddAttachments />
              </PromptInputActionMenuContent>
            </PromptInputActionMenu>
          </PromptInputTools>
          <PromptInputSubmit />
        </PromptInputFooter>
      </PromptInput>
    </div>
  )
}
