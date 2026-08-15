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
 * Card de aviso: o usuário anexou uma imagem (pendente no input OU já enviada)
 * e o modelo atual não tem visão e o modo Visão não está configurado — a
 * imagem não chega ao modelo. Oferece o atalho para abrir a configuração do
 * modo Visão. Descartável por sessão (uma nova imagem anexada reexibe o aviso).
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
  // Imagem anexada no input, ainda não enviada (sync feito pelo PendingAttachmentSync)
  const hasPendingImage = usePendingAttachmentsStore((s) => !!s.imagesByKey[sessionId ?? "draft"])

  // Só avalia a sessão ativa do modo (cards do painel lateral não mostram o aviso)
  const isActive = !sessionId || sessionId === activeSessionId
  const modelVision = selected ? modelSupportsVision(catalog[selected.providerId], selected.modelId) : true

  const lastImage = isActive && messages
    ? [...messages].reverse().find((m): m is ChatMessage & { parts: (FilePart | { type: string })[] } =>
        m.role === "user" && m.parts.some((p) => p.type === "file" && (p as FilePart).mime.startsWith("image/")),
      )
    : undefined

  // Aviso descartado só vale para a imagem atual: anexar uma nova reexibe o card
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
