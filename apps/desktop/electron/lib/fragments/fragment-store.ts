import { app } from 'electron'
import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type {
  FragmentCapability,
  FragmentKind,
  FragmentMcpAccess,
  FragmentLogEntry,
  FragmentManifest,
  FragmentMetaPatch,
  FragmentPins,
  FragmentUpdatedEvent,
} from '@shared/fragments'
import { withAssetLock, writeFileAtomic } from '../asset-lock'
import {
  FRAGMENT_KINDS,
  hostsAreSubset,
  isFragmentId,
  mcpIsSubset,
  sanitizeFragmentHosts,
  sanitizeFragmentMcp,
} from '@shared/fragments'
import {
  FRAGMENT_ENTRY,
  FRAGMENT_MAX_FILES,
  FRAGMENT_MAX_FILE_BYTES,
  FRAGMENT_SERVED_TYPES,
  checkFragmentSrcPath,
  defaultFragmentPins,
  sanitizeFragmentCaps,
  sanitizeFragmentIcon,
  sanitizeFragmentModel,
  sanitizeFragmentPins,
  sanitizeFragmentReasoning,
} from '@shared/fragment-rules'
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

const ENTRY = FRAGMENT_ENTRY

/** Per-file cap. The page is written by a model: above this it is a data dump. */
export const MAX_FILE_BYTES = FRAGMENT_MAX_FILE_BYTES
const MAX_FILES = FRAGMENT_MAX_FILES
const MAX_STORE_KEYS = 500
const MAX_STORE_VALUE_BYTES = 256 * 1024
const MAX_STORE_TOTAL_BYTES = 2 * 1024 * 1024
const LOG_CAPACITY = 80

/** Extensions the scheme may serve — text the page loads, plus small static assets. */
export const SERVED_TYPES = FRAGMENT_SERVED_TYPES

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
function resolveSrcPath(id: string, rel: string): string {
  const checked = checkFragmentSrcPath(rel)
  if (!checked.ok) throw new Error(checked.reason)
  const parts = checked.parts
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
      icon: sanitizeFragmentIcon(parsed.icon),
      kind,
      pinned: sanitizeFragmentPins(parsed.pinned, kind),
      model: sanitizeFragmentModel(parsed.model),
      reasoning: sanitizeFragmentReasoning(parsed.reasoning),
      sdk: 1,
      requests: sanitizeFragmentCaps(parsed.requests),
      grants: sanitizeFragmentCaps(parsed.grants),
      hosts: sanitizeFragmentHosts(parsed.hosts),
      mcp: sanitizeFragmentMcp(parsed.mcp),
      revision: typeof parsed.revision === 'number' ? parsed.revision : 1,
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : 0,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined,
    }
  } catch {
    return null
  }
}

async function writeManifestFile(manifest: FragmentManifest): Promise<void> {
  await fsp.mkdir(fragmentDir(manifest.id), { recursive: true })
  await writeFileAtomic(manifestFile(manifest.id), JSON.stringify(manifest, null, 2))
}

/**
 * Writes to the same fragment (manifest revision, data.json) go through the shared asset
 * lock, like motion and design: the agent may write two files in the same step, a subchat
 * may edit what its parent is editing, and the page saves to the store meanwhile.
 */
function serialized<T>(id: string, task: () => Promise<T>): Promise<T> {
  return withAssetLock(`fragment:${id}`, task)
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
  /** Extra files of `src/` (an import). Already validated by the caller; written as they are. */
  files?: Array<{ path: string; data: Buffer }>
  /** Writes the provenance record. Default: local. An import passes its third-party record. */
  recordProvenance?: (id: string) => Promise<void>
  /** Pins the new fragment gets. Default: where its kind lives; an import passes none. */
  pinned?: FragmentPins
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
    icon: sanitizeFragmentIcon(input.icon),
    kind,
    pinned: input.pinned ?? defaultFragmentPins(kind),
    sdk: 1,
    requests: sanitizeFragmentCaps(input.requests),
    grants: [],
    hosts: [],
    mcp: [],
    revision: 1,
    createdAt: now,
    updatedAt: now,
    sessionId: input.sessionId,
  }
  await fsp.mkdir(srcDir(id), { recursive: true })
  await fsp.writeFile(path.join(srcDir(id), ENTRY), input.html, 'utf8')
  for (const file of input.files ?? []) {
    const full = resolveSrcPath(id, file.path)
    await fsp.mkdir(path.dirname(full), { recursive: true })
    await fsp.writeFile(full, file.data)
  }
  // The record goes down BEFORE the manifest: a fragment is listed only once its manifest
  // exists, so nothing ever sees an import without its origin (no record would read as
  // local). Born here through the creation flow = local, the default.
  await (input.recordProvenance ?? recordLocalProvenance)(id)
  await writeManifestFile(manifest)
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
    if (typeof patch.icon === 'string') next.icon = sanitizeFragmentIcon(patch.icon)
    if (patch.pinned) {
      // Only the pins the patch names: a pin it leaves out keeps its value, not its kind's default.
      const named = Object.fromEntries(Object.entries(patch.pinned).filter(([, v]) => typeof v === 'boolean'))
      next.pinned = { ...manifest.pinned, ...sanitizeFragmentPins({ ...manifest.pinned, ...named }, manifest.kind) }
    }
    if (patch.model === null) delete next.model
    else if (patch.model) next.model = sanitizeFragmentModel(patch.model) ?? manifest.model
    if (patch.reasoning === null) delete next.reasoning
    else if (patch.reasoning) {
      const reasoning = sanitizeFragmentReasoning(patch.reasoning)
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
    const next = { ...manifest, requests: sanitizeFragmentCaps(requests) }
    // Dropping a request also drops its grant: nothing stays allowed that was not asked.
    next.grants = next.grants.filter((c) => next.requests.includes(c))
    await writeManifestFile(next)
    return next
  })
}

