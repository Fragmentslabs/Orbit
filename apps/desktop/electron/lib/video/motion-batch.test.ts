import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { batchProgress, detectDelimiter, estimateRemainingMs, formatDuration, parseCsv, parseTable, stageImageProps, variationsFromTable } from './motion-batch'
import { parsePropsSchema } from './motion-props'

const { schema } = parsePropsSchema({
  title: { type: 'text', default: 'Black Friday' },
  price: { type: 'number', default: 99, min: 0 },
  color: { type: 'color', default: '#c93b64' },
  photo: { type: 'image', default: 'logo.png' },
})

describe('parseCsv', () => {
  it('reads quotes, doubled quotes, delimiters and newlines inside quotes', () => {
    const rows = parseCsv('a,b\n"x, y","He said ""oi"""\n"two\nlines",z\n')
    expect(rows).toEqual([['a', 'b'], ['x, y', 'He said "oi"'], ['two\nlines', 'z']])
  })
  it('understands Windows line ends, a BOM and blank lines', () => {
    expect(parseCsv('﻿a,b\r\n1,2\r\n\r\n3,4')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']])
  })
  it('detects the delimiter of the header (comma, the semicolon of pt-BR Excel, tab) outside quotes', () => {
    expect(detectDelimiter('a;b;c')).toBe(';')
    expect(detectDelimiter('a\tb')).toBe('\t')
    expect(detectDelimiter('"a,b",c;d;e')).toBe(';')
    expect(detectDelimiter('single')).toBe(',')
    expect(parseCsv('titulo;preco\nOferta;12,5')).toEqual([['titulo', 'preco'], ['Oferta', '12,5']])
  })
})

describe('parseTable', () => {
  it('turns a CSV into rows keyed by the header', () => {
    expect(parseTable('title,price\nA,49\nB,59').rows).toEqual([{ title: 'A', price: '49' }, { title: 'B', price: '59' }])
  })
  it('accepts JSON: an array of objects, or { rows }, with any scalar turned into text', () => {
    expect(parseTable('[{"title":"A","price":49,"on":true},{"title":"B"}]').rows).toEqual([{ title: 'A', price: '49', on: 'true' }, { title: 'B' }])
    expect(parseTable('{"rows":[{"title":"A"}]}').rows).toEqual([{ title: 'A' }])
  })
  it('says what is wrong instead of guessing', () => {
    expect(() => parseTable('  ')).toThrow(/empty/)
    expect(() => parseTable('title\n')).toThrow(/header line .* and at least one row/)
    expect(() => parseTable('a,a\n1,2')).toThrow(/repeats a column: a/)
    expect(() => parseTable('a,\n1,2')).toThrow(/needs a name/)
    expect(() => parseTable('[1,2]')).toThrow(/array of objects/)
    expect(() => parseTable('[{"a":')).toThrow(/does not parse/)
  })
})

describe('variationsFromTable', () => {
  it('one variation per row; an empty cell keeps the default; the first column names the file', () => {
    const out = variationsFromTable(schema, parseTable('title,price,color\nOferta A,49,#2a7de1\nOferta B,,'))
    expect(out.errors).toEqual([])
    expect(out.variations).toEqual([
      { name: 'Oferta A', props: { title: 'Oferta A', price: '49', color: '#2a7de1' } },
      { name: 'Oferta B', props: { title: 'Oferta B' } },
    ])
  })

  it('a file column names the output and is not a prop', () => {
    const out = variationsFromTable(schema, parseTable('file,title\nsp,São Paulo\nrj,Rio'))
    expect(out.errors).toEqual([])
    expect(out.labelColumn).toBe('file')
    expect(out.variations.map((v) => v.name)).toEqual(['sp', 'rj'])
    expect(out.variations[0].props).toEqual({ title: 'São Paulo' })
  })

  it('a decimal comma is a number ("12,5")', () => {
    const out = variationsFromTable(schema, parseTable('title;price\nA;12,5'))
    expect(out.errors).toEqual([])
    expect(out.variations[0].props.price).toBe('12.5')
  })

  it('a column that is not a prop is an ERROR naming it and what is declared, never ignored', () => {
    const out = variationsFromTable(schema, parseTable('titel,price\nA,1'))
    expect(out.errors[0]).toMatch(/column "titel" is not declared in props.json — declared: title, price, color, photo/)
  })

  it('a cell of the wrong type is reported with its row (line of the file) and the name', () => {
    const out = variationsFromTable(schema, parseTable('title,price,color\nA,49,#fff\nB,-5,red\nC,abc,#000'))
    expect(out.errors).toHaveLength(3)
    expect(out.errors[0]).toMatch(/row 3 \("B"\): price: -5 is below the minimum 0/)
    expect(out.errors[1]).toMatch(/row 3 \("B"\): color: expected a hex colour/)
    expect(out.errors[2]).toMatch(/row 4 \("C"\): price: expected a number/)
  })

  it('refuses a table with no column at all that matches', () => {
    expect(variationsFromTable(schema, { headers: [], rows: [{}] }).errors[0]).toMatch(/no column matches/)
  })
})

describe('stageImageProps', () => {
  let dir: string
  let folder: string
  let project: string
  beforeAll(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'orbit-batch-'))
    folder = path.join(dir, 'piece')
    project = path.join(dir, 'project')
    await fsp.mkdir(folder, { recursive: true })
    await fsp.mkdir(path.join(project, 'fotos'), { recursive: true })
    await fsp.writeFile(path.join(folder, 'logo.png'), 'LOGO')
    await fsp.writeFile(path.join(project, 'fotos', 'tenis azul.png'), 'AZUL')
    await fsp.writeFile(path.join(project, 'fotos', 'copia.png'), 'AZUL') // the same content, another name
  })
  afterAll(() => fsp.rm(dir, { recursive: true, force: true }))

  const find = async (value: string) => {
    const file = path.join(project, value)
    return (await fsp.stat(file).catch(() => null)) ? file : null
  }

  it('keeps a file that is already in the piece', async () => {
    const res = await stageImageProps({ folder, schema, props: { photo: 'logo.png', title: 'x' }, find })
    expect(res.errors).toEqual([])
    expect(res.props).toEqual({ photo: 'logo.png', title: 'x' })
  })

  it('copies a project file into props-assets/ under its hash, and the value becomes that relative path', async () => {
    const res = await stageImageProps({ folder, schema, props: { photo: 'fotos/tenis azul.png' }, find })
    expect(res.errors).toEqual([])
    const rel = res.props.photo as string
    expect(rel).toMatch(/^props-assets\/[0-9a-f]{10}-tenis-azul\.png$/)
    expect(await fsp.readFile(path.join(folder, rel), 'utf8')).toBe('AZUL')
  })

  it('the same content is copied once (same hash prefix), and a second call reuses the file', async () => {
    const a = await stageImageProps({ folder, schema, props: { photo: 'fotos/tenis azul.png' }, find })
    const b = await stageImageProps({ folder, schema, props: { photo: 'fotos/copia.png' }, find })
    expect((a.props.photo as string).split('-')[0]).toBe((b.props.photo as string).split('-')[0])
    const listed = await fsp.readdir(path.join(folder, 'props-assets'))
    expect(listed.filter((n) => n.endsWith('azul.png'))).toHaveLength(1)
  })

  it('an image that is nowhere is an error naming the prop, and only image props are touched', async () => {
    const res = await stageImageProps({ folder, schema, props: { photo: 'fotos/sumiu.png', title: 'fotos/sumiu.png' }, find })
    expect(res.errors).toHaveLength(1)
    expect(res.errors[0]).toMatch(/photo: the image "fotos\/sumiu.png" was not found/)
    expect(res.props.title).toBe('fotos/sumiu.png')
  })

  it('never copies from outside through a ".." path', async () => {
    const res = await stageImageProps({ folder, schema, props: { photo: '../project/fotos/copia.png' }, find: async () => null })
    expect(res.errors).toHaveLength(1)
  })
})

describe('ETA', () => {
  it('formats durations', () => {
    expect(formatDuration(45_000)).toBe('45 s')
    expect(formatDuration(200_000)).toBe('3 min 20 s')
    expect(formatDuration(180_000)).toBe('3 min')
    expect(formatDuration(3_900_000)).toBe('1 h 05 min')
  })
  it('estimates from the average of what is done, and says nothing before anything is done', () => {
    expect(estimateRemainingMs([10_000, 20_000], 4)).toBe(60_000)
    expect(estimateRemainingMs([], 4)).toBeNull()
    expect(estimateRemainingMs([5000], 0)).toBe(0)
  })
  it('the progress says the number, the total and (after the first) the time left', () => {
    expect(batchProgress(0, 10, [])).toEqual({ n: 1, total: 10, left: null })
    expect(batchProgress(3, 10, [60_000, 60_000, 60_000])).toEqual({ n: 4, total: 10, left: '7 min' })
  })
})
