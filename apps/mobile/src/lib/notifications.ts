import { Platform } from 'react-native'

let Notifications: any = null

try {
  if (Platform.OS !== 'web') {
    // Conditional loading of an optional module: a static import does not
    // work here (the module may not exist at runtime — Expo Go, web,
    // build without the native part) and that is exactly why the require is
    // inside the try/if.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    Notifications = require('expo-notifications')
  }
} catch {
  Notifications = null
}

// ─── Notification Handler ────────────────────────────────────────────────────

/** Sets up how notifications are displayed when the app is in the foreground. */
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

/** Requests permission for notifications. Returns true if granted. */
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
  /** Extra data accessible in the listener. */
  data?: Record<string, unknown>
}

/**
 * Shows an immediate local notification.
 * No push server needed — it runs on the device.
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
    trigger: null, // immediate
  })

  return id
}

// ─── Badge ───────────────────────────────────────────────────────────────────

/** Updates the badge count (iOS). On Android, badges are managed by the channel. */
export async function setBadgeCount(count: number) {
  if (!Notifications) return
  if (Platform.OS === 'ios') {
    await Notifications.setBadgeCountAsync(count)
  }
}

/** Clears the badge. */
export async function clearBadge() {
  if (!Notifications) return
  if (Platform.OS === 'ios') {
    await Notifications.setBadgeCountAsync(0)
  }
}

// ─── Listeners ───────────────────────────────────────────────────────────────

export type NotificationListener = (notification: unknown) => void

/**
 * Registers a listener for received notifications (app in the foreground).
 * Returns a cleanup function.
 */
export function addNotificationReceivedListener(
  handler: NotificationListener
): () => void {
  if (!Notifications) return () => {}
  const subscription = Notifications.addNotificationReceivedListener(handler as any)
  return () => subscription.remove()
}

/**
 * Registers a listener for when the user taps a notification.
 * Returns a cleanup function.
 */
export function addNotificationResponseListener(
  handler: (response: { notification: { request: { content: { data: unknown } } } }) => void
): () => void {
  if (!Notifications) return () => {}
  const subscription = Notifications.addNotificationResponseReceivedListener(handler as any)
  return () => subscription.remove()
}
