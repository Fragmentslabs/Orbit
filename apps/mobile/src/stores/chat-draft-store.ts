const drafts = new Map<string, string>()

export function setInputDraft(sessionId: string, text: string) {
  drafts.set(sessionId, text)
}

export function getInputDraft(sessionId: string): string {
  return drafts.get(sessionId) ?? ''
}

export function clearInputDraft(sessionId: string) {
  drafts.delete(sessionId)
}
