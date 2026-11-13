import type { ArtifactKind } from '@shared/artifacts'
import path from 'node:path'
import { designIdForName, getDesign } from '../design/design-store'
import { getFragment } from '../fragments/fragment-store'
import { getMotion, motionIdForName } from '../video/motion-store'

/**
 * What the app has to know about a KIND of artifact — and nothing else. Everything generic
 * (which chats worked on it, the embedded chat, the sidebar rule, the chat card) reads this
 * table; adding a kind means adding one entry here and one profile (profiles/index.ts).
 */
export interface ArtifactKindDescriptor {
  kind: ArtifactKind
  /** Tools that create or change the artifact: a chat that runs one has worked on it. */
  tools: readonly string[]
  /** The artifact's id for one call of those tools (null = could not tell). */
  resolveId(call: { sessionId: string; args: unknown; result: unknown }): Promise<string | null>
  /** Its human name, or null when it no longer exists. */
  nameOf(id: string): Promise<string | null>
  /** The argument that carries the id in this kind's tools, to reach it from another chat. */
  idArgument: 'id' | 'fragmentId'
}

const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)
const field = (value: unknown, key: string): unknown =>
  value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined

/** Pieces that live in a chat's folder and are addressed by id or by name (motion, design). */
function byIdOrName(lookup: (sessionId: string, name: string) => Promise<string | null>) {
  return async ({ sessionId, args }: { sessionId: string; args: unknown }): Promise<string | null> => {
    const id = str(field(args, 'id'))
    if (id) return id
    const name = str(field(args, 'name'))
    return name ? lookup(sessionId, name) : null
  }
}

export const ARTIFACT_KIND_DESCRIPTORS: readonly ArtifactKindDescriptor[] = [
  {
    kind: 'fragment',
    tools: ['fragment_create', 'fragment_write_file', 'fragment_edit_file', 'fragment_delete_file', 'fragment_set_ai', 'fragment_set_models', 'fragment_set_notify'],
    // create returns the new id; the others take it as an argument.
    resolveId: async ({ args, result }) => str(field(args, 'fragmentId')) ?? str(field(result, 'fragmentId')),
    nameOf: async (id) => (await getFragment(id))?.name ?? null,
    idArgument: 'fragmentId',
  },
  {
    kind: 'motion',
    tools: ['motion_write', 'motion_edit', 'motion_asset'],
    resolveId: byIdOrName(motionIdForName),
    nameOf: async (id) => {
      const entry = await getMotion(id)
      return entry ? path.basename(entry.folder) : null
    },
    idArgument: 'id',
  },
  {
    kind: 'design',
    tools: ['design_write', 'design_edit', 'design_asset'],
    resolveId: byIdOrName(designIdForName),
    nameOf: async (id) => {
      const entry = await getDesign(id)
      return entry ? path.basename(entry.folder) : null
    },
    idArgument: 'id',
  },
]

export function descriptorOf(kind: ArtifactKind): ArtifactKindDescriptor {
  const found = ARTIFACT_KIND_DESCRIPTORS.find((d) => d.kind === kind)
  if (!found) throw new Error(`unknown artifact kind: ${kind}`)
  return found
}
