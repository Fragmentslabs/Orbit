import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  ArrowDownToLine,
  ArrowUpToLine,
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
  Trash2,
  Upload,
} from "lucide-react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { docsApi, type SourceDocument } from "@/src/lib/ipc"
import { useSessionStore } from "@/src/stores/session-store"
import { usePanelStore } from "@/src/stores/panel-store"
import { cn } from "@/lib/utils"

/**
 * Aba Fontes: os documentos com que se CONVERSA.
 *
 * É o outro lado da galeria de mídia. Lá ficam as saídas do agente (imagens,
 * artefatos, documentos gerados); aqui ficam as entradas — e os dois ciclos
 * de vida são opostos: apagar um artefato libera espaço, apagar uma fonte
 * muda as respostas seguintes. Por isso a exclusão em lote e a limpeza
 * automática da galeria não alcançam nada desta lista.
 *
 * Duas áreas, porque a diferença é de INTENÇÃO:
 *
 * - "Fontes da pasta" é o corpus declarado, válido para todas as conversas
 *   daquela pasta.
 * - "Desta conversa" são os anexos que você jogou no chat para perguntar uma
 *   coisa — o que é a maioria dos anexos, e não vira corpus sozinho.
 *
 * Nada escorre de baixo para cima automaticamente: fonte errada é silenciosa
 * e muda respostas em OUTRAS conversas, enquanto o clique a mais é visível na
 * hora. Mas o anexo aparece aqui assim que chega, com o botão do lado — o
 * problema de um gesto que ninguém adivinha se resolve mostrando, não
 * compartilhando por padrão. Arrastar entre as áreas faz o mesmo, e soltar o
 * arquivo direto na área certa já decide o escopo.
 *
 * Vale nos dois modos. No código o repositório já é o corpus dos ARQUIVOS —
 * `read` e `grep` abrem PDF, DOCX e planilha de lá paginando igual, então um
 * documento commitado não precisa ser declarado fonte. O que não está no
 * repositório é o resto: a doc de uma lib, uma RFC, o ticket colado, o PDF de
 * spec que o cliente mandou e que ninguém quer commitar. Para esse material a
 * pasta automática do projeto vira o que seria um `docs/` não versionado,
 * disponível em toda conversa daquele repositório.
 */

const ACCEPT = ".pdf,.docx,.xlsx,.xls,.ods,.csv"

/** Tipo de arrasto interno — distingue mover um documento entre as áreas de
 *  um arquivo vindo de fora do app. */
const DRAG_MIME = "application/x-orbit-document"

/** Teto por arquivo — barreira contra arquivo patológico, não limite de uso. */
const MAX_FILE_BYTES = 100 * 1024 * 1024

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

function KindIcon({ kind, className }: { kind: SourceDocument["kind"]; className?: string }) {
  const Icon = KIND_ICONS[kind] ?? FileText
  return <Icon className={className} />
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}

/** Lê o arquivo como base64 — é o formato que o IPC do anexo já usa. */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? "")
      // O data URL vem como "data:<mime>;base64,<dados>"; o main só quer os dados.
      resolve(result.slice(result.indexOf(",") + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error("falha ao ler o arquivo"))
    reader.readAsDataURL(file)
  })
}

function DocumentRow({
  doc,
  originLabel,
  moveLabel,
  MoveIcon,
  onMove,
  onOpen,
  onRemove,
}: {
  doc: SourceDocument
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

  return (
    <li
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_MIME, doc.id)
        e.dataTransfer.effectAllowed = "move"
      }}
      className="group flex cursor-grab items-center gap-2.5 rounded-md px-2 py-2 active:cursor-grabbing hover:bg-accent/50"
    >
      <KindIcon kind={doc.kind} className="size-4 shrink-0 text-muted-foreground" />
      {/* O corpo da linha abre o arquivo; os botões da direita ficam fora dele
          para o clique de remover não abrir o que está sendo removido. */}
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") onOpen()
        }}
        className="min-w-0 flex-1 cursor-pointer text-left"
      >
        <p className="truncate text-xs font-medium text-foreground">{doc.filename}</p>
        <p className="truncate text-[11px] text-muted-foreground">
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
      </div>
      {onMove && MoveIcon && (
        <button
          type="button"
          onClick={onMove}
          className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-accent hover:text-foreground"
          title={moveLabel}
        >
          <MoveIcon className="size-3.5" />
        </button>
      )}
      <button
        type="button"
        onClick={onRemove}
        className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive"
        title={t("sources.remove")}
      >
        <Trash2 className="size-3.5" />
      </button>
    </li>
  )
}

/**
 * Escopo do chat que ainda nao virou sessao. Precisa bater com o DRAFT_SCOPE
 * do main: e a mesma pasta em disco, e o rascunho e adotado pela sessao na
 * primeira mensagem.
 */
const DRAFT_SCOPE = "draft"

