import fsp from 'node:fs/promises'
import path from 'node:path'

/**
 * Props of a motion composition — the parameters that change from one video to the next (a title, a
 * price, a colour, a logo) declared ONCE, so the same piece can be rendered many times with other data
 * instead of being copied and edited as text.
 *
 *   props.json, next to index.html:
 *     { "title": { "type": "text", "default": "Black Friday" },
 *       "price": { "type": "number", "default": 99, "min": 0 },
 *       "color": { "type": "color", "default": "#c93b64" },
 *       "tone":  { "type": "select", "options": ["warm", "cool"], "default": "warm" },
 *       "logo":  { "type": "image", "default": "logo.png" },
 *       "name":  "shorthand: a bare value is its own default (text, number, boolean or #colour)" }
 *
 *   in the composition:  const { title, price } = orbitMotion.props
 *   when rendering:      motion_render({ name, props: { title: "Oferta A" } })
 *                        motion_render({ name, variations: [{ props: {…} }, …] })
 *
 * The values are fixed for a whole render, so a frame is still a pure function of its number. They
 * reach the page as a script the scheme handler injects before the runtime (defaults + the overrides
 * that came in the URL); nothing here touches the DOM.
 */

export const PROPS_FILE = 'props.json'
/** The query parameter that carries the overrides of one render (base64url of a JSON object). */
export const PROPS_QUERY = 'orbitProps'
/** How many variations one call may ask for. */
export const MAX_VARIATIONS = 200

export const PROP_TYPES = ['text', 'number', 'color', 'boolean', 'select', 'image'] as const
export type PropType = (typeof PROP_TYPES)[number]

export interface PropDef {
  type: PropType
  default: string | number | boolean
  label?: string
  min?: number
  max?: number
  options?: string[]
}
export type PropsSchema = Record<string, PropDef>
export type PropValue = string | number | boolean

/** A name the composition can destructure: `const { title } = orbitMotion.props`. */
const NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/** A relative path inside the composition folder: no scheme, no leading slash, no `..`. */
export function isSafeRelativePath(p: string): boolean {
  if (!p || /^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith('/') || p.startsWith('\\')) return false
  return !p.replace(/\\/g, '/').split('/').includes('..')
}

function inferType(value: unknown): PropType | null {
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'string') return COLOR.test(value) ? 'color' : 'text'
  return null
}

/** Checks one value against its definition. Pure. */
export function coerceProp(def: PropDef, value: unknown, name: string): { ok: true; value: PropValue } | { ok: false; error: string } {
  const bad = (why: string) => ({ ok: false as const, error: `${name}: ${why}` })
  switch (def.type) {
    case 'text':
      return typeof value === 'string' || typeof value === 'number' ? { ok: true, value: String(value) } : bad('expected text')
    case 'number': {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
      if (typeof n !== 'number' || !Number.isFinite(n)) return bad('expected a number')
      if (def.min !== undefined && n < def.min) return bad(`${n} is below the minimum ${def.min}`)
      if (def.max !== undefined && n > def.max) return bad(`${n} is above the maximum ${def.max}`)
      return { ok: true, value: n }
    }
    case 'color':
      return typeof value === 'string' && COLOR.test(value) ? { ok: true, value } : bad('expected a hex colour like #c93b64')
    case 'boolean':
      if (typeof value === 'boolean') return { ok: true, value }
      if (value === 'true' || value === 'false') return { ok: true, value: value === 'true' }
      return bad('expected true or false')
    case 'select':
      return typeof value === 'string' && def.options?.includes(value) ? { ok: true, value } : bad(`expected one of ${(def.options ?? []).map((o) => `"${o}"`).join(', ')}`)
    case 'image':
      return typeof value === 'string' && isSafeRelativePath(value) ? { ok: true, value } : bad('expected a file path inside the composition folder (no URL, no "..")')
  }
}

