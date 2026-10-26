/**
 * Raciocínio que escapou para a resposta.
 *
 * Alguns modelos (visto em DeepSeek servido por gateway openai-compatible)
 * escrevem o pensamento no próprio texto da resposta: um rascunho, um "But
 * wait — I should actually call…", uma conclusão. No painel do atalho isso
 * aparece na tela e, em modo de chamada, é FALADO. O pensamento sai em inglês
 * mesmo quando a conversa é em outra língua — é o que o separa da resposta.
 *
 * O filtro derruba as frases que são claramente inglês quando a conversa não é
 * em inglês. É deliberadamente conservador: uma frase só cai se tiver mais
 * palavras funcionais inglesas que da língua da conversa, e nomes próprios,
 * código e termos soltos em inglês dentro de uma frase em português ficam.
 * Conversa em inglês não passa por aqui — não há como separar pela língua.
 */

/** Palavras funcionais do inglês que NÃO existem como palavras comuns em português/espanhol. */
const ENGLISH = new Set([
  'the', 'is', 'are', 'was', 'were', 'be', 'been', 'i', "i'll", "i'm", "i've", 'it', "it's", 'its', 'this', 'that', 'these', 'those',
  'to', 'of', 'and', 'or', 'but', 'not', 'should', 'would', 'could', 'will', 'can', 'let', 'my', 'we', 'user', 'they', 'their',
  'what', 'which', 'who', 'how', 'why', 'when', 'if', 'then', 'now', 'just', 'also', 'at', 'by', 'from', 'with', 'about', 'again',
  'actually', 'wait', 'need', 'call', 'tool', 'answer', 'reply', 'voice', 'short', 'keep', 'honest', 'maybe', 'because', 'there',
  'here', 'have', 'has', 'had', 'than', 'too', 'very', 'still', 'only', 'really', 'so', 'you', 'your', 'me', 'do', 'does', 'did',
])

/** Palavras funcionais do português que pesam contra a frase ser inglesa. */
const PORTUGUESE = new Set([
  'de', 'que', 'não', 'o', 'a', 'os', 'as', 'um', 'uma', 'para', 'com', 'você', 'na', 'no', 'em', 'é', 'do', 'da', 'dos', 'das',
  'se', 'por', 'mais', 'mas', 'está', 'são', 'foi', 'já', 'só', 'ao', 'nem', 'eu', 'meu', 'minha', 'isso', 'esse', 'essa', 'aqui',
  'ele', 'ela', 'tem', 'ter', 'vou', 'pela', 'pelo', 'nos', 'nas', 'ou', 'como', 'quando', 'também', 'sim', 'ainda', 'sua', 'seu',
  'el', 'la', 'los', 'las', 'y', 'es', 'con', 'una', 'por', 'pero', 'sí', 'su', 'lo', 'al',
])

/** Fim de frase, mesmo colado na seguinte ("Short.Nada"), ou quebra de linha. */
const SEGMENTS = /[^.!?…\n]*[.!?…]+(?=\s|$|[A-ZÀ-Ú"“])\s*|[^.!?…\n]+$|\n+/g

function isEnglishSentence(sentence: string): boolean {
  const words = sentence.toLowerCase().match(/[a-zà-ú']+/g)
  if (!words || words.length === 0) return false
  let english = 0
  let other = 0
  for (const word of words) {
    if (ENGLISH.has(word)) english += 1
    // "a", "o", "e" aparecem em qualquer frase inglesa ("a false claim"): não contam.
    else if (word.length > 1 && PORTUGUESE.has(word)) other += 1
  }
  if (english === 0) return false
  // Frase curta inteira de pensamento ("Short.", "Voice: short.").
  if (words.length <= 2) return other === 0
  // Sem nenhuma palavra funcional da língua da conversa e sem acento: uma
  // frase de 3+ palavras em português sempre tem uma das duas.
  if (other === 0 && !/[à-ú]/.test(sentence.toLowerCase())) return true
  return english >= 2 && english > other
}

/** A conversa é em inglês? `language` é o nome em inglês da preferência ("Portuguese"). */
function isEnglish(language: string | undefined): boolean {
  return !language || /^en/i.test(language) || /english/i.test(language)
}

/**
 * O texto sem as frases de raciocínio em inglês. Idempotente e seguro para
 * chamar a cada delta do streaming: uma frase só muda de classe enquanto ainda
 * está sendo escrita.
 */
export function stripLeakedReasoning(text: string, language: string | undefined): string {
  if (isEnglish(language) || !text) return text
  const parts = text.match(SEGMENTS)
  if (!parts) return text
  const kept = parts.filter((part) => part.trim() === '' || !isEnglishSentence(part))
  return kept.length === parts.length ? text : kept.join('').replace(/^\s+/, '').replace(/\n{3,}/g, '\n\n')
}
