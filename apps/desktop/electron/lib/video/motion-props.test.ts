import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  MAX_VARIATIONS,
  PROPS_QUERY,
  checkOverrides,
  coerceProp,
  decodeOverrides,
  describeProps,
  encodeOverrides,
  isSafeRelativePath,
  lintProps,
  parsePropsSchema,
  propsForPage,
  propsScriptTag,
  propsUsedIn,
  readPropsFile,
  resolveProps,
  slugify,
  variationLabels,
  withOverrides,
} from './motion-props'

const full = {
  title: { type: 'text', default: 'Black Friday' },
  price: { type: 'number', default: 99, min: 0, max: 1000 },
  color: { type: 'color', default: '#c93b64' },
  tone: { type: 'select', options: ['warm', 'cool'], default: 'warm' },
  logo: { type: 'image', default: 'logo.png' },
  on: { type: 'boolean', default: true },
}

describe('parsePropsSchema', () => {
  it('reads every type', () => {
    const { schema, errors } = parsePropsSchema(full)
    expect(errors).toEqual([])
    expect(Object.keys(schema)).toEqual(['title', 'price', 'color', 'tone', 'logo', 'on'])
    expect(schema.price).toMatchObject({ type: 'number', min: 0, max: 1000, default: 99 })
  })

  it('accepts the shorthand: a bare value is its own default, with the type inferred', () => {
    const { schema, errors } = parsePropsSchema({ name: 'Ana', n: 3, flag: false, c: '#fff' })
    expect(errors).toEqual([])
    expect(schema).toEqual({
      name: { type: 'text', default: 'Ana' },
      n: { type: 'number', default: 3 },
      flag: { type: 'boolean', default: false },
      c: { type: 'color', default: '#fff' },
    })
  })

  it('infers the type of an object from its default when "type" is missing', () => {
    expect(parsePropsSchema({ x: { default: 7 } }).schema.x.type).toBe('number')
  })

  it('collects every problem with a reason instead of stopping at the first', () => {
    const { schema, errors } = parsePropsSchema({
      'bad name': 'x',
      noDefault: { type: 'text' },
      weird: { type: 'video', default: 'a' },
      list: [1, 2],
      pick: { type: 'select', default: 'a' },
      pick2: { type: 'select', options: ['a'], default: 'b' },
      n: { type: 'number', default: 5, min: 10 },
      range: { type: 'number', default: 1, min: 5, max: 2 },
      img: { type: 'image', default: 'https://x.test/a.png' },
    })
    expect(schema).toEqual({})
    expect(errors).toHaveLength(9)
    expect(errors.join('\n')).toMatch(/"bad name" is not a valid name/)
    expect(errors.join('\n')).toMatch(/needs a "default"/)
    expect(errors.join('\n')).toMatch(/type "video" does not exist/)
    expect(errors.join('\n')).toMatch(/needs "options"/)
    expect(errors.join('\n')).toMatch(/expected one of "a"/)
    expect(errors.join('\n')).toMatch(/below the minimum 10/)
    expect(errors.join('\n')).toMatch(/min \(5\) is above max \(2\)/)
    expect(errors.join('\n')).toMatch(/inside the composition folder/)
  })

  it('refuses a file that is not an object', () => {
    expect(parsePropsSchema([]).errors[0]).toMatch(/must be an object/)
    expect(parsePropsSchema('x').errors[0]).toMatch(/must be an object/)
  })
})

describe('coerceProp', () => {
  const defs = parsePropsSchema(full).schema
  it('accepts what fits and converts the obvious (a numeric string, "true")', () => {
    expect(coerceProp(defs.price, '49.5', 'price')).toEqual({ ok: true, value: 49.5 })
    expect(coerceProp(defs.on, 'false', 'on')).toEqual({ ok: true, value: false })
    expect(coerceProp(defs.title, 2024, 'title')).toEqual({ ok: true, value: '2024' })
  })
  it('refuses what does not', () => {
    expect(coerceProp(defs.price, -1, 'price')).toMatchObject({ ok: false })
    expect(coerceProp(defs.price, 1001, 'price')).toMatchObject({ ok: false })
    expect(coerceProp(defs.price, 'abc', 'price')).toMatchObject({ ok: false })
    expect(coerceProp(defs.color, 'red', 'color')).toMatchObject({ ok: false })
    expect(coerceProp(defs.tone, 'hot', 'tone')).toMatchObject({ ok: false })
    expect(coerceProp(defs.logo, '../secret.png', 'logo')).toMatchObject({ ok: false })
    expect(coerceProp(defs.on, 'maybe', 'on')).toMatchObject({ ok: false })
  })
  it('isSafeRelativePath keeps a path inside the folder', () => {
    for (const ok of ['logo.png', 'img/a.png']) expect(isSafeRelativePath(ok)).toBe(true)
    for (const bad of ['', '/etc/x', '../x', 'a/../../x', 'http://x/a.png', 'file:///x', 'C:\\x']) expect(isSafeRelativePath(bad)).toBe(false)
  })
})

