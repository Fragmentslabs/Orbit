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
