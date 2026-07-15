import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'

// ─── Notification Handler ────────────────────────────────────────────────────

/** Configura como notificações são exibidas quando o app está em foreground. */
export function configureNotifications() {
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
  const hasPermission = await requestNotificationPermission()
  if (!hasPermission) return null

  const id = await Notifications.scheduleNotificationAsync({
    content: {
      title: payload.title,
      body: payload.body,
      data: payload.data ?? {},
      sound: true,
    },
    trigger: null, // imediato
  })

  return id
}

// ─── Badge ───────────────────────────────────────────────────────────────────

/** Atualiza o badge count (iOS). No Android, badges são gerenciados pelo canal. */
export async function setBadgeCount(count: number) {
  if (Platform.OS === 'ios') {
    await Notifications.setBadgeCountAsync(count)
  }
}

/** Limpa o badge. */
export async function clearBadge() {
  if (Platform.OS === 'ios') {
    await Notifications.setBadgeCountAsync(0)
  }
}

// ─── Listeners ───────────────────────────────────────────────────────────────

export type NotificationListener = (notification: Notifications.Notification) => void

/**
 * Registra listener para notificações recebidas (app em foreground).
 * Retorna uma função de cleanup.
 */
export function addNotificationReceivedListener(
  handler: NotificationListener
): () => void {
  const subscription = Notifications.addNotificationReceivedListener(handler)
  return () => subscription.remove()
}

/**
 * Registra listener para quando o usuário toca numa notificação.
 * Retorna uma função de cleanup.
 */
export function addNotificationResponseListener(
  handler: (response: Notifications.NotificationResponse) => void
): () => void {
  const subscription = Notifications.addNotificationResponseReceivedListener(handler)
  return () => subscription.remove()
}
