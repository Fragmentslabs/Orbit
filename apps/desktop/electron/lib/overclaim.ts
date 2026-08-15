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

/**
 * Particípios ingleses são ambíguos: "added"/"created" aparecem em descrições
 * passivas de código existente ("the group is added in Sidebar.tsx") e em
 * citações de commits. Só contam como afirmação do agente quando há sujeito
 * de 1ª pessoa na janela anterior ("I added", "the file I created"). Os
 * verbos portugueses da lista já são 1ª pessoa (criei, implementei…) e não
 * passam por esse filtro.
 */
const ENGLISH_PARTICIPLE =
  /\b(created|added|implemented|fixed|updated|removed|deleted|renamed|moved|refactored|changed|modified|wrote|applied)\b/i

const FIRST_PERSON = /\bI\b/i

/** Negação logo antes do verbo, na mesma oração. */
const NEGATION_BEFORE =
  /\b(n[aã]o|nenhum[ao]?|nunca|jamais|sem|didn'?t|did\s+not|couldn'?t|could\s+not|won'?t|will\s+not|haven'?t|have\s+not|no)\b[\s\w,]{0,24}$/i

/** Janela de texto anterior ao verbo onde a negação ainda conta. */
const NEGATION_WINDOW = 40

/**
 * Marcas explícitas de que a afirmação descreve trabalho de TURNOS ANTERIORES
 * (perguntas informativas, resumos de "o que mudou"): fala do que já foi feito
 * antes, não do que foi feito neste turno — não é overclaim deste turno e não
 * deve disparar a cobrança.
 */
const PAST_TURN =
  /\b(turno|troca|resposta|mensagem|pergunta)\s+(anterior|passad[oa])\b|\b(ontem|anteriormente)\b|\b(semana|m[êe]s|ano)\s+passad[oa]\b|\b(previous|earlier|last)\s+(turn|response|answer|message)\b|\b(previously|yesterday)\b/i

/** Extrai a sentença que contém o índice dado (heurística simples, sem NLP). */
function sentenceContaining(text: string, index: number): string {
  for (const match of text.matchAll(/[^.!?\n]+[.!?]*/g)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    if (index >= start && index < end) return match[0]
  }
  return text
}

/**
 * Remove trechos de código (fenced ```…``` e inline `…`) antes de casar os
 * verbos: citações de identificadores, campos e comandos ("o campo `added`",
 * "`groups.push(...)`") não são afirmações do agente sobre o próprio trabalho.
 */
function stripCode(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
}

/**
 * Tratar negação é obrigatório: "analisei e não alterei nada" — a resposta
 * honesta que o próprio prompt exige — seria lida como overclaim, e o agente
 * levaria uma cobrança justamente por ter sido franco.
 *
 * Basta uma ocorrência NÃO negada para valer como afirmação: em "implementei X,
 * mas não alterei Y" a primeira continua valendo.
 */
export function claimsCompletion(text: string): boolean {
  const clean = stripCode(text)
  for (const match of clean.matchAll(COMPLETION_CLAIM)) {
    const index = match.index ?? 0
    // "adicionei X no turno anterior" descreve trabalho passado, não este
    // turno — a sentença é ignorada antes mesmo da checagem de negação.
    if (PAST_TURN.test(sentenceContaining(clean, index))) continue
    const window = clean.slice(Math.max(0, index - NEGATION_WINDOW), index)
    if (NEGATION_BEFORE.test(window)) continue
    // Particípio inglês sem "I" na janela = voz passiva/descrição de código
    // ("was added", "is created") — não é o agente afirmando o próprio
    // trabalho.
    if (ENGLISH_PARTICIPLE.test(match[0]) && !FIRST_PERSON.test(window)) continue
    return true
  }
  return false
}

/**
 * A resposta à cobrança do nudge foi SÓ a confirmação de que não havia nada a
 * corrigir (falso positivo do gatilho — ex.: o texto descrevia trabalho de um
 * turno anterior). O engine esconde esses textos do chat (source 'internal'):
 * são verificação interna, não conteúdo para o usuário. Correções reais
 * ("Correção: …") não casam e permanecem visíveis.
 */
export function isNoCorrectionReply(text: string): boolean {
  const t = text.trim().toLowerCase()
  if (t.startsWith('nada a corrigir')) return true
  // Estilo "Confirmado: nenhuma alteração foi feita" — a negação precisa vir
  // logo após o início; "Correto, na verdade não editei nada" (correção real)
  // não casa.
  return /^(confirmado|correto|ok)[\s:,-]*\s*(nada|nenhum[ao]?|sem)(\s+a corrigir|\s+altera[cç]|\s+arquivo|\s+mudança)/i.test(t)
}
