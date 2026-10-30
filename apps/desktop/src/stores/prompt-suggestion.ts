import { useAppSettings } from "@/src/stores/app-settings"
import { useSessionStore } from "@/src/stores/session-store"

/** Suggestion of the session's next message — only with the option on in the Preferences. */
export function usePromptSuggestion(sessionId: string | undefined): string | undefined {
  const enabled = useAppSettings((s) => s.settings.promptSuggestions)
  const suggestion = useSessionStore((s) => (sessionId ? s.suggestions[sessionId] : undefined))
  return enabled ? suggestion : undefined
}
