import { describe, expect, it } from 'vitest'

import {
  formatQueryResult,
  runSheetQuery,
  SheetQueryError,
  toNumber,
  type CellValue,
} from './sheet-query'

/**
 * This layer exists for the agent to CALCULATE instead of estimating. Two failures
 * here are worse than a visible error, because they come out looking like a right answer:
 *
 * 1. A badly parsed number (locale) entering the sum as another value.
 * 2. Non-numeric cells being ignored WITHOUT the result saying so — a sum
 *    that covered half the column looks identical to a complete sum.
 */

const rows: CellValue[][] = [
  ['id', 'customer', 'region', 'amount', 'status'],
  [1, 'Alpha', 'South', 100, 'paid'],
  [2, 'Beta', 'South', 250.5, 'pending'],
  [3, 'Gamma', 'North', 300, 'paid'],
  [4, 'Delta', 'North', 50, 'pending'],
  [5, 'Epsilon', 'South', 99.5, 'paid'],
]

describe('toNumber', () => {
  it('accepts a plain number and a boolean', () => {
    expect(toNumber(1234.5)).toBe(1234.5)
    expect(toNumber(true)).toBe(1)
  })

  it('understands pt-BR decimal and thousands separator', () => {
    expect(toNumber('1.234,56')).toBeCloseTo(1234.56)
    expect(toNumber('1234,5')).toBeCloseTo(1234.5)
  })

  it('understands decimal and thousands comma', () => {
    expect(toNumber('1,234.56')).toBeCloseTo(1234.56)
    expect(toNumber('1,234')).toBe(1234)
  })

  it('tolerates currency and percentage glued to the value', () => {
    expect(toNumber('R$ 1.234,00')).toBeCloseTo(1234)
    expect(toNumber('45%')).toBe(45)
  })

  it('preserva o negativo', () => {
    expect(toNumber('-250,75')).toBeCloseTo(-250.75)
  })

  it('returns null for what is NOT a number — never zero, which would lie in the sum', () => {
    expect(toNumber('n/a')).toBeNull()
    expect(toNumber('')).toBeNull()
    expect(toNumber(null)).toBeNull()
    expect(toNumber('-')).toBeNull()
  })
})

describe('runSheetQuery — filter', () => {
  it('filters by text equality ignoring case', () => {
    const result = runSheetQuery(rows, { where: [{ column: 'region', op: 'eq', value: 'south' }] })
    expect(result.matched).toBe(3)
    expect(result.scanned).toBe(5)
  })

  it('compares a number as a number, not as text', () => {
    // It really discriminates: 100, 250.5, 300 and 99.5 pass. Comparing as
    // TEXT, only "99.5" > "60" would be true ("1" and "2" and "3" < "6") and the
    // result would fall to 1.
    const result = runSheetQuery(rows, { where: [{ column: 'amount', op: 'gt', value: 60 }] })
    expect(result.matched).toBe(4)
  })

  it('combines conditions with AND', () => {
    const result = runSheetQuery(rows, {
      where: [
        { column: 'region', op: 'eq', value: 'South' },
        { column: 'status', op: 'eq', value: 'paid' },
      ],
    })
    expect(result.matched).toBe(2)
  })

  it('contains finds a stretch in the middle', () => {
    // "ta" matches Beta and Delta, in the middle and at the end — it is not a prefix
    expect(runSheetQuery(rows, { where: [{ column: 'customer', op: 'contains', value: 'ta' }] }).matched).toBe(2)
  })

  it('explicit error when the column does not exist — and it lists the ones that do', () => {
    expect(() => runSheetQuery(rows, { where: [{ column: 'inexistente', op: 'eq', value: 1 }] }))
      .toThrow(SheetQueryError)
    try {
      runSheetQuery(rows, { where: [{ column: 'inexistente', op: 'eq', value: 1 }] })
    } catch (err) {
      expect((err as Error).message).toContain('customer')
    }
  })
})