/**
 * The agent declares which hosts `orbit.http` may reach. Declaring only asks: if the list
 * grows past what was there, a standing "http" grant is dropped so the person approves the
 * new list (narrowing keeps it). Returns null when the fragment does not exist.
 */
export function setFragmentHosts(id: string, hosts: unknown): Promise<FragmentManifest | null> {
  return serialized(id, async () => {
    const manifest = await readManifestFile(id)
    if (!manifest) return null
    const next = { ...manifest, hosts: sanitizeFragmentHosts(hosts) }
    if (!hostsAreSubset(next.hosts, manifest.hosts)) next.grants = next.grants.filter((c) => c !== 'http')
    await writeManifestFile(next)
    emitUpdated(next)
    return next
  })
}

/** Same for the MCP server/tool pairs `orbit.mcp` may call. */
export function setFragmentMcp(id: string, access: unknown): Promise<FragmentManifest | null> {
  return serialized(id, async () => {
    const manifest = await readManifestFile(id)
    if (!manifest) return null
    const mcp: FragmentMcpAccess[] = sanitizeFragmentMcp(access)
    const next = { ...manifest, mcp }
    if (!mcpIsSubset(mcp, manifest.mcp)) next.grants = next.grants.filter((c) => c !== 'mcp')
    await writeManifestFile(next)
    emitUpdated(next)
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

/** Must run inside the fragment's lock. */
async function writeFileLocked(id: string, rel: string, content: string): Promise<FragmentManifest> {
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
    throw new Error(`${rel} too large (limit ${Math.round(MAX_FILE_BYTES / 1024)}KB)`)
  }
  const manifest = await readManifestFile(id)
  if (!manifest) throw new Error(`Fragment not found: ${id}`)
  const full = resolveSrcPath(id, rel)
  const exists = await fsp.stat(full).then(() => true).catch(() => false)
  if (!exists && (await listFragmentFiles(id)).length >= MAX_FILES) {
    throw new Error(`too many files (limit ${MAX_FILES})`)
  }
  await writeFileAtomic(full, content)
  await noteProvenanceModified(id)
  const next = { ...manifest, revision: manifest.revision + 1, updatedAt: Date.now() }
  await writeManifestFile(next)
  emitUpdated(next)
  return next
}

export function writeFragmentFile(id: string, rel: string, content: string): Promise<FragmentManifest> {
  return serialized(id, () => writeFileLocked(id, rel, content))
}

/**
 * Read, transform and write one file under the same lock. An edit computed from a stale
 * read (another chat wrote in between) would silently overwrite that work, so the read
 * must happen here. `transform` throws to reject the edit; a missing file is `null`.
 */
export function editFragmentFile(
  id: string,
  rel: string,
  transform: (current: string | null) => string,
): Promise<FragmentManifest> {
  return serialized(id, async () => writeFileLocked(id, rel, transform(await readFragmentFile(id, rel))))
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
    await writeFileAtomic(dataFile(id), serializedData)
  })
}

export async function storeDelete(id: string, key: string): Promise<void> {
  await serialized(id, async () => {
    const data = await readFragmentData(id)
    if (!Object.prototype.hasOwnProperty.call(data, key)) return
    delete data[key]
    await writeFileAtomic(dataFile(id), JSON.stringify(data))
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
