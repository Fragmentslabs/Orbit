import { Linking } from 'react-native'

/** What a link may open outside the app: a page, a mail or a call. Nothing else leaves the app. */
const OPENABLE = /^(https?:\/\/|mailto:|tel:)/i

export function isExternalUrl(url: string): boolean {
  return OPENABLE.test(url.trim())
}

/**
 * Opens a link in the system's own handler (the default browser for a page), never inside the app.
 * Returns false for a scheme that is not allowed or when the system could not open it.
 */
export async function openExternal(url: string): Promise<boolean> {
  const target = url.trim()
  if (!isExternalUrl(target)) return false
  try {
    await Linking.openURL(target)
    return true
  } catch {
    return false
  }
}
