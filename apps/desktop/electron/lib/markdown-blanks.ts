/**
 * Campos para preencher que somem na visualização.
 *
 * `____/____/______` não chega inteiro na tela: em Markdown, `__` é negrito, e
 * dois grupos na mesma linha viram abre-e-fecha. "Data: ____/____/______" é
 * renderizado como "Data: //______" — os underscores são consumidos como
 * marcação e o que sobra é a barra. Não é bug do Orbit nem do renderizador: é
 * a regra da linguagem, e vale igual no PDF e no DOCX, que saem do mesmo
 * Markdown.
 *
 * Um grupo sozinho (`**Escola:** ____________`) passa intacto, porque não há
 * segundo grupo para fechar a ênfase. Por isso o aviso é sobre a LINHA com
 * mais de um grupo, e não sobre underscore em geral.
 *
 * O documento é gravado do mesmo jeito: quem escreveu foi o agente, e reescrever
 * o texto dele por conta própria seria decidir no lugar de quem pediu. O que
 * volta é o aviso, com a linha e a correção — que é o que o modelo lê e
 * conserta na chamada seguinte.
 */

/** Dois ou mais grupos de underscores separados só por pontuação: a cara de um
 *  campo de data, telefone ou CPF. Texto entre os grupos (o `__negrito__` de
 *  verdade) tem letra, e não entra aqui. */
const CAMPO_QUEBRADO = /_{2,}[^\w\s_]+_{2,}/u

export function underscoreBlankWarning(markdown: string): string | null {
  const linhas = markdown.split(/\r?\n/)
  const atingidas: number[] = []
  for (let i = 0; i < linhas.length; i++) {
    if (CAMPO_QUEBRADO.test(linhas[i])) atingidas.push(i + 1)
  }
  if (atingidas.length === 0) return null

  const onde =
    atingidas.length === 1
      ? `a linha ${atingidas[0]}`
      : `as linhas ${atingidas.slice(0, 5).join(', ')}${atingidas.length > 5 ? '…' : ''}`
  return (
    `Atenção: ${onde} tem campos como "____/____/____", e em Markdown dois grupos de ` +
    'underscores viram negrito — o usuário vai ver "//" no lugar do campo, na tela e no ' +
    'PDF. Escreva "\\_\\_\\_\\_/\\_\\_\\_\\_/\\_\\_\\_\\_" (escapados) ou separe com espaço ' +
    '("____ / ____ / ____") e chame update_document de novo.'
  )
}
