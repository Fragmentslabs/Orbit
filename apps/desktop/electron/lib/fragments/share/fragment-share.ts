import path from 'node:path'
import {
  FRAGMENT_PACKAGE_EXTENSION,
  FRAGMENT_PACKAGE_LIMITS,
  type FragmentImportConfirmResult,
  type FragmentImportPreviewResult,
} from '@shared/fragment-package'
import { createPendingStore } from '../../share/pending'
import { recordThirdPartyProvenance } from '../fragment-provenance'
import { createFragment, getFragment, listFragmentFiles, readFragmentAsset, slugify } from '../fragment-store'
import { packFragment, unpackFragment, type PackFile, type UnpackResult } from './package-codec'

/**
 * Sharing a fragment: the `.orbitfrag` export, and the two-step import (read and verify,
 * then write only after the person confirmed the consent card).
 *
 * What an import writes is decided here and nowhere else: the code and the requests, with
 * NOTHING granted, no pin anywhere, no saved data, and a provenance record of `third_party`
 * written before the fragment exists. Whatever the package says about itself is data.
 */

type Verified = Extract<UnpackResult, { ok: true }> & { fileName: string }

const pending = createPendingStore<Verified>()

/** The file name Orbit shows and records: the basename only, bounded, without control characters. */
export function safeFileName(name: unknown): string {
  const base = path.basename(String(name ?? '').replace(/\\/g, '/'))
  const clean = Array.from(base)
    .filter((ch) => ch.codePointAt(0)! >= 32 && ch.codePointAt(0) !== 127)
    .join('')
    .slice(0, 120)
  return clean || 'fragment' + FRAGMENT_PACKAGE_EXTENSION
}

/** The bytes of a `.orbitfrag` for one fragment: its code and what it asks for, nothing else. */
export async function buildFragmentArchive(id: string): Promise<{ bytes: Uint8Array; suggestedName: string } | null> {
  const manifest = await getFragment(id)
  if (!manifest) return null
  const files: PackFile[] = []
  for (const rel of await listFragmentFiles(id)) {
    const asset = await readFragmentAsset(id, rel)
    if (asset) files.push({ path: rel, data: asset.data })
  }
  if (!files.some((f) => f.path === 'index.html')) return null
  const bytes = packFragment({ name: manifest.name, kind: manifest.kind, icon: manifest.icon, requests: manifest.requests, files })
  return { bytes, suggestedName: `${slugify(manifest.name)}${FRAGMENT_PACKAGE_EXTENSION}` }
}

/** Step one: read, verify and hold the file. Writes nothing. */
export function previewFragmentImport(fileName: unknown, data: unknown): FragmentImportPreviewResult {
  if (!(data instanceof Uint8Array) && !(data instanceof ArrayBuffer)) return { ok: false, code: 'not_an_archive' }
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  if (bytes.byteLength > FRAGMENT_PACKAGE_LIMITS.archiveBytes) return { ok: false, code: 'too_large' }
  const result = unpackFragment(bytes)
  if (!result.ok) return result
  const name = safeFileName(fileName)
  const { manifest } = result
  const token = pending.put({ ...result, fileName: name })
  return {
    ok: true,
    preview: {
      token,
      fileName: name,
      sha256: result.sha256,
      archiveBytes: bytes.byteLength,
      name: manifest.name,
      kind: manifest.kind,
      icon: manifest.icon,
      requests: manifest.requests,
      author: manifest.author,
      description: manifest.description,
      files: result.files.map((f) => ({ path: f.path, bytes: f.data.byteLength })),
      totalBytes: result.totalBytes,
    },
  }
}

export function cancelFragmentImport(token: unknown): void {
  if (typeof token === 'string') pending.drop(token)
}

/** Step two: only after the person confirmed the card. */
export async function confirmFragmentImport(token: unknown): Promise<FragmentImportConfirmResult> {
  const held = typeof token === 'string' ? pending.take(token) : null
  if (!held) return { ok: false, code: 'expired' }
  const { manifest, files, fileName, sha256 } = held
  const entry = files.find((f) => f.path === 'index.html')
  if (!entry) return { ok: false, code: 'failed' }
  try {
    const created = await createFragment({
      name: manifest.name,
      html: Buffer.from(entry.data).toString('utf8'),
      kind: manifest.kind,
      icon: manifest.icon,
      requests: manifest.requests,
      files: files.filter((f) => f !== entry).map((f) => ({ path: f.path, data: Buffer.from(f.data) })),
      // Not on the sidebar, the panel hub or the home screen until the person chooses so.
      pinned: { sidebar: false, panel: false, home: false },
      recordProvenance: (id) => recordThirdPartyProvenance(id, { arrival: 'file', fileName, fileHash: sha256, author: manifest.author }),
    })
    return { ok: true, fragmentId: created.id }
  } catch {
    return { ok: false, code: 'failed' }
  }
}
