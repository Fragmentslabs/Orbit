import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const userData = path.join(os.tmpdir(), `orbit-doc-formats-${Date.now()}`)

/**
 * O Chromium não existe aqui, então `session.fromPartition` explode — e é
 * exatamente o que estes testes querem: a captura da miniatura e a geração do
 * PDF são best-effort, e falhar nelas não pode derrubar a criação do
 * documento. O .docx não depende de janela nenhuma (é ZIP + XML), então é por
 * ele que o caminho de sucesso é verificado.
 */
vi.mock('electron', () => ({
  app: { getPath: () => userData },
  BrowserWindow: {
    getAllWindows: () => [],
  },
  net: {},
  protocol: { handle: () => {} },
  session: {
    fromPartition: () => {
      throw new Error('sem Chromium no teste')
    },
  },
  dialog: {},
}))

const { documentInfo, ensureDocumentRender, saveDerivedDocx, saveDocument, saveDocumentEdit, updateDocument } =
  await import('./media')
const { documentOpensAsFile } = await import('@shared/media')

/** O texto do .docx, para conferir QUE versão o arquivo entregue carrega. */
async function docxText(file: string): Promise<string> {
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(await fsp.readFile(file))
  return zip.file('word/document.xml')!.async('string')
}

const documentsDir = path.join(userData, 'orbit-data', 'documents')

/** Os arquivos irmãos de um documento, pela extensão. */
async function siblings(id: string): Promise<string[]> {
  const base = id.replace(/\.md$/, '')
  const names = await fsp.readdir(documentsDir)
  return names
    .filter((name) => name.startsWith(base))
    .map((name) => name.slice(base.length))
    .sort()
}

