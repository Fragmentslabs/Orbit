import { app } from 'electron'
import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type {
  FragmentCapability,
  FragmentKind,
  FragmentLogEntry,
  FragmentManifest,
  FragmentMetaPatch,
  FragmentModel,
  FragmentReasoning,
  FragmentPins,
  FragmentUpdatedEvent,
} from '@shared/fragments'
import {
  FRAGMENT_CAPABILITIES,
  FRAGMENT_DEFAULT_ICON,
  FRAGMENT_ICON_PATTERN,
  FRAGMENT_KINDS,
  isFragmentId,
} from '@shared/fragments'
import { noteProvenanceModified, recordLocalProvenance, removeProvenance } from './fragment-provenance'

/**
 * Fragments on disk — `orbit-data/fragments/<id>/`:
 *
 *   manifest.json  the contract (name, what it asked for, what the user allowed)
 *   src/           the code the scheme serves (index.html is the entry)
 *   data.json      the fragment's own state (orbit.store) — NEVER served
 *
 * Code and data are separated on purpose: rewriting the code never touches what the
 * user's fragment saved, and the scheme has no way to hand `data.json` or the manifest
 * to the page, because it only serves `src/`.
 */

const ENTRY = 'index.html'

/** Per-file cap. The page is written by a model: above this it is a data dump. */
export const MAX_FILE_BYTES = 1024 * 1024
const MAX_FILES = 60
const MAX_STORE_KEYS = 500
const MAX_STORE_VALUE_BYTES = 256 * 1024
const MAX_STORE_TOTAL_BYTES = 2 * 1024 * 1024
const LOG_CAPACITY = 80

/** Extensions the scheme may serve — text the page loads, plus small static assets. */
export const SERVED_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
}

/** Fires `updated` ({fragmentId, revision}) on every write; the IPC layer turns it into a UI event. */
export const fragmentEvents = new EventEmitter()

function fragmentsRoot(): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'fragments')
}

export { isFragmentId }

/** The folder of one fragment (history keeps its `.history/` next to `src/`). */
export function fragmentDir(id: string): string {
  if (!isFragmentId(id)) throw new Error(`invalid fragment id: ${String(id).slice(0, 60)}`)
  return path.join(fragmentsRoot(), id)
}

/** The folder of the fragment's code (for modules that measure it; the scheme never uses this). */
export function srcDir(id: string): string {
  return path.join(fragmentDir(id), 'src')
}

function manifestFile(id: string): string {
  return path.join(fragmentDir(id), 'manifest.json')
}

function dataFile(id: string): string {
  return path.join(fragmentDir(id), 'data.json')
}

/**
 * A relative path INSIDE `src/`, or an error. Absolute paths, `..`, hidden names and
 * extensions the scheme would not serve are refused — the same function guards the
 * agent's writes and the scheme's reads.
 */
export function resolveSrcPath(id: string, rel: string): string {
  if (typeof rel !== 'string' || !rel.trim()) throw new Error('path is empty')
  const clean = rel.replace(/\\/g, '/').replace(/^\/+/, '')
  const parts = clean.split('/')
  if (parts.some((p) => p === '' || p === '.' || p === '..' || p.startsWith('.'))) {
    throw new Error(`path not allowed: ${rel}`)
  }
  const ext = path.extname(clean).slice(1).toLowerCase()
  if (!SERVED_TYPES[ext]) {
    throw new Error(`file type .${ext || '(none)'} is not allowed — use ${Object.keys(SERVED_TYPES).join(', ')}`)
  }
  const base = srcDir(id)
  const full = path.join(base, ...parts)
  if (!full.startsWith(base + path.sep)) throw new Error(`path not allowed: ${rel}`)
  return full
}

export function slugify(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/g, '')
  return slug || 'fragment'
}

async function readManifestFile(id: string): Promise<FragmentManifest | null> {
  try {
    const parsed = JSON.parse(await fsp.readFile(manifestFile(id), 'utf8')) as Partial<FragmentManifest>
    if (!parsed || parsed.id !== id || typeof parsed.name !== 'string') return null
    const kind = FRAGMENT_KINDS.find((k) => k === parsed.kind) ?? 'screen'
    return {
      id,
      name: parsed.name,
      icon: sanitizeIcon(parsed.icon),
      kind,
      pinned: sanitizePins(parsed.pinned, kind),
      model: sanitizeModel(parsed.model),
      reasoning: sanitizeReasoning(parsed.reasoning),
      sdk: 1,
      requests: sanitizeCaps(parsed.requests),
      grants: sanitizeCaps(parsed.grants),
      revision: typeof parsed.revision === 'number' ? parsed.revision : 1,
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : 0,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined,
    }
  } catch {
    return null
  }
}

