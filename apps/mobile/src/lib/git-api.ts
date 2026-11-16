import type { BranchesResponse, GitDiffResponse, GitStatusResponse } from '@orbit/shared'
import { useConnectionStore } from '~/stores/connection-store'

/** Thin typed calls over the companion socket for the Changes / Diff / Branch screens. */
async function call<T>(req: Record<string, unknown>, fallback: string): Promise<T> {
  const res = await useConnectionStore.getState().wsClient.send(req as never)
  if (!res.ok) throw new Error(res.error ?? fallback)
  return res.data as T
}

export const gitStatus = (directory: string) =>
  call<GitStatusResponse>({ type: 'git:status', directory }, 'Could not read the changes')

export const gitDiff = (directory: string, path?: string) =>
  call<GitDiffResponse>({ type: 'git:diff', directory, path }, 'Could not read the diff')

export const gitBranches = (directory: string) =>
  call<BranchesResponse>({ type: 'git:branches', directory }, 'Could not read the branches')

export const gitCheckout = (directory: string, branch: string) =>
  call<void>({ type: 'git:checkout', directory, branch }, 'Could not switch branch')

export const gitCreateBranch = (directory: string, branch: string) =>
  call<void>({ type: 'git:create-branch', directory, branch }, 'Could not create the branch')

/** Language hint for the highlighter: the extension of the path. */
export function languageOfPath(path: string): string | undefined {
  const name = path.split('/').pop() ?? path
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : undefined
}
