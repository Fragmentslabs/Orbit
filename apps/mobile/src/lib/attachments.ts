/**
 * Helpers de anexos (FilePart) no nativo.
 *
 * - `uriToFilePart`: converte um asset local (câmera/galeria/document picker)
 *   em FilePart com data URL. Usa expo-file-system (API legacy, que preserva
 *   readAsStringAsync) porque `fetch(file://…)` + FileReader falha no RN
 *   nativo — era a causa dos erros ao anexar foto/arquivo.
 * - `openFilePart`: grava o data URL num arquivo de cache e abre o share
 *   sheet do sistema (o usuário escolhe o app que suporta o tipo).
 */
import { Platform } from 'react-native'
import * as FileSystem from 'expo-file-system/legacy'
import type { FilePart } from '@orbit/shared'

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

/** Extensão razoável a partir do mime/nome, pro share sheet sugerir apps certos. */
function extensionFor(file: FilePart): string {
  const fromName = file.filename?.match(/\.([a-zA-Z0-9]+)$/)?.[1]
  if (fromName) return fromName
  const subtype = file.mime.split('/')[1]?.split('+')[0]
  return subtype && subtype.length <= 5 ? subtype : 'bin'
}

/**
 * Abre um FilePart: URLs http(s) vão pro navegador via share/Linking;
 * data URLs são materializados num arquivo de cache e compartilhados.
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

  Sharing = require('expo-sharing') as typeof import('expo-sharing')
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(localUri, { mimeType: file.mime, dialogTitle: file.filename ?? 'Abrir com…' })
  }
}