/** A lucide name in kebab-case, or the default — an agent's guess never poisons the manifest. */
export function sanitizeIcon(value: unknown): string {
  if (typeof value !== 'string') return FRAGMENT_DEFAULT_ICON
  const name = value.trim().toLowerCase()
  return name.length <= 48 && FRAGMENT_ICON_PATTERN.test(name) ? name : FRAGMENT_DEFAULT_ICON
}

/** A new fragment is pinned where its kind lives; an old manifest without pins gets the same. */
function defaultPins(kind: FragmentKind): FragmentPins {
  return { sidebar: kind === 'screen', panel: kind === 'panel', home: kind === 'widget' }
}

function sanitizePins(value: unknown, kind: FragmentKind): FragmentPins {
  const base = defaultPins(kind)
  if (!value || typeof value !== 'object') return base
  const raw = value as Partial<FragmentPins>
  return {
    sidebar: typeof raw.sidebar === 'boolean' ? raw.sidebar : base.sidebar,
    panel: typeof raw.panel === 'boolean' ? raw.panel : base.panel,
    home: typeof raw.home === 'boolean' ? raw.home : base.home,
  }
}

function sanitizeModel(value: unknown): FragmentModel | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Partial<FragmentModel>
  if (typeof raw.providerId !== 'string' || typeof raw.modelId !== 'string') return undefined
  if (!raw.providerId || !raw.modelId) return undefined
  return { providerId: raw.providerId.slice(0, 120), modelId: raw.modelId.slice(0, 200) }
}

function sanitizeReasoning(value: unknown): FragmentReasoning | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Partial<FragmentReasoning>
  if (raw.enabled !== true) return undefined
  const variantId = typeof raw.variantId === 'string' && /^[a-z0-9_-]{1,40}$/i.test(raw.variantId) ? raw.variantId : undefined
  return { enabled: true, ...(variantId ? { variantId } : {}) }
}

function sanitizeCaps(value: unknown): FragmentCapability[] {
  if (!Array.isArray(value)) return []
  return FRAGMENT_CAPABILITIES.filter((c) => value.includes(c))
}

async function writeManifestFile(manifest: FragmentManifest): Promise<void> {
  await fsp.mkdir(fragmentDir(manifest.id), { recursive: true })
  await fsp.writeFile(manifestFile(manifest.id), JSON.stringify(manifest, null, 2), 'utf8')
}

/**
 * Writes to the same fragment (manifest revision, data.json) are serialized: the agent
 * may write two files in the same step while the page saves to the store.
 */
const queues = new Map<string, Promise<unknown>>()
function serialized<T>(id: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(id) ?? Promise.resolve()
  const next = previous.then(task, task)
  const tail = next.catch(() => {})
  queues.set(id, tail)
  void tail.then(() => {
    if (queues.get(id) === tail) queues.delete(id)
  })
  return next
}

function emitUpdated(manifest: FragmentManifest): void {
  const event: FragmentUpdatedEvent = { fragmentId: manifest.id, revision: manifest.revision }
  fragmentEvents.emit('updated', event)
}

// ─── Fragments ───────────────────────────────────────────────────────────────

export async function getFragment(id: string): Promise<FragmentManifest | null> {
  if (!isFragmentId(id)) return null
  return readManifestFile(id)
}

