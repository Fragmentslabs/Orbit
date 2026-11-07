/**
 * Where a fragment came from. A record kept by Orbit OUTSIDE the fragment folder and
 * never exported: nothing inside a package can claim an origin, because whoever packs it
 * would choose what it says. See docs/fragments.md, "Provenance".
 */

/** `local` = created in this Orbit. `third_party` = anything that arrived from outside. */
export type FragmentOrigin = "local" | "third_party"

/** How a third-party fragment reached this Orbit. */
export type FragmentArrival = "mcp" | "link" | "repository" | "file"

export const FRAGMENT_ARRIVALS: readonly FragmentArrival[] = ["mcp", "link", "repository", "file"]

/** What Orbit stores. The owner is NOT here: it is derived from `sourceUrl` whenever it is shown. */
export type FragmentProvenanceRecord =
  | { origin: "local"; recordedAt: number }
  | {
      origin: "third_party"
      arrival: FragmentArrival
      /** The URL Orbit itself fetched it from; absent for a loose file. */
      sourceUrl?: string
      /** The pinned commit it was imported at, for "changed since origin". */
      commit?: string
      recordedAt: number
      /** Set when the fragment was edited after the import. Editing never makes it local. */
      modifiedAt?: number
    }

/** What the UI shows: the record plus the derived owner. */
export type FragmentProvenance = FragmentProvenanceRecord & {
  /** `fracta` for github.com/fracta/app; the host for other URLs; absent without a URL. */
  owner?: string
}

/**
 * The owner of a source URL, never typed by anyone:
 * `https://github.com/fracta/app` and `github:fracta/app` give `fracta`; another http(s) URL
 * gives its host; anything else (a loose file, junk) gives nothing.
 */
export function deriveOwner(sourceUrl: string | undefined): string | undefined {
  if (!sourceUrl) return undefined
  const shorthand = /^github:([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/[\w.-]+/.exec(sourceUrl.trim())
  if (shorthand) return shorthand[1]
  let url: URL
  try {
    url = new URL(sourceUrl.trim())
  } catch {
    return undefined
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined
  const host = url.hostname.toLowerCase().replace(/^www\./, "")
  if (host === "github.com" || host === "raw.githubusercontent.com") {
    const owner = url.pathname.split("/").filter(Boolean)[0]
    return owner && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner) ? owner : undefined
  }
  return host || undefined
}

/** The link to show as "main app": only a web URL, never a path or a script scheme. */
export function safeSourceLink(sourceUrl: string | undefined): string | undefined {
  if (!sourceUrl) return undefined
  try {
    const url = new URL(sourceUrl.trim())
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined
  } catch {
    return undefined
  }
}