describe('resolveProps', () => {
  const { schema } = parsePropsSchema(full)
  it('gives every default, with the overrides on top', () => {
    const { values, errors } = resolveProps(schema, { title: 'Oferta A', price: 49 })
    expect(errors).toEqual([])
    expect(values).toMatchObject({ title: 'Oferta A', price: 49, color: '#c93b64', tone: 'warm', on: true })
  })
  it('refuses an undeclared name (a typo) listing what is declared — never drops it silently', () => {
    const { errors } = resolveProps(schema, { titel: 'x' })
    expect(errors[0]).toMatch(/titel: not declared in props.json — declared: title, price/)
  })
  it('says so when the file declares nothing', () => {
    expect(resolveProps({}, { a: 1 }).errors[0]).toMatch(/declares nothing/)
  })
  it('reports each wrong value', () => {
    expect(resolveProps(schema, { price: -5, color: 'x' }).errors).toHaveLength(2)
  })
})

describe('describeProps / slugify / variationLabels', () => {
  it('lists the declared props with type, range and default', () => {
    const text = describeProps(parsePropsSchema(full).schema)
    expect(text).toContain('title (text, default "Black Friday")')
    expect(text).toContain('price (number 0–1000, default 99)')
    expect(text).toContain('tone (select warm|cool, default "warm")')
  })
  it('slugs a name without accents or symbols', () => {
    expect(slugify('Oferta Ç! Ágil')).toBe('oferta-c-agil')
    expect(slugify('!!!')).toBe('variation')
  })
  it('labels are unique and ordered: the name, else the number', () => {
    expect(variationLabels([{ name: 'A' }, {}, { name: 'a' }, { name: 'A' }])).toEqual(['a', '02', 'a-2', 'a-3'])
  })
})

describe('transport', () => {
  it('round-trips the overrides through the URL, including quotes and accents', () => {
    const o = { title: 'He said "oi" — ação', n: 3 }
    expect(decodeOverrides(encodeOverrides(o))).toEqual(o)
  })
  it('refuses anything that is not an object', () => {
    expect(decodeOverrides(null)).toBeNull()
    expect(decodeOverrides('???')).toBeNull()
    expect(decodeOverrides(Buffer.from('[1,2]').toString('base64url'))).toBeNull()
  })
  it('adds the parameter to the URL and leaves a URL without overrides alone', () => {
    const base = 'orbit-motion://mv_x/index.html'
    expect(withOverrides(base, undefined)).toBe(base)
    expect(withOverrides(base, {})).toBe(base)
    const u = new URL(withOverrides(base, { a: 1 }))
    expect(decodeOverrides(u.searchParams.get(PROPS_QUERY))).toEqual({ a: 1 })
  })
  it('escapes a value so it cannot close the script or break the line', () => {
    const tag = propsScriptTag({ t: '</script><script>alert(1)</script>', u: 'a\u2028b' })
    expect(tag.startsWith('<script>window.__orbitProps=')).toBe(true)
    expect(tag.slice(8, -9)).not.toContain('<')
    expect(tag).not.toContain('\u2028')
    // and it still parses back to the same values
    const value = new Function('window', `${tag.slice(8, -9)}; return window.__orbitProps`)({})
    expect(value).toEqual({ t: '</script><script>alert(1)</script>', u: 'a\u2028b' })
  })
})

