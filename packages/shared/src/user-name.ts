/**
 * Reconhece o nome do usuário numa mensagem dele.
 *
 * A regra é conservadora de propósito: só vale quando a pessoa DIZ o nome
 * ("meu nome é X", "pode me chamar de X", "my name is X"). Um palpite errado
 * aparece na saudação e no system prompt — e "Olá, comum." é pior do que
 * saudação nenhuma. Quando não dá para ter certeza, devolve null.
 *
 * Vive no shared (e não no renderer) para o app mobile usar a mesma regra e
 * para a detecção ser testável sem Electron.
 */

/** Teto do nome guardado. app-settings.ts importa daqui para os dois não divergirem. */
export const USER_NAME_MAX = 40

/** Até três palavras de letras; aceita hífen e apóstrofo (João, Ana-Clara, D'Ávila). */
const NAME = /^[\p{L}][\p{L}'’-]*(?:\s+[\p{L}][\p{L}'’-]*){0,2}$/u

/**
 * Frases que introduzem o nome. O grupo 1 é o candidato.
 * `(?:^|[^\p{L}])` em vez de `\b`: com o flag `u`, `\b` continua ASCII e
 * quebraria em texto que começa com acento.
 */
const PATTERNS = [
  /(?:^|[^\p{L}])(?:meu nome (?:é|eh)|my name is|i'?m called)\s+([^.,;!?\n]{2,40})/iu,
  /(?:^|[^\p{L}])(?:pode me chamar de|me chama(?:m)? de|call me)\s+([^.,;!?\n]{2,40})/iu,
]

/** Artigos que sobram na frente ("me chama de o João") e não são o nome. */
const LEADING = /^(?:o|a|os|as|the)\s+/i

/** "ana clara" vira "Ana Clara"; "McDonald" e "desknik" ficam como vieram. */
function presentable(name: string): string {
  if (name !== name.toLowerCase()) return name
  return name.replace(/(^|\s)(\p{L})/gu, (_all, space: string, letter: string) => space + letter.toUpperCase())
}

export function detectUserName(text: string): string | null {
  // Mensagem gigante (código colado, documento) não é gente se apresentando.
  if (!text || text.length > 2000) return null

  for (const pattern of PATTERNS) {
    const match = pattern.exec(text)
    if (!match) continue
    const candidate = match[1].trim().replace(LEADING, '').replace(/[.!?]+$/, '').trim()
    if (!candidate || candidate.length > USER_NAME_MAX) continue
    // Precisa ser nome de gente: só letras, hífen e apóstrofo.
    if (!NAME.test(candidate)) continue
    return presentable(candidate)
  }
  return null
}
