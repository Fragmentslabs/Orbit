import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

/**
 * Diário de mídia por turno e o revert que o aplica: peças (aqui, um canvas de
 * design — motion e slides passam pelo mesmo journalPiece) e a galeria
 * (artefatos, imagens). Cada turno roda dentro do escopo que o chat-engine abre;
 * o revert desfaz do turno escolhido até o fim, e o unrevert devolve tudo.
 */

const userData = path.join(os.tmpdir(), `orbit-media-journal-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData, getAppPath: () => userData, isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  net: {},
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
  session: {},
  dialog: {},
}))

const { bindMediaJournal, closeMediaJournal, mergeJournals, readMediaJournal, runWithMediaJournal } = await import('./media-journal')
const { discardMediaRevert, revertMedia, unrevertMedia } = await import('./media-revert')
const media = await import('../media')
const { getDesign, designIdFor } = await import('../design/design-store')
const { createDesignTools, designPiecesDir } = await import('../tools/design')

type Exec = (input: unknown, options: unknown) => Promise<unknown>
const run = (tools: Record<string, unknown>, name: string, input: unknown) =>
  (tools[name] as { execute: Exec }).execute(input, { toolCallId: 'call1', messages: [], abortSignal: undefined }) as Promise<string>

/** Um turno do agente: o escopo que o chat-engine abre em volta do runChatTurn. */
function turn(sessionId: string, messageId: string, fn: () => Promise<void>): Promise<void> {
  return runWithMediaJournal(sessionId, async () => {
    bindMediaJournal(messageId)
    try {
      await fn()
    } finally {
      closeMediaJournal()
    }
  })
}

const board = (html: string) => ({ file: 'Main.html', x: 0, y: 0, w: 400, h: 300, html })

afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

describe('mergeJournals', () => {
  it('o primeiro turno que tocou um caminho ou uma entrada é o que vale', () => {
    const merged = mergeJournals([
      { dir: '/j/m1', records: [{ type: 'media', id: 'a.png', before: null }, { type: 'path', path: '/d/piece', backup: 'b1' }] },
      {
        dir: '/j/m2',
        records: [
          { type: 'media', id: 'a.png', before: { id: 'a.png' } as never },
          { type: 'path', path: '/d/piece', backup: 'b0' },
          // Dentro de uma pasta já registrada por um turno anterior: coberto por ela.
          { type: 'path', path: '/d/piece/x.html', backup: 'b3' },
          { type: 'path', path: '/d/other.png', backup: null },
        ],
      },
    ])
    expect(merged).toEqual([
      { type: 'media', id: 'a.png', before: null },
      { type: 'path', path: path.resolve('/d/piece'), backupFile: path.join('/j/m1', 'files', 'b1'), piece: undefined },
      { type: 'path', path: path.resolve('/d/other.png'), backupFile: null, piece: undefined },
    ])
  })
})

describe('revert de mídia', () => {
  const sessionId = 'sess1'
  const tools = createDesignTools({ sessionId })
  const folder = path.join(designPiecesDir(sessionId), 'landing')
  const boardFile = path.join(folder, 'Main.html')
  let createdArtifact = ''
  let foreignArtifact = ''

  it('fora de um turno nada é registrado', async () => {
    await run(tools, 'design_write', { name: 'Rascunho', boards: [board('<p>fora</p>')] })
    expect(await readMediaJournal(sessionId, 'msg0')).toBeNull()
  })

  it('cada turno guarda o estado ANTES da primeira escrita', async () => {
    await turn(sessionId, 'msg1', async () => {
      await run(tools, 'design_write', { name: 'Landing', boards: [board('<p>A</p>')] })
    })
    await turn(sessionId, 'msg2', async () => {
      await run(tools, 'design_edit', { name: 'Landing', file: 'Main.html', edits: [{ oldText: '<p>A</p>', newText: '<p>B</p>' }] })
      createdArtifact = (await media.saveArtifact('<p>novo</p>', { title: 'Novo', sessionId })).id
    })
    // Outro chat grava na galeria depois: o revert deste não pode levar junto.
    foreignArtifact = (await media.saveArtifact('<p>de outro chat</p>', { title: 'Outro', sessionId: 'outro' })).id

    const first = await readMediaJournal(sessionId, 'msg1')
    expect(first?.records).toEqual([expect.objectContaining({ type: 'path', path: folder, backup: null })])
    const second = await readMediaJournal(sessionId, 'msg2')
    expect(second?.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'path', path: folder, backup: expect.any(String) }),
        expect.objectContaining({ type: 'media', id: createdArtifact, before: null }),
      ]),
    )
  })

  it('reverter o segundo turno volta o canvas e tira só o artefato dele', async () => {
    const summary = await revertMedia(sessionId, ['msg2'])
    expect(summary).toEqual({ restored: true, pieces: 1, items: 1 })
    expect(await fsp.readFile(boardFile, 'utf8')).toBe('<p>A</p>')
    expect(await media.getMediaEntry(createdArtifact)).toBeNull()
    await expect(fsp.stat(path.join(userData, 'orbit-data', 'artifacts', createdArtifact))).rejects.toThrow()
    expect(await media.getMediaEntry(foreignArtifact)).not.toBeNull()
  })

  it('o unrevert devolve o que o revert desfez', async () => {
    await unrevertMedia(sessionId)
    expect(await fsp.readFile(boardFile, 'utf8')).toBe('<p>B</p>')
    const restored = await media.getMediaEntry(createdArtifact)
    expect(restored).not.toBeNull()
    expect(await fsp.readFile(restored!.path, 'utf8')).toBe('<p>novo</p>')
  })

  it('reverter desde o primeiro turno apaga a peça criada nele e a tira do registro', async () => {
    const summary = await revertMedia(sessionId, ['msg1', 'msg2'])
    expect(summary?.restored).toBe(true)
    await expect(fsp.stat(folder)).rejects.toThrow()
    expect(await getDesign(designIdFor(folder))).toBeUndefined()
    // A peça feita fora de um turno não é do agente: fica.
    expect(await fsp.readFile(path.join(designPiecesDir(sessionId), 'rascunho', 'Main.html'), 'utf8')).toBe('<p>fora</p>')
  })

  it('confirmar o revert (nova mensagem) descarta os diários dos turnos e o redo', async () => {
    await discardMediaRevert(sessionId, ['msg1', 'msg2'])
    expect(await readMediaJournal(sessionId, 'msg1')).toBeNull()
    expect(await readMediaJournal(sessionId, 'msg2')).toBeNull()
    await unrevertMedia(sessionId) // sem redo: não faz nada
    await expect(fsp.stat(folder)).rejects.toThrow()
  })
})

describe('revert de mídia — galeria', () => {
  const sessionId = 'sess2'

  it('um artefato reescrito no turno volta ao texto e à revisão de antes', async () => {
    const ref = await media.saveArtifact('<p>v1</p>', { title: 'Doc', sessionId })
    await turn(sessionId, 'msg1', async () => {
      await media.updateArtifact(ref.id, '<p>v2</p>')
    })
    expect((await media.getMediaEntry(ref.id))?.revision).toBe(2)

    await revertMedia(sessionId, ['msg1'])
    const entry = await media.getMediaEntry(ref.id)
    expect(entry?.revision ?? 1).toBe(1)
    expect(await fsp.readFile(entry!.path, 'utf8')).toBe('<p>v1</p>')
  })

  it('uma imagem excluída no turno volta à galeria, com o arquivo', async () => {
    const id = media.mediaIdFromUrl(await media.saveMedia(Buffer.from('fake-png'), 'png', { source: 'chat', sessionId }))!
    const file = (await media.getMediaEntry(id))!.path
    await turn(sessionId, 'msg2', async () => {
      await media.deleteMedia(id)
    })
    expect(await media.getMediaEntry(id)).toBeNull()

    const summary = await revertMedia(sessionId, ['msg2'])
    expect(summary).toEqual({ restored: true, pieces: 0, items: 1 })
    expect(await media.getMediaEntry(id)).not.toBeNull()
    expect(await fsp.readFile(file, 'utf8')).toBe('fake-png')
  })

  it('turnos que não tocaram em mídia não produzem resumo', async () => {
    expect(await revertMedia(sessionId, ['msg-sem-midia'])).toBeUndefined()
  })
})
