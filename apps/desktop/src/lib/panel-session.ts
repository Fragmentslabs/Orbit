/**
 * Which chat's side panel an artifact event belongs to.
 *
 * A specialist subchat creates its artifact under its own session id, but the person is
 * usually looking at the parent chat: a tab born in the child's bucket would stay hidden
 * until they opened the subchat. So the event is re-targeted along the parent chain:
 * the chat on screen wins when it is the subchat or one of its ancestors; otherwise the
 * topmost ancestor does (the sidebar chat the subchat hangs from).
 */
export function resolvePanelSession(
  sessionId: string,
  activeId: string | null,
  parentOf: (id: string) => string | undefined,
): string {
  const chain = [sessionId]
  const seen = new Set(chain)
  for (let id = parentOf(sessionId); id && !seen.has(id); id = parentOf(id)) {
    chain.push(id)
    seen.add(id)
  }
  if (activeId && chain.includes(activeId)) return activeId
  return chain[chain.length - 1]
}
