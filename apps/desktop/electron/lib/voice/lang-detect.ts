/**
 * Language of a text, for SPEECH — the "Automatic" mode of reading aloud.
 *
 * The local engine (Supertonic) speaks with the accent of the language it receives: with the
 * language fixed to English, an answer in Portuguese comes out in Portuguese with
 * an American accent. In "Automatic" the language comes from the text itself, sentence by
 * sentence — it is the text that will be spoken, so it is the text that knows.
 *
 * No dependency: the alphabet settles the languages with their own script (Cyrillic,
 * Greek, Arabic, Devanagari, Hangul, Kana) and, in Latin script, function words
 * ("de", "the", "und"…) plus the typical accented letters decide. It only returns
 * a language Supertonic speaks (see TTS_LANGS). Short or ambiguous text
 * ("Ok.", "Claro.") comes back as NOT confident — the caller keeps the language it
 * was already using instead of changing accents in the middle of the answer.
 */

export interface LangGuess {
  lang: string
  /** The evidence is enough to switch language (short/ambiguous text is not enough). */
  confident: boolean
}

/** Function words: the most frequent of each language, and the ones that distinguish it most. */
const STOPWORDS: Record<string, string[]> = {
  pt: [
    "de", "que", "não", "o", "os", "as", "um", "uma", "é", "do", "da", "dos", "das", "em", "no", "na", "nos", "nas",
    "para", "com", "por", "se", "mais", "mas", "como", "eu", "você", "voce", "ele", "ela", "isso", "isto", "está",
    "são", "foi", "tem", "muito", "também", "já", "ao", "seu", "sua", "meu", "minha", "quando", "onde", "porque",
    "então", "aqui", "ainda", "só", "sim", "obrigado", "olá", "vou", "vai", "pode", "fazer", "agora", "ou", "nem",
    "pelo", "pela", "numa", "num", "dele", "dela", "lhe", "estou", "tudo", "nada", "depois", "assim", "bem",
  ],
  en: [
    "the", "and", "is", "are", "was", "were", "to", "of", "in", "that", "it", "you", "i", "for", "on", "with", "this",
    "be", "have", "has", "not", "but", "what", "can", "do", "will", "my", "your", "we", "they", "he", "she", "at",
    "from", "there", "about", "would", "just", "so", "if", "an", "here", "yes", "hello", "thanks", "okay", "it's",
    "i'm", "don't", "how", "which", "when", "where", "there's", "let's", "been", "also", "now", "then", "some",
  ],
  es: [
    "el", "la", "los", "las", "de", "que", "y", "en", "un", "una", "es", "no", "por", "con", "para", "se", "lo",
    "como", "más", "pero", "su", "al", "del", "este", "esta", "eso", "esto", "está", "son", "muy", "también", "ya",
    "yo", "tú", "usted", "hola", "gracias", "sí", "porque", "cuando", "donde", "hay", "puedo", "quiero", "ahora",
    "aquí", "todo", "nada", "bien", "hacer", "estoy", "pues", "ella", "ellos", "nosotros", "tiene", "fue",
  ],
  fr: [
    "le", "la", "les", "de", "des", "du", "et", "est", "un", "une", "que", "qui", "en", "dans", "pour", "pas", "ne",
    "sur", "avec", "ce", "cette", "il", "elle", "je", "vous", "nous", "mais", "ou", "au", "aux", "sont", "très",
    "bonjour", "merci", "oui", "c'est", "j'ai", "être", "avoir", "fait", "plus", "tout", "bien", "aussi", "ici",
  ],
  de: [
    "der", "die", "das", "und", "ist", "nicht", "ein", "eine", "zu", "den", "dem", "mit", "sich", "auf", "für", "von",
    "ich", "du", "sie", "es", "wir", "auch", "aber", "wie", "noch", "nur", "sind", "hallo", "danke", "ja", "ihr",
    "einen", "einem", "werden", "wird", "kann", "haben", "hat", "bin", "bist", "jetzt", "hier", "sehr", "oder",
  ],
  it: [
    "il", "lo", "la", "gli", "le", "di", "che", "e", "è", "un", "una", "per", "non", "con", "sono", "del", "della",
    "nel", "nella", "mi", "ti", "ma", "anche", "come", "questo", "questa", "ciao", "grazie", "sì", "molto",
    "perché", "ho", "hai", "ha", "abbiamo", "sei", "siamo", "fare", "tutto", "bene", "qui", "adesso", "ancora",
  ],
  nl: [
    "de", "het", "een", "en", "van", "is", "dat", "niet", "ik", "je", "op", "met", "voor", "zijn", "er", "maar",
    "ook", "wat", "hallo", "dank", "jij", "wij", "hij", "zij", "heb", "heeft", "kan", "nog", "wel", "naar", "bij",
  ],
}

