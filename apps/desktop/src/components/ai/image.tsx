import { useState } from "react"
import { ImageOff } from "lucide-react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
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
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState(false)

  if (failed) {
    return (
      <div className="not-prose my-2 flex w-fit items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
        <ImageOff className="size-3.5" />
        Imagem indisponível{alt ? ` — ${alt}` : ""}
      </div>
    )
  }

  return (
    <>
      <figure className={cn("not-prose my-2 w-fit max-w-full", className)}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          title="Ampliar imagem"
          className="block cursor-zoom-in overflow-hidden rounded-lg border bg-muted/30 transition-colors hover:border-ring"
        >
          <img
            src={src}
            alt={alt ?? "Imagem do assistente"}
            loading="lazy"
            onError={() => setFailed(true)}
            className="max-h-80 w-auto max-w-full object-contain"
          />
        </button>
        {alt && (
          <figcaption className="mt-1 px-0.5 text-[11px] text-muted-foreground">{alt}</figcaption>
        )}
      </figure>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-5xl p-2">
          <DialogTitle className="sr-only">{alt ?? "Imagem do assistente"}</DialogTitle>
          <img
            src={src}
            alt={alt ?? "Imagem do assistente"}
            className="max-h-[82vh] w-full rounded-md object-contain"
          />
          {alt && <p className="px-1 pb-1 text-center text-xs text-muted-foreground">{alt}</p>}
        </DialogContent>
      </Dialog>
    </>
  )
}

/** Render direto de uma ImagePart de mensagem do assistente. */
export function ImagePartView({ part }: { part: ImagePart }) {
  return <Image src={part.src} alt={part.alt} />
}
