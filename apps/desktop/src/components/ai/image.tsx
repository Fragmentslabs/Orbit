import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Check, Copy, Download, ImageOff } from "lucide-react"
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

/**
 * Lightbox de imagem em dialog — mesmo padrão da galeria de mídia (painel
 * lateral). Usado pelas imagens do assistente e pelos anexos do chat/input.
 */
export function ImageLightbox({ src, alt, open, onOpenChange }: {
  src: string
  alt?: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const [done, setDone] = useState<"copied" | "saved" | null>(null)
  const [busy, setBusy] = useState(false)

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
        <div className="overflow-hidden rounded-md bg-[length:16px_16px] bg-[position:0_0,8px_8px] bg-[image:linear-gradient(45deg,var(--muted)_25%,transparent_25%,transparent_75%,var(--muted)_75%),linear-gradient(45deg,var(--muted)_25%,transparent_25%,transparent_75%,var(--muted)_75%)]">
          <img
            src={src}
            alt={alt ?? t("images.assistantImage")}
            className="max-h-[76vh] w-full object-contain"
          />
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

/** Render direto de uma ImagePart de mensagem do assistente. */
export function ImagePartView({ part }: { part: ImagePart }) {
  return <Image src={part.src} alt={part.alt} />
}
