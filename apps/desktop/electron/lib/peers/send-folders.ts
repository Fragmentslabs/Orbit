import path from 'node:path'
import type { SendMessageRequest } from '@shared/companion'

const clip = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined

/**
 * Working folders a desktop paired with full control may pick for a code chat, the way the phone
 * does. Only absolute paths, a handful of them, nothing else of the request.
 */
export function cleanDirectories(req: Pick<SendMessageRequest, 'directory' | 'extraDirectories'>): Pick<SendMessageRequest, 'directory' | 'extraDirectories'> {
  const directory = clip(req.directory, 1024)
  if (!directory || !path.isAbsolute(directory)) return {}
  const extra = (Array.isArray(req.extraDirectories) ? req.extraDirectories : [])
    .map((d) => clip(d, 1024))
    .filter((d): d is string => !!d && path.isAbsolute(d))
    .slice(0, 8)
  return { directory, ...(extra.length ? { extraDirectories: extra } : {}) }
}
