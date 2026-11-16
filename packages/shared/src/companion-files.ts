/**
 * Wire types of the companion file endpoints (`/api/files/*`): browse, read, search and
 * write the working folders of a session from the phone.
 *
 * Every path on the wire is RELATIVE to a root (the session's `directory` or one of its
 * `extraDirectories`) and uses `/`. The desktop never accepts an absolute path from the
 * phone: the root is validated against the session, the relative part against the root.
 */

/** Largest text file the phone reads or writes (same ceiling as the desktop panel). */
export const COMPANION_FILE_MAX_BYTES = 2 * 1024 * 1024

export interface FilesScope {
  sessionId: string
  /** One of the session's folders. Absent = the session's main `directory`. */
  root?: string
}

export interface FilesListRequest extends FilesScope {
  /** Directory relative to the root. Absent or '' = the root itself. */
  path?: string
}

export interface FileDirEntry {
  name: string
  /** Relative to the root, '/'-separated. */
  path: string
  isDirectory: boolean
  /** Bytes (files only). */
  size?: number
  mtimeMs?: number
}

export interface FilesListResponse {
  ok: true
  root: string
  /** Every folder of the session — what the phone offers as the root switcher. */
  roots: string[]
  path: string
  entries: FileDirEntry[]
}

export interface FilesReadRequest extends FilesScope {
  path: string
}

export type FileReadKind = 'text' | 'image' | 'binary' | 'too-large'

export interface FilesReadResponse {
  ok: true
  path: string
  kind: FileReadKind
  size: number
  mtimeMs: number
  /** `text` only. */
  content?: string
  /** Signed URL (`image` and `binary`): `<Image>`/WebView cannot send the Bearer header. */
  url?: string
  /** Content type guessed from the extension. */
  mime?: string
}

export interface FilesWriteRequest extends FilesScope {
  path: string
  content: string
  /** `mtimeMs` the file had when the phone opened it. A mismatch answers `stale`. */
  expectedMtimeMs?: number
}

export type FilesWriteFailure =
  | 'outside-root'
  | 'git-internal'
  | 'not-a-file'
  | 'too-large'
  | 'binary'
  | 'stale'
  | 'failed'

export type FilesWriteResponse =
  | { ok: true; mtimeMs: number; size: number }
  | {
      ok: false
      reason: FilesWriteFailure
      /** `stale`: what is on disk now, so the person can compare or take it. */
      content?: string
      mtimeMs?: number
      error?: string
    }

export interface FilesSearchRequest extends FilesScope {
  query: string
}

export interface FilesSearchResponse {
  ok: true
  hits: { path: string; name: string; dir: string }[]
  /** The index hit its ceiling: some files may be missing. */
  truncated: boolean
}

/** Error body of the file endpoints (HTTP status carries the class). */
export interface FilesErrorResponse {
  ok: false
  error: string
}
