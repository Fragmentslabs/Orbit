import { describe, expect, it } from 'vitest'

import { claimsCompletion, isNoCorrectionReply } from './overclaim'

/**
 * Heurística de linguagem: falso positivo custa uma ida a mais ao modelo,
 * falso negativo deixa passar uma resposta que afirma ter feito trabalho que
 * não aconteceu. O caso que mais dói é o da negação — "analisei e não alterei
 * nada" é a resposta honesta que o prompt exige, e ser cobrado por ela ensina
 * o agente exatamente a coisa errada.
 */

describe('claimsCompletion', () => {
  describe('afirma trabalho', () => {
    it.each([
      'Criei o arquivo de configuração.',
      'Implementei a validação no formulário.',
      'Corrigi o bug do seletor.',
      'I added the rotation group to the picker.',
      'I fixed the alignment issue.',
    ])('detecta: %s', (text) => {
      expect(claimsCompletion(text)).toBe(true)
    })
  })

  describe('negação — a resposta honesta não pode ser cobrada', () => {
    it.each([
      'Analisei o código e não alterei nada.',
      'Não implementei ainda, quero confirmar antes.',
      'Nenhum arquivo foi alterado; apenas li o código.',
      "I didn't change any file — just read them.",
      'Sem alterações: o comportamento já era o esperado.',
    ])('ignora: %s', (text) => {
      expect(claimsCompletion(text)).toBe(false)
    })

    it('uma afirmação não negada ainda vale, mesmo junto de uma negada', () => {
      expect(claimsCompletion('Implementei o parser, mas não alterei os testes.')).toBe(true)
    })
  })

  describe('descrição de código existente não é afirmação do agente', () => {
    it.each([
      'The group is added in Sidebar.tsx by the layout effect.',
      'The file was created by the migration script.',
      'A flag `applied` é lida no reducer.',
    ])('ignora: %s', (text) => {
      expect(claimsCompletion(text)).toBe(false)
    })

    it('ignora verbos dentro de bloco de código', () => {
      expect(claimsCompletion('Veja:\n```ts\n// I added this earlier\nconst x = 1\n```')).toBe(false)
    })

    it('ignora verbo citado como identificador inline', () => {
      expect(claimsCompletion('O campo `added` guarda a contagem.')).toBe(false)
    })
  })

  describe('trabalho de turnos anteriores', () => {
    it.each([
      'Adicionei esse campo no turno anterior.',
      'Como expliquei na resposta anterior, implementei o cache lá.',
      'I added it in a previous turn.',
    ])('ignora: %s', (text) => {
      expect(claimsCompletion(text)).toBe(false)
    })
  })

  it('texto vazio não afirma nada', () => {
    expect(claimsCompletion('')).toBe(false)
  })
})

describe('isNoCorrectionReply', () => {
  it.each([
    'Nada a corrigir — o texto descrevia o turno anterior.',
    'Confirmado: nenhuma alteração foi feita neste turno.',
    'Ok, nada a corrigir.',
  ])('reconhece a confirmação de falso positivo: %s', (text) => {
    expect(isNoCorrectionReply(text)).toBe(true)
  })

  it.each([
    'Correção: eu disse que criei o arquivo, mas não criei.',
    'Correto, na verdade não editei nada — vou fazer agora.',
    'Revisei e realmente faltou aplicar a mudança.',
  ])('mantém visível a correção real: %s', (text) => {
    expect(isNoCorrectionReply(text)).toBe(false)
  })
})