/** Reads the parsed props.json. Collects every problem instead of stopping at the first. Pure. */
export function parsePropsSchema(raw: unknown): { schema: PropsSchema; errors: string[] } {
  const errors: string[] = []
  const schema: PropsSchema = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { schema, errors: [`${PROPS_FILE} must be an object: { "title": { "type": "text", "default": "…" }, … }`] }
  }
  for (const [name, spec] of Object.entries(raw as Record<string, unknown>)) {
    if (!NAME.test(name)) {
      errors.push(`"${name}" is not a valid name — use letters, digits, _ or $, not starting with a digit (the composition reads it as orbitMotion.props.${name})`)
      continue
    }
    const isObject = spec !== null && typeof spec === 'object' && !Array.isArray(spec)
    // Shorthand: a bare value is its own default.
    if (!isObject) {
      const type = inferType(spec)
      if (!type) {
        errors.push(`${name}: a bare value must be text, a number or true/false — use { "type", "default" } for anything else`)
        continue
      }
      schema[name] = { type, default: spec as PropValue }
      continue
    }
    const o = spec as Record<string, unknown>
    if (!('default' in o)) {
      errors.push(`${name}: needs a "default" — the value used when a render does not set it`)
      continue
    }
    const type = (o.type as PropType | undefined) ?? inferType(o.default)
    if (!type || !PROP_TYPES.includes(type)) {
      errors.push(`${name}: type "${String(o.type)}" does not exist — use ${PROP_TYPES.join(', ')}`)
      continue
    }
    const def: PropDef = { type, default: o.default as PropValue }
    if (typeof o.label === 'string') def.label = o.label
    if (type === 'number') {
      if (o.min !== undefined) def.min = Number(o.min)
      if (o.max !== undefined) def.max = Number(o.max)
      if ((def.min !== undefined && !Number.isFinite(def.min)) || (def.max !== undefined && !Number.isFinite(def.max))) {
        errors.push(`${name}: min and max must be numbers`)
        continue
      }
      if (def.min !== undefined && def.max !== undefined && def.min > def.max) {
        errors.push(`${name}: min (${def.min}) is above max (${def.max})`)
        continue
      }
    }
    if (type === 'select') {
      if (!Array.isArray(o.options) || !o.options.length || !o.options.every((x) => typeof x === 'string')) {
        errors.push(`${name}: a select needs "options": ["a", "b"] (a non-empty list of text)`)
        continue
      }
      def.options = o.options as string[]
    }
    const checked = coerceProp(def, o.default, name)
    if (!checked.ok) {
      errors.push(`${checked.error} (in "default")`)
      continue
    }
    def.default = checked.value
    schema[name] = def
  }
  return { schema, errors }
}

export interface ResolvedProps {
  values: Record<string, PropValue>
  errors: string[]
}

/**
 * The values of a render: every default, with the overrides on top. An override that is not declared
 * or does not fit its type is an ERROR (listed, with what is declared) — it is never silently dropped,
 * because a typo in a batch of fifty videos would be fifty videos with the wrong title.
 */
export function resolveProps(schema: PropsSchema, overrides: Record<string, unknown> = {}): ResolvedProps {
  const values: Record<string, PropValue> = {}
  const errors: string[] = []
  for (const [name, def] of Object.entries(schema)) values[name] = def.default
  const known = Object.keys(schema)
  for (const [name, raw] of Object.entries(overrides)) {
    const def = schema[name]
    if (!def) {
      errors.push(`${name}: not declared in ${PROPS_FILE}${known.length ? ` — declared: ${known.join(', ')}` : ' (the file declares nothing)'}`)
      continue
    }
    const checked = coerceProp(def, raw, name)
    if (checked.ok) values[name] = checked.value
    else errors.push(checked.error)
  }
  return { values, errors }
}

/** "title (text, default "Black Friday") · price (number 0–100, default 99)" — what the agent reads. Pure. */
export function describeProps(schema: PropsSchema): string {
  const entries = Object.entries(schema)
  if (!entries.length) return ''
  return entries
    .map(([name, d]) => {
      const range = d.type === 'number' && (d.min !== undefined || d.max !== undefined) ? ` ${d.min ?? ''}–${d.max ?? ''}` : ''
      const opts = d.type === 'select' ? ` ${d.options!.join('|')}` : ''
      return `${name} (${d.type}${range}${opts}, default ${JSON.stringify(d.default)})`
    })
    .join(' · ')
}

// ---------------------------------------------------------------------------------- transport

/** base64url of the overrides, for the URL of a render window. */
export function encodeOverrides(overrides: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(overrides), 'utf8').toString('base64url')
}

/** The overrides out of the query parameter; `null` when absent or not an object. */
export function decodeOverrides(encoded: string | null | undefined): Record<string, unknown> | null {
  if (!encoded) return null
  try {
    const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** The URL of a composition with the overrides of this render appended. */
export function withOverrides(url: string, overrides: Record<string, unknown> | undefined): string {
  if (!overrides || !Object.keys(overrides).length) return url
  const u = new URL(url)
  u.searchParams.set(PROPS_QUERY, encodeOverrides(overrides))
  return u.toString()
}

/**
 * The tag that hands the values to the page, to go BEFORE the runtime. JSON in a script is
 * escaped so no value can close the tag or break the line.
 */
export function propsScriptTag(values: Record<string, PropValue>): string {
  const json = JSON.stringify(values)
    .replace(/</g, '\\u003c')
    .replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028')
    .replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029')
  return `<script>window.__orbitProps=${json}</script>`
}

// -------------------------------------------------------------------------------------- disk

export interface PropsFile {
  exists: boolean
  schema: PropsSchema
  errors: string[]
}

/** Reads props.json of a composition folder. A missing file is `exists: false`, not an error. */
export async function readPropsFile(folder: string): Promise<PropsFile> {
  const text = await fsp.readFile(path.join(folder, PROPS_FILE), 'utf8').catch(() => null)
  if (text === null) return { exists: false, schema: {}, errors: [] }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return { exists: true, schema: {}, errors: [`${PROPS_FILE} is not valid JSON: ${(err as Error).message}`] }
  }
  return { exists: true, ...parsePropsSchema(raw) }
}

/**
 * What the scheme handler injects for a page: the values (defaults + the overrides of the URL), or `null`
 * when the composition declares no props. Never throws — the page must load even with a broken file; the
 * lint and the render say what is wrong.
 */
export async function propsForPage(folder: string, encodedOverrides: string | null): Promise<Record<string, PropValue> | null> {
  const file = await readPropsFile(folder)
  if (!file.exists || file.errors.length) return file.exists ? {} : null
  const overrides = decodeOverrides(encodedOverrides) ?? {}
  // Valid overrides apply; an invalid one falls back to its default (the render refuses it before getting here).
  const valid: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(overrides)) {
    const def = file.schema[name]
    if (def && coerceProp(def, value, name).ok) valid[name] = value
  }
  return resolveProps(file.schema, valid).values
}

