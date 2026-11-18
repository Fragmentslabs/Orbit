import { Platform } from 'react-native'
import * as FileSystem from 'expo-file-system/legacy'
import type { CompanionHttp } from '@orbit/companion-client'

/** Paper colours: a print is never drawn in the app's dark theme. */
export const PRINT_COLORS = {
  background: '#ffffff',
  foreground: '#111111',
  muted: '#555555',
  border: '#dddddd',
  accent: '#1a56db',
  highlight: '#fff3b0',
}

/** Pages of a PDF that are drawn into a print on Android (it has no native print of a PDF file). */
export const PRINT_MAX_PAGES = 60
const PRINT_BATCH = 3

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

export function mimeOfOriginal(kind: string): string {
  return MIME[kind] ?? 'application/octet-stream'
}

type PrintModule = typeof import('expo-print')
let printModule: PrintModule | null | undefined

/**
 * `expo-print` is a native module: an app built before it was added does not have it, and a static
 * import would crash the whole app at startup ("Cannot find native module"). It is loaded on demand,
 * and its absence only hides the print button until the app is rebuilt.
 */
function loadPrint(): PrintModule | null {
  if (printModule !== undefined) return printModule
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    printModule = require('expo-print') as PrintModule
  } catch {
    printModule = null
  }
  return printModule
}

/** Can this build print? false until the app is rebuilt with the native module. */
export function printAvailable(): boolean {
  return loadPrint() !== null
}

/** Closing the print dialog is not a failure. */
function isCancel(err: unknown): boolean {
  return /did not complete|cancel/i.test(String((err as Error)?.message ?? err))
}

export async function printHtml(html: string): Promise<void> {
  const Print = loadPrint()
  if (!Print) throw new Error('printing is not available in this build')
  try {
    await Print.printAsync({ html })
  } catch (err) {
    if (!isCancel(err)) throw err
  }
}

/**
 * Downloads the document's ORIGINAL file from the desktop into the cache. null when the desktop has
 * none (a pasted excerpt, a downloaded page) or answered with anything but the file.
 */
export async function downloadOriginal(
  http: CompanionHttp,
  docId: string,
  sessionId: string | undefined,
  fileName: string,
): Promise<string | null> {
  const dir = FileSystem.cacheDirectory
  if (!dir) throw new Error('no cache directory')
  const { url, headers } = http.documentFileRequest(docId, sessionId)
  const res = await FileSystem.downloadAsync(url, `${dir}${fileName}`, { headers })
  if (res.status !== 200) {
    await FileSystem.deleteAsync(res.uri, { idempotent: true }).catch(() => {})
    return null
  }
  return res.uri
}

/** The pages of a PDF as one printable page of pictures, for the platform that cannot print the file. */
export async function pdfPagesHtml(
  http: CompanionHttp,
  docId: string,
  sessionId: string | undefined,
  total: number,
): Promise<string> {
  const last = Math.min(total, PRINT_MAX_PAGES)
  const images: string[] = []
  for (let from = 1; from <= last; from += PRINT_BATCH) {
    const res = await http.getDocumentPages(docId, {
      sessionId,
      from,
      count: Math.min(PRINT_BATCH, last - from + 1),
      scale: 1.4,
      text: false,
    })
    if (!res.ok || !res.data) throw new Error('could not render the pages')
    for (const page of res.data.pages) images.push(`<img src="${page.dataUrl}">`)
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@page{margin:0}body{margin:0}img{display:block;width:100%;page-break-after:always}
</style></head><body>${images.join('')}</body></html>`
}

/**
 * Prints a PDF of the desktop: iOS prints the file itself; Android has no print of a file, so it
 * prints the rendered pages (up to {@link PRINT_MAX_PAGES}).
 */
export async function printPdf(
  http: CompanionHttp,
  docId: string,
  sessionId: string | undefined,
  total: number,
  fileName: string,
): Promise<void> {
  if (Platform.OS === 'ios') {
    const uri = await downloadOriginal(http, docId, sessionId, fileName)
    if (!uri) throw new Error('document has no file')
    const Print = loadPrint()
    if (!Print) throw new Error('printing is not available in this build')
    try {
      await Print.printAsync({ uri })
    } catch (err) {
      if (!isCancel(err)) throw err
    }
    return
  }
  await printHtml(await pdfPagesHtml(http, docId, sessionId, total))
}
