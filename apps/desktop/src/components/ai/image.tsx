import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Check, ChevronLeft, ChevronRight, Copy, Download, ExternalLink, ImageOff } from "lucide-react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { appSettingsApi, mediaApi } from "@/src/lib/ipc"
import { cn } from "@/lib/utils"
import type { ImagePart, ImageSource } from "@shared/chat"
import { Hint } from "@/components/ui/hint"
import { Truncate } from "@/components/ui/truncated-text"

/**
 * Image sent by the assistant in the reply (tool show_image → ImagePart).
 * Framed preview in the flow of the message; a click opens the lightbox.
 */
export function Image({ src, alt, className, source }: {
  src: string
  alt?: string
  className?: string
  /** Set for a web image: shows where it came from, in the caption and in the lightbox */
  source?: ImageSource
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
        <Hint label={t("images.enlarge")}>
          <button
            type="button"
            onClick={() => setOpen(true)}
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
        </Hint>
        {alt && (
          <figcaption className="mt-1 px-0.5 text-[11px] text-muted-foreground">{alt}</figcaption>
        )}
      </figure>

      <ImageLightbox src={src} alt={alt} source={source} open={open} onOpenChange={setOpen} />
    </>
  )
}

export interface LightboxImage {
  src: string
  alt?: string
  source?: ImageSource
}

