import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  AudioLines,
  ChevronRight,
  Clapperboard,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  Loader2,
  Type,
  Video,
} from "lucide-react"
import type { MotionBundle, MotionBundleFile } from "@shared/media"
import { cn } from "@/lib/utils"
import { motionApi } from "@/src/lib/ipc"
import { Truncate } from "@/components/ui/truncated-text"

import { Hint } from "@/components/ui/hint"
/**
 * O card da PEÇA no chat: um lugar só para os arquivos que a composição foi
 * juntando enquanto era construída.
 *
 * Antes, cada áudio gerado e cada imagem trazida virava um player solto na
 * resposta — e o que tinha sido trocado continuava lá, ocupando a conversa com
 * material que a peça já não usa. Aqui eles são LINHAS de um card, com o estado
 * de cada um à vista: usado pela composição, ou descartado.
 *
 * Descartado não é lixo e não some: o arquivo continua na pasta e na galeria,
 * porque é da pessoa também (ela pode querer a narração antiga). O que muda é
 * a etiqueta — e a peça pode voltar a citá-lo a qualquer momento.
 *
 * Os bytes ficam onde sempre estiveram; o card lê a PASTA (via main) e por isso
 * se atualiza sozinho quando a mídia é regravada, sem um card novo na conversa.
 */

const THUMBS = 5

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** URL do arquivo DENTRO da peça (o scheme serve a pasta registrada). */
function pieceUrl(motionId: string, name: string): string {
  const path = name.split("/").map(encodeURIComponent).join("/")
  return `orbit-motion://${motionId}/${path}`
}

function kindIcon(kind: MotionBundleFile["kind"]) {
  if (kind === "audio") return AudioLines
  if (kind === "image") return ImageIcon
  if (kind === "video") return Video
  if (kind === "font") return Type
  return FileText
}

/**
 * Quantos arquivos o card tinha quando a pessoa olhou para ele pela última vez.
 *
 * É o que faz o selo "N novos" dizer algo: o card muda no lugar, e sem esta
 * memória uma narração regravada apareceria como se nada tivesse acontecido.
 * Fica no armazenamento local do renderer — é preferência de leitura, não dado
 * da peça.
 */
function seenKey(motionId: string): string {
  return `orbit-motion-bundle-seen:${motionId}`
}

