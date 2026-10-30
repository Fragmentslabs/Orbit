/**
 * Helpers for attachments (FilePart) on native.
 *
 * - `uriToFilePart`: converts a local asset (camera/gallery/document picker)
 *   into a FilePart with a data URL. Uses expo-file-system (legacy API, which keeps
 *   readAsStringAsync) because `fetch(file://…)` + FileReader fails on native
 *   RN — that was the cause of the errors when attaching a photo/file.
 * - `openFilePart`: writes the data URL to a cache file and opens the system
 *   share sheet (the user picks the app that supports the type).
 */
import { Platform } from 'react-native'
import * as FileSystem from 'expo-file-system/legacy'
import type { FilePart } from '@orbit/shared'
import i18n from '~/i18n'

let Sharing: typeof import('expo-sharing') | undefined

function newId(): string {
  return Math.random().toString(36).substring(2, 9)
}

export async function uriToFilePart(uri: string, mime?: string, filename?: string): Promise<FilePart> {
  let dataUrl: string
  let resolvedMime = mime ?? 'application/octet-stream'

  if (Platform.OS === 'web') {
    const response = await fetch(uri)
    const blob = await response.blob()
    if (!mime && blob.type) resolvedMime = blob.type
    dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onloadend = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
  } else {
    const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 })
    dataUrl = `data:${resolvedMime};base64,${base64}`
  }

  return {
    id: newId(),
    type: 'file',
    mime: resolvedMime,
    filename,
    url: dataUrl,
  }
}

/** Reasonable extension from the mime/name, so the share sheet suggests the right apps. */
function extensionFor(file: FilePart): string {
  const fromName = file.filename?.match(/\.([a-zA-Z0-9]+)$/)?.[1]
  if (fromName) return fromName
  const subtype = file.mime.split('/')[1]?.split('+')[0]
  return subtype && subtype.length <= 5 ? subtype : 'bin'
}

/**
 * Opens a FilePart: http(s) URLs go to the browser via share/Linking;
 * data URLs are materialized into a cache file and shared.
 */
export async function openFilePart(file: FilePart): Promise<void> {
  if (!file.url) return

  if (Platform.OS === 'web') {
    window.open(file.url, '_blank')
    return
  }

  let localUri = file.url

  if (file.url.startsWith('data:')) {
    const base64 = file.url.split(',')[1] ?? ''
    const safeName = (file.filename ?? `anexo-${file.id}`).replace(/[^\w.-]/g, '_')
    const withExt = safeName.includes('.') ? safeName : `${safeName}.${extensionFor(file)}`
    localUri = `${FileSystem.cacheDirectory}${withExt}`
    await FileSystem.writeAsStringAsync(localUri, base64, { encoding: FileSystem.EncodingType.Base64 })
  }

  // Conditional loading of an optional module: a static import does not
  // work here (the module may not exist at runtime — Expo Go, web,
  // build without the native part) and that is exactly why the require is
  // inside the try/if.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Sharing = require('expo-sharing') as typeof import('expo-sharing')
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(localUri, { mimeType: file.mime, dialogTitle: file.filename ?? i18n.t('attachment.openWith') })
  }
}
