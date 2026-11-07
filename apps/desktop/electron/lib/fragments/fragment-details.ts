import fsp from 'node:fs/promises'
import path from 'node:path'
import type { ChatMessage } from '@shared/chat'
import { StorageKeys } from '@shared/chat'
import type { FragmentDataEntry, FragmentDetails, FragmentFileWeight, FragmentTokenSpend } from '@shared/fragment-details'
import { listArtifactChats } from '../artifacts/chat-registry'
import { readJson } from '../storage'
import { historyBytes } from './fragment-history'
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
  const [files, data, chatIds, provenance, history] = await Promise.all([
    fileWeights(id),
    readFragmentData(id),
    chatIdsOf(id, manifest.sessionId),
    getProvenance(id, manifest.createdAt),
    historyBytes(id),
  ])
  const histories = await Promise.all(chatIds.map(async (sid) => (await readJson<ChatMessage[]>(StorageKeys.messages(sid))) ?? []))
  const dataKeys = Object.keys(data)
    .sort()
    .map((key) => ({ key, bytes: Buffer.byteLength(JSON.stringify(data[key]) ?? 'null', 'utf8') }))
  return {
    files,
    srcBytes: files.reduce((sum, f) => sum + f.bytes, 0),
    dataBytes: dataKeys.reduce((sum, k) => sum + k.bytes, 0),
    historyBytes: history,
    dataKeys,
    tokens: sumSpend(histories),
    // Third-party packages arrive with the package format (docs/fragments.md, section 8).
    packages: [],
    provenance,
  }
}

/** Per entry, what the data view shows of a value: enough to read, never a data dump in the UI. */
const MAX_SHOWN_CHARS = 20_000

/** The fragment's stored data, for the read-only data view. Nothing here can change it. */
export async function getFragmentData(id: string): Promise<FragmentDataEntry[] | null> {
  if (!(await getFragment(id))) return null
  const data = await readFragmentData(id)
  return Object.keys(data)
    .sort()
    .map((key) => {
      const pretty = JSON.stringify(data[key], null, 2) ?? 'null'
      const truncated = pretty.length > MAX_SHOWN_CHARS
      return {
        key,
        bytes: Buffer.byteLength(JSON.stringify(data[key]) ?? 'null', 'utf8'),
        json: truncated ? pretty.slice(0, MAX_SHOWN_CHARS) : pretty,
        truncated,
      }
    })
}
