import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * O Chromium guarda só a ÚLTIMA chamada de `protocol.registerSchemesAsPrivileged`
 * (comprovado com um probe: registrar uma segunda lista faz a primeira deixar de
 * valer). Uma segunda chamada em qualquer módulo apaga silenciosamente o
 * `supportFetchAPI` dos schemes que já estavam lá — foi assim que o
 * `orbit-design://` parou de responder a `fetch` e o canvas.json deixou de
 * carregar ao abrir um design.
 *
 * Este teste é a trava: a lista é uma só, e mora em media.ts.
 */
async function sources(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await sources(full, out)
      continue
    }
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full)
  }
  return out
}

describe('privilégios de scheme', () => {
  it('são registrados numa chamada única, em media.ts', async () => {
    const root = path.join(process.cwd(), 'electron')
    const files = await sources(root)
    const registered: string[] = []
    for (const file of files) {
      const text = await fs.readFile(file, 'utf8')
      if (text.includes('registerSchemesAsPrivileged(')) {
        registered.push(path.relative(process.cwd(), file).replace(/\\/g, '/'))
      }
    }
    expect(registered).toEqual(['electron/lib/media.ts'])
  })
})
