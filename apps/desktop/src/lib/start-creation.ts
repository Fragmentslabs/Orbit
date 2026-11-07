import type { SessionMode, SpecialistProfile } from "@shared/chat"
import { useDraftInput } from "@/src/stores/draft-input"
import { useSessionStore } from "@/src/stores/session-store"

export type CreationKind = "document" | "design" | "slides" | "motion"

/** The pieces that have a specialist agent: starting one also picks that agent for the new chat. */
const CREATION_AGENT: Partial<Record<CreationKind, SpecialistProfile>> = {
  design: "design",
  motion: "motion",
}

/**
 * Opens a new chat with a ready-made message in the composer, without sending it: the person
 * fills the [fields] and presses Enter. The chat is opened first so the message lands in the
 * new conversation's input, and not in the one that was open.
 */
export async function startCreation(mode: SessionMode, kind: CreationKind, text: string): Promise<void> {
  const store = useSessionStore.getState()
  await store.selectSession(mode, null)
  // Opening a new chat resets the agent; the piece being created then picks its own, so the
  // header already shows it.
  store.setPendingProfile(CREATION_AGENT[kind] ?? null)
  useDraftInput.getState().setDraft(null, text, undefined, { fields: true, template: kind })
}
