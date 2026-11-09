import type { FragmentCapability, FragmentKind } from "./fragments"

/**
 * The `.orbitfrag` file: a zip with `manifest.json` and the fragment's code under `src/`.
 * Never the saved data (`data.json`), history, grants, chats, keys or the provenance record.
 * See docs/fragments.md, "Sharing".
 */

export const FRAGMENT_PACKAGE_FORMAT = "orbitfrag"
/** Bumped when a field changes meaning. An import of a higher version is refused, never guessed. */
export const FRAGMENT_PACKAGE_VERSION = 1
export const FRAGMENT_PACKAGE_EXTENSION = ".orbitfrag"

/** Extensions a package may carry: exactly what the fragment scheme serves. */
export const FRAGMENT_PACKAGE_TYPES: readonly string[] = ["html", "css", "js", "mjs", "json", "svg", "txt", "csv", "md"]

export const FRAGMENT_PACKAGE_LIMITS = {
  /** The whole .orbitfrag file. */
  archiveBytes: 5 * 1024 * 1024,
  /** One file (the same cap the store enforces on writes). */
  fileBytes: 1024 * 1024,
  /** All files together, uncompressed. */
  totalBytes: 5 * 1024 * 1024,
  files: 60,
  manifestBytes: 64 * 1024,
  name: 80,
  author: 80,
  description: 400,
} as const

/** What `manifest.json` says. The author and description are claims, shown as such and never trusted. */
export interface FragmentPackageManifest {
  format: typeof FRAGMENT_PACKAGE_FORMAT
  version: number
  name: string
  kind: FragmentKind
  icon: string
  /** What the fragment asks for. Importing grants nothing. */
  requests: FragmentCapability[]
  author?: string
  description?: string
  /** Every file of `src/` with its size and SHA-256, so a damaged or tampered archive is caught. */
  files: Array<{ path: string; bytes: number; sha256: string }>
}

export type FragmentImportErrorCode =
  | "too_large"
  | "not_an_archive"
  | "missing_manifest"
  | "bad_manifest"
  | "unsupported_version"
  | "forbidden_entry"
  | "bad_path"
  | "bad_file_type"
  | "file_too_large"
  | "too_many_files"
  | "size_mismatch"
  | "hash_mismatch"
  | "missing_entry"
  | "duplicate_path"

/** What the consent card shows before anything is written. */
export interface FragmentImportPreview {
  /** Hands the confirmation back to the main process, which holds the verified files. */
  token: string
  fileName: string
  sha256: string
  archiveBytes: number
  name: string
  kind: FragmentKind
  icon: string
  requests: FragmentCapability[]
  author?: string
  description?: string
  files: Array<{ path: string; bytes: number }>
  totalBytes: number
}

export type FragmentImportPreviewResult =
  | { ok: true; preview: FragmentImportPreview }
  | { ok: false; code: FragmentImportErrorCode }

export type FragmentImportConfirmResult =
  | { ok: true; fragmentId: string }
  | { ok: false; code: "expired" | "failed" }

export type FragmentExportResult = { ok: true; path: string } | { ok: false; canceled?: boolean }

export const FRAGMENT_SHARE_CHANNELS = {
  export: "fragment:export",
  importPreview: "fragment:import-preview",
  importConfirm: "fragment:import-confirm",
  importCancel: "fragment:import-cancel",
  markReviewed: "fragment:mark-reviewed",
} as const
