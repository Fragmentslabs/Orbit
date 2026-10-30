import { describe, expect, it } from 'vitest'

import { parsePatch } from './unified-diff'

/**
 * The parser feeds the Diff tab and the file viewer of the Folders. An
 * error here breaks nothing visibly: it shifts line numbers or
 * paints the wrong line green/red, which is the kind of defect the user
 * only discovers by trusting the wrong diff.
 */

const patch = `diff --git a/src/a.ts b/src/a.ts
index 1234567..89abcde 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,7 +10,8 @@ export function sum(a: number, b: number) {
 const x = 1
-  return a + b
+  // now with a log
+  return a + b + 0
 const y = 2
`

describe('parsePatch', () => {
  it('extracts paths, hunk and counts', () => {
    const [file] = parsePatch(patch)
    expect(file.oldPath).toBe('src/a.ts')
    expect(file.newPath).toBe('src/a.ts')
    expect(file.added).toBe(2)
    expect(file.removed).toBe(1)
    expect(file.hunks).toHaveLength(1)
  })

  it('reads the numbers of the hunk header', () => {
    const [hunk] = parsePatch(patch)[0].hunks
    expect(hunk.oldStart).toBe(10)
    expect(hunk.oldLines).toBe(7)
    expect(hunk.newStart).toBe(10)
    expect(hunk.newLines).toBe(8)
    expect(hunk.header).toBe('export function sum(a: number, b: number) {')
  })

  it('classifies the lines and strips the prefix', () => {
    const [hunk] = parsePatch(patch)[0].hunks
    expect(hunk.lines.map((l) => l.kind)).toEqual(['ctx', 'del', 'add', 'add', 'ctx'])
    expect(hunk.lines[1].text).toBe('  return a + b')
    expect(hunk.lines[2].text).toBe('  // now with a log')
    expect(hunk.lines[0].text).toBe('const x = 1')
  })

  it('does not invent an empty line at the end of the patch', () => {
    // The split of the body leaves a ghost "" because of the trailing \n; if it
    // entering as a line, every number after it comes out shifted.
    const [hunk] = parsePatch(patch)[0].hunks
    expect(hunk.lines.at(-1)).toEqual({ kind: 'ctx', text: 'const y = 2' })
  })

  it('splits several files in the same patch', () => {
    const files = parsePatch(`${patch}${patch.replace(/src\/a\.ts/g, 'src/b.ts')}`)
    expect(files.map((f) => f.newPath)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('reads several hunks of the same file', () => {
    const twoHunks = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1,2 +1,2 @@
-a
+b
@@ -20,2 +20,2 @@
-c
+d
`
    const [file] = parsePatch(twoHunks)
    expect(file.hunks.map((h) => h.oldStart)).toEqual([1, 20])
    expect(file.added).toBe(2)
    expect(file.removed).toBe(2)
  })

  it('assumes a count of 1 when the header omits it (one-line hunk)', () => {
    const [hunk] = parsePatch(`diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -5 +5 @@
-a
+b
`)[0].hunks
    expect(hunk.oldLines).toBe(1)
    expect(hunk.newLines).toBe(1)
  })

  it('reads a new file (/dev/null as the origin)', () => {
    const [file] = parsePatch(`diff --git a/new.ts b/new.ts
new file mode 100644
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+line 1
+line 2
`)
    expect(file.added).toBe(2)
    expect(file.removed).toBe(0)
    expect(file.hunks[0].oldStart).toBe(0)
  })

  it('tolerates CRLF without leaving the \\r in the text', () => {
    const [hunk] = parsePatch(
      'diff --git a/x.ts b/x.ts\r\n--- a/x.ts\r\n+++ b/x.ts\r\n@@ -1,1 +1,1 @@\r\n-a\r\n+b\r\n',
    )[0].hunks
    expect(hunk.lines.map((l) => l.text)).toEqual(['a', 'b'])
  })

  it('returns an empty list for empty input or no git header', () => {
    expect(parsePatch('')).toEqual([])
    expect(parsePatch('loose text that is not a patch')).toEqual([])
  })
})
