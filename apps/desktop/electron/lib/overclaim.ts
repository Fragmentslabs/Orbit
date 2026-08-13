/**
 * Detecção de overclaim: a resposta AFIRMA ter feito o trabalho?
 *
 * É só o GATILHO da verificação, nunca a prova — quem decide se houve trabalho
 * é o snapshot do filesystem (chat-engine: verifyTurn). Por isso o custo de um
 * falso positivo é baixo: uma ida a mais ao modelo, que confirma e segue.
 *
 * Módulo separado e sem dependência do Electron de propósito: é heurística de
 * linguagem, a parte mais fácil de errar em silêncio, e assim fica coberta por
 * teste sem precisar carregar o app.
 */

/**
 * Verbos de conclusão em 1ª pessoa (pt/en). Só verbos de ação: particípios
 * soltos ("criado", "feito") aparecem em frases descritivas inofensivas como
 * "o arquivo criado anteriormente já cobre esse caso".
 */
const COMPLETION_CLAIM =
  /\b(criei|adicionei|implementei|corrigi|ajustei|atualizei|removi|apaguei|renomeei|movi|refatorei|alterei|modifiquei|escrevi|gerei|configurei|created|added|implemented|fixed|updated|removed|deleted|renamed|moved|refactored|changed|modified|wrote|applied)\b/gi

/** Negação logo antes do verbo, na mesma oração. */
const NEGATION_BEFORE =
  /\b(n[aã]o|nenhum[ao]?|nunca|jamais|sem|didn'?t|did\s+not|couldn'?t|could\s+not|won'?t|will\s+not|haven'?t|have\s+not|no)\b[\s\w,]{0,24}$/i

/** Janela de texto anterior ao verbo onde a negação ainda conta. */
const NEGATION_WINDOW = 40

/**
 * Tratar negação é obrigatório: "analisei e não alterei nada" — a resposta
 * honesta que o próprio prompt exige — seria lida como overclaim, e o agente
 * levaria uma cobrança justamente por ter sido franco.
 *
 * Basta uma ocorrência NÃO negada para valer como afirmação: em "implementei X,
 * mas não alterei Y" a primeira continua valendo.
 */
export function claimsCompletion(text: string): boolean {
  for (const match of text.matchAll(COMPLETION_CLAIM)) {
    const index = match.index ?? 0
    if (!NEGATION_BEFORE.test(text.slice(Math.max(0, index - NEGATION_WINDOW), index))) return true
  }
  return false
}
