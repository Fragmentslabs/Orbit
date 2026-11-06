/**
 * Which machine an asset id belongs to.
 *
 * Messages of another desktop keep their `orbit-media://…`, `orbit-motion://…`
 * addresses (that machine does not rewrite them for a desktop). The renderer loads
 * them as usual; this machine's scheme handlers do not find the id on the local disk,
 * ask this index, and fetch the file from the right peer over the pinned TLS
 * connection (remote-assets.ts).
 *
 * Local always wins: a handler only falls back here when the id is NOT local, so a
 * peer naming one of this machine's ids cannot swap what a local chat shows.
 */

const SCHEME_ID_RE = /orbit-(?:media|artifact|audio|video|motion|design|slides):\/\/([A-Za-z0-9_.-]+)/g
const PIECE_ID_RE = /\b((?:mv|dsg|sld|vid|aud|art|doc)_[a-z0-9]+(?:\.[a-z0-9]+)?)\b/g
/** A document lives as `<base>.md` + `<base>.html` (+ pdf/docx/png): seeing one names them all. */
const DERIVED_EXT_RE = /^(.+)\.(html|md|pdf|docx|png)$/
const MAX_IDS = 50_000
const MAX_SCAN = 8 * 1024 * 1024

const owners = new Map<string, string>()

export function rememberRemoteId(id: string, peerId: string): void {
  if (!id || id.length > 200) return
  owners.delete(id)
  owners.set(id, peerId)
  const base = DERIVED_EXT_RE.exec(id)?.[1]
  if (base) owners.set(`base:${base}`, peerId)
  if (owners.size > MAX_IDS) {
    const oldest = owners.keys().next().value
    if (oldest) owners.delete(oldest)
  }
}

/** Scans anything that came from a peer (messages, parts, bundles) for asset ids. */
export function indexRemoteIds(peerId: string, value: unknown): void {
  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    return
  }
  if (!text || text.length > MAX_SCAN) return
  for (const m of text.matchAll(SCHEME_ID_RE)) rememberRemoteId(m[1], peerId)
  for (const m of text.matchAll(PIECE_ID_RE)) rememberRemoteId(m[1], peerId)
}

export function peerForAsset(id: string): string | undefined {
  const direct = owners.get(id)
  if (direct) return direct
  const base = DERIVED_EXT_RE.exec(id)?.[1]
  return base ? owners.get(`base:${base}`) : undefined
}

export function forgetPeerAssets(peerId: string): void {
  for (const [id, owner] of owners) if (owner === peerId) owners.delete(id)
}
