import { describe, expect, it } from 'vitest'
import { underscoreBlankWarning } from './markdown-blanks'

/**
 * O caso veio de uma prova escolar: "**Data:** ____/____/______" chegou na tela
 * como "Data: //______". O aviso existe para o modelo consertar sozinho na
 * chamada seguinte, então ele não pode gritar em documento que está correto —
 * um aviso falso ensina a ignorar o aviso.
 */

describe('underscoreBlankWarning', () => {
  it('avisa sobre o campo de data que vira "//"', () => {
    const aviso = underscoreBlankWarning('**Nome:** ______\n\n**Data:** ____/____/______')
    expect(aviso).toContain('linha 3')
    expect(aviso).toContain('update_document')
  })

  it('cala sobre um campo sozinho, que é renderizado inteiro', () => {
    expect(underscoreBlankWarning('**Escola:** ____________________')).toBeNull()
  })

  it('cala sobre a lacuna no fim da conta', () => {
    expect(underscoreBlankWarning('a) 245 + 138 = ______\n\nb) 356 + 274 = ______')).toBeNull()
  })

  it('cala sobre negrito de verdade', () => {
    // __assim__ também são dois grupos na mesma linha, mas com TEXTO no meio:
    // é negrito pedido de propósito, não campo quebrado.
    expect(underscoreBlankWarning('Isto é __mesmo__ negrito, e __isto__ também.')).toBeNull()
  })

  it('pega telefone e CPF pelo mesmo motivo', () => {
    expect(underscoreBlankWarning('Telefone: (__)_____-____')).toContain('linha 1')
    expect(underscoreBlankWarning('CPF: ___.___.___-__')).toContain('linha 1')
  })

  it('cala quando os grupos estão separados por espaço', () => {
    expect(underscoreBlankWarning('**Data:** ____ / ____ / ______')).toBeNull()
  })

  it('lista as linhas quando há várias', () => {
    const aviso = underscoreBlankWarning('Data: __/__/__\nx\nCPF: ___.___.___-__')
    expect(aviso).toContain('linhas 1, 3')
  })
})
