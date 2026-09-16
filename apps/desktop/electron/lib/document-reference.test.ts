import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * O endereço de um documento depois que ele muda de área.
 *
 * O id é o endereço E o lugar: `doc1` é anexo da conversa, `src1` é fonte da
 * pasta. Arrastar o arquivo de uma área para a outra troca um pelo outro — e
 * tudo que já foi ESCRITO com o endereço antigo continua escrito. As citações
 * da resposta ("[1](#orbit-source/doc1/p12L2)") e o chip do anexo guardam o id
 * do dia do envio; o histórico não é reescrito em disco.
 *
 * Sem rastro, o clique naquela citação parava de abrir o documento e não dizia
 * nada — a aba Fontes continuava mostrando o arquivo, o que fazia parecer que
 * a conversa tinha perdido a memória. É esse par (o rastro, e o resgate do que
 * foi movido antes de o rastro existir) que estes testes prendem.
 */

const userData = path.join(os.tmpdir(), `orbit-ref-test-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
}))

const FOLDER = 'pastaum'
const scope = (name: string) => path.join(userData, 'orbit-data', 'session-docs', name)

async function persistSession(id: string, folderId: string | null) {
  const dir = path.join(userData, 'orbit-data', 'storage', 'session')
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(
    path.join(dir, `${id}.json`),
    JSON.stringify({ id, title: id, mode: 'chat', folderId, createdAt: 1, updatedAt: 1 }),
  )
}

let docs: typeof import('./session-documents')

/** Anexo da conversa, depois promovido a fonte da pasta — o arrastar da aba. */
async function anexarEPromover(sessionId: string, titulo: string, texto: string) {
  const anexo = await docs.addSessionText(sessionId, titulo, texto, false)
  if (!anexo.ok) throw new Error(anexo.error)
  const movido = await docs.setSessionDocumentShared(sessionId, anexo.doc.id, true)
  if (!movido.ok) throw new Error(movido.error)
  return { antes: anexo.doc.id, agora: movido.id }
}

/** Apaga o rastro: é o estado de quem promoveu o arquivo antes disto existir. */
async function esquecerRastro(sessionId: string, docId: string) {
  await fsp.rm(path.join(scope(sessionId), `${docId}.moved.json`), { force: true })
}

beforeAll(async () => {
  docs = await import('./session-documents')
  for (const id of ['conv1', 'conv2', 'conv3', 'conv4', 'convsolta']) {
    await persistSession(id, id === 'convsolta' ? null : FOLDER)
  }
})

afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

describe('referência de documento que mudou de área', () => {
  it('a citação antiga continua abrindo o arquivo, e o painel diz o id novo', async () => {
    const { antes, agora } = await anexarEPromover('conv1', 'Topologias', 'Barramento é p12.')
    expect(antes).toMatch(/^doc\d+$/)
    expect(agora).toMatch(/^src\d+$/)

    // É este o clique da citação: o endereço gravado na conversa.
    const vista = await docs.readSessionText('conv1', antes)
    expect(vista?.filename).toBe('Topologias')
    expect(vista?.pages[0]?.lines.join('\n')).toContain('Barramento')
    // E o painel mostra para onde foi, senão a mudança de id pareceria o
    // arquivo errado aberto no lugar do certo.
    expect(vista?.id).toBe(agora)
    expect(vista?.movedFrom).toBe(antes)
  })

  it('o id que ainda vale não ganha aviso de mudança', async () => {
    const lista = await docs.listSessionSources('conv1')
    const id = lista.shared[0]!.id
    const vista = await docs.readSessionText('conv1', id)
    expect(vista?.id).toBe(id)
    expect(vista?.movedFrom).toBeUndefined()
  })

  it('o rastro é da conversa que moveu: o doc1 de OUTRA conversa não vai junto', async () => {
    // Cada chat tem o seu doc1. Seguir o rastro alheio abriria, sob a citação
    // de conv2, um arquivo que nunca esteve nela.
    expect(await docs.readSessionText('conv2', 'doc1')).toBeNull()
  })

  it('resgata o que foi promovido ANTES de o rastro existir', async () => {
    // O conserto precisa valer para as conversas que já perderam a referência
    // — elas são o motivo dele. Sem rastro, a prova é o registro da fonte, que
    // guarda de qual conversa o arquivo veio.
    const { antes, agora } = await anexarEPromover('conv3', 'Contrato', 'Cláusula 4.')
    await esquecerRastro('conv3', antes)

    const vista = await docs.readSessionText('conv3', antes)
    expect(vista?.filename).toBe('Contrato')
    expect(vista?.id).toBe(agora)
    expect(vista?.movedFrom).toBe(antes)
  })

  it('com dois candidatos o resgate DESISTE, em vez de abrir o arquivo errado', async () => {
    // Abrir o documento errado debaixo de uma citação é pior do que não abrir
    // nada: o trecho citado passa a apontar para um texto que não é o dele.
    const um = await anexarEPromover('conv4', 'Prova', 'Questão 1.')
    const dois = await anexarEPromover('conv4', 'Formulário', 'Campo nome.')
    await esquecerRastro('conv4', um.antes)
    await esquecerRastro('conv4', dois.antes)

    expect(await docs.readSessionText('conv4', um.antes)).toBeNull()
    expect(await docs.readSessionText('conv4', dois.antes)).toBeNull()

    // Com o rastro no lugar, os mesmos dois voltam a resolver — a ambiguidade
    // era da ausência de prova, não do caso.
    const terceiro = await anexarEPromover('conv4', 'Ata', 'Reunião de março.')
    expect((await docs.readSessionText('conv4', terceiro.antes))?.filename).toBe('Ata')
  })

  it('id que a conversa nunca distribuiu não resolve — o modelo inventa ids', async () => {
    // O exemplo do prompt do sistema usa `doc1` literalmente, então um id
    // inventado não é hipótese remota. O contador do escopo é o que desmente.
    expect(await docs.readSessionText('conv3', 'doc99')).toBeNull()
  })

  it('ir e voltar entre as áreas não perde o endereço original', async () => {
    const { antes, agora } = await anexarEPromover('conv1', 'Planilha', 'Total: 10')
    const devolta = await docs.setSessionDocumentShared('conv1', agora, false)
    expect(devolta.ok).toBe(true)
    if (!devolta.ok) return

    // doc1 → src1 → doc2, seguido de ponta a ponta.
    const vista = await docs.readSessionText('conv1', antes)
    expect(vista?.filename).toBe('Planilha')
    expect(vista?.id).toBe(devolta.id)
  })

  it('o rastro devolve o endereço, não permissão: rebaixado sai do alcance da pasta', async () => {
    // Enquanto era src, a outra conversa da pasta podia citá-lo. Rebaixado, o
    // arquivo passou a ser privado de conv1 — e o rastro não pode furar isso.
    const { agora } = await anexarEPromover('conv1', 'Privado', 'Só meu.')
    expect((await docs.readSessionText('conv2', agora))?.filename).toBe('Privado')

    const devolta = await docs.setSessionDocumentShared('conv1', agora, false)
    expect(devolta.ok).toBe(true)
    expect(await docs.readSessionText('conv2', agora)).toBeNull()
    expect((await docs.readSessionText('conv1', agora))?.filename).toBe('Privado')
  })

  it('o rastro não aparece como documento nem é cobrado como material', async () => {
    // Ele mora no mesmo diretório dos registros e termina em .json: sem
    // cuidado, entraria na lista da aba como uma fonte fantasma.
    const lista = await docs.listSessionSources('conv1')
    expect(lista.own.every((d) => /^doc\d+$/.test(d.id))).toBe(true)
    expect(lista.shared.every((d) => /^src\d+$/.test(d.id))).toBe(true)

    const antes = (await docs.listSessionSources('convsolta')).usage
    const anexo = await docs.addSessionText('convsolta', 'Nota', 'x', false)
    expect(anexo.ok).toBe(true)
    if (!anexo.ok) return
    const comAnexo = (await docs.listSessionSources('convsolta')).usage
    expect(comAnexo).toBeGreaterThan(antes)
  })
})