export function SourcesTab({ sessionId }: { sessionId?: string }) {
  // Sem sessao ainda (chat novo): as fontes vao para o escopo do rascunho, em
  // vez de a aba ficar inerte pedindo que o usuario mande uma mensagem antes
  // de poder trazer o material.
  const scope = sessionId ?? DRAFT_SCOPE
  const isDraft = !sessionId
  const { t } = useTranslation()
  const [shared, setShared] = useState<SourceDocument[]>([])
  const [own, setOwn] = useState<SourceDocument[]>([])
  const [folderId, setFolderId] = useState<string | null>(null)
  const [usage, setUsage] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [dropZone, setDropZone] = useState<"shared" | "own" | null>(null)
  const [dialog, setDialog] = useState<{ kind: "text" | "web"; shared: boolean } | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const sharedInput = useRef<HTMLInputElement>(null)
  const ownInput = useRef<HTMLInputElement>(null)

  const openSourceTab = usePanelStore((s) => s.openSourceTab)
  const folders = useSessionStore((s) => s.folders)
  const sessions = useSessionStore((s) => s.sessions)
  const folderName = useMemo(
    () => folders.find((f) => f.id === folderId)?.name ?? null,
    [folders, folderId],
  )

  const refresh = useCallback(async () => {
    const result = await docsApi.list(scope)
    setShared(result.shared)
    setOwn(result.own)
    setFolderId(result.folderId)
    setUsage(result.usage)
    setLoading(false)
  }, [scope])

  useEffect(() => {
    setLoading(true)
    void refresh()
  }, [refresh])

  // O anexo também chega pela conversa (e por outro chat da mesma pasta): sem
  // este aviso, a aba aberta ao lado mostraria a lista de antes.
  useEffect(() => docsApi.onChanged(() => void refresh()), [refresh])

  const addFiles = useCallback(
    async (files: File[], toShared: boolean) => {
      if (files.length === 0) return
      setBusy(true)
      setErrors([])
      const payload: { filename: string; data: string }[] = []
      const failed: string[] = []
      for (const file of files) {
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

  /** Soltar na área decide o escopo: arquivo de fora entra ali, documento
   *  arrastado da outra área muda de lado. */
  const handleDrop = useCallback(
    (e: React.DragEvent, toShared: boolean) => {
      e.preventDefault()
      setDropZone(null)
      const dragged = e.dataTransfer.getData(DRAG_MIME)
      if (dragged) {
        void move(dragged, toShared)
        return
      }
      void addFiles(Array.from(e.dataTransfer.files), toShared)
    },
    [addFiles, move],
  )

  const section = (
    kind: "shared" | "own",
    title: string,
    hint: string,
    docs: SourceDocument[],
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
        {docs.length === 0 ? (
          <p className="px-1 py-2 text-[11px] text-muted-foreground/80">{hint}</p>
        ) : (
          <ul className="flex flex-col">
            {docs.map((doc) => (
              <DocumentRow
                key={doc.id}
                doc={doc}
                originLabel={
                  isShared && doc.sessionId !== sessionId
                    ? sessions.find((s) => s.id === doc.sessionId)?.title
                    : undefined
                }
                moveLabel={isShared ? t("sources.unshare") : t("sources.share")}
                MoveIcon={isShared ? ArrowDownToLine : ArrowUpToLine}
                onMove={folderId ? () => void move(doc.id, !isShared) : undefined}
                onOpen={() =>
                  sessionId &&
                  openSourceTab(sessionId, { docId: doc.id, page: 1, title: doc.filename })
                }
                onRemove={() => void remove(doc.id)}
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
        <button
          type="button"
          onClick={() => void refresh()}
          className="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          title={t("sources.refresh")}
        >
          <RefreshCw className="size-3.5" />
        </button>
      </div>

      {errors.length > 0 && (
        <div className="border-b border-border/60 bg-destructive/10 px-4 py-2 text-[11px] text-destructive">
          {errors.map((error) => (
            <p key={error}>{error}</p>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-2">
        {loading ? (
          <div className="flex items-center justify-center gap-2 p-6 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            {t("sources.loading")}
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {folderName &&
              section(
                "shared",
                t("sources.sharedTitle", { folder: folderName }),
                t("sources.sharedHint"),
                shared,
                sharedInput,
              )}
            {section(
              "own",
              isDraft ? t("sources.draftTitle") : t("sources.ownTitle"),
              isDraft ? t("sources.draftHint") : t("sources.ownHint"),
              own,
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

      {shared.length + own.length > 0 && (
        <div className="flex items-center gap-1.5 border-t border-border/60 px-4 py-2 text-[11px] text-muted-foreground">
          <HardDriveIcon className="size-3" />
          {t("sources.usage", { count: shared.length + own.length, size: formatBytes(usage) })}
        </div>
      )}

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
 * Colar um trecho ou apontar um endereço — as duas fontes que não vêm de
 * arquivo. O mesmo diálogo serve aos dois porque a diferença é só o campo; o
 * destino (pasta ou conversa) já veio decidido de onde o menu foi aberto.
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

  // Limpa ao abrir: o diálogo é reaproveitado entre os dois tipos e entre as
  // duas áreas, e reaparecer com o texto anterior seria confuso.
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
