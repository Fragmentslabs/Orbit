/**
 * Splits the text into pieces for the streamed synthesis.
 *
 * The normal cut is at the END OF A SENTENCE — the `call()` of the engine inserts 0.3 s of
 * silence between the pieces, so a cut in the middle of a sentence would create a
 * pause where the speech does not have one. The `maxChars` is a TARGET, not a hard limit.
 *
 * A sentence ALONE above the target is split at the natural pause signals
 * (comma, semicolon, colon, em dash): that way the engine starts to
 * speak before synthesizing the whole sentence. This shortens the gap between one piece
 * and the next when the machine synthesizes slower than real time — the
 * audio of the first piece is still playing when the next one is ready.
 */
export function splitForStreaming(text, maxChars = 140) {
  const clean = String(text).replace(/\s+/g, " ").trim()
  if (!clean) return []
  // The target of 140 is good for the size of the piece, but bad for the latency of
  // call mode: the audio of the previous piece may end before its synthesis
  // is ready. 90 characters is the point where the engine usually stays ahead.
  const target = Math.min(maxChars, 90)
  const sentences = clean.match(/[^.!?…]+[.!?…]+[»”’")\]]*(?=\s|$)|[^.!?…]+$/g) || [clean]
  const pieces = []
  let current = ""
  for (const raw of sentences) {
    const sentence = raw.trim()
    if (!sentence) continue
    if (!current) current = sentence
    else if (current.length + 1 + sentence.length <= target) current += " " + sentence
    else {
      pieces.push(current)
      current = sentence
    }
  }
  if (current) pieces.push(current)

  const out = []
  for (const piece of pieces) {
    if (piece.length <= target) {
      out.push(piece)
      continue
    }
    const clauses = piece
      .split(/(?<=[,;:—])\s+/)
      .map((part) => part.trim())
      .filter(Boolean)
    // Without a natural pause, the sentence stays whole: cutting in the middle would be worse than
    // waiting for the synthesis to finish.
    if (clauses.length > 1) out.push(...clauses)
    else out.push(piece)
  }
  return out
}
