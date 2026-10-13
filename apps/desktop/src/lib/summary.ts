/**
 * Corpo do resumo de compactação para a TELA. O cabeçalho ("Summary of the
 * conversation so far:") é contexto para o modelo — o título do card já diz o
 * que é. Vale para o formato atual, em inglês, e para os resumos antigos, que
 * foram gravados com o cabeçalho em português.
 */
export function summaryBody(text: string): string {
  return text.replace(/^\s*(Summary of the conversation so far|Resumo da conversa até aqui):\s*/, "")
}
