/**
 * O que recarregar quando o watcher avisa que a pasta do canvas mudou.
 *
 * O main manda a LISTA de arquivos que mudaram (ver design-store.ts) — é o que
 * permite recarregar só o artboard que o agente gravou, em vez de remontar
 * todos os iframes a cada gravação. Este módulo é a tradução dessa lista para
 * as duas abas que a recebem (o editor e a apresentação), puro e testável.
 */

const isBoardFile = (file: string) => /\.html?$/i.test(file)
const isIndexFile = (file: string) => file.toLowerCase().endsWith('canvas.json')

export interface DesignReloadPlan {
  /** O `canvas.json` pode ter mudado: re-ler o índice (telas novas, removidas,
   *  movidas). */
  index: boolean
  /** Artboards que mudaram de fato, com o nome que está no canvas.json. */
  boards: string[]
  /** Mudança fora dos artboards (CSS, imagem, fonte da pasta): qualquer tela
   *  pode ter mudado de aparência, então todas recarregam. */
  all: boolean
}

/**
 * Sem lista — plataforma em que o `fs.watch` não informa o nome, ou um evento
 * que ele não soube descrever — não dá para ser cirúrgico: recarrega tudo, como
 * era antes do watcher mandar os nomes.
 */
export function planDesignReload(files: string[] | undefined): DesignReloadPlan {
  const list = files ?? []
  if (list.length === 0) return { index: true, boards: [], all: true }
  return {
    index: list.some(isIndexFile),
    boards: list.filter(isBoardFile),
    all: list.some((file) => !isBoardFile(file) && !isIndexFile(file)),
  }
}
