/**
 * Saneamento do HTML que o mammoth gera a partir de um .docx de fora.
 *
 * Separado do resto para ser testável sem o Electron: é a parte do caminho
 * que responde pela segurança, e é a que mais precisa de teste.
 */

/** Esquemas que um link do documento pode ter. O resto vira âncora morta. */
const LINK_SEGURO = /^(https?:|mailto:|#)/i

export function sanitizeDocxHtml(html: string): string {
  return (
    html
      // O mammoth não escreve <script>, mas a garantia não pode depender disso.
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/<a\s+([^>]*?)href\s*=\s*"([^"]*)"([^>]*)>/gi, (_all, antes, href, depois) => {
        const alvo = LINK_SEGURO.test(href.trim()) ? href : '#'
        // target=_blank leva o clique ao setWindowOpenHandler do main, que só
        // abre http(s) no navegador do sistema e nega o resto — o documento
        // nunca navega o próprio painel.
        return `<a ${antes}href="${alvo}"${depois} target="_blank" rel="noreferrer">`
      })
  )
}
