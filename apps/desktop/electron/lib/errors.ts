import type { MessageErrorKind } from '@shared/chat'
import { ProviderResolutionError } from './provider-errors'

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

/**
 * Recusa do gateway do OpenCode por falta do header de sessão. A requisição não
 * chegou a ser roteada e nenhum token foi consumido — é indisponibilidade do
 * caminho até o modelo, não do request: cai em `network` (recuperável) para que
 * a rotação de modelos siga adiante. O `providerFetch` já repete uma vez com um
 * id de sessão novo antes disso, então chegar aqui significa que a repetição
 * também falhou.
 */
const SESSION_ROUTING_PATTERNS = [/missing x-opencode-session/i]

/**
 * Limite de uso/requisições do provedor ou gateway. Cobre o 429 clássico
 * (OpenAI/Anthropic/OpenRouter: `statusCode`/`code` 429), o Zen do OpenCode
 * (`FreeUsageLimitError` — teto de uso gratuito por conta, janela rolante) e
 * mensagens de quota dos demais gateways (Groq, orama, NVIDIA...).
 */
const RATE_LIMIT_PATTERNS = [
  /\b429\b/,
  /too many requests/i,
  /rate[ _-]?limit/i,
  /rate.?limited/i,
  /freeusage/i,
  /free ?usage ?limit/i,
  /quota (exceeded|exhausted|reached)/i,
  // O 429 de cota da OpenAI inverte a ordem ("You exceeded your current
  // quota") e o code vem como insufficient_quota — nenhum dos dois casava
  // com o padrão acima, que exige o verbo logo depois de "quota".
  /insufficient_quota/i,
  /(exceed|exhaust)\w*\s+(your\s+)?(current\s+)?quota/i,
  /usage limit/i,
  /request limit/i,
  /RATE_LIMIT_EXCEEDED|RATE_LIMITED/i,
  /retry.?after/i,
]

/**
 * Rede/indisponibilidade do endpoint. Cobre códigos do undici/fetch nativo
 * (`ECONNREFUSED`, `ENOTFOUND`, `UND_ERR_CONNECT_TIMEOUT`...), `fetch failed`
 * do SDK da Vercel, e HTTP 5xx (OpenAI `server_error`, Anthropic
 * `overloaded_error` em 529, gateways em 502/503/504).
 */
const NETWORK_PATTERNS = [
  /ECONNREFUSED/i,
  /ENOTFOUND/i,
  /ETIMEDOUT/i,
  /EHOSTUNREACH/i,
  /EAI_AGAIN/i,
  /EPIPE/i,
  /EADDRNOTAVAIL/i,
  /UND_ERR_CONNECT_TIMEOUT/i,
  /UND_ERR_SOCKET/i,
  /socket hang up/i,
  /fetch failed/i,
  /network error/i,
  /connection (refused|reset|closed|timed out)/i,
  /timed? ?out/i,
  /service unavailable/i,
  /bad gateway/i,
  /gateway timeout/i,
  /overloaded/i,
  /\b5\d{2}\b/, // HTTP 5xx
]

/**
 * Erro de configuração de provedor, mesmo reembrulhado. Instâncias de módulos
 * distintos (bundle duplicado) escapam do `instanceof`, então o `name` — fixado
 * no construtor — é o segundo critério.
 */
function isProviderConfigError(value: unknown): boolean {
  return (
    value instanceof ProviderResolutionError ||
    (value instanceof Error && value.name === 'ProviderResolutionError')
  )
}

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
  // Falha de CONFIGURAÇÃO (provedor/SDK desconhecido, chave ausente) antes de
  // qualquer padrão: o texto é nosso, não do provedor — e um id de provider com
  // "429" no meio casaria com rate-limit.
  if (isProviderConfigError(value)) return { kind: 'provider-config', detail }
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
  if (SESSION_ROUTING_PATTERNS.some((re) => re.test(haystack))) return { kind: 'network', detail }
  if (RATE_LIMIT_PATTERNS.some((re) => re.test(haystack))) return { kind: 'rate-limit', detail }
  if (NETWORK_PATTERNS.some((re) => re.test(haystack))) return { kind: 'network', detail }
  return { kind: 'unknown', detail }
}

/** Kinds que a rotação de modelos contorna automaticamente (trocar de modelo
 *  resolve). Auth (401/403) e abort manual ficam de fora de propósito. */
const RECOVERABLE_ERROR_KINDS: ReadonlySet<MessageErrorKind> = new Set([
  'moderation',
  'model-unavailable',
  'rate-limit',
  'network',
])

export function isRecoverableErrorKind(kind: MessageErrorKind): boolean {
  return RECOVERABLE_ERROR_KINDS.has(kind)
}
