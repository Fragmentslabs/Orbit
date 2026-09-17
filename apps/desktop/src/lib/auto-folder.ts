import { folderKey, normalizeFolderName, type FolderInfo, type SessionMode } from "@shared/chat"

/**
 * Qual pasta recebe uma sessão de código nova, com "criar pastas
 * automaticamente" ligado.
 *
 * Vive fora do store porque a decisão é pura e as consequências não são: ela
 * cria pasta, desarquiva, grava o mapa e persiste a sessão. Separado, o
 * caminho todo pode ser fechado por teste — e é um caminho que falhava CALADO,
 * que é o pior jeito de falhar: a sessão nascia solta e nada dizia por quê.
 *
 * O mapa diretório → pasta é uma PISTA, não um veredito. Ele guarda o que
 * aconteceu da última vez, e o que aconteceu desde então (a pasta foi
 * arquivada, renomeada, apagada) ele não sabe.
 */
export interface AutoFolderPlan {
  /** Pasta existente que recebe a sessão. */
  folderId?: string
  /** Nome da pasta a criar, quando nenhuma serve. */
  create?: string
  /** A pasta escolhida está arquivada e precisa voltar à sidebar antes de
   *  receber a sessão. */
  revive?: boolean
}

export function planAutoFolder(input: {
  directory: string
  mode: SessionMode
  folders: FolderInfo[]
  /** O que o mapa automático diz sobre este diretório, se disser algo. */
  mappedId?: string
}): AutoFolderPlan {
  const { directory, mode, folders, mappedId } = input

  // A pasta apontada pelo mapa só serve se ainda existir e for do mesmo modo.
  // Quando não serve, a busca por nome assume — antes, este ramo simplesmente
  // não fazia nada, e como o mapa continuava apontando para a mesma pasta, o
  // projeto ficava sem pasta PARA SEMPRE. Arquivar a pasta de um projeto
  // desligava a criação automática dele em definitivo.
  const mapped = folders.find((f) => f.id === mappedId)
  if (mapped && mapped.mode === mode) {
    return { folderId: mapped.id, ...(mapped.archived ? { revive: true } : {}) }
  }

  // Sem mapa utilizável, o nome do projeto decide. Cobre o mapa perdido
  // (localStorage limpo, máquina nova) e o mesmo projeto aberto por um caminho
  // diferente — barra no fim, outra caixa, ~ em vez do absoluto.
  const name = normalizeFolderName(directory)
  const sameName = folders.filter((f) => f.mode === mode && folderKey(f.name) === folderKey(name))
  const alive = sameName.find((f) => !f.archived)
  if (alive) return { folderId: alive.id }
  // A arquivada também conta: criar uma segunda pasta com o mesmo nome ao lado
  // dela é exatamente a duplicata que o "Organizar" existe para desfazer.
  if (sameName[0]) return { folderId: sameName[0].id, revive: true }

  return { create: name }
}
