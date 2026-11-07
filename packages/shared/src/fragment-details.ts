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
  /** What the per-turn history keeps so the agent's writes can be undone. */
  historyBytes: number
  /** The `orbit.store` keys, with the size of each value. */
  dataKeys: { key: string; bytes: number }[]
  tokens: FragmentTokenSpend
  packages: FragmentPackageInfo[]
  provenance: FragmentProvenance
}

/** One `orbit.store` entry as the read-only data view shows it. */
export interface FragmentDataEntry {
  key: string
  bytes: number
  /** The value as pretty JSON, clipped to a size a dialog can show. */
  json: string
  truncated: boolean
}

/** What a revision did to its file. */
export type FragmentRevisionKind = "create" | "edit" | "delete"

/** One agent write to a fragment's files, as the history shows it (never its content). */
export interface FragmentRevisionInfo {
  /** The fragment's `revision` right after this write. Unique and increasing. */
  revision: number
  at: number
  /** All writes of one agent turn share it: that is the unit the person reverts. */
  turn: string
  sessionId?: string
  path: string
  kind: FragmentRevisionKind
}
