import { app } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { FragmentArrival, FragmentProvenance, FragmentProvenanceRecord } from '@shared/fragment-provenance'
import { FRAGMENT_ARRIVALS, deriveOwner, isUntrusted } from '@shared/fragment-provenance'
import { isFragmentId } from '@shared/fragments'

/**
 * The provenance record of each fragment: `orbit-data/fragment-provenance/<id>.json`.
 *
 * It lives OUTSIDE `orbit-data/fragments/<id>/` on purpose. That folder is what gets
 * exported, and nothing inside a package may claim an origin for itself. Only Orbit's own
 * code writes here: the creation flow (`local`) and, once import exists, the import flow
 * (`third_party`, with the URL or file Orbit itself read). The agent's tools and the page have
 * no way to reach it.
 */

function recordFile(id: string): string {
  if (!isFragmentId(id)) throw new Error(`invalid fragment id: ${String(id).slice(0, 60)}`)
  return path.join(app.getPath('userData'), 'orbit-data', 'fragment-provenance', `${id}.json`)
}

async function writeRecord(id: string, record: FragmentProvenanceRecord): Promise<void> {
  const file = recordFile(id)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, JSON.stringify(record, null, 2), 'utf8')
}

async function readRecord(id: string): Promise<FragmentProvenanceRecord | null> {
  try {
    const raw = JSON.parse(await fsp.readFile(recordFile(id), 'utf8')) as Partial<FragmentProvenanceRecord> & Record<string, unknown>
    const recordedAt = typeof raw.recordedAt === 'number' ? raw.recordedAt : 0
    if (raw.origin === 'local') return { origin: 'local', recordedAt }
    if (raw.origin !== 'third_party') return null
    const arrival = FRAGMENT_ARRIVALS.find((a) => a === raw.arrival) ?? 'file'
    return {
      origin: 'third_party',
      arrival,
      sourceUrl: typeof raw.sourceUrl === 'string' ? raw.sourceUrl.slice(0, 2000) : undefined,
      commit: typeof raw.commit === 'string' && /^[0-9a-f]{7,64}$/i.test(raw.commit) ? raw.commit : undefined,
      recordedAt,
      modifiedAt: typeof raw.modifiedAt === 'number' ? raw.modifiedAt : undefined,
      fileName: typeof raw.fileName === 'string' ? raw.fileName.slice(0, 200) : undefined,
      fileHash: typeof raw.fileHash === 'string' && /^[0-9a-f]{64}$/i.test(raw.fileHash) ? raw.fileHash : undefined,
      author: typeof raw.author === 'string' ? raw.author.slice(0, 80) : undefined,
      reviewedAt: typeof raw.reviewedAt === 'number' ? raw.reviewedAt : undefined,
    }
  } catch {
    return null
  }
}

/** A fragment made in this Orbit through the creation flow. */
export async function recordLocalProvenance(id: string): Promise<void> {
  await writeRecord(id, { origin: 'local', recordedAt: Date.now() })
}

/**
 * Anything that arrived from outside. Called by the import flow with the URL ORBIT fetched
 * (never one read from the package), before the fragment is shown. Nothing imports itself
 * as local: this is the only door for the other origin.
 */
export async function recordThirdPartyProvenance(
  id: string,
  source: { arrival: FragmentArrival; sourceUrl?: string; commit?: string; fileName?: string; fileHash?: string; author?: string },
): Promise<void> {
  await writeRecord(id, {
    origin: 'third_party',
    arrival: source.arrival,
    sourceUrl: source.sourceUrl,
    commit: source.commit,
    fileName: source.fileName,
    fileHash: source.fileHash,
    author: source.author,
    recordedAt: Date.now(),
  })
}

/** The person looked at the code and what it asks for: from now on it may be granted things. */
export async function markReviewed(id: string): Promise<boolean> {
  const record = await readRecord(id)
  if (!record || record.origin !== 'third_party') return false
  if (record.reviewedAt === undefined) await writeRecord(id, { ...record, reviewedAt: Date.now() })
  return true
}

/** True for a third-party fragment nobody reviewed. Unknown or local fragments are not untrusted. */
export async function isFragmentUntrusted(id: string): Promise<boolean> {
  if (!isFragmentId(id)) return false
  const record = await readRecord(id)
  return record !== null && isUntrusted(record)
}

/**
 * A third-party fragment was edited: it stays third party, and the record notes it was
 * modified (with the original commit kept) so the UI can say "changed since origin".
 */
export async function noteProvenanceModified(id: string): Promise<void> {
  const record = await readRecord(id)
  if (!record || record.origin !== 'third_party' || record.modifiedAt) return
  await writeRecord(id, { ...record, modifiedAt: Date.now() })
}

export async function removeProvenance(id: string): Promise<void> {
  await fsp.rm(recordFile(id), { force: true })
}

/**
 * What the UI shows. A fragment with no record predates the record, and every fragment
 * before import existed was created here — so the absence reads as local. Import must write
 * its record BEFORE the fragment appears, so this fallback can never mislabel an import.
 */
export async function getProvenance(id: string, createdAt: number): Promise<FragmentProvenance> {
  if (!isFragmentId(id)) return { origin: 'local', recordedAt: createdAt }
  const record = (await readRecord(id)) ?? { origin: 'local' as const, recordedAt: createdAt }
  return record.origin === 'third_party' ? { ...record, owner: deriveOwner(record.sourceUrl) } : record
}
