import path from 'node:path'
import type { SendMessageRequest } from '@shared/companion'
import { StorageKeys, type SessionInfo } from '@shared/chat'
import type { RemotePieceKind, RemotePieceRef, RemotePieceResolved } from '@shared/peers'
import { readJson } from '../storage'
import { getMotion, motionIdForName, motionIdForPath } from '../video/motion-store'
import { listMotionBundles } from '../video/motion-files'
import { readPropsFile } from '../video/motion-props'
import { designIdForName, designIdForPath, getDesign, readDesignBoard } from '../design/design-store'
import { getSlides, slidesIdForName, slidesIdForPath } from '../slides/slides-store'
import { documentInfo, readArtifact, readDocumentSource } from '../media'
import { getSessionModelsCache } from '../companion-http'
import { listDirectory, readProjectFile } from './fs-access'

/**
 * The requests only a desktop peer makes (the allowlist in permissions.ts already
 * ran). They mirror the renderer IPCs the panel tabs use — `motion:open`,
 * `motion:props`, `design:readBoard`, … — so the other machine's main can answer
 * its own tabs as if the piece were local.
 *
 * Everything here is read-only. Ids and refs go through the same registries as
 * the local IPCs, so only pieces that this machine registered can be reached.
 */

type Req = { type: string; [key: string]: unknown }

const str = (v: unknown, max = 4096): string | undefined =>
  typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined

function cleanRef(raw: unknown): RemotePieceRef {
  const r = (raw ?? {}) as Record<string, unknown>
  return { id: str(r.id, 200), path: str(r.path), sessionId: str(r.sessionId, 200), name: str(r.name, 500) }
}

async function resolvePiece(kind: RemotePieceKind, ref: RemotePieceRef): Promise<RemotePieceResolved | null> {
  if (kind === 'motion') {
    let id = ref.id ?? null
    if (!id && ref.path) id = await motionIdForPath(ref.path)
    if (!id && ref.sessionId && ref.name) id = await motionIdForName(ref.sessionId, ref.name)
    const entry = id ? await getMotion(id) : undefined
    if (!id || !entry) return null
    return { id, entry: path.relative(entry.folder, entry.entry).split(path.sep).join('/'), title: path.basename(entry.folder) }
  }
  if (kind === 'design') {
    let id = ref.id ?? null
    if (!id && ref.path) id = await designIdForPath(ref.path)
    if (!id && ref.sessionId && ref.name) id = await designIdForName(ref.sessionId, ref.name)
    const entry = id ? await getDesign(id) : undefined
    if (!id || !entry) return null
    return { id, title: path.basename(entry.folder) }
  }
  let id = ref.id ?? null
  if (!id && ref.path) id = await slidesIdForPath(ref.path)
  if (!id && ref.sessionId && ref.name) id = await slidesIdForName(ref.sessionId, ref.name)
  const entry = id ? await getSlides(id) : undefined
  if (!id || !entry) return null
  return { id, entry: path.relative(entry.folder, entry.entry).split(path.sep).join('/'), title: path.basename(entry.folder) }
}

/** The project folders of the session, from THIS machine's record — never from the request. */
async function sessionRoots(sessionId: unknown): Promise<string[]> {
  const id = str(sessionId, 200)
  if (!id) throw new Error('not_found')
  const session = await readJson<SessionInfo>(StorageKeys.session(id))
  if (!session) throw new Error('not_found')
  return [session.directory, ...(session.extraDirectories ?? [])].filter((d): d is string => typeof d === 'string' && d.length > 0)
}

export async function handleDesktopOnlyRequest(req: Req): Promise<unknown> {
  switch (req.type) {
    case 'piece:resolve': {
      const kind = req.kind === 'motion' || req.kind === 'design' || req.kind === 'slides' ? req.kind : null
      if (!kind) throw new Error('invalid')
      return resolvePiece(kind, cleanRef(req.ref))
    }
    case 'piece:props': {
      const id = str(req.id, 200)
      const entry = id ? await getMotion(id) : undefined
      return entry ? readPropsFile(entry.folder) : { exists: false, schema: {}, errors: [] }
    }
    case 'piece:bundles': {
      const id = str(req.sessionId, 200)
      return id ? listMotionBundles(id) : []
    }
    case 'design:board': {
      const id = str(req.id, 200)
      const file = str(req.file, 500)
      if (!id || !file) throw new Error('invalid')
      return readDesignBoard(id, file)
    }
    case 'artifact:read': {
      const id = str(req.id, 200)
      const artifact = id ? await readArtifact(id) : null
      return artifact ? artifact.html : null
    }
    case 'document:source': {
      const id = str(req.id, 200)
      const found = id ? await readDocumentSource(id) : null
      return found ? { markdown: found.markdown, revision: found.entry.revision ?? 1 } : null
    }
    case 'document:info': {
      const id = str(req.id, 200)
      return id ? documentInfo(id) : null
    }
    case 'fs:tree': {
      const roots = await sessionRoots(req.sessionId)
      if (!roots.length) return { roots: [], root: 0, path: '', entries: [] }
      return listDirectory(roots, req.root, req.path)
    }
    case 'fs:read': {
      const roots = await sessionRoots(req.sessionId)
      return readProjectFile(roots, req.root, req.path)
    }
    default:
      throw new Error('unknown_request')
  }
}

const MAX_TEXT = 100_000

/**
 * A message from another desktop keeps only the text. Folders, permission mode,
 * models, loop, orchestration and attachments are this machine's decisions: the
 * turn runs with the model the chat already uses here and under this machine's
 * own permission mode.
 */
export async function sanitizeDesktopSend(req: SendMessageRequest): Promise<SendMessageRequest | null> {
  const sessionId = str(req.sessionId, 200)
  const text = typeof req.text === 'string' ? req.text.slice(0, MAX_TEXT) : ''
  if (!sessionId || !text.trim()) return null
  const model =
    getSessionModelsCache()[sessionId] ??
    (await readJson<{ providerId: string; modelId: string }>(StorageKeys.selectedModel)) ??
    undefined
  return {
    type: 'messages:send',
    sessionId,
    text,
    ...(model ? { providerId: model.providerId, modelId: model.modelId } : {}),
  }
}
