import { useCallback } from "react"
import { useTranslation } from "react-i18next"
import { FolderPlus, X } from "lucide-react"
import { pickFolder } from "@/src/components/folder-selector"

/**
 * Warning card shown above the input when the user tries to send with
 * no folder attached in code mode — the same language as the
 * ProviderHintCard: sending does not stay silently disabled, the click is
 * intercepted (the text is preserved) and the card says the reason with the shortcut that
 * solves it. It goes away by itself when a folder is chosen.
 */
export function FolderHintCard({ visible, onPick, onDismiss }: {
  visible: boolean
  onPick: (folder: string) => void
  onDismiss: () => void
}) {
  const { t } = useTranslation()

  const choose = useCallback(async () => {
    const picked = await pickFolder()
    if (picked) onPick(picked)
  }, [onPick])

  if (!visible) return null

  return (
    <div className="pb-2">
      <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-foreground/80">
        <FolderPlus className="size-4 shrink-0 text-primary" />
        <span className="flex-1">{t("folderHint.hint")}</span>
        <button
          type="button"
          onClick={() => void choose()}
          className="shrink-0 rounded-md bg-foreground/10 px-2 py-1 font-medium text-foreground transition-colors hover:bg-foreground/20"
        >
          {t("folderHint.choose")}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("folderHint.dismiss")}
          className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  )
}
