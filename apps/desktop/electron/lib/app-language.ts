import { StorageKeys } from '@shared/chat'
import { readJson } from './storage'

/**
 * Idioma efetivo do app (nome em inglês, ex.: "Portuguese"), publicado pelo
 * renderer no boot e a cada troca (canal `app:setLanguage`).
 *
 * Existe porque o main não lê o localStorage do renderer, e o scheduler de
 * rotinas dispara agentes sem nenhum pedido vindo de lá — sem este valor eles
 * responderiam no idioma do prompt.
 *
 * Fica persistido, e não em memória, porque uma rotina atrasada pode disparar
 * logo depois do boot, antes de o renderer montar e publicar.
 *
 * Módulo separado do storage.ts de propósito: aquele é a camada de arquivos e
 * não conhece tipos de domínio.
 */
export async function readAppLanguage(): Promise<string | undefined> {
  return (await readJson<string>(StorageKeys.appLanguage)) ?? undefined
}
