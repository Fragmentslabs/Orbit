import { StorageKeys, type SpecialistProfile } from '@shared/chat'
import { readJson, writeJson } from '../storage'

/**
 * Which crafts the person already answered the specialist offer for, per conversation. "Continue
 * here" (or declining) has to hold for the life of the conversation, restarts included, or the
 * card would come back after every launch. One small record per conversation, removed with it.
 */

/** Serializes the read-modify-write per conversation: two tools can answer in the same step. */
const queues = new Map<string, Promise<unknown>>()

async function decidedCrafts(sessionId: string): Promise<SpecialistProfile[]> {
  const saved = await readJson<SpecialistProfile[]>(StorageKeys.specialistOffers(sessionId)).catch(() => null)
  return Array.isArray(saved) ? saved.filter((p): p is SpecialistProfile => typeof p === 'string') : []
}

export async function offerDecided(sessionId: string, profile: SpecialistProfile): Promise<boolean> {
  return (await decidedCrafts(sessionId)).includes(profile)
}

export function recordOfferDecision(sessionId: string, profile: SpecialistProfile): Promise<void> {
  const run = (queues.get(sessionId) ?? Promise.resolve()).then(async () => {
    const crafts = await decidedCrafts(sessionId)
    if (!crafts.includes(profile)) await writeJson(StorageKeys.specialistOffers(sessionId), [...crafts, profile])
  })
  queues.set(sessionId, run.catch(() => undefined))
  return run
}