/** Letters that (almost) only appear in one language: each one counts as a word. */
const LETTERS: Record<string, RegExp> = {
  pt: /[ãõ]/g,
  es: /[ñ¿¡]/g,
  de: /ß/g,
  fr: /[œùûëï]/g,
}

const WORD_SETS = Object.fromEntries(Object.entries(STOPWORDS).map(([lang, words]) => [lang, new Set(words)]))

/** Own scripts → language (only the ones Supertonic speaks). */
function byScript(text: string): string | null {
  const count = (re: RegExp) => (text.match(re) ?? []).length
  const scripts: [string, number][] = [
    ["ko", count(/[가-힯]/g)],
    ["ja", count(/[぀-ヿ]/g)],
    ["cyrillic", count(/[Ѐ-ӿ]/g)],
    ["el", count(/[Ͱ-Ͽ]/g)],
    ["ar", count(/[؀-ۿ]/g)],
    ["hi", count(/[ऀ-ॿ]/g)],
  ]
  const latin = count(/[a-zà-ÿ]/gi)
  const [best, n] = scripts.reduce((a, b) => (b[1] > a[1] ? b : a))
  if (n === 0 || n < latin) return null
  // Ukrainian has letters Russian does not; Bulgarian and Russian stay Russian.
  if (best === "cyrillic") return /[іїєґ]/i.test(text) ? "uk" : "ru"
  return best
}

export function detectSpeechLang(text: string): LangGuess | null {
  const sample = String(text ?? "").slice(0, 2000)
  if (!sample.trim()) return null

  const script = byScript(sample)
  if (script) return { lang: script, confident: true }

  const lower = sample.toLowerCase()
  const words = lower.split(/[^\p{L}']+/u).filter(Boolean)
  const scores: Record<string, number> = {}
  for (const lang of Object.keys(STOPWORDS)) {
    let score = 0
    for (const word of words) if (WORD_SETS[lang].has(word)) score++
    const letters = LETTERS[lang]
    if (letters) score += (lower.match(letters) ?? []).length
    scores[lang] = score
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1])
  const [lang, best] = ranked[0]
  const second = ranked[1]?.[1] ?? 0
  if (best === 0) return null
  // Confident = enough evidence AND a margin over the runner-up. "Claro."
  // (pt/es) or "Ok." do not switch the accent; a whole sentence does.
  const confident = best >= 2 && best - second >= 2 && best >= second * 1.5
  return { lang, confident }
}

/**
 * Speech language of a segment. A concrete `requested` ("pt", "en"…) is forced;
 * "auto" (or nothing) detects it in the text. `memory` keeps the last language decided
 * in the SAME utterance (call-mode sentences arrive one by one): an ambiguous
 * segment inherits the language of the previous sentences instead of falling back to the reserve.
 */
export function pickSpeechLang(
  requested: string | undefined,
  text: string,
  fallback: string,
  memory?: { lang?: string },
): string {
  if (requested && requested !== "auto") return requested
  const guess = detectSpeechLang(text)
  if (guess?.confident) {
    if (memory) memory.lang = guess.lang
    return guess.lang
  }
  if (memory?.lang) return memory.lang
  // First segment and ambiguous: the reserve applies — a lone "Ok." cannot
  // decide the accent of the whole answer.
  return fallback
}
