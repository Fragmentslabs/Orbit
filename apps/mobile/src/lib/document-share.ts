import * as FileSystem from 'expo-file-system/legacy'
import * as Sharing from 'expo-sharing'

/** Safe file name from a title — the share sheet shows it. */
export function shareFileName(title: string | undefined, fallback: string, ext: string): string {
  const base = (title || fallback)
    .replace(/[^\w.\- ]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
  const safe = base || fallback
  return safe.toLowerCase().endsWith(`.${ext}`) ? safe : `${safe}.${ext}`
}

/** Downloads (the share sheet only takes a local file) and hands the file to the system sheet. */
export async function shareRemoteFile(url: string, name: string, mimeType: string, dialogTitle: string) {
  const dir = FileSystem.cacheDirectory
  if (!dir) throw new Error('no cache directory')
  const downloaded = await FileSystem.downloadAsync(url, `${dir}${name}`)
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(downloaded.uri, { mimeType, dialogTitle })
  }
}

export async function shareText(text: string, name: string, dialogTitle: string) {
  const dir = FileSystem.cacheDirectory
  if (!dir) throw new Error('no cache directory')
  const uri = `${dir}${name}`
  await FileSystem.writeAsStringAsync(uri, text)
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri, { mimeType: 'text/plain', dialogTitle })
  }
}
