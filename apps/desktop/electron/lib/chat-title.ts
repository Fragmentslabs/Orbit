export const MAX_TITLE_LENGTH = 50

// Modelos thinking (DeepSeek R1, Qwen QwQ, OpenAI o1/o3, Gemini Thinking etc.)
// emitem blocos `<think>...</think>`. Alguns provedores/gateways não separam
// o raciocínio direito e esses tokens vazam no `text` retornado — quando o
// bloco é filtrado e sobra só o início da tag, o título nasce com `<think`
// colado na frente. Remove também tokens de fim/início de turno de outros
// modelos (ChatML, Llama, Mistral) que aparecem raramente em gateways mal
// configurados.
function stripThinkingAndArtifacts(text: string): string {
  return text
    // Bloco de raciocínio completo (com fechamento) — pode aparecer em
    // qualquer lugar; alguns provedores não separam reasoning direito.
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    // Tag aberta/fechada solta OU parcial sem `>` (modelo cortou, gateway
    // vazou). Ancorada em "<think" pra não comer texto legítimo.
    .replace(/<\/?think(?:ing)?\b[^>]*>?/gi, '')
    // Tokens de fim/início de turno de modelos específicos (ChatML,
    // Anthropic specials, Llama/Mistral end-of-turn).
    .replace(/<\/?(?:s|antml(?::text|_thinking)?)\s*>/gi, '')
    .replace(/<\||\|>/g, '')
    .replace(/\[\/?INST\]/g, '')
}

// Quando a mensagem do usuário é uma tarefa ("liste os arquivos…"), alguns
// modelos (DeepSeek via opencode-go) executam em vez de dar título e devolvem
// a chamada de ferramenta como texto: DSML da DeepSeek (`<｜DSML｜invoke …>`,
// com a barra de largura total U+FF5C), tokens `<｜tool▁calls▁begin｜>`,
// `<toolcall>`/`<tool_call>`/`<function_call>`, `[TOOL_CALLS]` do Mistral ou
// JSON cru com `name` + `arguments`. Nada disso pode virar título.
const TOOL_CALL_MARKERS = [
  /[｜|]\s*DSML\s*[｜|]/i,
  /<\s*[｜|]\s*tool[\s▁_]*call/i,
  /<\s*\/?\s*(?:tool[\s_-]?calls?|function[\s_-]?calls?|invoke|antml:invoke)\b/i,
  /<function=/i,
  /\[TOOL_CALLS\]/i,
  /"(?:name|tool|function)"\s*:\s*"[^"]*"\s*,\s*"(?:arguments|parameters|input|args)"\s*:/i,
]

export function looksLikeToolCall(text: string): boolean {
  if (TOOL_CALL_MARKERS.some((re) => re.test(text))) return true
  // JSON cru (objeto ou lista) nunca é um título legível
  return /^[{[]/.test(text.trim())
}

export function truncateTitle(text: string): string {
  const cleaned = stripThinkingAndArtifacts(text)
    .trim()
    .replace(/\*\*/g, '') // negrito/marcação forte
    .replace(/[*_`#>~]/g, '') // outra marcação markdown
    .replace(/^["']|["']$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return ''
  if (cleaned.length <= MAX_TITLE_LENGTH) return cleaned
  // corta no limite de caracteres SEM quebrar palavra no meio, quando possível
  const hard = cleaned.slice(0, MAX_TITLE_LENGTH)
  const lastSpace = hard.lastIndexOf(' ')
  const cut = lastSpace > MAX_TITLE_LENGTH * 0.5 ? lastSpace : hard.length
  return hard.slice(0, cut).trim()
}

// Título de reserva tirado da própria mensagem: a primeira frase da primeira
// linha não vazia costuma dizer do que se trata ("Benchmark de navegação de
// código. Use…" → "Benchmark de navegação de código").
export function titleFromUserText(userText: string): string {
  const firstLine = userText.split('\n').find((line) => line.trim()) ?? ''
  const firstSentence = firstLine.split(/(?<=[.!?])\s/)[0] ?? ''
  return truncateTitle(firstSentence.replace(/[.!?]+$/, ''))
}

/**
 * Converte a resposta do modelo de título em título final. Se ela vier com
 * markup de chamada de ferramenta (ou ficar vazia depois da limpeza), cai para
 * `fallback` — o título derivado da mensagem do usuário.
 */
export function resolveTitle(modelText: string, fallback: string): string {
  if (looksLikeToolCall(modelText)) return fallback
  return truncateTitle(modelText) || fallback
}