describe('runSheetQuery — aggregation', () => {
  it('sums the whole column when there is no groupBy', () => {
    const result = runSheetQuery(rows, { aggregate: [{ fn: 'sum', column: 'amount' }] })
    expect(result.rows[0][0]).toBeCloseTo(800)
  })

  it('groups and sums by key', () => {
    const result = runSheetQuery(rows, {
      groupBy: ['region'],
      aggregate: [{ fn: 'sum', column: 'amount', as: 'total' }],
      orderBy: { column: 'total', direction: 'desc' },
    })
    expect(result.columns).toEqual(['region', 'total'])
    expect(result.rows[0][0]).toBe('South')
    expect(result.rows[0][1]).toBeCloseTo(450)
    expect(result.rows[1][1]).toBeCloseTo(350)
  })

  it('filter and aggregation together', () => {
    const result = runSheetQuery(rows, {
      where: [{ column: 'status', op: 'eq', value: 'paid' }],
      aggregate: [{ fn: 'sum', column: 'amount' }, { fn: 'count' }],
    })
    expect(result.rows[0][0]).toBeCloseTo(499.5)
    expect(result.rows[0][1]).toBe(3)
  })

  it('avg, min and max', () => {
    const result = runSheetQuery(rows, {
      aggregate: [
        { fn: 'avg', column: 'amount', as: 'avg' },
        { fn: 'min', column: 'amount', as: 'smallest' },
        { fn: 'max', column: 'amount', as: 'largest' },
      ],
    })
    expect(result.rows[0][0]).toBeCloseTo(160)
    expect(result.rows[0][1]).toBe(50)
    expect(result.rows[0][2]).toBe(300)
  })

  it('COUNTS the ignored non-numeric cells instead of treating them as zero', () => {
    const dirty: CellValue[][] = [
      ['item', 'amount'],
      ['a', 100],
      ['b', 'n/a'],
      ['c', 'pending'],
      ['d', 50],
    ]
    const result = runSheetQuery(dirty, { aggregate: [{ fn: 'sum', column: 'amount' }] })
    expect(result.rows[0][0]).toBe(150)
    expect(result.skippedCells).toBe(2)
    expect(formatQueryResult(result)).toContain('skipped')
  })

  it('an empty cell is absence, not a type error — it does not enter the ignored count', () => {
    const withEmpty: CellValue[][] = [
      ['item', 'amount'],
      ['a', 100],
      ['b', ''],
      ['c', null],
    ]
    const result = runSheetQuery(withEmpty, { aggregate: [{ fn: 'sum', column: 'amount' }] })
    expect(result.rows[0][0]).toBe(100)
    expect(result.skippedCells).toBe(0)
  })

  it('a column with no number at all returns null, not zero', () => {
    const values: CellValue[][] = [['item', 'amount'], ['a', 'x'], ['b', 'y']]
    const result = runSheetQuery(values, { aggregate: [{ fn: 'sum', column: 'amount' }] })
    expect(result.rows[0][0]).toBeNull()
    expect(result.skippedCells).toBe(2)
  })

  it('sums values written as text in pt-BR', () => {
    const ptbr: CellValue[][] = [['item', 'amount'], ['a', '1.234,56'], ['b', '2.000,00']]
    const result = runSheetQuery(ptbr, { aggregate: [{ fn: 'sum', column: 'amount' }] })
    expect(result.rows[0][0] as number).toBeCloseTo(3234.56)
    expect(result.skippedCells).toBe(0)
  })
})

describe('runSheetQuery — projection and limits', () => {
  it('select returns only the requested columns', () => {
    const result = runSheetQuery(rows, { select: ['customer', 'amount'], limit: 2 })
    expect(result.columns).toEqual(['customer', 'amount'])
    expect(result.rows[0]).toHaveLength(2)
  })

  it('limit cuts the response but the checked total stays true', () => {
    const result = runSheetQuery(rows, { limit: 2 })
    expect(result.returned).toBe(2)
    expect(result.matched).toBe(5)
    expect(result.truncated).toBe(true)
  })

  it('the row ceiling keeps the query from becoming a spreadsheet dump', () => {
    const huge: CellValue[][] = [['n'], ...Array.from({ length: 5000 }, (_, i) => [i])]
    const result = runSheetQuery(huge, { limit: 99999 })
    expect(result.returned).toBe(200)
    expect(result.scanned).toBe(5000)
    expect(result.truncated).toBe(true)
  })

  it('an empty spreadsheet does not break', () => {
    expect(runSheetQuery([], {}).scanned).toBe(0)
  })
})

describe('formatQueryResult', () => {
  it('declares how many rows were scanned — that is what makes the number auditable', () => {
    const out = formatQueryResult(runSheetQuery(rows, { aggregate: [{ fn: 'sum', column: 'amount' }] }))
    expect(out).toContain('5 rows in the sheet')
  })

  it('warns about the cut when there was truncation', () => {
    expect(formatQueryResult(runSheetQuery(rows, { limit: 2 }))).toContain('showing 2')
  })
})

describe('runSheetQuery — group key and footer counts', () => {
  it('a value with an extra space does not become two groups', () => {
    const cities: CellValue[][] = [
      ['city', 'state', 'amount'],
      ['New York', 'NY', 10],
      ['New York', 'NY', 20],
      ['Los Angeles', 'LA', 5],
    ]
    const result = runSheetQuery(cities, {
      groupBy: ['city'],
      aggregate: [{ fn: 'sum', column: 'amount', as: 'total' }],
    })
    expect(result.rows).toHaveLength(2)
    expect(result.rows.find((r) => r[0] === 'New York')?.[1]).toBe(30)
  })

  it('groups by more than one column without shuffling the keys', () => {
    const rows: CellValue[][] = [
      ['region', 'status', 'amount'],
      ['South', 'paid', 10],
      ['South', 'pending', 20],
      ['North', 'paid', 5],
    ]
    const result = runSheetQuery(rows, {
      groupBy: ['region', 'status'],
      aggregate: [{ fn: 'sum', column: 'amount', as: 'total' }],
    })
    expect(result.rows).toHaveLength(3)
    expect(result.columns).toEqual(['region', 'status', 'total'])
  })

  it('in an aggregated query, "considered" are ROWS and the groups come separately', () => {
    // The footer said "3 after the filter" for 8000 rows in 3 groups — the model
    // would report that only 3 rows entered the count.
    const result = runSheetQuery(rows, {
      groupBy: ['region'],
      aggregate: [{ fn: 'sum', column: 'amount' }],
    })
    expect(result.matched).toBe(5)
    expect(result.groups).toBe(2)
    const out = formatQueryResult(result)
    expect(out).toContain('5 considered')
    expect(out).toContain('2 group(s)')
  })

  it('a query without aggregation reports no groups', () => {
    expect(runSheetQuery(rows, {}).groups).toBeUndefined()
  })
})
