import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const userData = path.join(os.tmpdir(), `orbit-doc-source-${Date.now()}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  BrowserWindow: { getAllWindows: () => [] },
  net: {},
  protocol: { handle: () => {} },
  session: {
    fromPartition: () => {
      throw new Error('sem Chromium no teste')
    },
  },
  dialog: {},
}))

const { isDocumentSource, useDocumentAsSource } = await import('./document-source')
const { getMediaEntry, saveDocument } = await import('./media')
const { listSessionDocuments, removeSessionDocument } = await import('./session-documents')

const SESSION = 'sessao-de-teste'

beforeEach(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

/**
 * Promover é o único caminho entre os dois espaços — o que o agente PRODUZIU e
 * o que a conversa LÊ. Ele é deliberado por segurança de conteúdo (saída que
 * escorre sozinha para as fontes faz o agente citar o próprio relatório como
 * evidência), então o que estes testes protegem é que ele só aconteça quando
 * pedido, e que pedir duas vezes não encha a aba de cópias.
 */
describe('promover documento a fonte', () => {
  it('leva o Markdown para as fontes da conversa', async () => {
    const ref = await saveDocument('# Manual\n\nComo instalar.', [], { title: 'Manual' })

    const result = await useDocumentAsSource(SESSION, ref.id)

    expect(result.ok).toBe(true)
    const sources = await listSessionDocuments(SESSION)
    expect(sources.map((d) => d.filename)).toEqual(['Manual'])
    // O id da fonte fica anotado no documento: é o que torna promover idempotente.
    expect((await getMediaEntry(ref.id))?.sourceId).toBe(sources[0].id)
  })

  it('promover de novo aponta para a mesma fonte, sem duplicar', async () => {
    const ref = await saveDocument('# Manual\n\nCorpo.', [], { title: 'Manual' })
    const first = await useDocumentAsSource(SESSION, ref.id)

    const second = await useDocumentAsSource(SESSION, ref.id)

    expect(second).toEqual({
      ok: true,
      sourceId: first.ok ? first.sourceId : '',
      already: true,
    })
    expect(await listSessionDocuments(SESSION)).toHaveLength(1)
  })

  it('removida a fonte, promover repõe em vez de achar que já existe', async () => {
    const ref = await saveDocument('# Manual\n\nCorpo.', [], { title: 'Manual' })
    const first = await useDocumentAsSource(SESSION, ref.id)
    await removeSessionDocument(SESSION, first.ok ? first.sourceId : '')
    expect(await listSessionDocuments(SESSION)).toHaveLength(0)

    const again = await useDocumentAsSource(SESSION, ref.id)

    expect(again).toMatchObject({ ok: true, already: false })
    expect(await listSessionDocuments(SESSION)).toHaveLength(1)
  })

  it('documento que não existe não vira fonte', async () => {
    expect(await useDocumentAsSource(SESSION, 'doc_naoexiste.md')).toMatchObject({ ok: false })
    expect(await listSessionDocuments(SESSION)).toHaveLength(0)
  })
})

/**
 * O estado da pastilha vem DAQUI, e não de um booleano guardado na tela: a
 * fonte pode ser removida na aba Fontes a qualquer momento, e aí o botão tem
 * que voltar a oferecer a promoção em vez de fingir que o documento já está lá.
 */
describe('estado de fonte', () => {
  it('acompanha promover e remover', async () => {
    const ref = await saveDocument('# Manual\n\nCorpo.', [], { title: 'Manual' })
    expect(await isDocumentSource(SESSION, ref.id)).toBe(false)

    const added = await useDocumentAsSource(SESSION, ref.id)
    expect(await isDocumentSource(SESSION, ref.id)).toBe(true)

    await removeSessionDocument(SESSION, added.ok ? added.sourceId : '')
    // O `sourceId` continua anotado no documento, mas a fonte não existe mais:
    // o que vale é a lista, não a anotação.
    expect(await isDocumentSource(SESSION, ref.id)).toBe(false)
  })

  it('outra conversa não herda a fonte', async () => {
    const ref = await saveDocument('# Manual\n\nCorpo.', [], { title: 'Manual' })
    await useDocumentAsSource(SESSION, ref.id)

    expect(await isDocumentSource('outra-sessao', ref.id)).toBe(false)
  })
})