beforeEach(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

describe('documento nasce em Markdown', () => {
  it('sem formats, grava só o fonte e o preview', async () => {
    const ref = await saveDocument('# Relatório\n\nCorpo do texto.', [], { title: 'Relatório' })

    expect(ref.formats).toEqual([])
    expect(await siblings(ref.id)).toEqual(['.html', '.md'])
  })

  it('com formats pedido, renderiza na criação', async () => {
    const ref = await saveDocument('# Proposta\n\nCorpo.', ['docx'], { title: 'Proposta' })

    expect(ref.formats).toEqual(['docx'])
    expect(await siblings(ref.id)).toContain('.docx')
  })

  it('editar não inventa renderização que ninguém pediu', async () => {
    const ref = await saveDocument('# Ata\n\nPrimeira versão.', [], { title: 'Ata' })
    const updated = await updateDocument(ref.id, '# Ata\n\nSegunda versão.', {})

    expect(updated.ok && updated.ref.formats).toEqual([])
    expect(updated.ok && updated.ref.revision).toBe(2)
    expect(await siblings(ref.id)).toEqual(['.html', '.md'])
  })
})

describe('renderização sob demanda', () => {
  it('gera o arquivo no primeiro pedido e o registra', async () => {
    const ref = await saveDocument('# Manual\n\n- um\n- dois', [], { title: 'Manual' })
    expect(await siblings(ref.id)).not.toContain('.docx')

    const file = await ensureDocumentRender(ref.id, 'docx')

    expect(file).toBe(path.join(documentsDir, ref.id.replace(/\.md$/, '.docx')))
    expect(await siblings(ref.id)).toContain('.docx')
  })

  it('o segundo pedido reaproveita o que está em disco', async () => {
    const ref = await saveDocument('# Manual\n\nCorpo.', [], { title: 'Manual' })
    const first = await ensureDocumentRender(ref.id, 'docx')
    const stamp = (await fsp.stat(first!)).mtimeMs

    const second = await ensureDocumentRender(ref.id, 'docx')

    expect(second).toBe(first)
    expect((await fsp.stat(second!)).mtimeMs).toBe(stamp)
  })

  it('gera de novo quando o arquivo sumiu do disco por fora', async () => {
    const ref = await saveDocument('# Manual\n\nCorpo.', [], { title: 'Manual' })
    const file = (await ensureDocumentRender(ref.id, 'docx'))!
    await fsp.rm(file)

    expect(await ensureDocumentRender(ref.id, 'docx')).toBe(file)
    expect(await siblings(ref.id)).toContain('.docx')
  })

  it('documento que não existe não gera nada', async () => {
    expect(await ensureDocumentRender('doc_naoexiste.md', 'docx')).toBeNull()
  })
})

describe('documento derivado', () => {
  it('não é convertido sob demanda: o que ele tem é o arquivo, não uma fonte', async () => {
    // Bytes que não são um .docx de verdade: o mammoth falha, o preview cai no
    // texto de indisponível e o registro nasce igual ao de uma cópia editada.
    const ref = await saveDerivedDocx(Buffer.from('nao é um docx'), {
      title: 'Contrato revisado',
      sourceName: 'contrato.docx',
    })

    expect(ref.formats).toEqual(['docx'])
    expect(await ensureDocumentRender(ref.id, 'pdf')).toBeNull()
    expect(await siblings(ref.id)).not.toContain('.pdf')
  })
})

describe('destino do documento', () => {
  it('sem formats, é documento vivo: abre no canvas', async () => {
    const ref = await saveDocument('# Notas\n\nCorpo.', [], { title: 'Notas' })
    const info = (await documentInfo(ref.id))!

    expect(info.delivery).toBeUndefined()
    expect(documentOpensAsFile(info)).toBe(false)
  })

  it('pedido como arquivo, abre no visualizador', async () => {
    const ref = await saveDocument('# Contrato\n\nCorpo.', ['docx'], { title: 'Contrato' })
    const info = (await documentInfo(ref.id))!

    expect(info.delivery).toEqual(['docx'])
    expect(documentOpensAsFile(info)).toBe(true)
  })

  it('baixar um documento vivo não o transforma em arquivo', async () => {
    const ref = await saveDocument('# Notas\n\nCorpo.', [], { title: 'Notas' })
    await ensureDocumentRender(ref.id, 'docx')
    const info = (await documentInfo(ref.id))!

    // O cache cresceu, o destino não: continua sendo um documento para editar.
    expect(info.formats).toEqual(['docx'])
    expect(documentOpensAsFile(info)).toBe(false)
  })

  it('pedir o formato depois muda o destino', async () => {
    const ref = await saveDocument('# Notas\n\nCorpo.', [], { title: 'Notas' })
    await updateDocument(ref.id, '# Notas\n\nCorpo revisado.', { formats: ['docx'] })

    expect(documentOpensAsFile((await documentInfo(ref.id))!)).toBe(true)
  })
})

describe('edição do usuário no canvas', () => {
  it('grava o fonte e avança a revisão', async () => {
    const ref = await saveDocument('# Ata\n\nPrimeira.', [], { title: 'Ata' })

    const result = await saveDocumentEdit(ref.id, '# Ata\n\nEscrita à mão.')

    expect(result.ok && result.revision).toBe(2)
    expect(await fsp.readFile(path.join(documentsDir, ref.id), 'utf8')).toContain('Escrita à mão.')
  })

  it('o arquivo baixado depois da edição carrega o texto novo', async () => {
    const ref = await saveDocument('# Manual\n\nVersão do agente.', [], { title: 'Manual' })
    const antes = (await ensureDocumentRender(ref.id, 'docx'))!
    expect(await docxText(antes)).toContain('Versão do agente')

    await saveDocumentEdit(ref.id, '# Manual\n\nVersão do usuário.')
    const depois = (await ensureDocumentRender(ref.id, 'docx'))!

    expect(await docxText(depois)).toContain('Versão do usuário')
    expect(await docxText(depois)).not.toContain('Versão do agente')
  })

  it('derivado não é editável: o Markdown dele é só um bilhete', async () => {
    const ref = await saveDerivedDocx(Buffer.from('nao é um docx'), { title: 'Contrato revisado' })

    expect(await saveDocumentEdit(ref.id, '# Reescrito')).toEqual({
      ok: false,
      reason: 'notFound',
    })
  })

  it('recusa a gravação baseada numa versão que o agente já substituiu', async () => {
    const ref = await saveDocument('# Ata\n\nDo agente.', [], { title: 'Ata' })
    const aberto = (await documentInfo(ref.id))!.revision ?? 1
    await updateDocument(ref.id, '# Ata\n\nSegunda do agente.', {})

    const result = await saveDocumentEdit(ref.id, '# Ata\n\nDo usuário.', aberto)

    expect(result).toEqual({ ok: false, reason: 'stale', revision: 2 })
    expect(await fsp.readFile(path.join(documentsDir, ref.id), 'utf8')).toContain(
      'Segunda do agente.',
    )
  })
})

/**
 * O agente lê, o usuário edita no canvas, o agente escreve: sem guarda, a
 * reescrita apagaria em silêncio o que a pessoa acabou de digitar. É o único
 * caminho neste módulo em que se perde trabalho, então é o mais coberto.
 */
describe('agente escrevendo por cima da edição do usuário', () => {
  /** O que está gravado agora — o que importa é se a reescrita ENTROU. */
  async function sourceOf(id: string): Promise<string> {
    return fsp.readFile(path.join(documentsDir, id), 'utf8')
  }

  it('recusa a reescrita baseada numa versão velha, sem gravar nada', async () => {
    const ref = await saveDocument('# Ata\n\nDo agente.', [], { title: 'Ata' })
    const lido = (await documentInfo(ref.id))!.revision ?? 1
    await saveDocumentEdit(ref.id, '# Ata\n\nDo usuário.')

    const result = await updateDocument(ref.id, '# Ata\n\nReescrita cega.', {
      baseRevision: lido,
    })

    expect(result).toEqual({ ok: false, reason: 'stale', revision: 2 })
    expect(await sourceOf(ref.id)).toContain('Do usuário.')
  })

  it('recusa também sem baseRevision, quando há edição humana pendente', async () => {
    const ref = await saveDocument('# Ata\n\nDo agente.', [], { title: 'Ata' })
    await saveDocumentEdit(ref.id, '# Ata\n\nDo usuário.')

    const result = await updateDocument(ref.id, '# Ata\n\nReescrita cega.', {})

    expect(result.ok).toBe(false)
    expect(await sourceOf(ref.id)).toContain('Do usuário.')
  })

  it('aceita quando o agente partiu da versão que está em disco', async () => {
    const ref = await saveDocument('# Ata\n\nDo agente.', [], { title: 'Ata' })
    await saveDocumentEdit(ref.id, '# Ata\n\nDo usuário.')
    const atual = (await documentInfo(ref.id))!.revision!

    const result = await updateDocument(ref.id, '# Ata\n\nDo agente, sobre a do usuário.', {
      baseRevision: atual,
    })

    expect(result.ok).toBe(true)
    expect(await sourceOf(ref.id)).toContain('sobre a do usuário')
  })

  it('depois de o agente ver a versão do usuário, a escrita volta a ser livre', async () => {
    const ref = await saveDocument('# Ata\n\nDo agente.', [], { title: 'Ata' })
    await saveDocumentEdit(ref.id, '# Ata\n\nDo usuário.')
    const atual = (await documentInfo(ref.id))!.revision!
    await updateDocument(ref.id, '# Ata\n\nPrimeira do agente.', { baseRevision: atual })

    // Sem edição humana pendente, reescrever sem baseRevision continua valendo:
    // é o caso de quem escreveu o texto do zero e não leu nada.
    const result = await updateDocument(ref.id, '# Ata\n\nSegunda do agente.', {})

    expect(result.ok).toBe(true)
    expect(await sourceOf(ref.id)).toContain('Segunda do agente')
  })

  it('documento que o usuário nunca tocou continua aceitando reescrita direta', async () => {
    const ref = await saveDocument('# Ata\n\nPrimeira.', [], { title: 'Ata' })

    expect((await updateDocument(ref.id, '# Ata\n\nSegunda.', {})).ok).toBe(true)
  })
})
