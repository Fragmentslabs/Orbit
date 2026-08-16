import { Platform } from 'react-native'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let Notifications: any = null

try {
  if (Platform.OS !== 'web') {
    Notifications = require('expo-notifications')
  }
} catch {
  Notifications = null
}

// ─── Notification Handler ────────────────────────────────────────────────────

/** Configura como notificações são exibidas quando o app está em foreground. */
export function configureNotifications() {
  if (!Notifications) return
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  })
}

// ─── Permissions ─────────────────────────────────────────────────────────────

/** Solicita permissão para notificações. Retorna true se concedido. */
export async function requestNotificationPermission(): Promise<boolean> {
  if (!Notifications) return false
  const { status: existing } = await Notifications.getPermissionsAsync()

  if (existing === 'granted') return true

  const { status } = await Notifications.requestPermissionsAsync()
  return status === 'granted'
}

// ─── Local Notifications ─────────────────────────────────────────────────────

export interface NotificationPayload {
  title: string
  body: string
  /** Dados extras acessíveis no listener. */
  data?: Record<string, unknown>
}

/**
 * Exibe uma notificação local imediata.
 * Não precisa de push server — roda no dispositivo.
 */
export async function scheduleLocalNotification(
  payload: NotificationPayload
): Promise<string | null> {
  if (!Notifications) return null
  const hasPermission = await requestNotificationPermission()
  if (!hasPermission) return null

  const id = await Notifications.scheduleNotificationAsync({
    content: {
      title: payload.title,
      body: payload.body,
      data: payload.data ?? {},
      sound: 'notif.wav',
    },
    trigger: null, // imediato
  })

  return id
}

// ─── Badge ───────────────────────────────────────────────────────────────────

/** Atualiza o badge count (iOS). No Android, badges são gerenciados pelo canal. */
export async function setBadgeCount(count: number) {
  if (!Notifications) return
  if (Platform.OS === 'ios') {
    await Notifications.setBadgeCountAsync(count)
  }
}

/** Limpa o badge. */
export async function clearBadge() {
  if (!Notifications) return
  if (Platform.OS === 'ios') {
    await Notifications.setBadgeCountAsync(0)
  }
}

// ─── Listeners ───────────────────────────────────────────────────────────────

export type NotificationListener = (notification: unknown) => void

/**
 * Registra listener para notificações recebidas (app em foreground).
 * Retorna uma função de cleanup.
 */
export function addNotificationReceivedListener(
  handler: NotificationListener
): () => void {
  if (!Notifications) return () => {}
  const subscription = Notifications.addNotificationReceivedListener(handler as any)
  return () => subscription.remove()
}

/**
 * Registra listener para quando o usuário toca numa notificação.
 * Retorna uma função de cleanup.
 */
export function addNotificationResponseListener(
  handler: (response: { notification: { request: { content: { data: unknown } } } }) => void
): () => void {
  if (!Notifications) return () => {}
  const subscription = Notifications.addNotificationResponseReceivedListener(handler as any)
  return () => subscription.remove()
}