describe('on disk', () => {
  let dir: string
  beforeAll(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'orbit-props-'))
  })
  afterAll(() => fsp.rm(dir, { recursive: true, force: true }))
  const write = (folder: string, text: string) => fsp.writeFile(path.join(folder, 'props.json'), text)
  const sub = async (name: string) => {
    const f = path.join(dir, name)
    await fsp.mkdir(f, { recursive: true })
    return f
  }

  it('a folder without props.json declares nothing and is not an error', async () => {
    const f = await sub('none')
    expect(await readPropsFile(f)).toEqual({ exists: false, schema: {}, errors: [] })
    expect(await propsForPage(f, null)).toBeNull()
  })

  it('reads the file and reports invalid JSON with the reason', async () => {
    const f = await sub('broken')
    await write(f, '{ nope')
    const file = await readPropsFile(f)
    expect(file.exists).toBe(true)
    expect(file.errors[0]).toMatch(/not valid JSON/)
  })

  it('propsForPage: defaults, the valid overrides on top, an invalid one falls back', async () => {
    const f = await sub('page')
    await write(f, JSON.stringify(full))
    expect(await propsForPage(f, null)).toMatchObject({ title: 'Black Friday', price: 99 })
    const enc = encodeOverrides({ title: 'Oferta', price: -1, ghost: 1 })
    expect(await propsForPage(f, enc)).toMatchObject({ title: 'Oferta', price: 99 })
  })

  it('a broken props.json still lets the page load (with no props)', async () => {
    const f = await sub('broken2')
    await write(f, '{"a": {"type": "x", "default": 1}}')
    expect(await propsForPage(f, null)).toEqual({})
  })

  it('checkOverrides: names the variation and the problem, and refuses props on a piece with none', async () => {
    const f = await sub('check')
    await write(f, JSON.stringify(full))
    const problems = await checkOverrides(f, [
      { label: 'variation 1', props: { title: 'ok' } },
      { label: 'variation 2 "b"', props: { price: -3 } },
      { label: 'variation 3', props: { titel: 'x' } },
    ])
    expect(problems).toHaveLength(2)
    expect(problems[0]).toMatch(/^variation 2 "b": price: -3 is below/)
    expect(problems[1]).toMatch(/^variation 3: titel: not declared/)
    const none = await sub('check-none')
    expect((await checkOverrides(none, [{ label: 'props', props: { a: 1 } }]))[0]).toMatch(/declares no props/)
    expect(await checkOverrides(none, [{ label: 'props', props: {} }])).toEqual([])
  })

  it('the limit of variations is stated', () => {
    expect(MAX_VARIATIONS).toBe(50)
  })
})

describe('lintProps / propsUsedIn', () => {
  it('finds the names the page reads', () => {
    expect(propsUsedIn('const t = orbitMotion.props.title + M.props["price"]; const { color, tone: t2, n = 3 } = orbitMotion.props')).toEqual(
      expect.arrayContaining(['title', 'price', 'color', 'tone', 'n']),
    )
    expect(propsUsedIn('const { a } = other')).toEqual([])
  })

  const file = (schema: Record<string, unknown>) => ({ exists: true, schema: parsePropsSchema(schema).schema, errors: [] as string[] })

  it('errors on a prop read but not declared, warns on one declared but not read', () => {
    const findings = lintProps(file({ title: 'x', unused: 1 }), ['const { title, price } = orbitMotion.props'])
    expect(findings.map((f) => `${f.rule}:${f.severity}`).sort()).toEqual(['props-undeclared:error', 'props-unused:warning'])
    expect(findings.find((f) => f.rule === 'props-undeclared')!.message).toContain('props.price')
  })

  it('errors when the page reads props but there is no props.json', () => {
    const findings = lintProps({ exists: false, schema: {}, errors: [] }, ['orbitMotion.props.title'])
    expect(findings[0]).toMatchObject({ rule: 'props-undeclared', severity: 'error' })
  })

  it('is quiet when there is no props.json and the page does not use props', () => {
    expect(lintProps({ exists: false, schema: {}, errors: [] }, ['console.log(1)'])).toEqual([])
  })

  it('reports an invalid props.json as an error', () => {
    const findings = lintProps({ exists: true, schema: {}, errors: ['x: needs a "default"'] }, [])
    expect(findings[0]).toMatchObject({ rule: 'props-invalid', severity: 'error' })
  })
})
