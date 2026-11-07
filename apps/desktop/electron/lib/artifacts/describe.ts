import { listChatArtifacts } from './chat-registry'
import { descriptorOf } from './kinds'

const MAX_LINES = 5

/**
 * What a chat made, in words a parent chat can act on: the kind, the name and how to reach it
 * from another conversation. The same for every kind of artifact. Artifacts that no longer
 * exist are left out.
 */
export async function describeChatArtifacts(sessionId: string): Promise<string[]> {
  const refs = await listChatArtifacts(sessionId).catch(() => [])
  const lines: string[] = []
  for (const ref of [...refs].reverse()) {
    if (lines.length >= MAX_LINES) break
    const descriptor = descriptorOf(ref.kind)
    const name = await descriptor.nameOf(ref.id).catch(() => null)
    if (!name) continue
    lines.push(`${ref.kind} "${name}" (id ${ref.id} — pass it as \`${descriptor.idArgument}\` to the ${ref.kind} tools to read or change it)`)
  }
  return lines
}