function readSeen(motionId: string): number | null {
  try {
    const raw = window.localStorage.getItem(seenKey(motionId))
    if (raw == null) return null
    const value = Number(raw)
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

function writeSeen(motionId: string, count: number): void {
  try {
    window.localStorage.setItem(seenKey(motionId), String(count))
  } catch {
    // sem localStorage o card continua funcionando — só não lembra do "já vi"
  }
}

export function MotionBundleCard({ bundle }: { bundle: MotionBundle }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [opening, setOpening] = useState(false)
  const [gone, setGone] = useState(false)
  const [seen, setSeen] = useState<number | null>(() => readSeen(bundle.motionId))

  // Primeira aparição do card: o que já está nele é o "visto". Sem isto, uma
  // peça que nasce com seis arquivos abriria com o selo "6 novos", que não
  // informa nada.
  useEffect(() => {
    if (seen != null) return
    writeSeen(bundle.motionId, bundle.files.length)
    setSeen(bundle.files.length)
  }, [bundle.motionId, bundle.files.length, seen])

  const fresh = seen == null ? 0 : Math.max(0, bundle.files.length - seen)

  const toggle = useCallback(() => {
    const next = !open
    setOpen(next)
    // Abriu: daqui em diante estes arquivos já foram vistos.
    if (next) {
      writeSeen(bundle.motionId, bundle.files.length)
      setSeen(bundle.files.length)
    }
  }, [open, bundle.motionId, bundle.files.length])

  const openTab = useCallback(() => {
    if (opening) return
    setOpening(true)
    setGone(false)
    motionApi
      .open({ id: bundle.motionId })
      .then((ok) => setGone(!ok))
      .catch(() => setGone(true))
      .finally(() => setOpening(false))
  }, [bundle.motionId, opening])

  const revealFolder = useCallback(() => {
    void window.ipcRenderer.invoke("shell:showItemInFolder", bundle.folder)
  }, [bundle.folder])

  const files = bundle.files
  if (!files.length) return null
  const subtitle = [
    t("motion.bundle.files", { count: files.length }),
    formatBytes(bundle.totalBytes),
    bundle.discarded ? t("motion.bundle.discarded", { count: bundle.discarded }) : null,
  ]
    .filter(Boolean)
    .join(" · ")
  const thumbs = files.slice(0, THUMBS)
  const rest = files.length - thumbs.length

  return (
    <div className="not-prose my-2 w-full max-w-md">
      <div
        className={cn(
          "overflow-hidden rounded-xl border bg-muted/30 transition-colors",
          open && "bg-muted/40",
        )}
      >
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="flex w-full cursor-pointer items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent/40"
        >
          <div className="relative flex size-9 shrink-0 items-center justify-center rounded-md border bg-background">
            <Clapperboard className="size-4 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              
                <Truncate>
                    <span className="truncate text-sm font-medium text-foreground">{bundle.name}</span>
                </Truncate>
              {fresh > 0 && (
                <span className="shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                  {t("motion.bundle.new", { count: fresh })}
                </span>
              )}
            </div>
            
              <Truncate>
                  <p className="truncate text-[11px] text-muted-foreground">{subtitle}</p>
              </Truncate>
          </div>
          <ChevronRight
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
        </button>

        {/* Tira de miniaturas: o card fechado já mostra o que tem dentro. */}
        {!open && (
          <div className="flex items-center gap-1.5 px-3 pb-2.5">
            {thumbs.map((file) => (
              <FileThumb key={file.name} motionId={bundle.motionId} file={file} />
            ))}
            {rest > 0 && (
              <span className="text-[11px] font-medium text-muted-foreground">+{rest}</span>
            )}
          </div>
        )}

        {open && (
          <div className="border-t border-border/60 px-3 py-2">
            <p className="mb-1.5 text-[11px] text-muted-foreground">{t("motion.bundle.hint")}</p>
            <ul className="flex flex-col">
              {files.map((file) => (
                <FileRow key={file.name} motionId={bundle.motionId} file={file} />
              ))}
            </ul>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={openTab}
                disabled={opening}
                className="flex h-7 items-center gap-1.5 rounded-md bg-primary px-2.5 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/85 disabled:opacity-70"
              >
                {opening ? <Loader2 className="size-3 animate-spin" /> : <Clapperboard className="size-3" />}
                {t("motion.openTab")}
              </button>
              <Hint label={bundle.folder}>
                <button
                  type="button"
                  onClick={revealFolder}
                  className="flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
       
                       <FolderOpen className="size-3" />
                {t("motion.bundle.openFolder")}
              </button>
              </Hint>
            </div>
            {gone && (
              <p className="mt-1.5 text-[11px] text-destructive">{t("motion.gone")}</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** Miniatura de um arquivo: a imagem de verdade quando é imagem. */
function FileThumb({ motionId, file }: { motionId: string; file: MotionBundleFile }) {
  const [broken, setBroken] = useState(false)
  const Icon = kindIcon(file.kind)
  if (file.kind === "image" && !broken) {
    return (
      <img
        src={pieceUrl(motionId, file.name)}
        alt={file.name}
        title={file.name}
        onError={() => setBroken(true)}
        className={cn(
          "size-8 shrink-0 rounded-md border object-cover",
          !file.used && "opacity-45 grayscale",
        )}
      />
    )
  }
  return (
    <span
      title={file.name}
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-md border bg-background",
        !file.used && "opacity-45",
      )}
    >
      <Icon className="size-3.5 text-muted-foreground" />
    </span>
  )
}

function FileRow({ motionId, file }: { motionId: string; file: MotionBundleFile }) {
  const { t } = useTranslation()
  const [broken, setBroken] = useState(false)
  const Icon = kindIcon(file.kind)
  return (
    <li className={cn("flex items-center gap-2 py-0.5", !file.used && "opacity-70")}>
      {file.kind === "image" && !broken ? (
        <img
          src={pieceUrl(motionId, file.name)}
          alt=""
          loading="lazy"
          onError={() => setBroken(true)}
          className={cn("size-4 shrink-0 rounded-sm border object-cover", !file.used && "grayscale")}
        />
      ) : (
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <Truncate text={file.name}>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[12px]",
            file.used ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {file.name}
        </span>
      </Truncate>
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
        {formatBytes(file.size)}
      </span>
      <span
        className={cn(
          "w-16 shrink-0 text-right text-[10px]",
          file.used ? "text-muted-foreground/80" : "text-muted-foreground/60",
        )}
      >
        {t(file.used ? "motion.bundle.used" : "motion.bundle.discardedTag")}
      </span>
    </li>
  )
}
