import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Edição de artefato como FILA: dois chats no mesmo artifactId são
 * serializados, cada um aplicando sobre o resultado do outro. Uma edição cujo
 * oldText já não existe falha em vez de sobrescrever — é o "rejeitar stale".
 */

const userData = path.join(os.tmpdir(), `orbit-artifact-edit-test-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  BrowserWindow: { getAllWindows: () => [] },
  net: {},
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
  session: {},
  dialog: {},
}))

const { applyTextEdits } = await import('./tools/motion-chat')
let media: typeof import('./media')

beforeAll(async () => {
  media = await import('./media')
})

afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

async function readArtifact(id: string): Promise<string> {
  const entry = await media.getMediaEntry(id)
  return fsp.readFile(entry!.path, 'utf8')
}

describe('mutateArtifact', () => {
  it('applies exact-text edits in place and bumps the revision', async () => {
    const ref = await media.saveArtifact('<p>[A]</p>', { title: 'T', sessionId: 's' })
    const updated = await media.mutateArtifact(ref.id, (html) =>
      applyTextEdits(html, [{ oldText: '[A]', newText: '[A1]' }]),
    )
    expect(await readArtifact(ref.id)).toBe('<p>[A1]</p>')
    expect(updated?.revision).toBe(2)
  })

  it('serializes concurrent edits so neither is lost', async () => {
    const ref = await media.saveArtifact('<p>[A][B]</p>', { title: 'T', sessionId: 's' })
    const slow = (oldText: string, newText: string) => async (html: string) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return applyTextEdits(html, [{ oldText, newText }])
    }
    await Promise.all([
      media.mutateArtifact(ref.id, slow('[A]', '[A2]')),
      media.mutateArtifact(ref.id, slow('[B]', '[B2]')),
    ])
    // Cada edição leu DENTRO do lock, então a segunda viu o resultado da
    // primeira: as duas trocas sobrevivem (uma fila, não um "último vence").
    expect(await readArtifact(ref.id)).toBe('<p>[A2][B2]</p>')
  })

  it('rejects a stale edit and leaves the file untouched', async () => {
    const ref = await media.saveArtifact('<p>[A]</p>', { title: 'T', sessionId: 's' })
    await media.mutateArtifact(ref.id, (html) => applyTextEdits(html, [{ oldText: '[A]', newText: '[A3]' }]))
    await expect(
      media.mutateArtifact(ref.id, (html) => applyTextEdits(html, [{ oldText: '[A]', newText: 'x' }])),
    ).rejects.toThrow(/not found/)
    expect(await readArtifact(ref.id)).toBe('<p>[A3]</p>')
  })
})