/** Opens a web address in the system browser — the only way out of the app for a source link. */
function openSource(url: string) {
  if (/^https?:\/\//i.test(url)) appSettingsApi.openExternal(url)
}

/**
 * Image lightbox in a dialog — same pattern as the media gallery (side
 * panel). Used by the assistant images and by the chat/input attachments.
 *
 * `images`/`index`/`onNavigate` are optional: when present (more than one
 * image in the group), they enable prev/next arrows, a counter and the
 * keyboard arrows — the same navigation the media gallery offers. Without them the
 * behavior is the usual one, a single image.
 */
export function ImageLightbox({
  src,
  alt,
  source,
  open,
  onOpenChange,
  images,
  index = 0,
  onNavigate,
}: {
  src: string
  alt?: string
  source?: ImageSource
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

  // Keyboard arrows — only when the lightbox is open on a real group,
  // otherwise it steals the ←/→ from any other shortcut in the window.
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
    // The downloaded file takes the media's name IN ORBIT: the caption, when it exists,
    // otherwise the file name in the gallery. A generic label is no use for
    // finding the image again later.
    const fileName = src.startsWith("orbit-media://") ? src.slice("orbit-media://".length) : ""
    const result = await mediaApi.exportImage(src, alt || fileName || t("images.assistantImage"))
      .catch(() => ({ ok: false as const }))
    setBusy(false)
    if (result.ok) flash("saved")
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl p-2">
        <DialogTitle className="sr-only">{alt ?? t("images.assistantImage")}</DialogTitle>
        {/*
          Checkerboard behind the image: in a PNG with a cut-out background, without it one cannot
          tell "it became transparent" from "it became black" — which is
          exactly the question one asks when enlarging a cut-out.
        */}
        <div className="relative overflow-hidden rounded-md bg-[length:16px_16px] bg-[position:0_0,8px_8px] bg-[image:linear-gradient(45deg,var(--muted)_25%,transparent_25%,transparent_75%,var(--muted)_75%),linear-gradient(45deg,var(--muted)_25%,transparent_25%,transparent_75%,var(--muted)_75%)]">
          <img
            src={src}
            alt={alt ?? t("images.assistantImage")}
            className="max-h-[76vh] w-full object-contain"
          />
          {hasGroup && (
            <>
              <Hint label={t("images.previous")}>
                <button
                  type="button"
                  onClick={() => goTo(index - 1)}
                  className="absolute top-1/2 left-2 flex size-8 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-background/80 text-foreground shadow-sm backdrop-blur transition-colors hover:bg-background"
                >
                  <ChevronLeft className="size-4" />
                </button>
              </Hint>
              <Hint label={t("images.next")}>
                <button
                  type="button"
                  onClick={() => goTo(index + 1)}
                  className="absolute top-1/2 right-2 flex size-8 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-background/80 text-foreground shadow-sm backdrop-blur transition-colors hover:bg-background"
                >
                  <ChevronRight className="size-4" />
                </button>
              </Hint>
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
          {alt && <Truncate text={alt}>
            <p className="ml-auto truncate text-xs text-muted-foreground">{alt}</p>
          </Truncate>}
        </div>
        {source && (
          // The full address, not just the host: the user decides whether to trust it, and
          // it is also what they copy to find the original.
          <div className="flex items-center gap-2 px-1 pb-1">
            <button
              type="button"
              onClick={() => openSource(source.pageUrl)}
              title={source.pageUrl}
              className="flex min-w-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <ExternalLink className="size-3.5 shrink-0" />
              <span className="shrink-0 font-medium text-foreground">{t("images.source")}</span>
              <span className="truncate">{source.pageUrl}</span>
            </button>
            <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{t("images.sourceNote")}</span>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** Straight from a single ImagePart. */
export function ImagePartView({ part }: { part: ImagePart }) {
  return <Image src={part.src} alt={part.alt} source={part.source} />
}

/**
 * Thumbnail filmstrip for when the reply brings more than one image —
 * several photos asked for at once, or the steps of a chained edit. A single
 * image falls into the normal case (full-width figure); more than one becomes
 * a compact strip, all of them opening the SAME lightbox with prev/next arrows, in
 * stead of stacking N whole figures and burying the result among them.
 */
export function ImageGroupView({ parts }: { parts: ImagePart[] }) {
  const { t } = useTranslation()
  const [openIndex, setOpenIndex] = useState<number | null>(null)
  const [failed, setFailed] = useState<Set<string>>(new Set())

  if (parts.length <= 1) {
    return parts[0] ? <ImagePartView part={parts[0]} /> : null
  }

  const images = parts.map((p) => ({ src: p.src, alt: p.alt, source: p.source }))
  // References from the web are LOOKED at (that is the point of fetching them): a grid of
  // large tiles — the source is in the lightbox, not on the tile — not the 80px strip of an edit's steps.
  const web = parts.every((p) => p.source)

  if (web) {
    return (
      <>
        <div className="not-prose my-2 grid max-w-2xl grid-cols-2 gap-2 sm:grid-cols-3">
          {parts.map((part, i) =>
            failed.has(part.id) ? (
              <div key={part.id} className="flex aspect-[4/3] items-center justify-center rounded-xl border border-dashed text-muted-foreground">
                <ImageOff className="size-4" />
              </div>
            ) : (
              <button
                key={part.id}
                type="button"
                onClick={() => setOpenIndex(i)}
                title={part.alt || part.source?.pageUrl}
                className="group relative block aspect-[4/3] cursor-zoom-in overflow-hidden rounded-xl border bg-muted/30 transition-colors hover:border-ring"
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
        <ImageLightbox
          src={openIndex !== null ? images[openIndex].src : images[0].src}
          alt={openIndex !== null ? images[openIndex].alt : images[0].alt}
          source={openIndex !== null ? images[openIndex].source : images[0].source}
          open={openIndex !== null}
          onOpenChange={(next) => setOpenIndex(next ? (openIndex ?? 0) : null)}
          images={images}
          index={openIndex ?? 0}
          onNavigate={setOpenIndex}
        />
      </>
    )
  }

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
              <Hint label={part.alt ?? t("images.enlarge")}>
                <button
                  key={part.id}
                  type="button"
                  onClick={() => setOpenIndex(i)}
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
              </Hint>
            ),
          )}
        </div>
      </div>

      <ImageLightbox
        src={openIndex !== null ? images[openIndex].src : images[0].src}
        alt={openIndex !== null ? images[openIndex].alt : images[0].alt}
        source={openIndex !== null ? images[openIndex].source : images[0].source}
        open={openIndex !== null}
        onOpenChange={(next) => setOpenIndex(next ? (openIndex ?? 0) : null)}
        images={images}
        index={openIndex ?? 0}
        onNavigate={setOpenIndex}
      />
    </>
  )
}
