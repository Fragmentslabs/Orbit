import { BrowserWindow, Notification } from 'electron'
import type { AskItem, ChatMessage } from '@shared/chat'
import { StorageKeys } from '@shared/chat'
import { readJson } from './storage'
import { somCustomDisponivel, tocarSom } from './sound'
import { notifyCompanionMessage } from './companion-server'

/**
 * Notificações nativas do desktop.
 *
 * Critérios de exibição (iguais para os 3 tipos):
 * - A janela principal NÃO está focada — com o app na frente o usuário já vê
 *   o card de permissão / a mensagem na tela; banner nativo seria spam.
 * - Prefis do tipo habilitada (persistidas via storage:write, na chave
 *   `notification-prefs`, pelo renderer — ver notification-prefs-store).
 * - Som custom `notification.wav` quando há player disponível (afplay,
 *   SoundPlayer etc.); sem player, cai no som nativo do sistema.
 *
 * Pendências de workers (origin) são agrupadas: um batch = uma notificação.
 */
export interface NotificationPrefs {
  pendingAsk: boolean
  newMessage: boolean
  chatError: boolean
}

const DEFAULTS: NotificationPrefs = { pendingAsk: true, newMessage: true, chatError: true }

export async function getNotificationPrefs(): Promise<NotificationPrefs> {
  const saved = await readJson<Partial<NotificationPrefs>>('notification-prefs')
  return { ...DEFAULTS, ...saved }
}

function windowPrincipal(): BrowserWindow | null {
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null
}

function appVisivel(): boolean {
  const win = windowPrincipal()
  return !!win && win.isVisible() && win.isFocused()
}

/** Preview da primeira parte de texto "de verdade" (ignora nudge/internal). */
function previewDe(mensagem: ChatMessage, max = 140): string {
  for (const part of mensagem.parts) {
    if (part.type !== 'text') continue
    if (part.source === 'internal' || part.source === 'nudge') continue
    const texto = part.text.replace(/\s+/g, ' ').trim()
    if (!texto) continue
    return texto.length > max ? `${texto.slice(0, max)}…` : texto
  }
  return ''
}

async function tituloDaSessao(sessionId: string): Promise<string> {
  const session = await readJson<{ title?: string }>(StorageKeys.session(sessionId))
  return session?.title?.trim() || sessionId.slice(0, 8)
}

interface NotificacaoBase {
  title: string
  body: string
  sessionId?: string
}

async function mostrar(kind: keyof NotificationPrefs, n: NotificacaoBase): Promise<void> {
  if (!Notification.isSupported()) return
  if (appVisivel()) return
  const prefs = await getNotificationPrefs()
  if (!prefs[kind]) return

  const win = windowPrincipal()
  const somCustom = await somCustomDisponivel()
  const notification = new Notification({ title: n.title, body: n.body, silent: somCustom })
  if (somCustom) void tocarSom('notification.wav')
  notification.on('click', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
    if (n.sessionId) {
      win?.webContents.send('chat:event', { type: 'notifications:open', sessionId: n.sessionId })
    }
  })
  notification.show()
}

/** Pergunta/permissão pendente (pedido de um turno; batch de workers = 1 aviso). */
export async function notifyPendingAsk(sessionId: string, item: AskItem): Promise<void> {
  const titulo = await tituloDaSessao(sessionId)
  if (item.kind === 'question') {
    const primeira = item.questions?.[0]?.text
    void mostrar('pendingAsk', {
      title: 'Pergunta do Orbit',
      body: primeira ? `${titulo}: ${primeira}` : `Pergunta pendente em ${titulo}`,
      sessionId,
    })
  } else {
    void mostrar('pendingAsk', {
      title: 'Permissão necessária',
      body: `${titulo}: ${item.claim?.title ?? 'o agente quer executar uma ação'}`,
      sessionId,
    })
  }
}

/** Lote de pedidos de workers — uma notificação só, com o primeiro claim. */
export async function notifyPendingAskBatch(sessionId: string, items: AskItem[]): Promise<void> {
  if (items.length === 0) return
  const titulo = await tituloDaSessao(sessionId)
  const primeiro = items[0]
  const extra = items.length > 1 ? ` (+${items.length - 1} mais)` : ''
  void mostrar('pendingAsk', {
    title: 'Permissão necessária',
    body:
      primeiro.kind === 'question'
        ? `${titulo}: ${primeiro.questions?.[0]?.text ?? 'pergunta pendente'}${extra}`
        : `${titulo}: ${primeiro.claim?.title ?? 'ação pendente'}${extra}`,
    sessionId,
  })
}

/** Nova mensagem do assistente concluída em sessão inativa (janela fora de foco). */
export async function notifyNewMessage(sessionId: string, mensagem: ChatMessage): Promise<void> {
  const preview = previewDe(mensagem)
  if (!preview) return
  const titulo = await tituloDaSessao(sessionId)
  void mostrar('newMessage', {
    title: titulo,
    body: preview,
    sessionId,
  })
  // Companions (mobile) também são avisados — as prefs do mobile decidem se
  // exibem; o canal é local, independente das prefs do desktop.
  notifyCompanionMessage(sessionId, titulo, preview)
}

/** Erro de chat (fallha do provider, não aborto manual). */
export async function notifyChatError(sessionId: string, erro: string): Promise<void> {
  const titulo = await tituloDaSessao(sessionId)
  void mostrar('chatError', {
    title: 'Erro no chat',
    body: `${titulo}: ${erro.slice(0, 200) || 'erro inesperado'}`,
    sessionId,
  })
}