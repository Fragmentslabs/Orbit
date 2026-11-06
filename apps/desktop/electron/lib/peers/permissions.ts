import type { PeerGrants } from '@shared/peers'

/**
 * What a paired DESKTOP may ask of this machine.
 *
 * The phone keeps the full companion API (it is the owner's own device, paired by
 * scanning a QR on this screen). A desktop is someone else's machine on the same
 * network, so it gets an allowlist: anything not listed here is refused, and a new
 * request type added to the companion protocol is refused for desktops until
 * someone decides, here, that it is safe.
 *
 * Deliberately out, whatever the grants: approving permission prompts, plans or
 * orchestrations (`ask:reply`, `plan:review-*`, `orchestration:*`) — the person at
 * this machine decides what the agent may do on it —, git, memory, settings,
 * models, folders, routines, pipelines, deleting/moving/reverting chats and
 * listing arbitrary directories.
 */

/** Always allowed once paired: read the chats and the pieces in them. */
const VIEW = new Set<string>([
  'ping',
  'status:get',
  'sessions:list',
  'sessions:running',
  'session:state',
  'messages:get',
  'piece:resolve',
  'piece:props',
  'piece:bundles',
  'design:board',
  'artifact:read',
  'document:source',
  'document:info',
])

/** With the "send messages" grant. */
const SEND = new Set<string>(['messages:send', 'chat:abort'])

/** With the "see files" grant: only inside the chat's own project folders. */
const FILES = new Set<string>(['fs:tree', 'fs:read'])

export type DesktopRequestClass = 'view' | 'send' | 'files' | 'denied'

export function classifyDesktopRequest(type: string): DesktopRequestClass {
  if (VIEW.has(type)) return 'view'
  if (SEND.has(type)) return 'send'
  if (FILES.has(type)) return 'files'
  return 'denied'
}

export function desktopMayRequest(type: string, grants: PeerGrants): boolean {
  switch (classifyDesktopRequest(type)) {
    case 'view':
      return true
    case 'send':
      return grants.send
    case 'files':
      return grants.files
    default:
      return false
  }
}

/** Requests that only exist for desktops: the phone path must not see them. */
export function isDesktopOnlyRequest(type: string): boolean {
  return (
    type === 'piece:resolve' ||
    type === 'piece:props' ||
    type === 'piece:bundles' ||
    type === 'design:board' ||
    type === 'artifact:read' ||
    type === 'document:source' ||
    type === 'document:info' ||
    FILES.has(type)
  )
}
