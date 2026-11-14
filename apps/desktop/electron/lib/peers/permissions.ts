import type { PeerGrants } from '@shared/peers'
import { isToolsRequestType } from '@shared/tools-remote'

/**
 * What a paired DESKTOP may ask of this machine.
 *
 * The phone keeps the full companion API (it is the owner's own device, paired by
 * scanning a QR on this screen). A desktop connected to another Orbit is the same
 * kind of client: the data lives on the machine that owns it, and the other one
 * controls it — that is what "access another Orbit" means (docs/remote-desktop-control.md).
 *
 * So the default is full control: every companion request, exactly like the phone,
 * including creating/renaming/archiving/deleting chats, folders, memory, routines,
 * the pipeline, plan review and the agent's questions.
 *
 * The Tools screen (`mcp:*`, `skills:*`, `hooks:*`, see tools-remote.ts) is `control` and
 * desktop-only: it edits what the agent can run on this machine, and has no phone UI.
 *
 * Two things stay outside the full-control grant:
 * - the project files (`fs:*`), which keep their own opt-in grant;
 * - nothing else — a peer paired without `control` keeps the old read-only
 *   behavior (chats, messages, pieces) so an older pairing does not silently gain
 *   powers it never asked for.
 */

/** Reading the chats and the pieces in them: always allowed once paired. */
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

/** Sending a message / stopping a turn: part of control, or its own grant. */
const SEND = new Set<string>(['messages:send', 'chat:abort'])

/** With the "see files" grant: only inside the chat's own project folders. */
const FILES = new Set<string>(['fs:tree', 'fs:read'])

export type DesktopRequestClass = 'view' | 'send' | 'files' | 'control'

export function classifyDesktopRequest(type: string): DesktopRequestClass {
  if (VIEW.has(type)) return 'view'
  if (SEND.has(type)) return 'send'
  if (FILES.has(type)) return 'files'
  return 'control'
}

export function desktopMayRequest(type: string, grants: PeerGrants): boolean {
  switch (classifyDesktopRequest(type)) {
    case 'view':
      return true
    case 'send':
      return grants.control || grants.send
    case 'files':
      return grants.files
    case 'control':
      return grants.control
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
    isToolsRequestType(type) ||
    FILES.has(type)
  )
}
