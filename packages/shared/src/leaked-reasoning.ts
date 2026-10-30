/**
 * Reasoning that escaped into the answer.
 *
 * Some models (seen in DeepSeek served by an openai-compatible gateway)
 * write the thinking in the text of the answer itself: a draft, a "But
 * wait — I should actually call…", a conclusion. In the shortcut panel this
 * shows up on the screen and, in call mode, is SPOKEN. The thinking comes out in English
 * even when the conversation is in another language — that is what separates it from the answer.
 *
 * The filter drops the sentences that are clearly English when the conversation is not
 * in English. It is deliberately conservative: a sentence only falls if it has more
 * English function words than from the conversation's language, and proper nouns,
 * code and loose English terms inside a Portuguese sentence stay.
 * Conversation in English does not go through here — there is no way to separate by language.
 */

/** English function words that do NOT exist as ordinary words in Portuguese/Spanish. */
const ENGLISH = new Set([
  'the', 'is', 'are', 'was', 'were', 'be', 'been', 'i', "i'll", "i'm", "i've", 'it', "it's", 'its', 'this', 'that', 'these', 'those',
  'to', 'of', 'and', 'or', 'but', 'not', 'should', 'would', 'could', 'will', 'can', 'let', 'my', 'we', 'user', 'they', 'their',
  'what', 'which', 'who', 'how', 'why', 'when', 'if', 'then', 'now', 'just', 'also', 'at', 'by', 'from', 'with', 'about', 'again',
  'actually', 'wait', 'need', 'call', 'tool', 'answer', 'reply', 'voice', 'short', 'keep', 'honest', 'maybe', 'because', 'there',
  'here', 'have', 'has', 'had', 'than', 'too', 'very', 'still', 'only', 'really', 'so', 'you', 'your', 'me', 'do', 'does', 'did',
])

/** Portuguese function words that weigh against the sentence being English. */
const PORTUGUESE = new Set([
  'de', 'que', 'não', 'o', 'a', 'os', 'as', 'um', 'uma', 'para', 'com', 'você', 'na', 'no', 'em', 'é', 'do', 'da', 'dos', 'das',
  'se', 'por', 'mais', 'mas', 'está', 'são', 'foi', 'já', 'só', 'ao', 'nem', 'eu', 'meu', 'minha', 'isso', 'esse', 'essa', 'aqui',
  'ele', 'ela', 'tem', 'ter', 'vou', 'pela', 'pelo', 'nos', 'nas', 'ou', 'como', 'quando', 'também', 'sim', 'ainda', 'sua', 'seu',
  'el', 'la', 'los', 'las', 'y', 'es', 'con', 'una', 'por', 'pero', 'sí', 'su', 'lo', 'al',
])

/** End of sentence, even glued to the next one ("Short.Nada"), or line break. */
const SEGMENTS = /[^.!?…\n]*[.!?…]+(?=\s|$|[A-ZÀ-Ú"“])\s*|[^.!?…\n]+$|\n+/g

function isEnglishSentence(sentence: string): boolean {
  const words = sentence.toLowerCase().match(/[a-zà-ú']+/g)
  if (!words || words.length === 0) return false
  let english = 0
  let other = 0
  for (const word of words) {
    if (ENGLISH.has(word)) english += 1
    // "a", "o", "e" appear in any English sentence ("a false claim"): they do not count.
    else if (word.length > 1 && PORTUGUESE.has(word)) other += 1
  }
  if (english === 0) return false
  // Short sentence entirely of thinking ("Short.", "Voice: short.").
  if (words.length <= 2) return other === 0
  // Without any function word from the conversation's language and without an accent: a
  // 3+ word sentence in Portuguese always has one of the two.
  if (other === 0 && !/[à-ú]/.test(sentence.toLowerCase())) return true
  return english >= 2 && english > other
}

/** Is the conversation in English? `language` is the English name of the preference ("Portuguese"). */
function isEnglish(language: string | undefined): boolean {
  return !language || /^en/i.test(language) || /english/i.test(language)
}

/**
 * The text without the English reasoning sentences. Idempotent and safe to
 * call on every streaming delta: a sentence only changes class while it is still
 * being written.
 */
export function stripLeakedReasoning(text: string, language: string | undefined): string {
  if (isEnglish(language) || !text) return text
  const parts = text.match(SEGMENTS)
  if (!parts) return text
  const kept = parts.filter((part) => part.trim() === '' || !isEnglishSentence(part))
  return kept.length === parts.length ? text : kept.join('').replace(/^\s+/, '').replace(/\n{3,}/g, '\n\n')
}
