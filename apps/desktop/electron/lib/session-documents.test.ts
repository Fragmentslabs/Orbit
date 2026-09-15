import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Escopo de pasta das fontes, do ponto de vista de QUEM PERGUNTA.
 *
 * O módulo não olha o modo da sessão em lugar nenhum — o que ele lê é o
 * `folderId` do SessionInfo persistido. Isso é o que faz a aba Fontes valer
 * igual no chat e no código, onde a pasta é criada automaticamente por
 * repositório: a área "compartilhado" de uma sessão de código é o material de
 * referência daquele repo, visível em todas as suas conversas.
 *
 * Os testes abaixo fecham justamente esse par — o que atravessa, o que não
 * atravessa, e o que acontece com a sessão que não está em pasta nenhuma.
 */

const userData = path.join(os.tmpdir(), `orbit-docs-test-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  // O módulo avisa as janelas a cada mudança (documents:changed). Sem janela
  // nenhuma aberta o aviso não tem para onde ir, que é o caso aqui.
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
}))

const storageDir = path.join(userData, 'orbit-data', 'storage', 'session')

/** Uma sessão como o renderer a persiste — o main só lê este arquivo. */
async function persistSession(id: string, folderId: string | null, mode: 'chat' | 'code') {
  await fsp.mkdir(storageDir, { recursive: true })
  await fsp.writeFile(
    path.join(storageDir, `${id}.json`),
    JSON.stringify({
      id,
      title: id,
      mode,
      directory: mode === 'code' ? 'C:/Projects/Orbit' : undefined,
      folderId,
      pinned: false,
      archived: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  )
}

const FOLDER = 'folderrepo1'

let docs: typeof import('./session-documents')

beforeAll(async () => {
  docs = await import('./session-documents')
  // Duas conversas de código do mesmo repositório + uma fora de pasta.
  await persistSession('conva', FOLDER, 'code')
  await persistSession('convb', FOLDER, 'code')
  await persistSession('convsolta', null, 'code')
})

afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

describe('fontes no modo código', () => {
  it('lê o folderId da sessão persistida, sem olhar o modo', async () => {
    expect(await docs.documentFolderId('conva')).toBe(FOLDER)
    expect(await docs.documentFolderId('convsolta')).toBeNull()
  })

  it('a fonte da pasta atravessa as conversas do mesmo repositório; o anexo não', async () => {
    const fonte = await docs.addSessionText('conva', 'Spec do cliente', 'A retenção é de 4,5% ao mês.', true)
    const anexo = await docs.addSessionText('conva', 'Rascunho', 'Isto vale só aqui.', false)
    expect(fonte.ok).toBe(true)
    expect(anexo.ok).toBe(true)
    if (!fonte.ok || !anexo.ok) return

    // O prefixo é o que diz onde o arquivo mora — src na pasta, doc na sessão.
    expect(fonte.doc.id).toMatch(/^src\d+$/)
    expect(anexo.doc.id).toMatch(/^doc\d+$/)

    const outra = await docs.listSessionSources('convb')
    expect(outra.folderId).toBe(FOLDER)
    expect(outra.shared.map((d) => d.id)).toContain(fonte.doc.id)
    // O anexo de A é de A: a outra conversa do mesmo repo não o vê.
    expect(outra.own).toHaveLength(0)
  })

  it('a outra conversa consegue LER o conteúdo da fonte da pasta', async () => {
    const lista = await docs.listSessionSources('convb')
    const id = lista.shared[0]?.id
    expect(id).toBeDefined()
    const leitura = await docs.readSessionDocument('convb', id!)
    expect(leitura?.extracted.pages.map((p) => p.text).join('\n')).toContain('4,5%')
  })

  it('conversa fora de pasta não enxerga o compartilhado, e não quebra', async () => {
    const solta = await docs.listSessionSources('convsolta')
    expect(solta.folderId).toBeNull()
    expect(solta.shared).toHaveLength(0)
  })

  it('promover o anexo (o arrastar entre as áreas) o publica para o repositório', async () => {
    const antes = await docs.listSessionSources('conva')
    const anexo = antes.own[0]
    expect(anexo).toBeDefined()

    expect(await docs.setSessionDocumentShared('conva', anexo!.id, true)).toBeTruthy()

    const depois = await docs.listSessionSources('convb')
    expect(depois.shared).toHaveLength(2)
    // Ao mudar de área o id muda de namespace — senão dois docN de conversas
    // diferentes colidiriam dentro da pasta.
    expect(depois.shared.every((d) => /^src\d+$/.test(d.id))).toBe(true)
    expect(new Set(depois.shared.map((d) => d.id)).size).toBe(2)
  })

  it('apagar a pasta leva as fontes dela, e só elas', async () => {
    await docs.addSessionText('conva', 'Só desta conversa', 'texto', false)
    await docs.deleteFolderDocuments(FOLDER)

    const lista = await docs.listSessionSources('conva')
    expect(lista.shared).toHaveLength(0)
    expect(lista.own).toHaveLength(1)
  })
})
