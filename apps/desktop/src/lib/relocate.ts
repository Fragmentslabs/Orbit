import { normalizeFolderName, type SessionInfo } from "@shared/chat"

/**
 * Revalidação das pastas de trabalho.
 *
 * O caminho de uma pasta é guardado como STRING — no diretório da sessão, no
 * mapa diretório → pasta e na lista de pastas do workspace. Renomear, mover ou
 * apagar a pasta no Finder não avisa ninguém: as três referências continuam
 * apontando para o vazio, e o Orbit só descobre no dia em que tenta usá-las.
 *
 * Aqui mora a parte que decide O QUE sumiu e O QUE fazer com cada referência
 * quando a pessoa relocaliza a pasta. Pura de propósito: é fechada por teste,
 * sem Electron e sem store.
 */

/** Uma pasta referenciada que não existe mais em disco. */
export interface MissingFolder {
  /** O caminho exatamente como está guardado — é a chave do religamento. */
  path: string
  /** Nome curto para a UI (o último segmento do caminho). */
  name: string
}

/** Último segmento do caminho ("/a/b/meu-app" → "meu-app"). */
export function folderBaseName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/** Os caminhos de pasta de uma sessão, o principal primeiro. */
export function sessionFolderPaths(
  session: Pick<SessionInfo, "directory" | "extraDirectories">,
): string[] {
  return [session.directory, ...(session.extraDirectories ?? [])].filter(
    (path): path is string => Boolean(path),
  )
}

/**
 * Todos os caminhos referenciados — pelas pastas do workspace e pelas sessões —
 * sem repetição e na ordem em que aparecem.
 */
export function collectFolderPaths(
  workspaceFolders: string[],
  sessions: ReadonlyArray<Pick<SessionInfo, "directory" | "extraDirectories">>,
): string[] {
  const seen = new Set<string>()
  const paths: string[] = []
  for (const path of [...workspaceFolders, ...sessions.flatMap(sessionFolderPaths)]) {
    if (!path || seen.has(path)) continue
    seen.add(path)
    paths.push(path)
  }
  return paths
}

/**
 * Os caminhos que não existem mais, na ordem de `paths`.
 *
 * Só `false` conta: um caminho que nem foi checado (o main não respondeu, a
 * lista mudou no meio) é dúvida, e dúvida não vira alerta — senão o aviso
 * nasce mentindo.
 */
export function missingFolders(paths: string[], existing: Record<string, boolean>): MissingFolder[] {
  return paths
    .filter((path) => existing[path] === false)
    .map((path) => ({ path, name: folderBaseName(path) }))
}

/**
 * Religar uma sessão de `oldPath` para `newPath`: o diretório principal e as
 * pastas extras, na posição em que estavam. `null` quando a sessão não
 * referencia o caminho — é o que mantém a operação cirúrgica, sem tocar em
 * quem não tem nada a ver.
 */
export function relocateSessionFolders(
  session: Pick<SessionInfo, "directory" | "extraDirectories">,
  oldPath: string,
  newPath: string,
): Partial<Pick<SessionInfo, "directory" | "extraDirectories">> | null {
  const extras = session.extraDirectories ?? []
  const hitMain = session.directory === oldPath
  const hitExtra = extras.includes(oldPath)
  if (!hitMain && !hitExtra) return null
  return {
    ...(hitMain ? { directory: newPath } : {}),
    ...(hitExtra
      ? { extraDirectories: extras.map((path) => (path === oldPath ? newPath : path)) }
      : {}),
  }
}

/**
 * Move a entrada do mapa automático para o caminho novo. Se o destino já tem
 * pasta (a pessoa já trabalhou por lá), a entrada antiga sai sem sobrescrever:
 * trocar o dono do caminho novo seria pior do que perder a pista antiga.
 */
export function relocateAutoFolderEntry(
  map: Record<string, string>,
  oldPath: string,
  newPath: string,
): Record<string, string> | null {
  const folderId = map[oldPath]
  if (!folderId) return null
  const next = { ...map }
  delete next[oldPath]
  if (!(newPath in next)) next[newPath] = folderId
  return next
}

/**
 * O nome da pasta na sidebar acompanha o projeto: se ele ainda é o derivado do
 * caminho antigo ("meu-app" → "Meu App"), deixá-lo como está faz a pasta mentir
 * sobre o que há dentro depois de relocalizada. Nome editado à mão é decisão da
 * pessoa e não se toca — por isso a comparação, e não a atribuição direta.
 */
export function relocatedFolderName(
  currentName: string,
  oldPath: string,
  newPath: string,
): string | null {
  if (currentName !== normalizeFolderName(oldPath)) return null
  const next = normalizeFolderName(newPath)
  return next === currentName ? null : next
}
