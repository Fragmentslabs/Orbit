import { useCallback } from 'react'
import { useRouter } from 'expo-router'
import { useTranslation } from 'react-i18next'
import { useDraftInput } from '~/stores/draft-input-store'
import { useSessionStore } from '~/stores/session-store'

/** What can be created by describing it in a chat (mirror of the desktop's `use-creation-chat`). */
export type CreationKind = 'routine' | 'pipeline' | 'skill' | 'mcp'

/** The pipeline only exists in code mode; the others are born in a plain chat. */
const MODE_OF: Record<CreationKind, 'chat' | 'code'> = { routine: 'chat', pipeline: 'code', skill: 'chat', mcp: 'chat' }

/**
 * "Create" for the lists: opens a NEW chat with the first words already in the composer. The person
 * completes and sends; the agent asks if the request is vague and a card in the conversation
 * confirms. With `text` the chat opens with that text instead of the starter (an example chip, or what
 * was typed in the dock of the list).
 */
export function useStartCreationChat(): (kind: CreationKind, text?: string) => Promise<void> {
  const { t } = useTranslation()
  const router = useRouter()
  const createSession = useSessionStore((s) => s.createSession)

  return useCallback(
    async (kind, text) => {
      const draft = text?.trim() || t(`creation.${kind}.starter`)
      try {
        const created = await createSession(MODE_OF[kind], t(`creation.${kind}.sheetTitle`))
        if (created) {
          // The draft goes straight to the NEW session's key. Parking it under the "no session" key
          // first would hand it to the home composer, which is still mounted under this screen
          // and takes it at once — the new chat would open empty and the text would only show up
          // in the next "new chat".
          useDraftInput.getState().setDraft(created.id, draft)
          router.push(`/(main)/chat/${created.id}`)
          return
        }
      } catch {
        // falls through to the home chat below
      }
      // No connection or the creation failed: the text waits in the home chat's composer.
      useDraftInput.getState().setDraft(null, draft)
      router.replace('/(main)')
    },
    [createSession, router, t],
  )
}
