import { createHash } from 'node:crypto'
import type { AppliedEdit } from '../tools/piece-common'

/**
 * Looking at a composition's file without re-reading all of it, and proving an edit landed.
 *
 * Two jobs the agent used to do badly by hand: copying an exact string out of a 500-line file
 * (it re-read the whole thing five times) and finding out whether motion_edit really changed
 * anything (it only learned at the next render). A short hash of the file travels in both
 * directions: motion_read says it, the edit receipt says before → after, and `baseHash` on the
 * next edit refuses to run on a file that is no longer the one the agent looked at.
 */

export const MAX_VIEW_LINES = 400
const MAX_MATCHES = 40

/** 8 hex chars of the file's content: enough to tell two versions apart. */
export function fileHash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 8)
}

export interface ViewRequest {
  from?: number
  to?: number
  /** Plain text (case-sensitive): the lines that contain it, with context around. */
  find?: string
  context?: number
}

const numbered = (lines: string[], first: number, last: number): string => {
  const width = String(last).length
  return lines
    .slice(first - 1, last)
    .map((line, i) => `${String(first + i).padStart(width)}\t${line}`)
    .join('\n')
}

/**
 * What motion_read returns. No request = the file as it is (it is what edits copy from);
 * `from`/`to` = those lines, numbered; `find` = the matching lines with context, numbered.
 * Line numbers are NOT part of the file: oldText never includes them. Pure.
 */
export function viewFile(name: string, text: string, req: ViewRequest = {}): string {
  const lines = text.split('\n')
  const head = `${name} · ${lines.length} lines · hash ${fileHash(text)}`
  if (req.find === undefined && req.from === undefined && req.to === undefined) return `[${head}]\n${text}`

  if (req.find !== undefined) {
    if (!req.find) return `[${head}]\nfind is empty.`
    const context = Math.max(0, Math.min(10, req.context ?? 2))
    const hits: number[] = []
    lines.forEach((line, i) => {
      if (line.includes(req.find as string)) hits.push(i + 1)
    })
    if (hits.length === 0) return `[${head}]\nNo line contains ${JSON.stringify(req.find)}. (Case matters; try a shorter piece of the text.)`
    const shown = hits.slice(0, MAX_MATCHES)
    // Merge the windows around each hit so close matches read as one block.
    const blocks: Array<[number, number]> = []
    for (const hit of shown) {
      const start = Math.max(1, hit - context)
      const end = Math.min(lines.length, hit + context)
      const last = blocks[blocks.length - 1]
      if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end)
      else blocks.push([start, end])
    }
    const body = blocks.map(([a, b]) => numbered(lines, a, b)).join('\n   …\n')
    const more = hits.length > shown.length ? `\n(+${hits.length - shown.length} more matches — narrow the text)` : ''
    return `[${head}] ${hits.length} line${hits.length === 1 ? '' : 's'} contain ${JSON.stringify(req.find)}; line numbers are not part of the file:\n${body}${more}`
  }

  const first = Math.max(1, Math.floor(req.from ?? 1))
  const requestedLast = Math.min(lines.length, Math.floor(req.to ?? lines.length))
  if (first > lines.length) return `[${head}]\nThe file has only ${lines.length} lines.`
  const last = Math.min(requestedLast, first + MAX_VIEW_LINES - 1)
  const cut = last < requestedLast ? `\n(stopped at ${MAX_VIEW_LINES} lines — ask from ${last + 1})` : ''
  return `[${head}] lines ${first}–${last}; line numbers are not part of the file:\n${numbered(lines, first, last)}${cut}`
}

/** What motion_edit answers: where each change landed and the file's hash before → after. Pure. */
export function describeEditReceipt(name: string, before: string, after: string, applied: AppliedEdit[]): string {
  const rows = applied.map((a) => {
    const times = a.replacements > 1 ? `${a.replacements} replacements, first at line ${a.line}` : `line ${a.line}`
    const size = a.oldLines === a.newLines ? '' : ` (${a.oldLines}→${a.newLines} lines)`
    return `- edit ${a.edit}: ${times}${size}${a.now ? ` — now: ${a.now}` : ''}`
  })
  const beforeLines = before.split('\n').length
  const afterLines = after.split('\n').length
  return [
    `Receipt for ${name}: ${beforeLines} → ${afterLines} lines, hash ${fileHash(before)} → ${fileHash(after)}.`,
    ...rows,
  ].join('\n')
}
