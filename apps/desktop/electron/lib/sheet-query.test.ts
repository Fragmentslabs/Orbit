import { describe, expect, it } from 'vitest'

import {
  formatQueryResult,
  runSheetQuery,
  SheetQueryError,
  toNumber,
  type CellValue,
} from './sheet-query'

/**
 * Esta camada existe para o agente CALCULAR em vez de estimar. Duas falhas
 * aqui são piores que um erro visível, porque saem com cara de resposta certa:
 *
 * 1. Um número mal parseado (locale) entrar na soma como outro valor.
 * 2. Células não numéricas serem ignoradas SEM o resultado dizer — uma soma
 *    que cobriu metade da coluna parece idêntica a uma soma completa.
 */

const rows: CellValue[][] = [
  ['id', 'cliente', 'regiao', 'valor', 'status'],
  [1, 'Alfa', 'Sul', 100, 'pago'],
  [2, 'Beta', 'Sul', 250.5, 'pendente'],
  [3, 'Gama', 'Norte', 300, 'pago'],
  [4, 'Delta', 'Norte', 50, 'pendente'],
  [5, 'Épsilon', 'Sul', 99.5, 'pago'],
]

describe('toNumber', () => {
  it('aceita número puro e booleano', () => {
    expect(toNumber(1234.5)).toBe(1234.5)
    expect(toNumber(true)).toBe(1)
  })

  it('entende decimal pt-BR e separador de milhar', () => {
    expect(toNumber('1.234,56')).toBeCloseTo(1234.56)
    expect(toNumber('1234,5')).toBeCloseTo(1234.5)
  })

  it('entende decimal en com vírgula de milhar', () => {
    expect(toNumber('1,234.56')).toBeCloseTo(1234.56)
    expect(toNumber('1,234')).toBe(1234)
  })

  it('tolera moeda e porcentagem coladas no valor', () => {
    expect(toNumber('R$ 1.234,00')).toBeCloseTo(1234)
    expect(toNumber('45%')).toBe(45)
  })

  it('preserva o negativo', () => {
    expect(toNumber('-250,75')).toBeCloseTo(-250.75)
  })

  it('devolve null no que NÃO é número — nunca zero, que mentiria na soma', () => {
    expect(toNumber('n/a')).toBeNull()
    expect(toNumber('')).toBeNull()
    expect(toNumber(null)).toBeNull()
    expect(toNumber('-')).toBeNull()
  })
})

describe('runSheetQuery — filtro', () => {
  it('filtra por igualdade de texto sem diferenciar maiúscula', () => {
    const result = runSheetQuery(rows, { where: [{ column: 'regiao', op: 'eq', value: 'sul' }] })
    expect(result.matched).toBe(3)
    expect(result.scanned).toBe(5)
  })

  it('compara número como número, não como texto', () => {
    // Discrimina de verdade: 100, 250.5, 300 e 99.5 passam. Comparando como
    // TEXTO, só "99.5" > "60" seria verdade ("1" e "2" e "3" < "6") e o
    // resultado cairia para 1.
    const result = runSheetQuery(rows, { where: [{ column: 'valor', op: 'gt', value: 60 }] })
    expect(result.matched).toBe(4)
  })

  it('combina condições em E', () => {
    const result = runSheetQuery(rows, {
      where: [
        { column: 'regiao', op: 'eq', value: 'Sul' },
        { column: 'status', op: 'eq', value: 'pago' },
      ],
    })
    expect(result.matched).toBe(2)
  })

  it('contains acha trecho no meio', () => {
    // "ta" casa Beta e Delta, no meio e no fim — não é prefixo
    expect(runSheetQuery(rows, { where: [{ column: 'cliente', op: 'contains', value: 'ta' }] }).matched).toBe(2)
  })

  it('erro explícito quando a coluna não existe — e lista as que existem', () => {
    expect(() => runSheetQuery(rows, { where: [{ column: 'inexistente', op: 'eq', value: 1 }] }))
      .toThrow(SheetQueryError)
    try {
      runSheetQuery(rows, { where: [{ column: 'inexistente', op: 'eq', value: 1 }] })
    } catch (err) {
      expect((err as Error).message).toContain('cliente')
    }
  })
})

