import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Chromium keeps only the LAST call to `protocol.registerSchemesAsPrivileged`
 * (proven with a probe: registering a second list makes the first stop
 * counting). A second call in any module silently erases the
 * `supportFetchAPI` of the schemes that were already there — that is how
 * `orbit-design://` stopped answering `fetch` and canvas.json stopped
 * loading when opening a design.
 *
 * This test is the lock: the list is a single one, and it lives in media.ts.
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

describe('scheme privileges', () => {
  it('are registered in a single call, in media.ts', async () => {
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
