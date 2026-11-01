import path from 'node:path'
import { resolveMotionFile } from './motion-store'

/**
 * What the agent hands to motion_write, checked BEFORE it touches the disk.
 *
 * A big composition written in one call can come out CUT OFF (the model's output ran out, the
 * tool call was clipped): the file that lands is a stub, and nothing says so — the tab
 * "loads" a piece with no seek. Two defences live here: refuse an HTML that visibly ends in the
 * middle, and let the piece be split in several files (`files`: scenes/*.js, a theme.css, a
 * data.json) so no single call has to carry all of it.
 */

/** Text a piece may carry besides its entry (binary material comes in through motion_asset). */
const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.css', '.json', '.svg', '.txt', '.html', '.glsl', '.vert', '.frag'])
export const MAX_PIECE_FILES = 40
export const MAX_PIECE_FILE_BYTES = 1_500_000

/**
 * Whether a full document stops short: no closing </html>, or more <script>/<style> opened than
 * closed. A bare fragment (no <html>/<body>) is left alone — the runtime accepts those.
 */
export function truncationReason(html: string): string | null {
  const text = html.replace(/<!--[\s\S]*?-->/g, '')
  if (!/<html\b|<body\b/i.test(text)) return null
  const count = (re: RegExp) => (text.match(re) ?? []).length
  if (!/<\/html\s*>/i.test(text)) return 'it has no closing </html>'
  if (count(/<script\b/gi) !== count(/<\/script\s*>/gi)) return 'a <script> is never closed'
  if (count(/<style\b/gi) !== count(/<\/style\s*>/gi)) return 'a <style> is never closed'
  return null
}

export interface PieceFile {
  /** Path relative to the piece's folder, with `/`. */
  name: string
  absolute: string
  content: string
}

/** The extra files of a piece, validated: inside the folder, text only, small, not the entry. */
export function planPieceFiles(folder: string, entry: string, files: Record<string, string> | undefined): PieceFile[] {
  if (!files) return []
  const names = Object.keys(files)
  if (names.length > MAX_PIECE_FILES) throw new Error(`too many files (${names.length}); the limit is ${MAX_PIECE_FILES}`)
  return names.map((name) => {
    const absolute = resolveMotionFile(folder, name)
    if (!absolute) throw new Error(`"${name}" is not a path inside the composition folder`)
    if (path.resolve(absolute) === path.resolve(entry)) throw new Error(`"${name}" is the entry — pass it as html`)
    const ext = path.extname(absolute).toLowerCase()
    if (!TEXT_EXTENSIONS.has(ext)) {
      throw new Error(`"${name}": only text files can be written here (${[...TEXT_EXTENSIONS].join(' ')}); bring binary material in with motion_asset`)
    }
    const content = files[name]
    if (Buffer.byteLength(content) > MAX_PIECE_FILE_BYTES) throw new Error(`"${name}" is larger than ${MAX_PIECE_FILE_BYTES} bytes`)
    return { name: name.replace(/\\/g, '/').replace(/^\/+/, ''), absolute, content }
  })
}

/** `file` of motion_edit: a text file of the piece (default: the entry). */
export function resolveEditFile(folder: string, entry: string, file: string | undefined): string {
  if (!file) return entry
  const absolute = resolveMotionFile(folder, file)
  if (!absolute) throw new Error(`"${file}" is not a path inside the composition folder`)
  if (!TEXT_EXTENSIONS.has(path.extname(absolute).toLowerCase())) throw new Error(`"${file}" is not a text file of the piece`)
  return absolute
}
