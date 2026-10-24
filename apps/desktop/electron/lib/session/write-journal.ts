import { AsyncLocalStorage } from 'node:async_hooks'
import path from 'node:path'

/**
 * Diário de ESCRITA das ferramentas do agente na pasta de trabalho.
 *
 * O snapshot do modo código (snapshot/index.ts) diz O QUE mudou na pasta entre
 * o começo e o fim do turno, mas não QUEM mudou: outra conversa na mesma
 * pasta, um editor externo, um formatter ou um `npm run dev` caem no mesmo
 * diff. Atribuir por janela de tempo obrigava a serializar os turnos da pasta
 * inteira (e ainda assim não cobria o que roda fora do Orbit).
 *
 * Aqui cada ferramenta que grava na pasta (write, edit, imagem, pdf, docx…)
 * registra o caminho ANTES de gravar, pelo `resolveWritePath` das tools. O
 * revert usa isso como prova de autoria: o que está no diff e foi escrito
 * pelas ferramentas do turno é desfeito; o que está no diff e NÃO foi (bash,
 * MCP, algo de fora) aparece à parte, "autor incerto", e só é desfeito se a
 * pessoa pedir.
 *
 * O escopo é um AsyncLocalStorage aberto em volta do turno — as tools herdam
 * sem receber nada por parâmetro, como no diário de mídia. Um turno ANINHADO e
 * esperado pelo pai (worker da orquestra) abre um escopo filho: o que ele grava
 * conta para ele e para o pai. O que é disparado em paralelo e vive além do
 * turno (subchat) sai do escopo com `detachFromTurn` — é outra conversa.
 *
 * Registrar a INTENÇÃO (antes de gravar) é suficiente: se a escrita falhar, o
 * caminho não muda e nem entra no diff.
 */

interface TurnScope {
  id: string
  startedAt: number
  /** Caminhos absolutos (arquivo ou pasta inteira) gravados pelas tools. */
  paths: Set<string>
  parent?: TurnScope
}

interface RecentWrite {
  path: string
  at: number
  /** Ids do escopo que gravou e de todos os ancestrais. */
  owners: Set<string>
}

const storage = new AsyncLocalStorage<TurnScope>()
/** Escritas recentes de TODOS os turnos — para saber o que é de outra conversa. */
const recent: RecentWrite[] = []
/** Um turno longo de agente cabe folgado; o resto é só memória sem uso. */
const RECENT_TTL_MS = 6 * 60 * 60 * 1000
const RECENT_MAX = 20_000
let counter = 0

/** Abre o escopo de escrita do turno em volta de `fn` (filho do atual, se houver). */
export function runWithWriteScope<T>(fn: () => T): T {
  const parent = storage.getStore()
  const scope: TurnScope = {
    id: `w${Date.now().toString(36)}-${(counter++).toString(36)}`,
    startedAt: Date.now(),
    paths: new Set(),
    parent,
  }
  return storage.run(scope, fn)
}

/** Roda `fn` fora do escopo do turno atual — para outra conversa disparada sem `await`. */
export function detachFromTurn<T>(fn: () => T): T {
  return storage.exit(fn)
}

function prune(now: number): void {
  const cutoff = now - RECENT_TTL_MS
  let drop = 0
  while (drop < recent.length && recent[drop].at < cutoff) drop += 1
  if (recent.length - drop > RECENT_MAX) drop = recent.length - RECENT_MAX
  if (drop > 0) recent.splice(0, drop)
}

/**
 * A ferramenta vai gravar (ou apagar/substituir) `absPath` — arquivo ou pasta
 * inteira. Fora de um turno não faz nada.
 */
export function recordToolWrite(absPath: string): void {
  const scope = storage.getStore()
  if (!scope) return
  const resolved = path.resolve(absPath)
  const owners = new Set<string>()
  for (let s: TurnScope | undefined = scope; s; s = s.parent) {
    s.paths.add(resolved)
    owners.add(s.id)
  }
  const now = Date.now()
  recent.push({ path: resolved, at: now, owners })
  prune(now)
}

/** Relativo a `directory`, com '/', ou null se estiver fora dela. */
function relativeTo(directory: string, abs: string): string | null {
  const rel = path.relative(path.resolve(directory), abs)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.replace(/\\/g, '/')
}

export interface TurnWrites {
  /** Caminhos (relativos, '/') gravados pelas tools deste turno. Pasta cobre o que há dentro. */
  authored: string[]
  /** Caminhos gravados pelas tools de OUTROS turnos do Orbit durante este. */
  others: string[]
}

/**
 * O que as tools gravaram em `directory` durante o turno atual, e o que as de
 * outros turnos gravaram no mesmo intervalo. Chamar no fim do turno, dentro
 * do escopo dele; fora de um escopo devolve null.
 */
export function currentTurnWrites(directory: string): TurnWrites | null {
  const scope = storage.getStore()
  if (!scope) return null
  const authored = new Set<string>()
  for (const abs of scope.paths) {
    const rel = relativeTo(directory, abs)
    if (rel) authored.add(rel)
  }
  const others = new Set<string>()
  for (const write of recent) {
    if (write.at < scope.startedAt || write.owners.has(scope.id)) continue
    const rel = relativeTo(directory, write.path)
    if (rel && !authored.has(rel)) others.add(rel)
  }
  return { authored: [...authored].sort(), others: [...others].sort() }
}

/** `rel` é um dos caminhos da lista, ou está dentro de uma pasta da lista? */
export function coveredBy(rel: string, list: Iterable<string>): boolean {
  for (const entry of list) {
    if (rel === entry || rel.startsWith(`${entry}/`)) return true
  }
  return false
}

/** Só para teste. */
export function __resetWriteJournal(): void {
  recent.length = 0
}
