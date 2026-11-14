import type { FilePart, PermissionMode, SendMessageOptions } from '@shared/chat'
import type { SendMessageRequest } from '@shared/companion'
import { cleanDirectories } from './send-folders'

/**
 * What a desktop paired with full control may put in a `messages:send`, the way the phone
 * does: the model, the input modes, thinking, the permission mode, attachments and the
 * delegated-model configs. One function, used by the sender (to send no more than the
 * other machine accepts) and by the receiver (which does not trust the sender).
 *
 * Options that only this machine's own surfaces set never cross: `profile`, `computer`,
 * `overlay`, `voiceCall`, `planReview`, `orchestrate` and the retry/bookkeeping flags.
 */

const MAX_TEXT = 100_000
const MAX_FILES = 12
const MODES = new Set<PermissionMode>(['ask', 'approve', 'full'])

const clip = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined
const flag = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)

export function cleanSendOptions(raw: unknown): SendMessageOptions {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const reasoning = o.reasoning as { enabled?: unknown; variantId?: unknown } | undefined
  const out: SendMessageOptions = {}
  for (const key of ['research', 'browser', 'plan', 'simple', 'subagents', 'brain', 'brainContext', 'skillHints', 'loop'] as const) {
    const v = flag(o[key])
    if (v !== undefined) (out as Record<string, unknown>)[key] = v
  }
  if (reasoning && typeof reasoning.enabled === 'boolean') {
    out.reasoning = { enabled: reasoning.enabled, ...(clip(reasoning.variantId, 100) ? { variantId: clip(reasoning.variantId, 100) } : {}) }
  }
  if (typeof o.permissionMode === 'string' && MODES.has(o.permissionMode as PermissionMode)) {
    out.permissionMode = o.permissionMode as PermissionMode
  }
  if (Array.isArray(o.toolsServers)) out.toolsServers = o.toolsServers.filter((s): s is string => typeof s === 'string').slice(0, 100)
  return out
}

function cleanFiles(raw: unknown): FilePart[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const files = raw
    .filter((f): f is FilePart => !!f && typeof f === 'object' && typeof (f as FilePart).url === 'string' && (f as FilePart).url.startsWith('data:'))
    .slice(0, MAX_FILES)
    .map((f) => ({ ...f, url: f.url }))
  return files.length ? files : undefined
}

function cleanModelConfig<T>(raw: unknown): T | undefined {
  const m = raw as { providerId?: unknown; modelId?: unknown } | undefined
  return m && typeof m.providerId === 'string' && typeof m.modelId === 'string' ? (raw as T) : undefined
}

export function cleanControlSend(req: SendMessageRequest): SendMessageRequest | null {
  const sessionId = clip(req.sessionId, 200)
  const text = typeof req.text === 'string' ? req.text.slice(0, MAX_TEXT) : ''
  const files = cleanFiles(req.files)
  if (!sessionId || (!text.trim() && !files)) return null
  const providerId = clip(req.providerId, 200)
  const modelId = clip(req.modelId, 200)
  const loopMax = req.loopConfig?.maxIterations
  const workerModel = cleanModelConfig<SendMessageRequest['workerModel']>(req.workerModel)
  const visionModel = cleanModelConfig<SendMessageRequest['visionModel']>(req.visionModel)
  return {
    type: 'messages:send',
    sessionId,
    text,
    ...(providerId && modelId ? { providerId, modelId } : {}),
    options: cleanSendOptions(req.options),
    ...(files ? { files } : {}),
    ...(workerModel ? { workerModel } : {}),
    ...(visionModel ? { visionModel } : {}),
    ...(typeof loopMax === 'number' && loopMax > 0 && loopMax <= 50 ? { loopConfig: { maxIterations: Math.floor(loopMax) } } : {}),
    ...cleanDirectories(req),
  }
}
