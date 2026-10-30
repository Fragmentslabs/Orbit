import { describe, expect, it } from 'vitest'

import { claimsCompletion, claimsImageLook, claimsScreenWork, isNoCorrectionReply } from './overclaim'

/**
 * Language heuristic: a false positive costs one more trip to the model,
 * a false negative lets through an answer that claims to have done work that
 * did not happen. The case that hurts the most is the negation — "I analyzed it and changed
 * nothing" is the honest answer the prompt demands, and being charged for it teaches
 * the agent exactly the wrong thing.
 */

describe('claimsCompletion', () => {
  describe('claims work', () => {
    it.each([
      'Criei o arquivo de configuração.',
      'Implementei a validação no formulário.',
      'Corrigi o bug do seletor.',
      'I added the rotation group to the picker.',
      'I fixed the alignment issue.',
    ])('detects: %s', (text) => {
      expect(claimsCompletion(text)).toBe(true)
    })
  })

  describe('negation — the honest answer must not be charged', () => {
    it.each([
      'Analisei o código e não alterei nada.',
      'Não implementei ainda, quero confirmar antes.',
      'Nenhum arquivo foi alterado; apenas li o código.',
      "I didn't change any file — just read them.",
      'Sem alterações: o comportamento já era o esperado.',
    ])('ignora: %s', (text) => {
      expect(claimsCompletion(text)).toBe(false)
    })

    it('an unnegated claim still counts, even next to a negated one', () => {
      expect(claimsCompletion('Implementei o parser, mas não alterei os testes.')).toBe(true)
    })
  })

  describe('describing existing code is not a claim by the agent', () => {
    it.each([
      'The group is added in Sidebar.tsx by the layout effect.',
      'The file was created by the migration script.',
      'A flag `applied` é lida no reducer.',
    ])('ignora: %s', (text) => {
      expect(claimsCompletion(text)).toBe(false)
    })

    it('ignores verbs inside a code block', () => {
      expect(claimsCompletion('Veja:\n```ts\n// I added this earlier\nconst x = 1\n```')).toBe(false)
    })

    it('ignores a verb quoted as an inline identifier', () => {
      expect(claimsCompletion('O campo `added` guarda a contagem.')).toBe(false)
    })
  })

  describe('work from previous turns', () => {
    it.each([
      'Adicionei esse campo no turno anterior.',
      'Como expliquei na resposta anterior, implementei o cache lá.',
      'I added it in a previous turn.',
    ])('ignora: %s', (text) => {
      expect(claimsCompletion(text)).toBe(false)
    })
  })

  it('empty text claims nothing', () => {
    expect(claimsCompletion('')).toBe(false)
  })
})

describe('isNoCorrectionReply', () => {
  it.each([
    'NOTHING_TO_FIX',
    'nothing_to_fix.',
    'Nothing to fix — the text described the previous turn.',
    'Confirmed: no changes were made in this turn.',
    'Nada a corrigir — o texto descrevia o turno anterior.',
    'Confirmado: nenhuma alteração foi feita neste turno.',
    'Ok, nada a corrigir.',
  ])('recognizes the false-positive confirmation: %s', (text) => {
    expect(isNoCorrectionReply(text)).toBe(true)
  })

  it.each([
    'Correção: eu disse que criei o arquivo, mas não criei.',
    'Correto, na verdade não editei nada — vou fazer agora.',
    'Revisei e realmente faltou aplicar a mudança.',
    'Correct, I did not actually edit anything — doing it now.',
  ])('keeps the real correction visible: %s', (text) => {
    expect(isNoCorrectionReply(text)).toBe(false)
  })
})

describe('claimsScreenWork', () => {
  it('catches the screen action or view claimed without a tool', () => {
    expect(claimsScreenWork('Abri o TextEdit e escrevi "oi" no documento novo.')).toBe(true)
    expect(claimsScreenWork('Não consigo, não — a captura até é gerada, mas o conteúdo não chega legível.')).toBe(true)
    expect(claimsScreenWork('I opened Safari and clicked Send.')).toBe(true)
  })

  it('a conversation without a screen does not trigger', () => {
    expect(claimsScreenWork('Tchau, até a próxima.')).toBe(false)
    expect(claimsScreenWork('O Qwen 3.5 9B compete com modelos bem maiores em visão.')).toBe(false)
  })
})

describe('claimsImageLook', () => {
  it('promise to look at the image', () => {
    expect(claimsImageLook('Só o contorno da janela, sem nada legível. Vou tentar pela imagem, um instante.')).toBe(true)
    expect(claimsImageLook("Let me look at the screen image.")).toBe(true)
  })

  it('an answer that already talks about the content does not trigger', () => {
    expect(claimsImageLook('Você está no TextEdit, com o arquivo aberto.')).toBe(false)
  })
})
