import type { MessageErrorKind } from '@shared/chat'

/**
 * Converte um valor lançado em texto legível. O SDK de AI e os gateways
 * (OpenRouter, NVIDIA, etc.) às vezes lançam objetos aninhados que não são
 * instâncias de Error — sem esse tratamento, `String(obj)` renderizaria
 * "[object Object]" no card de erro.
 *
 * Nunca lança: roda dentro de blocos catch, e uma exceção aqui derrubaria o
 * próprio tratamento de erro (a sessão ficaria sem status e sem mensagem).
 */
export function errorToText(value: unknown, depth = 0): string {
  try {
    if (value instanceof Error) return value.message
    if (typeof value === 'string') return value
    if (typeof value === 'object' && value !== null) {
      // Guarda contra cadeias `{error:{error:{...}}}` cíclicas
      if (depth > 10) return '[erro aninhado profundo demais]'
      const obj = value as { error?: unknown; message?: unknown }
      const inner = obj.error ?? obj.message
      if (inner != null && inner !== value) return errorToText(inner, depth + 1)
      return JSON.stringify(value, null, 2)
    }
    return String(value)
  } catch {
    return '[erro não serializável]'
  }
}

/**
 * Moderação de conteúdo do provedor. O bloqueio acontece no servidor do
 * provedor, antes de a resposta chegar aqui — não há flag no request que
 * desligue isso, então o único caminho é trocar de modelo.
 *
 * Alibaba/DashScope (Qwen, servido também por gateways como o OpenCode Zen) é
 * de longe o caso mais comum: a inspeção roda sobre a SAÍDA do modelo e dá
 * falso-positivo com frequência quando há imagem no contexto (prints de UI com
 * muito texto são um gatilho conhecido).
 */
const MODERATION_PATTERNS = [
  /data_inspection_failed/i,
  /datainspectionfailed/i,
  /inappropriate content/i,
  /content_filter/i,
  /content_policy_violation/i,
  /responsible_ai_policy/i,
  /\bguardrail/i,
  /blocked by (the )?safety/i,
  /PROHIBITED_CONTENT/,
  /SAFETY_?BLOCK/i,
]

/** Modelo inexistente/indisponível no provedor — trocar de modelo resolve. */
const MODEL_UNAVAILABLE_PATTERNS = [
  /\bis not supported\b/i,
  /model_not_found/i,
  /\bunknown model\b/i,
  /no endpoints found/i,
  /\bmodel .* does not exist/i,
]

export interface ClassifiedError {
  kind: MessageErrorKind
  /** Texto cru do provedor, preservado para diagnóstico no card de erro. */
  detail: string
}

/**
 * Texto usado só para casar os padrões acima. Não dá para classificar pelo
 * `detail`: `errorToText` desce até a mensagem mais interna e descarta campos
 * irmãos — e vários provedores mandam o motivo em `code`/`type`, não na
 * mensagem (ex: `{ error: { code: 'content_filter', message: 'The response was
 * filtered' } }`). Aqui serializamos a estrutura inteira.
 */
function matchable(value: unknown): string {
  const text = errorToText(value)
  if (typeof value !== 'object' || value === null) return text
  const seen = new WeakSet<object>()
  let serialized = ''
  try {
    serialized = JSON.stringify(value, (_key, val) => {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return undefined
        seen.add(val)
      }
      return val
    })
  } catch {
    // objetos exóticos (getters que lançam, BigInt) — o texto já basta
  }
  // Error tem propriedades não-enumeráveis: JSON.stringify(new Error(x)) === '{}'
  return serialized && serialized !== '{}' ? `${text}\n${serialized}` : text
}

/**
 * Classifica a falha de um turno para a UI decidir o que oferecer. O texto cru
 * nunca é descartado: a mensagem amigável é montada no renderer (i18n) a partir
 * do `kind`, e o `detail` fica visível para diagnóstico.
 */
export function classifyProviderError(value: unknown): ClassifiedError {
  const detail = errorToText(value)
  let haystack = detail
  try {
    haystack = matchable(value)
  } catch {
    // classificar é best-effort — nunca pode derrubar o catch que nos chamou
  }
  if (MODERATION_PATTERNS.some((re) => re.test(haystack))) return { kind: 'moderation', detail }
  if (MODEL_UNAVAILABLE_PATTERNS.some((re) => re.test(haystack))) {
    return { kind: 'model-unavailable', detail }
  }
  return { kind: 'unknown', detail }
}
