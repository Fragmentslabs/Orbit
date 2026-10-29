import type { FamiliaFerramenta } from './catalogo'
import { NUCLEO_SET } from './catalogo'

/**
 * Conjunto ativo DERIVADO do histórico — nunca mutado.
 *
 * Sai de varrer `messages` a cada passo por chamadas a `tools_load`. Duas
 * consequências que valem o desenho:
 * - **Persistência entre turnos de graça**: a família carregada no turno N
 *   continua ativa no N+1, até a compactação remover a chamada do histórico.
 * - **Sem histórico órfão**: o conjunto nunca encolhe sem motivo — se ele
 *   voltasse ao núcleo a cada turno, o histórico carregaria chamadas a tools
 *   que já não estão declaradas, e provedor OpenAI-compatível pode rejeitar.
 */

/** Chamada a `tools_load` encontrada no histórico. */
interface Carga {
  familias: string[]
  nomes: string[]
  /** Índice da mensagem — serve para a ordem e para o LRU do cap. */
  em: number
}

/** O que o modelo pediu para carregar, lido de uma chamada a `tools_load`. */
function lerCarga(parte: Record<string, unknown>, familias: readonly FamiliaFerramenta[]): Carga | null {
  if (parte.type !== 'tool-call' || parte.toolName !== 'tools_load') return null
  // O SDK já usou `args` e hoje usa `input`; aceitar os dois custa nada e
  // sobrevive a um replay de histórico antigo.
  const entrada = (parte.input ?? parte.args) as Record<string, unknown> | undefined
  if (!entrada) return null

  const alvo: string[] = []
  if (typeof entrada.family === 'string') alvo.push(entrada.family)
  if (typeof entrada.server === 'string') alvo.push(`mcp:${entrada.server}`)
  // `tools: [...]` — cada nome é resolvido para a família que o contém.
  const nomes: string[] = []
  if (Array.isArray(entrada.tools)) {
    for (const bruto of entrada.tools) {
      if (typeof bruto !== 'string') continue
      const nome = bruto.trim()
      if (!nome) continue
      nomes.push(nome)
      const familia = familias.find((f) => f.tools.includes(nome))
      if (familia) alvo.push(familia.id)
    }
  }
  if (alvo.length === 0 && nomes.length === 0) return null
  return { familias: [...new Set(alvo)], nomes, em: -1 }
}

/**
 * Famílias citadas no texto — auto-ativação determinística, zero token.
 *
 * Duas formas de citação, e o critério que separa as duas:
 * - `@mcp:<servidor>`: explícita, sem ambiguidade.
 * - **nome de tool**: só vale para nomes com `_` e 5+ caracteres. "git" solto
 *   é palavra do dia a dia ("faz um git pull"); `git_status` é a tool. Sem esse
 *   filtro, metade das mensagens ativaria uma família por acidente, que é pior
 *   do que não ativar: paga contexto e dilui o núcleo.
 */
export function familiasMencionadasNoTexto(
  texto: string,
  familias: readonly FamiliaFerramenta[] = [],
): string[] {
  const achadas = new Set<string>()
  for (const match of texto.matchAll(/@mcp:([\w.-]+)/gi)) achadas.add(`mcp:${match[1]}`)
  if (familias.length === 0) return [...achadas]

  const normalizado = texto.toLowerCase()
  for (const familia of familias) {
    if (familia.indisponivel || achadas.has(familia.id)) continue
    for (const nome of familia.tools) {
      if (NUCLEO_SET.has(nome) || nome.length < 5 || !nome.includes('_')) continue
      if (normalizado.includes(nome.toLowerCase())) {
        achadas.add(familia.id)
        break
      }
    }
  }
  return [...achadas]
}

export interface ConjuntoAtivo {
  /** Nomes de tool a mandar no `activeTools`. */
  nomes: string[]
  /** Famílias carregadas (para o marker ATIVO do mapa). */
  familias: Set<string>
  /** Famílias que caíram no cap — o prompt avisa. */
  cortadas: string[]
}

/**
 * Deriva o conjunto ativo do histórico inteiro.
 *
 * - Sempre inclui o núcleo que EXISTE neste turno (o núcleo nominal tem tools
 *   que o chat não monta — `read`, `bash` —, e declarar tool inexistente no
 *   `activeTools` quebra o request).
 * - `auto` são famílias ativadas por contexto (ex.: `@mcp:x` na mensagem).
 * - Cap: o conjunto cresce monotonicamente; ao estourar, cai primeiro a família
 *   **sem uso recente** (LRU pelas chamadas do histórico retido), não a mais
 *   antiga carregada — um worker que carregou `documents` no turno 2 e usou até
 *   o 9 não deve cair antes de `motion`, carregado no 7 e nunca chamado.
 */
export function derivarAtivas(
  mensagens: readonly unknown[],
  familias: readonly FamiliaFerramenta[],
  existentes: ReadonlySet<string>,
  opcoes: { auto?: readonly string[]; cap?: number } = {},
): ConjuntoAtivo {
  const cap = opcoes.cap ?? 120
  const porId = new Map(familias.map((f) => [f.id, f]))
  const carregadas: string[] = []
  const nomesSoltos = new Set<string>()
  const ultimoUso = new Map<string, number>()
  const familiaDoNome = new Map<string, string>()
  for (const familia of familias) for (const nome of familia.tools) familiaDoNome.set(nome, familia.id)

  mensagens.forEach((mensagem, indice) => {
    const conteudo = (mensagem as { content?: unknown }).content
    if (!Array.isArray(conteudo)) return
    for (const parte of conteudo) {
      if (!parte || typeof parte !== 'object') continue
      const p = parte as Record<string, unknown>
      // Uso de qualquer tool empurra o LRU da família dela.
      if (p.type === 'tool-call' && typeof p.toolName === 'string') {
        const familia = familiaDoNome.get(p.toolName)
        if (familia) ultimoUso.set(familia, indice)
      }
      const carga = lerCarga(p, familias)
      if (!carga) continue
      carga.em = indice
      for (const id of carga.familias) if (!carregadas.includes(id)) carregadas.push(id)
      for (const nome of carga.nomes) nomesSoltos.add(nome)
    }
  })

  const desejadas = [...new Set([...carregadas, ...(opcoes.auto ?? [])])].filter((id) => porId.has(id))
  const cortadas: string[] = []
  const manter = new Set(desejadas)
  // Teto: corta as de menor uso (nunca usadas primeiro), mais recentes depois.
  let total = manter.size
  if (total > cap) {
    const ordenadas = [...desejadas].sort(
      (a, b) => (ultimoUso.get(a) ?? -1) - (ultimoUso.get(b) ?? -1),
    )
    for (const id of ordenadas) {
      if (total <= cap) break
      manter.delete(id)
      cortadas.push(id)
      total--
    }
  }

  const nomes = new Set<string>()
  for (const nome of NUCLEO_SET) if (existentes.has(nome)) nomes.add(nome)
  for (const id of manter) {
    const familia = porId.get(id)
    if (!familia || familia.indisponivel) continue
    for (const nome of familia.tools) if (existentes.has(nome)) nomes.add(nome)
  }
  for (const nome of nomesSoltos) if (existentes.has(nome)) nomes.add(nome)

  return { nomes: [...nomes], familias: manter, cortadas }
}
