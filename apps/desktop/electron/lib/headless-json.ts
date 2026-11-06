import { streamText } from 'ai'
import type { RoutineModel } from '@shared/routines'
import { getProvider } from './catalog'
import { resolveModel } from './providers'
import { interleavedReasoningField, normalizeMessages } from './reasoning'

/**
 * One question, one JSON answer — no chat, no tools. It is what the "ask Orbit to
 * create it" dialogs (routine, hook, skill, MCP server) run: the model only
 * SUGGESTS, and whatever comes back is shown to the user for review before anything
 * is saved.
 */

const MAX_OUTPUT = 20_000

/** Extracts the JSON object from the reply (models insist on fences or prose). */
export function extractJson(text: string): Record<string, unknown> | null {
  const withoutFence = text.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1')
  const start = withoutFence.indexOf('{')
  const end = withoutFence.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(withoutFence.slice(start, end + 1))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** The common context lines of every generator prompt. */
export function contextLines(folders: string[], language?: string, extra: string[] = []): string {
  return [
    folders.length ? `Working folders: ${folders.join(', ')}` : 'Working folders: (none selected)',
    ...extra,
    language ? `User language: ${language}` : null,
  ]
    .filter(Boolean)
    .join('\n')
}

export async function askModelForJson(
  system: string,
  user: string,
  model: RoutineModel,
): Promise<{ ok: true; raw: Record<string, unknown> } | { ok: false; error: string }> {
  const provider = await getProvider(model.providerId)
  let output = ''
  try {
    const resolved = await resolveModel(model.providerId, model.modelId)
    const stream = streamText({
      model: resolved,
      system,
      messages: normalizeMessages(
        [{ role: 'user', content: user }],
        interleavedReasoningField(provider, model.modelId),
      ),
      onError: () => {
        /* handled below by the accumulated error */
      },
    })
    for await (const part of stream.fullStream) {
      if (part.type === 'text-delta') {
        output += part.text
        if (output.length > MAX_OUTPUT) break
      } else if (part.type === 'error') {
        return { ok: false, error: part.error instanceof Error ? part.error.message : String(part.error) }
      }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  const raw = extractJson(output)
  if (!raw) return { ok: false, error: 'The model did not return valid JSON. Try again or switch models.' }
  return { ok: true, raw }
}
