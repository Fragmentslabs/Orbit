/**
 * Erro do cliente HTTP do companion → o que mostrar na tela.
 *
 * O `CompanionHttp` devolve o corpo cru junto do status (`"503: {"error":…}"`),
 * e cada rota manda o que sabe. O ditado manda a frase pronta, e é dela que
 * `reasonFromHttpError` vive. A fala manda CÓDIGO, não frase — quem traduz é
 * este lado, onde se sabe em que idioma a pessoa está lendo.
 *
 * Os dois leitores ficam no mesmo módulo porque leem o mesmo corpo.
 */
export function reasonFromHttpError(error?: string): string | null {
  if (!error) return null
  const jsonStart = error.indexOf('{')
  if (jsonStart < 0) return null
  try {
    const parsed = JSON.parse(error.slice(jsonStart)) as { error?: string; reason?: string }
    return parsed.reason || parsed.error || null
  } catch {
    return null
  }
}

/**
 * Código do corpo de erro → código, sem tradução.
 *
 * A rota de fala responde `{"error":"tts_disabled"}` — um código fechado, não
 * uma frase. Devolve o que veio sem julgar: quem sabe quais códigos existem e
 * em que frase cada um vira é a tela. Corpo ilegível ou sem `error` → null, e
 * a tela cai no aviso genérico em vez de mostrar um pedaço de JSON.
 */
export function errorCodeFromHttpError(error?: string): string | null {
  if (!error) return null
  const jsonStart = error.indexOf('{')
  if (jsonStart < 0) return null
  try {
    const parsed = JSON.parse(error.slice(jsonStart)) as { error?: unknown }
    return typeof parsed.error === 'string' && parsed.error.trim() ? parsed.error.trim() : null
  } catch {
    return null
  }
}
