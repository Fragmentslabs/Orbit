import { folderKey, normalizeFolderName, type FolderInfo, type SessionInfo } from "@shared/chat"

/**
 * Com qual workspace nasce o chat novo do "+" de uma pasta da sidebar.
 *
 * A ordem é a que a pasta vive:
 *
 * 1. O CHAT ANTERIOR — o mais recente da pasta, com as pastas extras que ele
 *    tinha. É o "continua de onde eu estava": abrir o "+" da pasta depois de
 *    trabalhar num chat dela cai no mesmo repositório.
 * 2. A MEMÓRIA DA PASTA (`folders.workspace`) — gravada pelo primeiro chat que
 *    entrou nela e mantida quando os chats somem. É o que responde com a pasta
 *    VAZIA (todos os chats apagados), caso em que antes não havia resposta
 *    nenhuma e o workspace ficava como estava: o do último chat aberto. Daí o
 *    "+" da pasta Nodara abrir no repositório do Orbit.
 * 3. O MAPA AUTOMÁTICO diretório → pasta — o mesmo que o `createSession` usa
 *    para escolher a pasta de um projeto. Cobre pastas anteriores ao campo, que
 *    ainda não passaram pela migração. A chave é o repositório principal
 *    (worktree já resolvido), que é justamente a pasta certa para um chat novo.
 *
 * Devolve `undefined` quando não há pista nenhuma (pasta criada à mão e nunca
 * usada): aí quem chama não mexe no workspace.
 */
export function workspaceOfFolder(input: {
  folder: FolderInfo
  /** Todas as sessões do store — inclusive as arquivadas, que a pasta agrupa. */
  sessions: SessionInfo[]
  /** Mapa automático diretório → pasta (localStorage, `orbit-auto-folder-map`). */
  autoFolderMap: Record<string, string>
}): string[] | undefined {
  const { folder, sessions, autoFolderMap } = input

  // 1) O chat mais recente da pasta: é o projeto em que ela vinha sendo usada.
  //    Entre chats empata o primeiro na ordem do store (mais recente primeiro).
  let maisRecente: SessionInfo | undefined
  for (const session of sessions) {
    if (session.folderId !== folder.id || !session.directory) continue
    if (!maisRecente || session.updatedAt > maisRecente.updatedAt) maisRecente = session
  }
  if (maisRecente) return sessionWorkspace(maisRecente)

  // 2) A memória da pasta (primeiro chat que a associou a um repositório).
  if (folder.workspace?.length) return folder.workspace

  // 3) O mapa automático: diretórios que já foram desta pasta. A pasta pode
  //    ter mais de um (o mesmo projeto aberto por caminhos diferentes, ou um
  //    worktree de antes do mapa passar a apontar para o principal), então o
  //    nome da pasta desempata.
  const doMapa = Object.entries(autoFolderMap)
    .filter(([, folderId]) => folderId === folder.id)
    .map(([directory]) => directory)
  if (doMapa.length > 0) {
    const porNome = doMapa.find((dir) => folderKey(normalizeFolderName(dir)) === folderKey(folder.name))
    return [porNome ?? doMapa[0]]
  }

  return undefined
}

/** O workspace que a sessão tinha: repositório principal + pastas extras. */
export function sessionWorkspace(session: SessionInfo): string[] | undefined {
  if (!session.directory) return undefined
  return [session.directory, ...(session.extraDirectories ?? [])]
}

/**
 * A sessão MAIS ANTIGA da pasta que tem diretório — a primeira que a associou a
 * um repositório. É dela que a pasta tira a memória do workspace quando
 * aprende, e não do chat mais recente: a memória é a origem, não o uso.
 */
export function firstSessionOfFolder(
  folderId: string,
  sessions: SessionInfo[],
): SessionInfo | undefined {
  let primeira: SessionInfo | undefined
  for (const session of sessions) {
    if (session.folderId !== folderId || session.mode !== "code" || !session.directory) continue
    if (!primeira || session.createdAt < primeira.createdAt) primeira = session
  }
  return primeira
}
