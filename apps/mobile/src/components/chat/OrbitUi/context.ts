import { createContext, useCallback, useContext } from 'react'
import { INPUT_TYPES, interpolate, type OrbitUiBlock, type Scope, type Value } from '@orbit/shared'
import { useSessionStore } from '~/stores/session-store'

/**
 * State shared by all the blocks of ONE `orbit-ui` fence.
 *
 * The value of each input (slider, select…) lives here, not in the component: it is
 * what allows a text of the message to cite `{capital}` and a chart to recompute the
 * curve while the finger drags. The state is screen-only — reopening the conversation
 * gives back the initial values, same as the desktop.
 */
export type UiState = {
  scope: Scope
  /** Locale for the currency/number formatting (the app language). */
  locale: string
  setValue: (id: string, value: Value) => void
  /** Sends the text as a user message; false when there was no session. */
  send: (text: string) => boolean
}

export const UiContext = createContext<UiState>({
  scope: {},
  locale: 'pt-BR',
  setValue: () => {},
  send: () => false,
})

export const useUi = () => useContext(UiContext)

/** Text of the block with the `{expr}` resolved against the current state. */
export function useText() {
  const { scope, locale } = useUi()
  return useCallback(
    (text: string | undefined) => (text ? interpolate(text, scope, locale) : ''),
    [scope, locale],
  )
}

export const isInputBlock = (block: OrbitUiBlock) => (INPUT_TYPES as readonly string[]).includes(block.type)

/** Initial values declared by the input blocks themselves. */
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
 * Talks to the open session.
 *
 * The `sendMessage` of the store already handles the hard path: without a connection
 * the message goes into the offline queue, and if the desktop is in the middle of a turn
 * the engine refuses with SESSION_BUSY — which the store turns into an item at the front of the
 * shared queue. In other words: from here only "send this text" comes out.
 */
export function sendToActiveSession(text: string): boolean {
  const store = useSessionStore.getState()
  const sessionId = store.activeSessionId
  if (!sessionId || !text.trim()) return false
  void store.sendMessage(text, { sessionId })
  return true
}
