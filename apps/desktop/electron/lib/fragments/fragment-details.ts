import fsp from 'node:fs/promises'
import path from 'node:path'
import type { ChatMessage } from '@shared/chat'
import { StorageKeys } from '@shared/chat'
import type { FragmentDetails, FragmentFileWeight, FragmentTokenSpend } from '@shared/fragment-details'
import { listArtifactChats } from '../artifacts/chat-registry'
import { readJson } from '../storage'
import { getProvenance } from './fragment-provenance'
import { getFragment, listFragmentFiles, readFragmentData, srcDir } from './fragment-store'

/**
 * What the details panel shows beyond the manifest: weight on disk, the keys of the local
 * database, what the fragment's chats spent, packages and the provenance. Read-only — the
 * panel changes nothing here.
 */

/** Tokens and cost of the assistant messages of some chats. Pure so it can be tested alone. */
export function sumSpend(histories: ChatMessage[][]): FragmentTokenSpend {
  const spend: FragmentTokenSpend = { chats: histories.length, input: 0, output: 0, cost: 0 }
  for (const history of histories) {
    for (const message of history) {
      if (message.role !== 'assistant' || !message.tokens) continue
      spend.input += message.tokens.input ?? 0
      spend.output += message.tokens.output ?? 0
      spend.cost += message.tokens.cost ?? 0
    }
  }
  return spend
}

async function fileWeights(id: string): Promise<FragmentFileWeight[]> {
  const base = srcDir(id)
  const files = await listFragmentFiles(id)
  return Promise.all(
    files.map(async (rel) => ({
      path: rel,
      bytes: await fsp.stat(path.join(base, ...rel.split('/'))).then((s) => s.size, () => 0),
    })),
  )
}

/** The chats that worked on the fragment: the registry's list plus the one it was born in. */
async function chatIdsOf(id: string, bornIn?: string): Promise<string[]> {
  const { sessionIds } = await listArtifactChats({ kind: 'fragment', id })
  return [...new Set([...(bornIn ? [bornIn] : []), ...sessionIds])]
}

export async function getFragmentDetails(id: string): Promise<FragmentDetails | null> {
  const manifest = await getFragment(id)
  if (!manifest) return null
  const [files, data, chatIds, provenance] = await Promise.all([
    fileWeights(id),
    readFragmentData(id),
    chatIdsOf(id, manifest.sessionId),
    getProvenance(id, manifest.createdAt),
  ])
  const histories = await Promise.all(chatIds.map(async (sid) => (await readJson<ChatMessage[]>(StorageKeys.messages(sid))) ?? []))
  const dataKeys = Object.keys(data)
    .sort()
    .map((key) => ({ key, bytes: Buffer.byteLength(JSON.stringify(data[key]) ?? 'null', 'utf8') }))
  return {
    files,
    srcBytes: files.reduce((sum, f) => sum + f.bytes, 0),
    dataBytes: dataKeys.reduce((sum, k) => sum + k.bytes, 0),
    dataKeys,
    tokens: sumSpend(histories),
    // Third-party packages arrive with the package format (docs/fragments.md, section 8).
    packages: [],
    provenance,
  }
}