describe('runSheetQuery — agregação', () => {
  it('soma a coluna inteira quando não há groupBy', () => {
    const result = runSheetQuery(rows, { aggregate: [{ fn: 'sum', column: 'valor' }] })
    expect(result.rows[0][0]).toBeCloseTo(800)
  })

  it('agrupa e soma por chave', () => {
    const result = runSheetQuery(rows, {
      groupBy: ['regiao'],
      aggregate: [{ fn: 'sum', column: 'valor', as: 'total' }],
      orderBy: { column: 'total', direction: 'desc' },
    })
    expect(result.columns).toEqual(['regiao', 'total'])
    expect(result.rows[0][0]).toBe('Sul')
    expect(result.rows[0][1]).toBeCloseTo(450)
    expect(result.rows[1][1]).toBeCloseTo(350)
  })

  it('filtro e agregação juntos', () => {
    const result = runSheetQuery(rows, {
      where: [{ column: 'status', op: 'eq', value: 'pago' }],
      aggregate: [{ fn: 'sum', column: 'valor' }, { fn: 'count' }],
    })
    expect(result.rows[0][0]).toBeCloseTo(499.5)
    expect(result.rows[0][1]).toBe(3)
  })

  it('avg, min e max', () => {
    const result = runSheetQuery(rows, {
      aggregate: [
        { fn: 'avg', column: 'valor', as: 'media' },
        { fn: 'min', column: 'valor', as: 'menor' },
        { fn: 'max', column: 'valor', as: 'maior' },
      ],
    })
    expect(result.rows[0][0]).toBeCloseTo(160)
    expect(result.rows[0][1]).toBe(50)
    expect(result.rows[0][2]).toBe(300)
  })

  it('CONTA as células não numéricas ignoradas em vez de tratá-las como zero', () => {
    const sujo: CellValue[][] = [
      ['item', 'valor'],
      ['a', 100],
      ['b', 'n/a'],
      ['c', 'pendente'],
      ['d', 50],
    ]
    const result = runSheetQuery(sujo, { aggregate: [{ fn: 'sum', column: 'valor' }] })
    expect(result.rows[0][0]).toBe(150)
    expect(result.skippedCells).toBe(2)
    expect(formatQueryResult(result)).toContain('ignorada')
  })

  it('célula vazia é ausência, não erro de tipo — não entra na contagem de ignoradas', () => {
    const comVazio: CellValue[][] = [
      ['item', 'valor'],
      ['a', 100],
      ['b', ''],
      ['c', null],
    ]
    const result = runSheetQuery(comVazio, { aggregate: [{ fn: 'sum', column: 'valor' }] })
    expect(result.rows[0][0]).toBe(100)
    expect(result.skippedCells).toBe(0)
  })

  it('coluna sem nenhum número devolve null, não zero', () => {
    const texto: CellValue[][] = [['item', 'valor'], ['a', 'x'], ['b', 'y']]
    const result = runSheetQuery(texto, { aggregate: [{ fn: 'sum', column: 'valor' }] })
    expect(result.rows[0][0]).toBeNull()
    expect(result.skippedCells).toBe(2)
  })

  it('soma valores escritos como texto em pt-BR', () => {
    const ptbr: CellValue[][] = [['item', 'valor'], ['a', '1.234,56'], ['b', '2.000,00']]
    const result = runSheetQuery(ptbr, { aggregate: [{ fn: 'sum', column: 'valor' }] })
    expect(result.rows[0][0] as number).toBeCloseTo(3234.56)
    expect(result.skippedCells).toBe(0)
  })
})

describe('runSheetQuery — projeção e limites', () => {
  it('select devolve só as colunas pedidas', () => {
    const result = runSheetQuery(rows, { select: ['cliente', 'valor'], limit: 2 })
    expect(result.columns).toEqual(['cliente', 'valor'])
    expect(result.rows[0]).toHaveLength(2)
  })

  it('limit corta o retorno mas o total conferido continua verdadeiro', () => {
    const result = runSheetQuery(rows, { limit: 2 })
    expect(result.returned).toBe(2)
    expect(result.matched).toBe(5)
    expect(result.truncated).toBe(true)
  })

  it('teto de linhas impede a consulta de virar despejo da planilha', () => {
    const grande: CellValue[][] = [['n'], ...Array.from({ length: 5000 }, (_, i) => [i])]
    const result = runSheetQuery(grande, { limit: 99999 })
    expect(result.returned).toBe(200)
    expect(result.scanned).toBe(5000)
    expect(result.truncated).toBe(true)
  })

  it('planilha vazia não quebra', () => {
    expect(runSheetQuery([], {}).scanned).toBe(0)
  })
})

describe('formatQueryResult', () => {
  it('declara quantas linhas foram varridas — é o que torna o número auditável', () => {
    const out = formatQueryResult(runSheetQuery(rows, { aggregate: [{ fn: 'sum', column: 'valor' }] }))
    expect(out).toContain('5 linhas na aba')
  })

  it('avisa o corte quando houve truncamento', () => {
    expect(formatQueryResult(runSheetQuery(rows, { limit: 2 }))).toContain('mostrando 2')
  })
})

describe('runSheetQuery — chave de grupo e contagens do rodapé', () => {
  it('valor com espaço não vira dois grupos', () => {
    const cidades: CellValue[][] = [
      ['cidade', 'uf', 'valor'],
      ['São Paulo', 'SP', 10],
      ['São Paulo', 'SP', 20],
      ['Rio de Janeiro', 'RJ', 5],
    ]
    const result = runSheetQuery(cidades, {
      groupBy: ['cidade'],
      aggregate: [{ fn: 'sum', column: 'valor', as: 'total' }],
    })
    expect(result.rows).toHaveLength(2)
    expect(result.rows.find((r) => r[0] === 'São Paulo')?.[1]).toBe(30)
  })

  it('agrupa por mais de uma coluna sem embaralhar as chaves', () => {
    const dados: CellValue[][] = [
      ['regiao', 'status', 'valor'],
      ['Sul', 'pago', 10],
      ['Sul', 'pendente', 20],
      ['Norte', 'pago', 5],
    ]
    const result = runSheetQuery(dados, {
      groupBy: ['regiao', 'status'],
      aggregate: [{ fn: 'sum', column: 'valor', as: 'total' }],
    })
    expect(result.rows).toHaveLength(3)
    expect(result.columns).toEqual(['regiao', 'status', 'total'])
  })

  it('numa consulta agregada, "consideradas" são LINHAS e os grupos vêm à parte', () => {
    // O rodapé dizia "3 após o filtro" para 8000 linhas em 3 grupos — o modelo
    // relataria que só 3 linhas entraram na conta.
    const result = runSheetQuery(rows, {
      groupBy: ['regiao'],
      aggregate: [{ fn: 'sum', column: 'valor' }],
    })
    expect(result.matched).toBe(5)
    expect(result.groups).toBe(2)
    const out = formatQueryResult(result)
    expect(out).toContain('5 consideradas')
    expect(out).toContain('2 grupo(s)')
  })

  it('consulta sem agregação não reporta grupos', () => {
    expect(runSheetQuery(rows, {}).groups).toBeUndefined()
  })
})
