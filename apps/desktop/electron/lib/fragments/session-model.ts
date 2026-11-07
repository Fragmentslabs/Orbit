/**
 * The model a fragment's `orbit.ai` call uses: the one the user last chatted with.
 *
 * A fragment never chooses (nor sees) a provider, key or model — Orbit answers with
 * what the person is already using. Remembered from the chat sends, so it needs no
 * extra setting; before any message is sent there is simply no model yet.
 */
export interface RememberedModel {
  providerId: string
  modelId: string
}

const bySession = new Map<string, RememberedModel>()
let latest: RememberedModel | null = null

export function rememberSessionModel(sessionId: string, providerId: string, modelId: string): void {
  if (!providerId || !modelId) return
  const model = { providerId, modelId }
  bySession.set(sessionId, model)
  latest = model
}

/** The model of that chat, else the most recent one anywhere. */
export function modelForSession(sessionId?: string): RememberedModel | null {
  return (sessionId ? bySession.get(sessionId) : undefined) ?? latest
}
