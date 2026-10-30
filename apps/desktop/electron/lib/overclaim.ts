/**
 * Overclaim detection: does the answer CLAIM to have done the work?
 *
 * It is only the TRIGGER of the verification, never the proof — what decides whether there was work
 * is the filesystem snapshot (chat-engine: verifyTurn). That is why the cost of a
 * false positive is low: one more trip to the model, which confirms and moves on.
 *
 * A separate module with no dependency on Electron on purpose: it is language
 * heuristics, the part easiest to get wrong silently, and this way it is covered by
 * tests without having to load the app.
 */

/**
 * First-person completion verbs (pt/en). Only action verbs: loose participles
 * ("created", "done") show up in harmless descriptive sentences such as
 * "the file created earlier already covers this case".
 */
const COMPLETION_CLAIM =
  /\b(criei|adicionei|implementei|corrigi|ajustei|atualizei|removi|apaguei|renomeei|movi|refatorei|alterei|modifiquei|escrevi|gerei|configurei|created|added|implemented|fixed|updated|removed|deleted|renamed|moved|refactored|changed|modified|wrote|applied)\b/gi

/**
 * English participles are ambiguous: "added"/"created" show up in passive
 * descriptions of existing code ("the group is added in Sidebar.tsx") and in
 * commit quotes. They only count as the agent's claim when there is a first-person
 * subject in the preceding window ("I added", "the file I created"). The
 * Portuguese verbs in the list are already first person (criei, implementei…) and do
 * not go through this filter.
 */
const ENGLISH_PARTICIPLE =
  /\b(created|added|implemented|fixed|updated|removed|deleted|renamed|moved|refactored|changed|modified|wrote|applied)\b/i

const FIRST_PERSON = /\bI\b/i

/** Negation right before the verb, in the same clause. */
const NEGATION_BEFORE =
  /\b(n[aã]o|nenhum[ao]?|nunca|jamais|sem|didn'?t|did\s+not|couldn'?t|could\s+not|won'?t|will\s+not|haven'?t|have\s+not|no)\b[\s\w,]{0,24}$/i

/** Window of text before the verb where the negation still counts. */
const NEGATION_WINDOW = 40

/**
 * Explicit marks that the claim describes work from PREVIOUS TURNS
 * (informative questions, "what changed" summaries): it talks about what was already done
 * before, not about what was done in this turn — it is not this turn's overclaim and it should
 * not trigger the charge.
 */
const PAST_TURN =
  /\b(turno|troca|resposta|mensagem|pergunta)\s+(anterior|passad[oa])\b|\b(ontem|anteriormente)\b|\b(semana|m[êe]s|ano)\s+passad[oa]\b|\b(previous|earlier|last)\s+(turn|response|answer|message)\b|\b(previously|yesterday)\b/i

/** Extracts the sentence that contains the given index (simple heuristic, no NLP). */
function sentenceContaining(text: string, index: number): string {
  for (const match of text.matchAll(/[^.!?\n]+[.!?]*/g)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    if (index >= start && index < end) return match[0]
  }
  return text
}

/**
 * Removes code stretches (fenced ```…``` and inline `…`) before matching the
 * verbs: quotes of identifiers, fields and commands ("the `added` field",
 * "`groups.push(...)`") are not the agent's claims about its own work.
 */
function stripCode(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
}

/**
 * Handling negation is mandatory: "I analyzed and changed nothing" — the
 * honest answer the prompt itself requires — would be read as overclaim, and the agent
 * would be charged precisely for having been frank.
 *
 * A single NON-negated occurrence is enough to count as a claim: in "I implemented X,
 * but did not change Y" the first one still counts.
 */
export function claimsCompletion(text: string): boolean {
  const clean = stripCode(text)
  for (const match of clean.matchAll(COMPLETION_CLAIM)) {
    const index = match.index ?? 0
    // "I added X in the previous turn" describes past work, not this
    // turn — the sentence is ignored even before the negation check.
    if (PAST_TURN.test(sentenceContaining(clean, index))) continue
    const window = clean.slice(Math.max(0, index - NEGATION_WINDOW), index)
    if (NEGATION_BEFORE.test(window)) continue
    // English participle without "I" in the window = passive voice/code description
    // ("was added", "is created") — it is not the agent claiming its own
    // trabalho.
    if (ENGLISH_PARTICIPLE.test(match[0]) && !FIRST_PERSON.test(window)) continue
    return true
  }
  return false
}

/**
 * The answer to the nudge's charge was ONLY the confirmation that there was nothing to
 * fix (a false positive of the trigger — e.g. the text described work from a
 * previous turn). The engine hides these texts from the chat (source 'internal'):
 * they are internal verification, not content for the user. Real corrections
 * ("Correction: …") do not match and remain visible.
 */
export function isNoCorrectionReply(text: string): boolean {
  const t = text.trim().toLowerCase()
  if (t.startsWith('nada a corrigir')) return true
  // Style "Confirmed: no change was made" — the negation has to come
  // right after the start; "Correct, actually I did not edit anything" (a real correction)
  // does not match.
  return /^(confirmado|correto|ok)[\s:,-]*\s*(nada|nenhum[ao]?|sem)(\s+a corrigir|\s+altera[cç]|\s+arquivo|\s+mudança)/i.test(t)
}

/**
 * The answer talks about the SCREEN as if it had looked at or acted on it: "I opened
 * TextEdit and wrote", "I'm seeing your screen", "the screenshot arrives illegible". It only
 * is a trigger in a turn with the screen tools at hand and NO call to them —
 * then there is nothing to have seen or done, and the sentence is invention (a fast model
 * in voice mode did this: it confirmed the action without calling any tool).
 *
 * Broader than `claimsCompletion` on purpose: negation does not save it ("I
 * cannot see, the screenshot does not arrive" without having captured anything is also
 * invention), and the cost of a false positive is one more trip that answers
 * "Nothing to fix.".
 */
const SCREEN_CLAIM =
  /\b(abri|cliquei|digitei|escrevi|preenchi|enviei|apertei|pressionei|selecionei|naveguei|rolei|salvei|fechei|vejo|estou vendo|consigo ver|n[aã]o consigo ver|na sua tela|sua tela|a captura|o print|screenshot|opened|clicked|typed|filled|sent|pressed|selected|scrolled|saved|closed|i can see|i see|on your screen|your screen|the capture)\b/i

export function claimsScreenWork(text: string): boolean {
  return SCREEN_CLAIM.test(text)
}

/**
 * The answer announces that it will look at the screen through an image ("I'll try through
 * the image", "let me look at the screen"). With the window already read as text, the
 * model can still promise the image and answer without calling the tool — the case
 * that repeated "it did not come through the image either" with no call at all.
 */
const IMAGE_LOOK_CLAIM =
  /\b(pela imagem|tentar pela imagem|olhar a (tela|imagem)|ver pela imagem|pelo print|pela captura|via image|from the image|let me (look|try|check)|i'?ll (look|try|check))\b/i

export function claimsImageLook(text: string): boolean {
  return IMAGE_LOOK_CLAIM.test(text)
}