export async function listFragments(): Promise<FragmentManifest[]> {
  let names: string[]
  try {
    names = await fsp.readdir(fragmentsRoot())
  } catch {
    return []
  }
  const all = await Promise.all(names.filter(isFragmentId).map((id) => readManifestFile(id)))
  return all.filter((m): m is FragmentManifest => m !== null).sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function createFragment(input: {
  name: string
  html: string
  kind?: FragmentKind
  icon?: string
  requests?: FragmentCapability[]
  sessionId?: string
}): Promise<FragmentManifest> {
  if (Buffer.byteLength(input.html, 'utf8') > MAX_FILE_BYTES) {
    throw new Error(`index.html too large (limit ${Math.round(MAX_FILE_BYTES / 1024)}KB)`)
  }
  const id = `frag-${slugify(input.name)}-${randomBytes(3).toString('hex')}`
  const now = Date.now()
  const kind = FRAGMENT_KINDS.find((k) => k === input.kind) ?? 'screen'
  const manifest: FragmentManifest = {
    id,
    name: input.name.trim().slice(0, 80) || 'Fragment',
    icon: sanitizeIcon(input.icon),
    kind,
    pinned: defaultPins(kind),
    sdk: 1,
    requests: sanitizeCaps(input.requests),
    grants: [],
    revision: 1,
    createdAt: now,
    updatedAt: now,
    sessionId: input.sessionId,
  }
  await fsp.mkdir(srcDir(id), { recursive: true })
  await fsp.writeFile(path.join(srcDir(id), ENTRY), input.html, 'utf8')
  await writeManifestFile(manifest)
  // Born here through the creation flow: the only way a fragment is recorded as local.
  await recordLocalProvenance(id)
  emitUpdated(manifest)
  return manifest
}

export async function removeFragment(id: string): Promise<boolean> {
  if (!isFragmentId(id)) return false
  const existed = (await readManifestFile(id)) !== null
  await fsp.rm(fragmentDir(id), { recursive: true, force: true })
  await removeProvenance(id)
  logs.delete(id)
  return existed
}

/**
 * What the person changes from the UI: name, where it is pinned, the model of
 * `orbit.ai`, which chat edits it. Never through the agent's tools. It does not bump
 * `revision` (the code did not change, so the page must not reload), but it does
 * announce the change so every open view re-reads the manifest.
 */
export async function updateFragmentMeta(id: string, patch: FragmentMetaPatch): Promise<FragmentManifest | null> {
  return serialized(id, async () => {
    const manifest = await readManifestFile(id)
    if (!manifest) return null
    const next: FragmentManifest = { ...manifest }
    if (typeof patch.name === 'string' && patch.name.trim()) next.name = patch.name.trim().slice(0, 80)
    if (typeof patch.icon === 'string') next.icon = sanitizeIcon(patch.icon)
    if (patch.pinned) {
      // Only the pins the patch names: a pin it leaves out keeps its value, not its kind's default.
      const named = Object.fromEntries(Object.entries(patch.pinned).filter(([, v]) => typeof v === 'boolean'))
      next.pinned = { ...manifest.pinned, ...sanitizePins({ ...manifest.pinned, ...named }, manifest.kind) }
    }
    if (patch.model === null) delete next.model
    else if (patch.model) next.model = sanitizeModel(patch.model) ?? manifest.model
    if (patch.reasoning === null) delete next.reasoning
    else if (patch.reasoning) {
      const reasoning = sanitizeReasoning(patch.reasoning)
      if (reasoning) next.reasoning = reasoning
      else delete next.reasoning
    }
    await writeManifestFile(next)
    emitUpdated(next)
    return next
  })
}

/**
 * The user (and only the user, through the UI) allows or revokes a capability the
 * fragment asked for. The agent's tools never call this.
 */
export async function setGrant(
  id: string,
  capability: FragmentCapability,
  on: boolean,
): Promise<FragmentManifest | null> {
  return serialized(id, async () => {
    const manifest = await readManifestFile(id)
    if (!manifest) return null
    if (on && !manifest.requests.includes(capability)) return manifest
    const grants = on
      ? [...new Set([...manifest.grants, capability])]
      : manifest.grants.filter((c) => c !== capability)
    const next = { ...manifest, grants }
    await writeManifestFile(next)
    return next
  })
}

/** The agent widens what the fragment asks for; the grant stays with the user. */
export async function requestCapabilities(id: string, requests: FragmentCapability[]): Promise<FragmentManifest | null> {
  return serialized(id, async () => {
    const manifest = await readManifestFile(id)
    if (!manifest) return null
    const next = { ...manifest, requests: sanitizeCaps(requests) }
    // Dropping a request also drops its grant: nothing stays allowed that was not asked.
    next.grants = next.grants.filter((c) => next.requests.includes(c))
    await writeManifestFile(next)
    return next
  })
}

/** Asks for (or stops asking for) ONE capability, leaving the others as they are. */
export async function setRequested(id: string, capability: FragmentCapability, on: boolean): Promise<FragmentManifest | null> {
  const manifest = await readManifestFile(id)
  if (!manifest) return null
  const rest = manifest.requests.filter((c) => c !== capability)
  return requestCapabilities(id, on ? [...rest, capability] : rest)
}

// ─── Files (src/) ────────────────────────────────────────────────────────────

export async function listFragmentFiles(id: string): Promise<string[]> {
  const base = srcDir(id)
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else out.push(path.relative(base, full).split(path.sep).join('/'))
      if (out.length >= 200) return
    }
  }
  await walk(base)
  return out.sort()
}

export async function readFragmentFile(id: string, rel: string): Promise<string | null> {
  try {
    return await fsp.readFile(resolveSrcPath(id, rel), 'utf8')
  } catch {
    return null
  }
}

/** Bytes for the scheme (an unknown or forbidden path is simply "not found"). */
export async function readFragmentAsset(id: string, rel: string): Promise<{ data: Buffer; ext: string } | null> {
  try {
    const full = resolveSrcPath(id, rel)
    return { data: await fsp.readFile(full), ext: path.extname(full).slice(1).toLowerCase() }
  } catch {
    return null
  }
}

