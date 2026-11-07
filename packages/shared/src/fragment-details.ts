import type { FragmentProvenance } from "./fragment-provenance"

/** One file of the fragment's `src/` and what it weighs. */
export interface FragmentFileWeight {
  path: string
  bytes: number
}

/** What the chats that worked on a fragment have spent (the page's own `orbit.ai` calls are not counted here). */
export interface FragmentTokenSpend {
  chats: number
  input: number
  output: number
  /** USD, when the catalog had prices. */
  cost: number
}

/** A third-party package a fragment uses (none until packages exist). */
export interface FragmentPackageInfo {
  name: string
  version: string
  bytes?: number
}

/** Everything the details panel shows that is not already in the manifest. */
export interface FragmentDetails {
  files: FragmentFileWeight[]
  /** Sum of `files`. */
  srcBytes: number
  /** Size of `data.json` (what `orbit.store` saved). */
  dataBytes: number
  /** The `orbit.store` keys, with the size of each value. */
  dataKeys: { key: string; bytes: number }[]
  tokens: FragmentTokenSpend
  packages: FragmentPackageInfo[]
  provenance: FragmentProvenance
}
