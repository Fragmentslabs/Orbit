import type { ChatMessage, MessagePart, TextPart } from "@shared/chat"

/**
 * Peças puras do modo chamada (conversa por voz). Vivem fora do hook para
 * serem testadas sem DOM, microfone ou IPC.
 */

/**
 * Nível (0..1, ver `pcmLevel`) a partir do qual um bloco do microfone conta como
 * fala: ~-34 dB. Ruído de sala fica bem abaixo; voz normal, bem acima.
 */
export const SPEECH_LEVEL = 0.35

/**
 * Já falando, basta este nível (~-41 dB) para a fala CONTINUAR: fim de sílaba,
 * voz que baixa no fim da frase e a respiração entre frases não contam como
 * silêncio. Histerese: começar exige mais do que continuar.
 */
export const SPEECH_CONTINUE_LEVEL = 0.2

/**
 * O bloco é fala? Antes da primeira palavra vale o limiar alto; depois, o baixo
 * — mas nunca abaixo do ruído da sala (`noise`, medido antes de a pessoa
 * falar) com folga: num ambiente com ventilador o limiar baixo puro nunca
 * deixaria a vez terminar.
 */
export function isSpeech(level: number, speaking: boolean, noise = 0): boolean {
  if (!speaking) return level >= SPEECH_LEVEL
  const floor = Math.min(SPEECH_LEVEL, Math.max(SPEECH_CONTINUE_LEVEL, noise + 0.12))
  return level >= floor
}

/** Média móvel do ruído de fundo, alimentada só com o silêncio antes da fala. */
export function trackNoise(noise: number, level: number): number {
  return noise === 0 ? level : noise * 0.9 + level * 0.1
}

/**
 * A vez da pessoa acabou? Só depois de ela ter falado algo (silêncio antes da
 * primeira palavra não encerra nada) e de um silêncio contínuo de `silenceMs`.
 */
export function turnEnded(state: { heardSpeech: boolean; lastSpeechAt: number; now: number; silenceMs: number }): boolean {
  return state.heardSpeech && state.now - state.lastSpeechAt >= state.silenceMs
}

/** O que a chamada fala de uma resposta (ver `callSpeech`). */
export interface CallSpeech {
  /** Prosa ANTES da primeira ferramenta: falada enquanto chega. */
  lead: string
  /** A resposta já chamou alguma ferramenta. */
  hasTool: boolean
  /** Com ferramentas: a prosa depois da última delas — a resposta final. */
  final: string | null
}

const isProse = (part: MessagePart): part is TextPart => part.type === "text" && part.source === undefined
/** Texto e raciocínio não quebram um bloco; ferramenta, agente, imagem etc. quebram. */
const isTextish = (part: MessagePart) => part.type === "text" || part.type === "reasoning"

/**
 * Raciocínio que vazou no texto (`<think>…</think>`, de gateways que não o
 * separam). Uma tag ainda aberta — o raciocínio no meio do streaming — leva
 * junto tudo o que vem depois dela.
 */
export function stripThinking(text: string): string {
  return text.replace(/<think(?:ing)?>[\s\S]*?(<\/think(?:ing)?>|$)/gi, "")
}

/**
 * Política de fala da chamada. Falar TODA a prosa de uma resposta com
 * ferramentas lia em voz alta a narração que o modelo escreve entre uma
 * ferramenta e outra ("deixa eu ver X… agora Y…", às vezes o próprio
 * raciocínio) — na tela ela fica recolhida em "N ações", na voz não. Então:
 *
 *   - sem ferramentas: a resposta é o próprio `lead`, falado em streaming;
 *   - com ferramentas: do `lead` só a frase de espera ("deixa eu pesquisar")
 *     já falada; a narração do meio, nunca; e o `final` (prosa depois da última
 *     ferramenta) quando o turno termina.
 *
 * Textos do engine (com `source`) não existem para a fala, como na tela.
 */
export function callSpeech(message: ChatMessage): CallSpeech {
  // Resumo da compactação: contexto para o modelo, nunca fala.
  if (message.role !== "assistant" || message.summary) return { lead: "", hasTool: false, final: null }
  const parts = message.parts.filter((part) => !(part.type === "text" && part.source !== undefined))
  let i = 0
  let lead = ""
  for (; i < parts.length && isTextish(parts[i]); i++) {
    if (isProse(parts[i])) lead += (parts[i] as TextPart).text
  }
  const hasTool = i < parts.length
  if (!hasTool) return { lead: stripThinking(lead), hasTool, final: null }
  let j = parts.length
  while (j > 0 && isTextish(parts[j - 1])) j--
  const tail = stripThinking(
    parts
      .slice(j)
      .filter(isProse)
      .map((part) => part.text)
      .join(""),
  ).trim()
  // O `lead` terminou numa ferramenta: a quebra fecha a última frase dele.
  return { lead: `${stripThinking(lead)}\n`, hasTool, final: tail || null }
}