export async function writeFragmentFile(id: string, rel: string, content: string): Promise<FragmentManifest> {
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
    throw new Error(`${rel} too large (limit ${Math.round(MAX_FILE_BYTES / 1024)}KB)`)
  }
  return serialized(id, async () => {
    const manifest = await readManifestFile(id)
    if (!manifest) throw new Error(`Fragment not found: ${id}`)
    const full = resolveSrcPath(id, rel)
    const exists = await fsp.stat(full).then(() => true).catch(() => false)
    if (!exists && (await listFragmentFiles(id)).length >= MAX_FILES) {
      throw new Error(`too many files (limit ${MAX_FILES})`)
    }
    await fsp.mkdir(path.dirname(full), { recursive: true })
    await fsp.writeFile(full, content, 'utf8')
    await noteProvenanceModified(id)
    const next = { ...manifest, revision: manifest.revision + 1, updatedAt: Date.now() }
    await writeManifestFile(next)
    emitUpdated(next)
    return next
  })
}

export async function deleteFragmentFile(id: string, rel: string): Promise<FragmentManifest> {
  if (rel.replace(/^\/+/, '') === ENTRY) throw new Error(`${ENTRY} is the entry and cannot be deleted`)
  return serialized(id, async () => {
    const manifest = await readManifestFile(id)
    if (!manifest) throw new Error(`Fragment not found: ${id}`)
    await fsp.rm(resolveSrcPath(id, rel), { force: true })
    await noteProvenanceModified(id)
    const next = { ...manifest, revision: manifest.revision + 1, updatedAt: Date.now() }
    await writeManifestFile(next)
    emitUpdated(next)
    return next
  })
}

// ─── Store (orbit.store) ─────────────────────────────────────────────────────

/** Everything `orbit.store` saved, parsed (read-only views use it; writes go through storeSet). */
export async function readFragmentData(id: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await fsp.readFile(dataFile(id), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export async function storeGet(id: string, key: string): Promise<unknown> {
  const data = await readFragmentData(id)
  return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null
}

export async function storeKeys(id: string): Promise<string[]> {
  return Object.keys(await readFragmentData(id)).sort()
}

export async function storeSet(id: string, key: string, value: unknown): Promise<void> {
  if (typeof key !== 'string' || !key || key.length > 200) throw new Error('store key must be a string of 1-200 characters')
  const encoded = JSON.stringify(value === undefined ? null : value)
  if (Buffer.byteLength(encoded, 'utf8') > MAX_STORE_VALUE_BYTES) {
    throw new Error(`value too large (limit ${Math.round(MAX_STORE_VALUE_BYTES / 1024)}KB per key)`)
  }
  await serialized(id, async () => {
    if (!(await readManifestFile(id))) throw new Error(`Fragment not found: ${id}`)
    const data = await readFragmentData(id)
    if (!Object.prototype.hasOwnProperty.call(data, key) && Object.keys(data).length >= MAX_STORE_KEYS) {
      throw new Error(`too many keys (limit ${MAX_STORE_KEYS})`)
    }
    data[key] = JSON.parse(encoded)
    const serializedData = JSON.stringify(data)
    if (Buffer.byteLength(serializedData, 'utf8') > MAX_STORE_TOTAL_BYTES) {
      throw new Error(`store full (limit ${Math.round(MAX_STORE_TOTAL_BYTES / 1024 / 1024)}MB)`)
    }
    await fsp.writeFile(dataFile(id), serializedData, 'utf8')
  })
}

export async function storeDelete(id: string, key: string): Promise<void> {
  await serialized(id, async () => {
    const data = await readFragmentData(id)
    if (!Object.prototype.hasOwnProperty.call(data, key)) return
    delete data[key]
    await fsp.writeFile(dataFile(id), JSON.stringify(data), 'utf8')
  })
}

// ─── Console of the page (fragment_logs) ─────────────────────────────────────

const logs = new Map<string, FragmentLogEntry[]>()

export function appendFragmentLog(id: string, entry: FragmentLogEntry): void {
  const list = logs.get(id) ?? []
  list.push({ ...entry, message: entry.message.slice(0, 2000) })
  if (list.length > LOG_CAPACITY) list.splice(0, list.length - LOG_CAPACITY)
  logs.set(id, list)
}

export function readFragmentLogs(id: string): FragmentLogEntry[] {
  return [...(logs.get(id) ?? [])]
}

export function clearFragmentLogs(id: string): void {
  logs.delete(id)
}
