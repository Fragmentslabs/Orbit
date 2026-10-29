/**
 * Citação de memória na resposta: `#orbit-memory/mem_xxx`.
 *
 * Mora no shared porque os dois renderers precisam ler o MESMO formato: o
 * desktop transforma o id num chip com aba do painel, o mobile numa folha com o
 * resumo — e um formato que divergisse entre eles produziria um link que abre
 * nada num dos dois, sem avisar. A parte de apresentação fica de cada lado.
 */

export const MEMORY_HREF = /^#orbit-memory\/(mem_[a-z0-9]+)$/i

export function parseMemoryHref(href: string): string | null {
  const match = MEMORY_HREF.exec(href.trim())
  return match ? match[1] : null
}

/**
 * Id de memória dentro de texto CRU — saída de ferramenta, não Markdown.
 *
 * `memory_search` e `memory_save` listam as memórias como `#mem_xxx`, e num
 * card de ferramenta esse id não diz nada. Aqui não há o que proteger (nem
 * fence, nem link montado): só o id. O `#` é consumido junto para não sobrar um
 * jornal solto na frente do chip.
 */
const RAW_MEMORY_ID = /(#?mem_[a-z0-9]{6,})\b/gi
const RAW_MEMORY_ID_EXACT = /^#?(mem_[a-z0-9]{6,})$/i

/** Pedaço de texto cru: ou uma sequência comum, ou um id já isolado. */
export type MemoryIdPart = string | { memoryId: string }

/**
 * Divide texto cru nos trechos entre ids de memória, com os ids isolados para
 * o renderer trocar cada um pelo chip. Existe separado dos componentes pelo
 * mesmo motivo do resto do arquivo: dá para testar sem UI.
 */
export function splitMemoryIds(text: string): MemoryIdPart[] {
  return (
    text
      .split(RAW_MEMORY_ID)
      // O split cria string vazia nas pontas quando o texto começa/termina num id.
      .filter((part) => part !== '')
      .map((part) => {
        const match = RAW_MEMORY_ID_EXACT.exec(part)
        return match ? { memoryId: match[1] } : part
      })
  )
}
