/** Quanto da primeira linha entra no nome do anexo. */
export const PASTED_HINT_CHARS = 48

/**
 * A primeira linha com conteúdo de um texto colado, aparada como nome de
 * arquivo.
 *
 * Um paste vira fonte da conversa, e o nome do arquivo é o título que ela
 * recebe na aba Fontes: "Texto colado (1,4 KB).txt" repetido duas vezes não
 * distingue um log de um contrato, e a lista fica sem como escolher. A primeira
 * linha diz o que é.
 *
 * Separador de caminho e caractere de controle saem (isso vira nome de arquivo
 * no disco, não só rótulo) e a linha é cortada em PASTED_HINT_CHARS — o nome
 * final ainda leva o rótulo e o tamanho atrás.
 */
export function pastedTextHint(text: string): string {
  const first = text
    .split("\n")
    .map(line => line.trim())
    .find(line => line.length > 0) ?? ""

  const clean = first
    .replace(/[\\/:*?"<>|\p{Cc}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()

  if (clean.length <= PASTED_HINT_CHARS) return clean
  return `${clean.slice(0, PASTED_HINT_CHARS).trimEnd()}…`
}
