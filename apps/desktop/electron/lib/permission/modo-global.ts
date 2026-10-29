import type { PermissionMode } from '@shared/chat'

/**
 * Nível de autonomia por chat. O renderer é a fonte da verdade (a escolha de
 * cada chat vive no localStorage dele) e empurra o mapa a cada mudança; o
 * celular também viaja por aqui, pelo mesmo snapshot.
 *
 * Antes havia UM modo global: trocar para Irrestrito num chat afrouxava todos,
 * inclusive turnos já rodando em outros chats. Agora cada sessão consulta o
 * próprio nível — turnos iniciados pelo seletor (`options.followGlobalPermission`)
 * continuam lendo a cada ferramenta, então trocar no meio de uma resposta
 * ainda freia/libera a próxima ação, mas só naquele chat.
 */

/** Último nível publicado — fallback de quem ainda não tem entrada no mapa. */
let atual: PermissionMode | null = null

const porSessao = new Map<string, PermissionMode>()

function isMode(value: unknown): value is PermissionMode {
  return value === 'ask' || value === 'approve' || value === 'full'
}

export function definirModoGlobal(modo: PermissionMode | undefined): void {
  if (isMode(modo)) atual = modo
}

/** Mapa sessionId → nível, empurrado pelo renderer a cada mudança. A chave
 *  'draft' é por aparelho e não entra. */
export function definirModosPorSessao(modes: Record<string, PermissionMode> | null | undefined): void {
  porSessao.clear()
  if (!modes) return
  for (const [sessionId, modo] of Object.entries(modes)) {
    if (sessionId === 'draft' || !isMode(modo)) continue
    porSessao.set(sessionId, modo)
  }
}

/** Nível da sessão; `inicial` enquanto ninguém publicou nada para ela. */
export function modoGlobal(sessionId: string | undefined, inicial: PermissionMode): PermissionMode {
  const daSessao = sessionId ? porSessao.get(sessionId) : undefined
  return daSessao ?? atual ?? inicial
}
