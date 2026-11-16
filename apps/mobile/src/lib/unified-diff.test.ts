import { describe, expect, it } from 'vitest'
import { buildDiffItems, parsePatch } from './unified-diff'

const PATCH = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@ function main
 keep
-old
+new
+extra
 tail
\\ No newline at end of file
diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+n1
+n2
diff --git a/img.png b/img.png
index 1..2 100644
Binary files a/img.png and b/img.png differ
diff --git a/old.txt b/old.txt
deleted file mode 100644
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
`

describe('parsePatch', () => {
  const files = parsePatch(PATCH)

  it('splits files and detects status and binaries', () => {
    expect(files.map((f) => [f.path, f.status, f.binary])).toEqual([
      ['src/a.ts', 'modified', false],
      ['new.txt', 'added', false],
      ['img.png', 'modified', true],
      ['old.txt', 'deleted', false],
    ])
  })

  it('counts lines and numbers both sides, skipping the no-newline note', () => {
    const a = files[0]
    expect([a.added, a.removed]).toEqual([2, 1])
    expect(a.hunks[0].header).toBe('function main')
    expect(a.hunks[0].lines.map((l) => [l.kind, l.text, l.oldNo, l.newNo])).toEqual([
      ['ctx', 'keep', 1, 1],
      ['del', 'old', 2, undefined],
      ['add', 'new', undefined, 2],
      ['add', 'extra', undefined, 3],
      ['ctx', 'tail', 3, 4],
    ])
  })

  it('reads a hunk with an omitted length as one line', () => {
    expect(files[3].hunks[0]).toMatchObject({ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0 })
  })

  it('returns nothing for an empty patch', () => {
    expect(parsePatch('')).toEqual([])
  })
})

describe('buildDiffItems', () => {
  const files = parsePatch(PATCH)

  it('lists header, hunk and chunk per file, with a note for binaries', () => {
    const kinds = buildDiffItems(files, new Set()).map((i) => i.kind)
    expect(kinds).toEqual(['file', 'hunk', 'chunk', 'file', 'hunk', 'chunk', 'file', 'note', 'file', 'hunk', 'chunk'])
  })

  it('hides the body of a collapsed file and cuts long hunks in chunks', () => {
    const items = buildDiffItems(files, new Set(['src/a.ts']))
    expect(items[0]).toMatchObject({ kind: 'file', collapsed: true })
    expect(items[1]).toMatchObject({ kind: 'file' })
    const chunks = buildDiffItems([files[0]], new Set(), 2).filter((i) => i.kind === 'chunk')
    expect(chunks.length).toBe(3)
  })
})
