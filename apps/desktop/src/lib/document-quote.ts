import { DOCUMENT_QUOTE_MIME, type FilePart } from "@shared/chat"
import type { DocumentQuote } from "@/src/stores/panel-store"

/**
 * Trecho citado → anexo da mensagem.
 *
 * Os dois compositores (chat e código) precisam disso na hora de enviar, e o
 * formato tem que ser idêntico nos dois: quem lê do outro lado é um `if` só no
 * preprocessAttachment do engine. Duplicar a serialização seria a forma mais
 * fácil de eles divergirem sem ninguém perceber.
 */

/** Onde o trecho está, no formato curto que o chip e o nome do anexo usam. */
export function quoteLocationLabel(quote: DocumentQuote): string {
  if (!quote.page) return ""
  if (!quote.fromLine) return ` p${quote.page}`
  const ate = quote.toLine && quote.toLine > quote.fromLine ? `-${quote.toLine}` : ""
  return ` p${quote.page}L${quote.fromLine}${ate}`
}

export function quotesToFileParts(quotes: DocumentQuote[]): FilePart[] {
  return quotes.map((quote) => {
    const payload = encodeURIComponent(
      JSON.stringify({
        kind: quote.kind,
        docId: quote.docId,
        name: quote.name,
        page: quote.page,
        fromLine: quote.fromLine,
        toLine: quote.toLine,
        text: quote.text,
      }),
    )
    return {
      id: quote.id,
      type: "file",
      mime: DOCUMENT_QUOTE_MIME,
      filename: `${quote.name}${quoteLocationLabel(quote)}`,
      url: `data:${DOCUMENT_QUOTE_MIME},${payload}`,
    }
  })
}

/**
 * Em que linhas da página está o trecho selecionado.
 *
 * Serve ao modo Original do PDF, onde a seleção acontece sobre a camada de
 * texto desenhada por cima da imagem: ali os pedaços são posições de glifos,
 * não linhas, e não existe número de linha no DOM para ler. O caminho é achar
 * o texto de volta na MESMA lista de linhas que o modelo enxerga — que é o
 * que garante que a citação leve à linha certa.
 *
 * A comparação ignora espaços pelo mesmo motivo do `locateText` do PDF: o
 * arquivo quebra a frase em pedaços e a posição dos espaços entre eles não é
 * confiável. Junta tudo, procura junto, e traduz o deslocamento de volta em
 * número de linha.
 */
export function locateLines(
  lines: string[],
  needle: string,
): { fromLine: number; toLine?: number } | null {
  const squash = (text: string) => text.replace(/\s+/g, "").toLowerCase()
  const target = squash(needle)
  if (target.length < 2) return null

  let flat = ""
  const spans: { from: number; to: number; line: number }[] = []
  for (let i = 0; i < lines.length; i++) {
    const piece = squash(lines[i])
    if (!piece) continue
    spans.push({ from: flat.length, to: flat.length + piece.length, line: i + 1 })
    flat += piece
  }

  const at = flat.indexOf(target)
  if (at < 0) return null
  const end = at + target.length

  const fromLine = spans.find((s) => at < s.to)?.line
  if (!fromLine) return null
  const toLine = [...spans].reverse().find((s) => end > s.from)?.line
  return { fromLine, toLine: toLine && toLine > fromLine ? toLine : undefined }
}
