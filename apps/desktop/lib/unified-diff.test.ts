import { describe, expect, it } from 'vitest'

import { parsePatch } from './unified-diff'

/**
 * O parser alimenta a aba Diff e o visualizador de arquivos das Pastas. Um
 * erro aqui não quebra nada visivelmente: ele desloca números de linha ou
 * pinta linha errada de verde/vermelho, que é o tipo de defeito que o usuário
 * só descobre confiando no diff errado.
 */

const patch = `diff --git a/src/a.ts b/src/a.ts
index 1234567..89abcde 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,7 +10,8 @@ export function soma(a: number, b: number) {
 const x = 1
-  return a + b
+  // agora com log
+  return a + b + 0
 const y = 2
`

describe('parsePatch', () => {
  it('extrai caminhos, hunk e contagens', () => {
    const [file] = parsePatch(patch)
    expect(file.oldPath).toBe('src/a.ts')
    expect(file.newPath).toBe('src/a.ts')
    expect(file.added).toBe(2)
    expect(file.removed).toBe(1)
    expect(file.hunks).toHaveLength(1)
  })

  it('lê os números do cabeçalho do hunk', () => {
    const [hunk] = parsePatch(patch)[0].hunks
    expect(hunk.oldStart).toBe(10)
    expect(hunk.oldLines).toBe(7)
    expect(hunk.newStart).toBe(10)
    expect(hunk.newLines).toBe(8)
    expect(hunk.header).toBe('export function soma(a: number, b: number) {')
  })

  it('classifica as linhas e tira o prefixo', () => {
    const [hunk] = parsePatch(patch)[0].hunks
    expect(hunk.lines.map((l) => l.kind)).toEqual(['ctx', 'del', 'add', 'add', 'ctx'])
    expect(hunk.lines[1].text).toBe('  return a + b')
    expect(hunk.lines[2].text).toBe('  // agora com log')
    expect(hunk.lines[0].text).toBe('const x = 1')
  })

  it('não inventa uma linha vazia no fim do patch', () => {
    // O split do corpo deixa um "" fantasma por causa do \n final; se ele
    // entrar como linha, todo número depois dele sai deslocado.
    const [hunk] = parsePatch(patch)[0].hunks
    expect(hunk.lines.at(-1)).toEqual({ kind: 'ctx', text: 'const y = 2' })
  })

  it('separa vários arquivos no mesmo patch', () => {
    const files = parsePatch(`${patch}${patch.replace(/src\/a\.ts/g, 'src/b.ts')}`)
    expect(files.map((f) => f.newPath)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('lê vários hunks do mesmo arquivo', () => {
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

  it('assume contagem 1 quando o cabeçalho omite (hunk de uma linha)', () => {
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

  it('lê arquivo novo (/dev/null como origem)', () => {
    const [file] = parsePatch(`diff --git a/novo.ts b/novo.ts
new file mode 100644
--- /dev/null
+++ b/novo.ts
@@ -0,0 +1,2 @@
+linha 1
+linha 2
`)
    expect(file.added).toBe(2)
    expect(file.removed).toBe(0)
    expect(file.hunks[0].oldStart).toBe(0)
  })

  it('tolera CRLF sem deixar o \\r no texto', () => {
    const [hunk] = parsePatch(
      'diff --git a/x.ts b/x.ts\r\n--- a/x.ts\r\n+++ b/x.ts\r\n@@ -1,1 +1,1 @@\r\n-a\r\n+b\r\n',
    )[0].hunks
    expect(hunk.lines.map((l) => l.text)).toEqual(['a', 'b'])
  })

  it('devolve lista vazia para entrada vazia ou sem cabeçalho git', () => {
    expect(parsePatch('')).toEqual([])
    expect(parsePatch('texto solto que não é patch')).toEqual([])
  })
})