/**
 * O que ainda dá para FALAR de uma resposta que chega aos pedaços: do ponto já
 * falado (`from`) até o fim da última frase completa. Com a resposta terminada
 * (`final`), vai tudo o que restou. `next` é o novo ponto já falado.
 *
 * Falar frase a frase é o que deixa a chamada em tempo real: a primeira frase
 * já toca enquanto o modelo escreve as seguintes.
 */
export function takeSpeakable(text: string, from: number, final: boolean): { chunk: string; next: number } {
  const rest = text.slice(from)
  if (final) return { chunk: rest.trim(), next: text.length }
  // Fim de frase: pontuação seguida de espaço/quebra, ou uma quebra de linha.
  const boundary = /[.!?…;:](?=\s)|\n/g
  let end = -1
  for (let match = boundary.exec(rest); match; match = boundary.exec(rest)) end = match.index + match[0].length
  if (end <= 0) return { chunk: "", next: from }
  return { chunk: rest.slice(0, end).trim(), next: from + end }
}

/**
 * O começo de `text` que já foi dito, cortado em limite de palavra: a legenda
 * do modo chamada cresce junto com o áudio sem cortar uma palavra ao meio.
 * `fraction` é 0..1 do que já tocou.
 */
export function spokenPrefix(text: string, fraction: number): string {
  if (!text) return ""
  if (fraction >= 1) return text
  if (!Number.isFinite(fraction) || fraction <= 0) return ""
  const cut = Math.ceil(text.length * fraction)
  if (cut >= text.length) return text
  // O primeiro espaço depois do corte: a palavra que começou só entra quando
  // estiver inteira (ou quando for a última).
  const rest = text.slice(cut)
  const gap = rest.search(/\s/)
  return gap === -1 ? text : text.slice(0, cut + gap)
}

/**
 * Fatia de `text` que cabe ao pedaço `index` de `total`. É o caminho de quem
 * manda só o áudio fatiado, sem o texto do pedaço (a rota do modelo): divide
 * por palavras para as fatias não se sobreporem nem deixarem buraco.
 */
export function speechPieceText(text: string, index: number, total: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0 || total <= 0 || index < 0 || index >= total) return ""
  if (total === 1) return words.join(" ")
  const start = Math.round((words.length * index) / total)
  const end = Math.round((words.length * (index + 1)) / total)
  return words.slice(start, Math.max(start, end)).join(" ")
}

/** Uma linha de legenda e o trecho que ela cobre no texto normalizado. */
export interface CaptionLine {
  text: string
  /** Índice do primeiro caractere da linha no texto normalizado. */
  start: number
  /** Índice logo depois do último caractere da linha. */
  end: number
}

/** Espaços, quebras e tabulações em um espaço só — a medida da legenda. */
export function normalizeSpeech(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

/**
 * Corta a fala em linhas de legenda curtas (até `maxChars`), sempre em limite
 * de palavra: o painel da chamada mostra duas — a que está sendo dita e a
 * próxima —, então cada linha precisa caber em uma linha visual.
 */
export function captionLines(text: string, maxChars = 48): CaptionLine[] {
  const normalized = normalizeSpeech(text)
  if (!normalized) return []
  const lines: CaptionLine[] = []
  let from = 0
  while (from < normalized.length) {
    let end = Math.min(normalized.length, from + maxChars)
    if (end < normalized.length) {
      const space = normalized.lastIndexOf(" ", end)
      if (space > from) end = space
    }
    const line = normalized.slice(from, end).trim()
    if (line) lines.push({ text: line, start: from, end })
    from = end
    while (from < normalized.length && normalized[from] === " ") from++
  }
  return lines
}

/**
 * Índice da linha que está sendo dita para uma posição (em caracteres) no
 * texto normalizado. Posições no espaço entre duas linhas continuam na
 * anterior; a próxima só assume quando a primeira letra dela começa.
 */
export function captionIndexAt(lines: CaptionLine[], position: number): number {
  let index = 0
  for (let i = 0; i < lines.length; i++) if (lines[i].start <= position) index = i
  return index
}

/**
 * Markdown → texto que soa bem em voz alta. O prompt da chamada já pede texto
 * puro; isto é a rede para o que escapar (um negrito, um link, um bloco de código).
 */
export function speechText(markdown: string): string {
  return (
    markdown
      // Bloco de código não se lê em voz alta.
      .replace(/```[\s\S]*?(```|$)/g, " ")
      .replace(/`([^`]*)`/g, "$1")
      // [texto](url) → texto; URL solta some.
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/https?:\/\/\S+/g, "")
      // Marcadores de título, citação, lista e tabela.
      .replace(/^\s{0,3}(#{1,6}|>)\s*/gm, "")
      .replace(/^\s*([-*+]|\d+[.)])\s+/gm, "")
      .replace(/\|/g, " ")
      // Ênfase.
      .replace(/(\*\*|__|\*|_|~~)(?=\S)([^*_~]+?)\1/g, "$2")
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .trim()
  )
}
