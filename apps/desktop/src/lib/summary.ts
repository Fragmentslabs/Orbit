/**
 * Body of the compaction summary for the SCREEN. The header ("Summary of the
 * conversation so far:") is context for the model — the card's title already says
 * what it is. It holds for the current format, in English, and for the old summaries, which
 * were recorded with the header in Portuguese.
 */
export function summaryBody(text: string): string {
  return text.replace(/^\s*(Summary of the conversation so far|Resumo da conversa até aqui):\s*/, "")
}
