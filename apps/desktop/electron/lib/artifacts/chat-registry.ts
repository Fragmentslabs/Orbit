import { EventEmitter } from 'node:events'
import type { ArtifactChats, ArtifactChatsEvent, ArtifactRef } from '@shared/artifacts'
import { ARTIFACT_KINDS } from '@shared/artifacts'
import { StorageKeys } from '@shared/chat'
import { withAssetLock } from '../asset-lock'
import { readJson, writeJson } from '../storage'

/**
 * Which chats worked on which artifact. One record per artifact, the same for every kind:
 * the chats in the order they joined, and the one the artifact's card is showing.
 *
 * It is the only place that holds this — an artifact's own files never carry it, so an
 * exported artifact does not bring along the chats of the Orbit that made it.
 */

const MAX_CHATS = 50
const SAFE_ID = /^[a-zA-Z0-9_-]+$/

export const artifactChatEvents = new EventEmitter()

function keyOf(ref: ArtifactRef): string {
  if (!ARTIFACT_KINDS.includes(ref.kind) || !SAFE_ID.test(ref.id)) throw new Error('invalid artifact')
  return StorageKeys.artifactChats(ref.kind, ref.id)
}

export async function listArtifactChats(ref: ArtifactRef): Promise<ArtifactChats> {
  const saved = await readJson<ArtifactChats>(keyOf(ref))
  const sessionIds = Array.isArray(saved?.sessionIds) ? saved.sessionIds.filter((s) => typeof s === 'string') : []
  const current = typeof saved?.current === 'string' && sessionIds.includes(saved.current) ? saved.current : undefined
  return { sessionIds, current }
}

async function save(ref: ArtifactRef, chats: ArtifactChats): Promise<ArtifactChats> {
  await writeJson(keyOf(ref), chats)
  artifactChatEvents.emit('changed', { ref, chats } satisfies ArtifactChatsEvent)
  return chats
}

/** Serializes the read-modify-write of one record: two chats can finish a tool at once. */
const serialized = <T>(key: string, task: () => Promise<T>): Promise<T> => withAssetLock(`artifact-chats:${key}`, task)

/**
 * A chat worked on the artifact. It joins the list once; it becomes the current one only when
 * there is none yet (the first chat is the artifact's author, and later ones do not steal
 * the card from the person).
 */
export function associateChat(ref: ArtifactRef, sessionId: string, options: { makeCurrent?: boolean } = {}): Promise<ArtifactChats> {
  return serialized(keyOf(ref), async () => {
    const chats = await listArtifactChats(ref)
    const joined = chats.sessionIds.includes(sessionId)
    if (!joined) await indexChat(sessionId, ref)
    const makeCurrent = options.makeCurrent || !chats.current
    if (joined && (!makeCurrent || chats.current === sessionId)) return chats
    return save(ref, {
      sessionIds: joined ? chats.sessionIds : [...chats.sessionIds, sessionId].slice(-MAX_CHATS),
      current: makeCurrent ? sessionId : chats.current,
    })
  })
}

/**
 * The way back: which artifacts a chat has worked on. A parent chat uses it to tell what
 * its specialist subchats made (see describe.ts). Written in the same place as the list above,
 * so the two cannot disagree.
 */
const chatIndexKey = (sessionId: string): string => {
  if (!SAFE_ID.test(sessionId)) throw new Error('invalid chat')
  return StorageKeys.artifactsOfChat(sessionId)
}

function indexChat(sessionId: string, ref: ArtifactRef): Promise<void> {
  const key = chatIndexKey(sessionId)
  return serialized(`chat:${key}`, async () => {
    const saved = (await readJson<ArtifactRef[]>(key)) ?? []
    if (saved.some((r) => r.kind === ref.kind && r.id === ref.id)) return
    await writeJson(key, [...saved, ref].slice(-MAX_CHATS))
  })
}

export async function listChatArtifacts(sessionId: string): Promise<ArtifactRef[]> {
  const saved = await readJson<ArtifactRef[]>(chatIndexKey(sessionId))
  return Array.isArray(saved)
    ? saved.filter((r) => r && ARTIFACT_KINDS.includes(r.kind) && typeof r.id === 'string' && SAFE_ID.test(r.id))
    : []
}

/** The person picked a chat in the card. */
export function setCurrentChat(ref: ArtifactRef, sessionId: string): Promise<ArtifactChats> {
  return associateChat(ref, sessionId, { makeCurrent: true })
}
