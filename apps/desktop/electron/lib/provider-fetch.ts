import { randomUUID } from 'node:crypto'

/**
 * Contrato do header de sessão do OpenCode (Zen e Go).
 *
 * Sem `x-opencode-session` o gateway responde 4xx com "Request is missing
 * x-opencode-session and cannot be routed efficiently" — a requisição não chega
 * a ser roteada para nenhum modelo. O valor é o id da conversa (estável durante
 * toda ela); o gateway aceita qualquer valor não-vazio.
 *
 * Vive num módulo sem Electron e sem SDK porque é usado por dois lados que não
 * devem se conhecer: o resolveModel (que monta as settings do provider) e o
 * wrapper de `fetch` abaixo — e precisa ser testável fora do processo principal.
 */
export const SESSION_HEADER = 'x-opencode-session'

/** Provedores que exigem o header acima; os demais seguem sem headers extras. */
export const SESSION_HEADER_PROVIDERS = new Set(['opencode', 'opencode-go'])

/** Recusa do gateway por falta de sessão (ver comentário no topo). */
export const MISSING_SESSION_PATTERN = /missing x-opencode-session/i

/** Gera um id de sessão novo (usado quando o gateway recusa o da conversa). */
export function freshSessionId(): string {
  return `orbit_${randomUUID()}`
}

/**
 * Troca o id recusado pelo que passou a valer no processo. Quem chama guarda a
 * decisão; o wrapper só sabe que precisa de outro valor para repetir a
 * requisição.
 */
export type RotateSession = (rejectedId: string) => string

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return (input as Request).url || 'requisição sem URL'
}

/**
 * `fetch` dos provedores que exigem o header de sessão. Duas barreiras:
 *
 * 1. Reenvia o header em TODA requisição que o SDK fizer. Ele já vai nas
 *    settings do provider; isto garante que nenhum outro caminho — versão nova
 *    do SDK, opção que remonta o request, chamada interna que não passa pelo
 *    resolveModel — saia sem ele. Quando precisa reinjetar, registra no log:
 *    significa que o header saiu do caminho esperado, e é esse registro que
 *    explica uma falha de sessão em campo.
 * 2. Se o gateway ainda recusar por falta de sessão, repete UMA vez com um id
 *    novo. A resposta chegou sem a requisição ter sido roteada (nenhum token foi
 *    consumido), então repetir é seguro — e sem isso o turno morreria com um
 *    erro que o usuário não tem como contornar.
 */
export function providerFetch(sessionId: string, rotate?: RotateSession): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers)
    if (!headers.get(SESSION_HEADER)) {
      // Valor vazio conta como ausente para o gateway — por isso `||` e não `??`.
      const injected = sessionId || freshSessionId()
      console.warn(
        `[providers] requisição para ${urlOf(input)} saiu sem ${SESSION_HEADER} nas settings ` +
          `do provider — reinjetando (sessão ${injected})`,
      )
      headers.set(SESSION_HEADER, injected)
    }

    const response = await fetch(input, { ...init, headers })
    if (response.status < 400 || init?.signal?.aborted) return response

    // Só a recusa por sessão ganha repetição, e só quando o corpo pode ser
    // reenviado: o SDK manda JSON como string; um body em stream não sobrevive
    // a uma segunda chamada, e aí o erro sobe como está.
    if (typeof init?.body !== 'string') return response
    const detail = await response
      .clone()
      .text()
      .catch(() => '')
    if (!MISSING_SESSION_PATTERN.test(detail)) return response

    const rejected = headers.get(SESSION_HEADER) ?? sessionId
    const rotated = rotate?.(rejected) ?? freshSessionId()
    console.warn(
      `[providers] gateway recusou a sessão ${rejected} em ${urlOf(input)} — ` +
        `repetindo a requisição com ${rotated}`,
    )
    // Headers novos para a repetição: os da primeira chamada não são mexidos.
    const retryHeaders = new Headers(headers)
    retryHeaders.set(SESSION_HEADER, rotated)
    return fetch(input, { ...init, headers: retryHeaders })
  }
}