/**
 * Checks the overrides of a render (or of every variation) against the composition's props.json BEFORE
 * any frame is made. Returns the messages to show, empty when everything fits.
 */
export async function checkOverrides(folder: string, sets: Array<{ label: string; props: Record<string, unknown> }>): Promise<string[]> {
  const file = await readPropsFile(folder)
  const out: string[] = []
  if (file.errors.length) return file.errors.map((e) => `${PROPS_FILE}: ${e}`)
  for (const { label, props } of sets) {
    if (!Object.keys(props).length) continue
    if (!file.exists) {
      out.push(`${label}: this composition declares no props — add a ${PROPS_FILE} next to index.html (motion_write files) and read orbitMotion.props in the page`)
      break
    }
    for (const e of resolveProps(file.schema, props).errors) out.push(`${label}: ${e}`)
  }
  return out
}

/** "Oferta A!" → "oferta-a": a file-name-safe label for a variation. Pure. */
export function slugify(text: string): string {
  return (
    text
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'variation'
  )
}

/** Unique, ordered file labels for the variations: their name, else their index; repeats get -2, -3… Pure. */
export function variationLabels(variations: Array<{ name?: string }>): string[] {
  const seen = new Map<string, number>()
  return variations.map((v, i) => {
    const base = v.name ? slugify(v.name) : String(i + 1).padStart(2, '0')
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return n === 1 ? base : `${base}-${n}`
  })
}

// ---------------------------------------------------------------------------------- lint

export interface PropsLintFinding {
  rule: string
  severity: 'error' | 'warning'
  message: string
  hint?: string
}

/** The names a script reads from orbitMotion.props: `.props.x` and `const { x, y } = … .props`. Pure. */
export function propsUsedIn(source: string): string[] {
  const used = new Set<string>()
  for (const m of source.matchAll(/\.props\s*\.\s*([A-Za-z_$][\w$]*)/g)) used.add(m[1])
  for (const m of source.matchAll(/\.props\s*\[\s*["']([^"']+)["']\s*\]/g)) used.add(m[1])
  for (const m of source.matchAll(/\{([^{}]*)\}\s*=\s*[\w$.]*\.props\b/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(':')[0].split('=')[0].trim()
      if (NAME.test(name)) used.add(name)
    }
  }
  return [...used]
}

/** Props.json problems, names used but not declared, and declared but never read. Pure. */
export function lintProps(file: PropsFile, sources: string[]): PropsLintFinding[] {
  const findings: PropsLintFinding[] = []
  for (const message of file.errors) {
    findings.push({ rule: 'props-invalid', severity: 'error', message: `${PROPS_FILE}: ${message}`, hint: 'fix props.json: the composition reads its defaults from it' })
  }
  const used = new Set(sources.flatMap(propsUsedIn))
  if (!file.exists) {
    if (used.size) {
      findings.push({
        rule: 'props-undeclared',
        severity: 'error',
        message: `the page reads orbitMotion.props (${[...used].join(', ')}) but there is no ${PROPS_FILE}`,
        hint: `add ${PROPS_FILE} next to index.html declaring each prop with its default`,
      })
    }
    return findings
  }
  if (file.errors.length) return findings
  for (const name of used) {
    if (!(name in file.schema)) {
      findings.push({
        rule: 'props-undeclared',
        severity: 'error',
        message: `orbitMotion.props.${name} is read but not declared in ${PROPS_FILE}`,
        hint: `declared: ${Object.keys(file.schema).join(', ') || 'none'}`,
      })
    }
  }
  for (const name of Object.keys(file.schema)) {
    if (!used.has(name)) {
      findings.push({ rule: 'props-unused', severity: 'warning', message: `prop "${name}" is declared but the page never reads it`, hint: 'read it from orbitMotion.props or remove it' })
    }
  }
  return findings
}
