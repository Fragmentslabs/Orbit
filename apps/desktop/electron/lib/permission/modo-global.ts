import type { PermissionMode } from '@shared/chat'

/**
 * Modo de permissão do seletor global, atualizado a cada troca (no desktop ou
 * no celular — o renderer empurra as preferências ao main a cada mudança).
 *
 * Turnos iniciados pelo seletor (options.followGlobalPermission) consultam
 * este valor a cada ferramenta: trocar para Ask no meio de uma resposta já
 * freia a próxima ação, e trocar para Irrestrito para de perguntar — em vez
 * de valer só na mensagem seguinte.
 */
let atual: PermissionMode | null = null

export function definirModoGlobal(modo: PermissionMode | undefined): void {
  if (modo === 'ask' || modo === 'approve' || modo === 'full') atual = modo
}

/** Modo global atual; `inicial` enquanto o renderer ainda não publicou nenhum. */
export function modoGlobal(inicial: PermissionMode): PermissionMode {
  return atual ?? inicial
}
