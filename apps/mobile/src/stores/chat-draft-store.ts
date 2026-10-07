import { Storage } from '~/lib/storage'

/**
 * Rascunho do input por chat, persistido no aparelho — antes era só um Map em
 * memória: trocar de chat no mesmo app preservava, mas sair do app (ou o SO
 * matar o processo) perdia o texto digitado. O mapa inteiro vive numa chave só
 * (SecureStore não lista chaves) e a gravação é debounced: a cada keystroke
 * não pode virar escrita de storage.
 */

const STORAGE_KEY = 'orbit_chat_drafts'
const FLUSH_MS = 400

const drafts = new Map<string, string>()
let hydrated = false

/** Carrega o mapa do storage uma vez por processo. Chamada no boot (_layout) e
 *  garantida pelo PromptInput antes de ler. */
export async function hydrateInputDrafts(): Promise<void> {
  if (hydrated) return
  hydrated = true
  try {
    const raw = await Storage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      for (const [sessionId, value] of Object.entries(parsed)) {
        if (typeof value === 'string' && value) drafts.set(sessionId, value)
      }
    }
  } catch {
    // Storage corrompido: começa limpo.
  }
}

let writeTimer: ReturnType<typeof setTimeout> | null = null

function flush() {
  if (writeTimer) {
    clearTimeout(writeTimer)
    writeTimer = null
  }
  writeTimer = setTimeout(() => {
    try {
      const obj: Record<string, string> = {}
      drafts.forEach((text, sessionId) => {
        if (text) obj[sessionId] = text
      })
      void Storage.setItem(STORAGE_KEY, JSON.stringify(obj))
    } catch {
      // Persistência é oportunista — o rascunho continua válido em memória.
    }
  }, FLUSH_MS)
}

/** Texto vazio apaga a chave: o envio (setText('')) limpa o rascunho. */
export function setInputDraft(sessionId: string, text: string) {
  if (text) drafts.set(sessionId, text)
  else drafts.delete(sessionId)
  flush()
}

export function getInputDraft(sessionId: string): string {
  return drafts.get(sessionId) ?? ''
}

export function clearInputDraft(sessionId: string) {
  drafts.delete(sessionId)
  flush()
}
