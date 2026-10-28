import { describe, expect, it } from 'vitest'
import { modelFileParts, type FilePart, type MessagePart } from '@shared/chat'

/**
 * O que de um anexo chega AO MODELO.
 *
 * A regra é uma só: o modelo recebe o texto que representa o anexo (trecho de
 * abertura do documento, nota da imagem/áudio/vídeo) e só recebe os BYTES
 * quando precisa mesmo olhá-los — visão nativa, e só no turno em que o anexo
 * chegou. Sem isso, a foto colada no primeiro turno da conversa era reenviada
 * em todos os seguintes, para sempre.
 */

const chip = (): FilePart => ({
  id: 'f1',
  type: 'file',
  mime: 'image/webp',
  filename: 'foto.webp',
  url: 'data:image/webp;base64,AAAA',
  chip: true,
})

const imagem = (turnOnly?: boolean): FilePart => ({
  id: 'f2',
  type: 'file',
  mime: 'image/png',
  filename: 'foto.png',
  url: 'data:image/png;base64,AAAA',
  ...(turnOnly ? { turnOnly: true } : {}),
})

const texto = (): MessagePart => ({ id: 'p1', type: 'text', text: 'oi', state: 'done' })

describe('anexos que vão ao modelo', () => {
  it('chip nunca vai: o conteúdo dele já está na TextPart irmã', () => {
    expect(modelFileParts([chip(), texto()], true)).toEqual([])
    // Nem no turno corrente: chip é decoração da UI em qualquer turno.
    expect(modelFileParts([chip()], true)).toEqual([])
  })

  it('anexo comum vai em todo turno (é o caso de um arquivo que o modelo precisa ver)', () => {
    const part = { ...imagem(), chip: undefined, turnOnly: undefined } as FilePart
    expect(modelFileParts([part], false)).toHaveLength(1)
    expect(modelFileParts([part], true)).toHaveLength(1)
  })

  it('turnOnly vai no turno em que chegou e para de ir depois', () => {
    const parts = [imagem(true), texto()]
    const noTurno = modelFileParts(parts, true)
    expect(noTurno).toHaveLength(1)
    expect(noTurno[0].id).toBe('f2')
    // Nos seguintes, só o texto (a linha de referência) permanece.
    expect(modelFileParts(parts, false)).toEqual([])
  })

  it('url vazio também fica de fora (chips gravados antes da flag existir)', () => {
    const antigo: FilePart = { ...imagem(), chip: undefined, url: '' }
    expect(modelFileParts([antigo], true)).toEqual([])
  })
})
