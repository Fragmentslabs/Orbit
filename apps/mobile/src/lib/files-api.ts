import type { FilesWriteResponse } from '@orbit/shared'
import { useConnectionStore } from '~/stores/connection-store'

/** Unwraps an `HttpResult` into `data` or a thrown Error (the screens show `error.message`). */
export async function unwrap<T>(call: Promise<{ ok: boolean; data?: T; error?: string }>): Promise<T> {
  const res = await call
  if (!res.ok || res.data === undefined) throw new Error(res.error ?? 'request failed')
  return res.data
}

function http() {
  const client = useConnectionStore.getState().http
  if (!client) throw new Error('not connected')
  return client
}

export interface FileScope {
  sessionId: string
  root?: string
}

export const filesApi = {
  list: (scope: FileScope, path: string) => unwrap(http().listFiles({ ...scope, path })),
  read: (scope: FileScope, path: string) => unwrap(http().readFile({ ...scope, path })),
  search: (scope: FileScope, query: string) => unwrap(http().searchFiles({ ...scope, query })),
  write: (
    scope: FileScope,
    path: string,
    content: string,
    expectedMtimeMs?: number,
  ): Promise<FilesWriteResponse> => unwrap(http().writeFile({ ...scope, path, content, expectedMtimeMs })),
}
