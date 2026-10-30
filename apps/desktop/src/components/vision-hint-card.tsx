import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Eye, X } from "lucide-react"
import { modelSupportsVision } from "@shared/chat"
import { useSessionModel } from "@/src/stores/session-model-prefs"
import { useProviderStore } from "@/src/stores/provider-store"
import { useModeActive } from "@/src/stores/mode-overrides"
import { useModelModePrefs } from "@/src/stores/model-mode-prefs"
import { useSessionStore } from "@/src/stores/session-store"
import { usePendingAttachmentsStore } from "@/src/stores/pending-attachments"
import { useWorkspace } from "@/lib/workspace-context"
import type { ChatMessage, FilePart } from "@shared/chat"

/**
 * Warning card: the user attached an image (pending in the input OR already sent)
 * and the current model has no vision and Vision mode is not configured — the
 * image does not reach the model. It offers the shortcut to open the Vision
 * mode settings. Dismissible per session (a new attached image shows the notice again).
 */
export function VisionHintCard({ sessionId }: { sessionId?: string }) {
  const { t } = useTranslation()
  const { mode } = useWorkspace()
  const [dismissed, setDismissed] = useState(false)

  const selected = useSessionModel(sessionId)
  const catalog = useProviderStore((s) => s.catalog)
  const modeDefaults = useModelModePrefs((s) => (mode === "code" ? s.codeActiveModes : s.chatActiveModes))
  const visionEnabled = useModeActive("vision", sessionId, modeDefaults.vision)
  const setVisionConfigOpen = useProviderStore((s) => s.setVisionConfigOpen)
  const activeSessionId = useSessionStore((s) => s.activeIds[mode])
  const messages = useSessionStore((s) => (sessionId ? s.messages[sessionId] : undefined))
  // Image attached in the input, not sent yet (sync done by PendingAttachmentSync)
  const hasPendingImage = usePendingAttachmentsStore((s) => !!s.imagesByKey[sessionId ?? "draft"])

  // It only evaluates the active session of the mode (side panel cards do not show the notice)
  const isActive = !sessionId || sessionId === activeSessionId
  const modelVision = selected ? modelSupportsVision(catalog[selected.providerId], selected.modelId) : true

  const lastImage = isActive && messages
    ? [...messages].reverse().find((m): m is ChatMessage & { parts: (FilePart | { type: string })[] } =>
        m.role === "user" && m.parts.some((p) => p.type === "file" && (p as FilePart).mime.startsWith("image/")),
      )
    : undefined

  // A dismissed notice only counts for the current image: attaching a new one shows the card again
  useEffect(() => {
    if (hasPendingImage) setDismissed(false)
  }, [hasPendingImage])

  const showCard = isActive && !modelVision && !visionEnabled && !dismissed && (hasPendingImage || lastImage)
  if (!showCard) return null

  return (
    <div className="mx-auto w-full max-w-2xl pb-2">
      <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-foreground/80">
        <Eye className="size-4 shrink-0 text-primary" />
        <span className="flex-1">{t("vision.hint")}</span>
        <button
          type="button"
          onClick={() => setVisionConfigOpen(true)}
          className="shrink-0 rounded-md bg-foreground/10 px-2 py-1 font-medium text-foreground transition-colors hover:bg-foreground/20"
        >
          {t("vision.configure")}
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label={t("vision.dismiss")}
          className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  )
}
