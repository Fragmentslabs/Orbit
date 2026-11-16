/**
 * Unified diff (`git diff` / `git diff --no-index`) as the phone shows it: a parser with the
 * same model as the desktop's `unified-diff.ts`, plus the flattening that feeds the virtualized
 * list (per-file collapse, long hunks cut in chunks so one horizontal scroller never holds
 * thousands of rows).
 */

export type DiffLineKind = 'add' | 'del' | 'ctx'

export interface DiffLine {
  kind: DiffLineKind
  text: string
  /** Line number on the old / new side (undefined where the line does not exist). */
  oldNo?: number
  newNo?: number
}

export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  header: string
  lines: DiffLine[]
}

export type DiffFileStatus = 'added' | 'deleted' | 'renamed' | 'modified'

export interface DiffFile {
  oldPath: string
  newPath: string
  /** The path to show and to pick the language from. */
  path: string
  status: DiffFileStatus
  binary: boolean
  hunks: DiffHunk[]
  added: number
  removed: number
}

export function parsePatch(patch: string): DiffFile[] {
  const files: DiffFile[] = []
  for (const block of patch.split(/(?=^diff --git )/m)) {
    if (!block.trim()) continue
    const head = block.match(/^diff --git a\/(.+?) b\/(.+?)\r?$/m)
    if (!head) continue
    const oldPath = head[1]
    const newPath = head[2]
    const firstHunk = block.search(/^@@ /m)
    const preamble = firstHunk === -1 ? block : block.slice(0, firstHunk)
    const status: DiffFileStatus = /^new file mode/m.test(preamble)
      ? 'added'
      : /^deleted file mode/m.test(preamble)
        ? 'deleted'
        : /^rename from /m.test(preamble) || oldPath !== newPath
          ? 'renamed'
          : 'modified'
    const binary = /^Binary files .* differ$/m.test(preamble) || /^GIT binary patch/m.test(preamble)

    const hunks: DiffHunk[] = []
    let added = 0
    let removed = 0
    if (firstHunk !== -1) {
      for (const hunkBlock of block.slice(firstHunk).split(/(?=^@@ )/m)) {
        const m = hunkBlock.match(/^@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@(.*)$/m)
        if (!m) continue
        const hunk: DiffHunk = {
          oldStart: Number(m[1]),
          oldLines: m[2] === '' ? 1 : Number(m[2]),
          newStart: Number(m[3]),
          newLines: m[4] === '' ? 1 : Number(m[4]),
          header: m[5].trim(),
          lines: [],
        }
        const body = hunkBlock.split('\n').slice(1)
        // The patch ends with \n: the split leaves a ghost "" that is not a line of the file.
        if (body.length > 0 && body[body.length - 1] === '') body.pop()
        let oldNo = hunk.oldStart
        let newNo = hunk.newStart
        for (const raw of body) {
          // "\ No newline at end of file" is a note about the previous line, not content.
          if (raw.startsWith('\\')) continue
          const line = raw.replace(/\r$/, '')
          if (line.startsWith('+')) {
            hunk.lines.push({ kind: 'add', text: line.slice(1), newNo: newNo++ })
            added++
          } else if (line.startsWith('-')) {
            hunk.lines.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++ })
            removed++
          } else {
            hunk.lines.push({ kind: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line, oldNo: oldNo++, newNo: newNo++ })
          }
        }
        hunks.push(hunk)
      }
    }
    files.push({ oldPath, newPath, path: newPath, status, binary, hunks, added, removed })
  }
  return files
}

export type DiffItem =
  | { kind: 'file'; key: string; file: DiffFile; collapsed: boolean }
  | { kind: 'hunk'; key: string; header: string }
  | { kind: 'chunk'; key: string; file: DiffFile; lines: DiffLine[] }
  | { kind: 'note'; key: string; note: 'binary' | 'empty' }

export const CHUNK_SIZE = 120

/** What the list renders: a header per file and, unless it is collapsed, its hunks in chunks. */
export function buildDiffItems(files: DiffFile[], collapsed: ReadonlySet<string>, chunkSize = CHUNK_SIZE): DiffItem[] {
  const items: DiffItem[] = []
  for (const file of files) {
    const isCollapsed = collapsed.has(file.path)
    items.push({ kind: 'file', key: `f:${file.path}`, file, collapsed: isCollapsed })
    if (isCollapsed) continue
    if (file.binary) {
      items.push({ kind: 'note', key: `n:${file.path}`, note: 'binary' })
      continue
    }
    if (file.hunks.length === 0) {
      items.push({ kind: 'note', key: `n:${file.path}`, note: 'empty' })
      continue
    }
    file.hunks.forEach((hunk, hi) => {
      items.push({
        key: `h:${file.path}:${hi}`,
        kind: 'hunk',
        header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${hunk.header ? ` ${hunk.header}` : ''}`,
      })
      for (let i = 0; i < hunk.lines.length; i += chunkSize) {
        items.push({ kind: 'chunk', key: `c:${file.path}:${hi}:${i}`, file, lines: hunk.lines.slice(i, i + chunkSize) })
      }
    })
  }
  return items
}
