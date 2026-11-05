import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { XIcon } from "lucide-react"
import { Image } from "@/src/components/ai/image"

/**
 * orbit-media:// URLs in a text (e.g. the screenshot manifest the agent pastes
 * into the task description). Same id format as the protocol in the main
 * process (media.ts: SAFE_ID) — no path traversal: image files only.
 */
const MEDIA_URL_RE = /orbit-media:\/\/[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp|gif)/g

export function extractMediaUrls(text: string): string[] {
  return Array.from(new Set(text.match(MEDIA_URL_RE) ?? []))
}

/**
 * Grid of the orbit-media:// images present in a text. The task description
 * keeps the URLs as text (that is what the phases receive); here they actually
 * show up, with a lightbox on click, just like the chat images.
 */
export function MediaEmbed({ text, onRemove }: { text: string; onRemove?: (url: string) => void }) {
  const { t } = useTranslation()
  const urls = useMemo(() => extractMediaUrls(text), [text])
  if (urls.length === 0) return null
  return (
    <div className="mt-2 grid grid-cols-2 gap-2">
      {urls.map((url) => (
        <div key={url} className="group relative">
          <Image src={url} className="!my-0" />
          {onRemove && (
            <button
              type="button"
              aria-label={t("pipeline.removeImage")}
              title={t("pipeline.removeImage")}
              onClick={() => onRemove(url)}
              className="absolute right-1 top-1 hidden size-5 cursor-pointer items-center justify-center rounded-full bg-background/90 text-muted-foreground shadow hover:text-destructive group-hover:flex"
            >
              <XIcon className="size-3" />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
