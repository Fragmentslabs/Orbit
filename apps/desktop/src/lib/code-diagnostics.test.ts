import { describe, expect, it } from 'vitest'

import { eslintDiagnostics, jsonDiagnostics, jsonErrorOffset } from './code-diagnostics'

/**
 * Posição fora dos limites do documento derruba o CodeMirror inteiro — ficar
 * vermelho não vale quebrar o editor. E o buffer muda entre o pedido do lint e
 * a resposta, então o caso "a mensagem aponta para um lugar que não existe
 * mais" não é exótico: é o que acontece quando se continua digitando.
 */

/** Um `Text` do CodeMirror no mínimo que o mapeamento usa. */
function doc(text: string) {
  const lines = text.split('\n')
  const starts: number[] = []
  let at = 0
  for (const line of lines) {
    starts.push(at)
    at += line.length + 1
  }
  return {
    lines: lines.length,
    length: text.length,
    line: (n: number) => ({
      from: starts[n - 1],
      to: starts[n - 1] + lines[n - 1].length,
    }),
  }
}

const msg = (over: Partial<Parameters<typeof eslintDiagnostics>[1][number]> = {}) => ({
  line: 1,
  column: 1,
  message: 'algo',
  ruleId: 'regra',
  severity: 2,
  ...over,
})

describe('eslintDiagnostics', () => {
  const text = 'const a = 1\nconst b = 2\n'

  it('converte linha/coluna em offset', () => {
    const [d] = eslintDiagnostics(doc(text), [msg({ line: 2, column: 7, endLine: 2, endColumn: 8 })])
    expect(text.slice(d.from, d.to)).toBe('b')
  })

  it('traduz a severidade do eslint', () => {
    const [erro] = eslintDiagnostics(doc(text), [msg({ severity: 2 })])
    const [aviso] = eslintDiagnostics(doc(text), [msg({ severity: 1 })])
    expect(erro.severity).toBe('error')
    expect(aviso.severity).toBe('warning')
  })

  it('nunca produz marca de largura zero', () => {
    // Sem endLine/endColumn a marca não teria largura e não apareceria.
    const [d] = eslintDiagnostics(doc(text), [msg({ line: 1, column: 1 })])
    expect(d.to).toBeGreaterThan(d.from)
  })

  it('prende posições além do fim do documento', () => {
    // O buffer encolheu depois que o lint foi pedido.
    const [d] = eslintDiagnostics(doc('a\n'), [
      msg({ line: 99, column: 99, endLine: 99, endColumn: 200 }),
    ])
    expect(d.from).toBeLessThanOrEqual(2)
    expect(d.to).toBeLessThanOrEqual(2)
  })

  it('usa o nome da regra como fonte, com reserva', () => {
    expect(eslintDiagnostics(doc(text), [msg({ ruleId: 'no-unused-vars' })])[0].source).toBe(
      'no-unused-vars',
    )
    expect(eslintDiagnostics(doc(text), [msg({ ruleId: null })])[0].source).toBe('eslint')
  })
})

describe('jsonDiagnostics', () => {
  it('não acusa nada em JSON válido, nem em arquivo vazio', () => {
    expect(jsonDiagnostics('{"a": 1}')).toEqual([])
    expect(jsonDiagnostics('   \n')).toEqual([])
  })

  it('acusa JSON inválido e preserva a mensagem do parser', () => {
    // A mensagem do JSON.parse diz o que houve; o nó de erro do Lezer só
    // diria que existe um.
    const [d] = jsonDiagnostics('{"a": }')
    expect(d.severity).toBe('error')
    expect(d.message.length).toBeGreaterThan(0)
    expect(d.to).toBeGreaterThan(d.from)
  })
})

describe('jsonErrorOffset', () => {
  it('extrai a posição da mensagem do V8', () => {
    expect(jsonErrorOffset('Unexpected token } in JSON at position 6', 100)).toBe(6)
    // O V8 novo acrescenta linha e coluna depois da posição.
    expect(jsonErrorOffset("Expected ',' or '}' at position 12 (line 2 column 3)", 100)).toBe(12)
  })

  it('cai no começo quando a mensagem não diz a posição', () => {
    expect(jsonErrorOffset('Unexpected end of JSON input', 100)).toBe(0)
  })

  it('não passa do fim do documento', () => {
    expect(jsonErrorOffset('at position 9999', 10)).toBe(9)
  })
})
