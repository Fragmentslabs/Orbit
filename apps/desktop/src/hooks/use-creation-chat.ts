import { useCallback } from "react"
import { useTranslation } from "react-i18next"
import { useWorkspace } from "@/lib/workspace-context"
import { inheritChatSettings } from "@/src/lib/inherit-chat-settings"
import { useDraftInput } from "@/src/stores/draft-input"
import { useSessionStore } from "@/src/stores/session-store"

/** The things that are created by describing them in a chat and confirming a card. */
export type CreationKind = "routine" | "agent" | "skill" | "mcp" | "hook"

/**
 * "Create" for anything the chat can propose: opens a NEW chat with the first words already in the
 * composer — fields to fill, selected one by one with Tab. The person edits and sends; the agent
 * asks if the request is vague; a card in the conversation confirms (and opens the full form
 * with everything filled in, for who wants to adjust). One path for every kind, instead of a
 * one-shot modal that cannot ask anything back.
 */
export function useStartCreationChat(): (kind: CreationKind) => Promise<void> {
  const { t } = useTranslation()
  const startChat = useStartChatWith()
  return useCallback((kind) => startChat(t(`creation.${kind}.title`), t(`creation.${kind}.starter`)), [t, startChat])
}

/**
 * A new chat with a title and the first words already in the composer (fields to fill with Tab).
 * With `folders` the chat opens on them (the first is the working directory), so what the agent
 * tries there — a script that reads files — sees the same folders as the thing being edited.
 */
export function useStartChatWith(): (title: string, starter: string, folders?: readonly string[]) => Promise<void> {
  const { setMode, setView } = useWorkspace()
  return useCallback(
    async (title, starter, folders) => {
      const [directory, ...extraDirectories] = folders ?? []
      const session = await useSessionStore
        .getState()
        .createSession("chat", { title, ...(directory ? { directory, extraDirectories } : {}) })
      // Like any new chat, it starts from the last chat used (model, thinking, autonomy, modes).
      inheritChatSettings(session.id, "chat")
      useDraftInput.getState().setDraft(session.id, starter, undefined, { fields: true })
      setMode("chat")
      setView("chat")
    },
    [setMode, setView],
  )
}
