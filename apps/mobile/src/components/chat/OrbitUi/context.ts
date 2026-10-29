import { createContext, useContext } from 'react'
import { INPUT_TYPES, interpolate, type OrbitUiBlock, type Scope, type Value } from '@orbit/shared'
import { useSessionStore } from '~/stores/session-store'

/**
 * Estado compartilhado por todos os blocos de UM fence `orbit-ui`.
 *
 * O valor de cada entrada (slider, select…) vive aqui, não no componente: é o
 * que permite um texto da mensagem citar `{capital}` e um gráfico recalcular a
 * curva enquanto o dedo arrasta. O estado é só de tela — reabrir a conversa
 * devolve os valores iniciais, igual ao desktop.
 */
export type UiState = {
  scope: Scope
  /** Locale da formatação monetária/números (o idioma do app). */
  locale: string
  setValue: (id: string, value: Value) => void
  /** Manda o texto como mensagem do usuário; false quando não havia sessão. */
  send: (text: string) => boolean
}

export const UiContext = createContext<UiState>({
  scope: {},
  locale: 'pt-BR',
  setValue: () => {},
  send: () => false,
})

export const useUi = () => useContext(UiContext)

/** Texto do bloco com os `{expr}` resolvidos contra o estado atual. */
export function useText() {
  const { scope, locale } = useUi()
  return (text: string | undefined) => (text ? interpolate(text, scope, locale) : '')
}

export const isInputBlock = (block: OrbitUiBlock) => (INPUT_TYPES as readonly string[]).includes(block.type)

/** Valores iniciais declarados pelos próprios blocos de entrada. */
export function defaultsOf(blocks: OrbitUiBlock[]): Scope {
  const out: Scope = {}
  for (const block of blocks) {
    if (!('id' in block) || out[block.id] !== undefined) continue
    switch (block.type) {
      case 'slider':
        out[block.id] = block.value ?? block.min
        break
      case 'number':
        out[block.id] = block.value
        break
      case 'select':
      case 'tabs':
        out[block.id] = block.value ?? block.options[0].value
        break
      case 'toggle':
        out[block.id] = block.value ?? false
        break
      case 'text':
        out[block.id] = block.value ?? ''
        break
    }
  }
  return out
}

/**
 * Fala com a sessão aberta.
 *
 * O `sendMessage` do store já resolve o caminho difícil: sem conexão a
 * mensagem entra na fila offline, e se o desktop estiver no meio de um turno a
 * engine recusa com SESSION_BUSY — que o store converte em item na frente da
 * fila compartilhada. Ou seja: daqui sai só "manda este texto".
 */
export function sendToActiveSession(text: string): boolean {
  const store = useSessionStore.getState()
  const sessionId = store.activeSessionId
  if (!sessionId || !text.trim()) return false
  void store.sendMessage(text, { sessionId })
  return true
}
