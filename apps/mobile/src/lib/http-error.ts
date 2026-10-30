/**
 * Error of the companion HTTP client → what to show on screen.
 *
 * `CompanionHttp` returns the raw body along with the status (`"503: {"error":…}"`),
 * and each route sends what it knows. The dictation sends the ready-made sentence, and that is
 * where `reasonFromHttpError` lives. Speech sends a CODE, not a sentence — the
 * translation happens on this side, where it is known in which language the person is reading.
 *
 * Both readers live in the same module because they read the same body.
 */
export function reasonFromHttpError(error?: string): string | null {
  if (!error) return null
  const jsonStart = error.indexOf('{')
  if (jsonStart < 0) return null
  try {
    const parsed = JSON.parse(error.slice(jsonStart)) as { error?: string; reason?: string }
    return parsed.reason || parsed.error || null
  } catch {
    return null
  }
}

/**
 * Code from the error body → code, without translation.
 *
 * The speech route answers `{"error":"tts_disabled"}` — a closed code, not
 * a sentence. Returns what came without judging: whoever knows which codes exist and
 * what sentence each one becomes is the screen. Unreadable body or no `error` → null, and
 * the screen falls back to the generic notice instead of showing a piece of JSON.
 */
export function errorCodeFromHttpError(error?: string): string | null {
  if (!error) return null
  const jsonStart = error.indexOf('{')
  if (jsonStart < 0) return null
  try {
    const parsed = JSON.parse(error.slice(jsonStart)) as { error?: unknown }
    return typeof parsed.error === 'string' && parsed.error.trim() ? parsed.error.trim() : null
  } catch {
    return null
  }
}
