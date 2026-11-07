import type { SessionMode } from "@shared/chat"
import { useDraftInput } from "@/src/stores/draft-input"
import { useSessionStore } from "@/src/stores/session-store"

export type CreationKind = "document" | "design" | "slides" | "motion"

/**
 * Opens a new chat with a ready-made message in the composer, without sending it: the person
 * fills the [fields] and presses Enter. The chat is opened first so the message lands in the
 * new conversation's input, and not in the one that was open.
 */
export async function startCreation(mode: SessionMode, text: string): Promise<void> {
  await useSessionStore.getState().selectSession(mode, null)
  useDraftInput.getState().setDraft(null, text, undefined, { fields: true })
}
