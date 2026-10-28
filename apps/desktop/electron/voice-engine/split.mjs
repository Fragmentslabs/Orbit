/**
 * Divide o texto em pedaços para a síntese em fluxo.
 *
 * O corte normal é em FIM DE FRASE — o `call()` do motor insere 0,3 s de
 * silêncio entre os pedaços, então um corte no meio de uma frase criaria uma
 * pausa onde a fala não tem uma. O `maxChars` é um ALVO, não um limite rígido.
 *
 * Uma frase SOZINHA acima do alvo é dividida nos sinais de pausa natural
 * (vírgula, ponto e vírgula, dois-pontos, travessão): assim o motor começa a
 * falar antes de sintetizar a frase inteira. Isso encurta o vão entre um pedaço
 * e o seguinte quando a máquina sintetiza mais devagar que o tempo real — o
 * áudio do primeiro pedaço ainda está tocando quando o próximo fica pronto.
 */
export function splitForStreaming(text, maxChars = 140) {
  const clean = String(text).replace(/\s+/g, " ").trim()
  if (!clean) return []
  // O alvo de 140 é bom para o tamanho do pedaço, mas ruim para a latência do
  // modo chamada: o áudio do pedaço anterior pode acabar antes de a síntese
  // dele pronta. 90 caracteres é o ponto em que o motor costuma ficar à frente.
  const target = Math.min(maxChars, 90)
  const sentences = clean.match(/[^.!?…]+[.!?…]+[»”’")\]]*(?=\s|$)|[^.!?…]+$/g) || [clean]
  const pieces = []
  let current = ""
  for (const raw of sentences) {
    const sentence = raw.trim()
    if (!sentence) continue
    if (!current) current = sentence
    else if (current.length + 1 + sentence.length <= target) current += " " + sentence
    else {
      pieces.push(current)
      current = sentence
    }
  }
  if (current) pieces.push(current)

  const out = []
  for (const piece of pieces) {
    if (piece.length <= target) {
      out.push(piece)
      continue
    }
    const clauses = piece
      .split(/(?<=[,;:—])\s+/)
      .map((part) => part.trim())
      .filter(Boolean)
    // Sem pausa natural, a frase fica inteira: cortar no meio seria pior que
    // esperar a síntese terminar.
    if (clauses.length > 1) out.push(...clauses)
    else out.push(piece)
  }
  return out
}
