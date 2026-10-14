/**
 * Idioma de um texto, para a FALA — o "Automático" da leitura em voz alta.
 *
 * O motor local (Supertonic) fala com o sotaque do idioma que recebe: com o
 * idioma fixo em inglês, uma resposta em português sai em português com
 * sotaque americano. No "Automático" o idioma sai do próprio texto, frase a
 * frase — é o texto que vai ser falado, então é ele quem sabe.
 *
 * Sem dependência: o alfabeto resolve os idiomas de escrita própria (cirílico,
 * grego, árabe, devanágari, hangul, kana) e, no latino, palavras funcionais
 * ("de", "the", "und"…) mais as letras acentuadas típicas decidem. Só devolve
 * idioma que o Supertonic fala (ver TTS_LANGS). Texto curto ou ambíguo
 * ("Ok.", "Claro.") volta como NÃO confiante — quem chama mantém o idioma que
 * já vinha usando em vez de trocar de sotaque no meio da resposta.
 */

export interface LangGuess {
  lang: string
  /** A evidência basta para trocar de idioma (texto curto/ambíguo não basta). */
  confident: boolean
}

/** Palavras funcionais: as mais frequentes de cada idioma, e as que mais o distinguem. */
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

/** Letras que (quase) só aparecem num idioma: cada uma vale como uma palavra. */
const LETTERS: Record<string, RegExp> = {
  pt: /[ãõ]/g,
  es: /[ñ¿¡]/g,
  de: /ß/g,
  fr: /[œùûëï]/g,
}

const WORD_SETS = Object.fromEntries(Object.entries(STOPWORDS).map(([lang, words]) => [lang, new Set(words)]))

/** Alfabetos próprios → idioma (só os que o Supertonic fala). */
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
  // Ucraniano tem letras que o russo não tem; búlgaro e russo ficam no russo.
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
  // Confiante = evidência suficiente E folga sobre o segundo colocado. "Claro."
  // (pt/es) ou "Ok." não trocam o sotaque; uma frase inteira troca.
  const confident = best >= 2 && best - second >= 2 && best >= second * 1.5
  return { lang, confident }
}

/**
 * Idioma da fala de um trecho. `requested` concreto ("pt", "en"…) é forçado; o
 * "auto" (ou nada) detecta no texto. `memory` guarda o último idioma decidido
 * na MESMA fala (as frases do modo chamada chegam uma a uma): um trecho
 * ambíguo herda o idioma das frases anteriores em vez de cair no reserva.
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
  // Primeiro trecho e ambíguo: vale o reserva — um "Ok." sozinho não pode
  // decidir o sotaque da resposta inteira.
  return fallback
}
