import { useAppSettings } from "@/src/stores/app-settings"
import { useSessionStore } from "@/src/stores/session-store"

/** Sugestão de próxima mensagem da sessão — só com a opção ligada nas Preferências. */
export function usePromptSuggestion(sessionId: string | undefined): string | undefined {
  const enabled = useAppSettings((s) => s.settings.promptSuggestions)
  const suggestion = useSessionStore((s) => (sessionId ? s.suggestions[sessionId] : undefined))
  return enabled ? suggestion : undefined
}
