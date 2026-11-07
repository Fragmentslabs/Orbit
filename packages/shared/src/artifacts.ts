import type { SessionInfo, SpecialistProfile } from './chat'

/**
 * Artifacts: things a specialist agent builds and keeps editing (a fragment, a motion
 * composition, a design canvas). Every kind follows the SAME rules, so a new kind only has
 * to be declared once (see electron/lib/artifacts/kinds.ts) to get chat history, the embedded
 * chat and the sidebar rule. Nothing here is specific to one kind.
 */
export type ArtifactKind = SpecialistProfile

export const ARTIFACT_KINDS: readonly ArtifactKind[] = ['fragment', 'motion', 'design']

/** One artifact: its kind plus the id that kind uses (frag-…, mv_…, the design id). */
export interface ArtifactRef {
  kind: ArtifactKind
  id: string
}

/** The chats that worked on an artifact, oldest first, and the one its card is showing. */
export interface ArtifactChats {
  sessionIds: string[]
  current?: string
}

export interface ArtifactChatsEvent {
  ref: ArtifactRef
  chats: ArtifactChats
}

/** IPC channels of the artifact chat lists (one set for every kind). */
export const ARTIFACT_CHATS_CHANNELS = {
  list: 'artifact-chats:list',
  associate: 'artifact-chats:associate',
  setCurrent: 'artifact-chats:set-current',
  changed: 'artifact-chats:changed',
} as const

export const artifactKey = (ref: ArtifactRef): string => `${ref.kind}:${ref.id}`

/**
 * A chat made INSIDE an artifact (from its card). It belongs to the artifact, not to the
 * sidebar — which is split into Chat and Code and would hide it from one of them — so it
 * only shows there as a subchat of the chat it was born in. Reached through the artifact.
 */
export function isEmbeddedArtifactChat(session: Pick<SessionInfo, 'artifact' | 'fragment' | 'parentId'>): boolean {
  return Boolean(session.artifact || session.fragment) && !session.parentId
}
