/**
 * Figuras de um Markdown lido do disco.
 *
 * O preview roda na origem do app, então um `./imagens/x.png` resolveria
 * contra ela e não contra o arquivo aberto — a imagem aparecia quebrada em
 * todo documento que referencia figura. O main resolve os caminhos contra a
 * pasta do arquivo e devolve data URLs; o que este módulo faz é achar o que
 * perguntar e trocar depois.
 *
 * São três formas, que são as que aparecem em documentação:
 *   ![alt](caminho "titulo")      — a comum
 *   ![alt](<caminho com espaço>)  — a de caminho com espaço
 *   <img src="caminho">           — HTML solto no meio do texto
 *
 * A forma com <> precisa de regex própria: o caminho dela pode ter espaço, e
 * a regex comum para de propósito no primeiro branco (senão engoliria o
 * "titulo" que vem depois).
 */
const MD_IMAGE_ANGLE = /(!\[[^\]]*\]\(\s*<)([^>]+)(?=>)/g
const MD_IMAGE_PLAIN = /(!\[[^\]]*\]\(\s*)([^)<\s]+)/g
const HTML_IMAGE_SRC = /(<img\b[^>]*?\bsrc\s*=\s*["'])([^"']+)/gi

const PATTERNS = [MD_IMAGE_ANGLE, MD_IMAGE_PLAIN, HTML_IMAGE_SRC]

/** Endereço que o renderer já sabe carregar sozinho — http, data, orbit-*. */
export function isExternalSrc(src: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//")
}

/** Os caminhos relativos referenciados, sem repetição. */
export function markdownImageSources(markdown: string): string[] {
  const found = new Set<string>()
  for (const re of PATTERNS) {
    // O regex é global e guarda posição entre chamadas: sem zerar, a segunda
    // leitura do mesmo texto começaria do meio.
    re.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = re.exec(markdown))) {
      const src = match[2]
      if (src && !isExternalSrc(src)) found.add(src)
    }
  }
  return [...found]
}

/**
 * Troca os caminhos relativos pelos data URLs resolvidos.
 *
 * O que não está no mapa fica como veio: figura que não existe no repositório
 * continua quebrada, e é assim que se percebe que ela falta.
 */
export function withResolvedImages(
  markdown: string,
  resolved: Record<string, string>,
): string {
  if (Object.keys(resolved).length === 0) return markdown
  const swap = (_all: string, head: string, src: string) => `${head}${resolved[src] ?? src}`
  return PATTERNS.reduce((text, re) => text.replace(re, swap), markdown)
}
