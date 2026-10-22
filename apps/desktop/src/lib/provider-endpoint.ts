/**
 * Classificação de endpoints de provedor. Nada disso é persistido: "local" e
 * "remoto" saem da própria URL. Guardar um campo no provedor criaria um dado
 * que envelhece — quem edita `localhost:11434` para um gateway na nuvem
 * continuaria aparecendo como local até alguém lembrar de atualizar o campo.
 */

/** Hosts que resolvem para a própria máquina (loopback). */
const LOOPBACK_HOSTS = new Set(["localhost", "::1"])

/**
 * URL de um servidor rodando NESTE computador. LAN (`192.168.x.x`, `mac.local`)
 * conta como remoto de propósito: é outra máquina, mesmo estando perto.
 *
 * URL inválida ou ausente devolve `false` — cai no grupo dos remotos, onde o
 * problema fica visível, em vez de se esconder entre os locais.
 */
export function isLocalEndpoint(api: string | undefined): boolean {
  if (!api) return false
  let host: string
  try {
    host = new URL(api).hostname.toLowerCase()
  } catch {
    return false
  }
  // A URL devolve IPv6 entre colchetes ("[::1]").
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host
  // "localhost." (ponto final) também é loopback.
  const name = bare.endsWith(".") ? bare.slice(0, -1) : bare

  if (LOOPBACK_HOSTS.has(name)) return true
  // 127.0.0.0/8 inteiro é loopback, não só 127.0.0.1.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)) return true
  // Por especificação, qualquer "*.<algo>localhost" aponta para o loopback.
  return name.endsWith(".localhost")
}
