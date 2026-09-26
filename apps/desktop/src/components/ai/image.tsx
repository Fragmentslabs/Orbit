import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Check, ChevronLeft, ChevronRight, Copy, Download, ImageOff } from "lucide-react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { mediaApi } from "@/src/lib/ipc"
import { cn } from "@/lib/utils"
import type { ImagePart } from "@shared/chat"

/**
 * Imagem enviada pelo assistente na resposta (tool show_image → ImagePart).
 * Preview emoldurado no fluxo da mensagem; clique abre o lightbox.
 */
export function Image({ src, alt, className }: {
  src: string
  alt?: string
  className?: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState(false)

  if (failed) {
    return (
      <div className="not-prose my-2 flex w-fit items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
        <ImageOff className="size-3.5" />
        {t("images.unavailable")}{alt ? ` — ${alt}` : ""}
      </div>
    )
  }

  return (
    <>
      <figure className={cn("not-prose my-2 w-fit max-w-full", className)}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          title={t("images.enlarge")}
          className="block cursor-zoom-in overflow-hidden rounded-lg border bg-muted/30 transition-colors hover:border-ring"
        >
          <img
            src={src}
            alt={alt ?? t("images.assistantImage")}
            loading="lazy"
            onError={() => setFailed(true)}
            className="max-h-80 w-auto max-w-full object-contain"
          />
        </button>
        {alt && (
          <figcaption className="mt-1 px-0.5 text-[11px] text-muted-foreground">{alt}</figcaption>
        )}
      </figure>

      <ImageLightbox src={src} alt={alt} open={open} onOpenChange={setOpen} />
    </>
  )
}

export interface LightboxImage {
  src: string
  alt?: string
}

/**
 * Lightbox de imagem em dialog — mesmo padrão da galeria de mídia (painel
 * lateral). Usado pelas imagens do assistente e pelos anexos do chat/input.
 *
 * `images`/`index`/`onNavigate` são opcionais: quando presentes (mais de uma
 * imagem no grupo), habilitam setas prev/next, contador e as setas do
 * teclado — a mesma navegação que a galeria de mídia oferece. Sem eles o
 * comportamento é o de sempre, uma imagem só.
 */
export function ImageLightbox({
  src,
  alt,
  open,
  onOpenChange,
  images,
  index = 0,
  onNavigate,
}: {
  src: string
  alt?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  images?: LightboxImage[]
  index?: number
  onNavigate?: (nextIndex: number) => void
}) {
  const { t } = useTranslation()
  const [done, setDone] = useState<"copied" | "saved" | null>(null)
  const [busy, setBusy] = useState(false)

  const hasGroup = (images?.length ?? 0) > 1
  const total = images?.length ?? 0

  const goTo = (next: number) => {
    if (!images || !onNavigate) return
    onNavigate(((next % total) + total) % total)
  }

  // Setas do teclado — só quando o lightbox está aberto num grupo de verdade,
  // senão rouba o ←/→ de qualquer outro atalho da janela.
  useEffect(() => {
    if (!open || !hasGroup) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") goTo(index - 1)
      else if (e.key === "ArrowRight") goTo(index + 1)
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hasGroup, index, total])

  const flash = (what: "copied" | "saved") => {
    setDone(what)
    setTimeout(() => setDone(null), 1600)
  }

  const copy = async () => {
    setBusy(true)
    const result = await mediaApi.copyImage(src).catch(() => ({ ok: false as const }))
    setBusy(false)
    if (result.ok) flash("copied")
  }

  const save = async () => {
    setBusy(true)
    const result = await mediaApi.exportImage(src, alt || t("images.assistantImage"))
      .catch(() => ({ ok: false as const }))
    setBusy(false)
    if (result.ok) flash("saved")
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl p-2">
        <DialogTitle className="sr-only">{alt ?? t("images.assistantImage")}</DialogTitle>
        {/*
          Xadrez atrás da imagem: num PNG com fundo recortado, sem ele não dá
          para distinguir "ficou transparente" de "ficou preto" — que é
          exatamente a pergunta que se faz ao ampliar um recorte.
        */}
        <div className="relative overflow-hidden rounded-md bg-[length:16px_16px] bg-[position:0_0,8px_8px] bg-[image:linear-gradient(45deg,var(--muted)_25%,transparent_25%,transparent_75%,var(--muted)_75%),linear-gradient(45deg,var(--muted)_25%,transparent_25%,transparent_75%,var(--muted)_75%)]">
          <img
            src={src}
            alt={alt ?? t("images.assistantImage")}
            className="max-h-[76vh] w-full object-contain"
          />
          {hasGroup && (
            <>
              <button
                type="button"
                onClick={() => goTo(index - 1)}
                title={t("images.previous")}
                className="absolute top-1/2 left-2 flex size-8 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-background/80 text-foreground shadow-sm backdrop-blur transition-colors hover:bg-background"
              >
                <ChevronLeft className="size-4" />
              </button>
              <button
                type="button"
                onClick={() => goTo(index + 1)}
                title={t("images.next")}
                className="absolute top-1/2 right-2 flex size-8 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-background/80 text-foreground shadow-sm backdrop-blur transition-colors hover:bg-background"
              >
                <ChevronRight className="size-4" />
              </button>
              <span className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-background/80 px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground backdrop-blur">
                {t("images.counter", { current: index + 1, total })}
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2 px-1 pb-1">
          <button
            type="button"
            onClick={() => void copy()}
            disabled={busy}
            className="flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            {done === "copied" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {done === "copied" ? t("images.copied") : t("images.copy")}
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy}
            className="flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            {done === "saved" ? <Check className="size-3.5" /> : <Download className="size-3.5" />}
            {done === "saved" ? t("images.saved") : t("images.save")}
          </button>
          {alt && <p className="ml-auto truncate text-xs text-muted-foreground">{alt}</p>}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Direto de uma ImagePart única. */
export function ImagePartView({ part }: { part: ImagePart }) {
  return <Image src={part.src} alt={part.alt} />
}

/**
 * Filmstrip de miniaturas para quando a resposta traz mais de uma imagem —
 * várias fotos pedidas de uma vez, ou os passos de uma edição em cadeia. Uma
 * imagem só cai no caso normal (figura em largura cheia); mais de uma vira
 * uma tira compacta, todas abrindo o MESMO lightbox com setas prev/next, em
 * vez de empilhar N figuras inteiras e enterrar o resultado no meio delas.
 */
export function ImageGroupView({ parts }: { parts: ImagePart[] }) {
  const { t } = useTranslation()
  const [openIndex, setOpenIndex] = useState<number | null>(null)
  const [failed, setFailed] = useState<Set<string>>(new Set())

  if (parts.length <= 1) {
    return parts[0] ? <ImagePartView part={parts[0]} /> : null
  }

  const images = parts.map((p) => ({ src: p.src, alt: p.alt }))

  return (
    <>
      <div className="not-prose my-2 flex w-fit max-w-full flex-col gap-1.5">
        <p className="px-0.5 text-[11px] text-muted-foreground">
          {t("images.group", { count: parts.length })}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {parts.map((part, i) =>
            failed.has(part.id) ? (
              <div
                key={part.id}
                className="flex size-20 shrink-0 items-center justify-center rounded-lg border border-dashed text-muted-foreground"
              >
                <ImageOff className="size-4" />
              </div>
            ) : (
              <button
                key={part.id}
                type="button"
                onClick={() => setOpenIndex(i)}
                title={part.alt ?? t("images.enlarge")}
                className="block size-20 shrink-0 cursor-zoom-in overflow-hidden rounded-lg border bg-muted/30 transition-colors hover:border-ring"
              >
                <img
                  src={part.src}
                  alt={part.alt ?? t("images.assistantImage")}
                  loading="lazy"
                  onError={() => setFailed((prev) => new Set(prev).add(part.id))}
                  className="size-full object-cover"
                />
              </button>
            ),
          )}
        </div>
      </div>

      <ImageLightbox
        src={openIndex !== null ? images[openIndex].src : images[0].src}
        alt={openIndex !== null ? images[openIndex].alt : images[0].alt}
        open={openIndex !== null}
        onOpenChange={(next) => setOpenIndex(next ? (openIndex ?? 0) : null)}
        images={images}
        index={openIndex ?? 0}
        onNavigate={setOpenIndex}
      />
    </>
  )
}
