import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import nodePath from 'node:path'
import { promisify } from 'node:util'

import type {
  FolderCreateRemoteRequest,
  FolderCreateRemoteResponse,
  FolderGitInfoResponse,
  FolderInitStatusResponse,
} from '@shared/companion'

/**
 * Project-folder helpers of the companion: what the phone's folder screen and project card ask
 * about a folder of the desktop. Kept free of Electron so it can be tested — the init status and
 * the GitHub call are injected by companion-server.
 *
 * The phone only names folders the desktop already shows it (sessions, recents, the directory
 * browser), but the path is still untrusted input: it must be absolute, free of NUL bytes and
 * an existing directory before any git command runs in it.
 */

const execFileAsync = promisify(execFile)

export class FolderRequestError extends Error {}

/** Normalizes the path or throws — absolute, no NUL, no relative segments left over. */
export function safeDirectory(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > 4096 || input.includes('\0')) {
    throw new FolderRequestError('Invalid folder')
  }
  if (!nodePath.isAbsolute(input)) throw new FolderRequestError('The folder must be an absolute path')
  return nodePath.resolve(input)
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, timeout: 15_000 })
    return stdout.trim()
  } catch {
    return null
  }
}

export async function folderGitInfo(rawDirectory: unknown): Promise<FolderGitInfoResponse> {
  const directory = safeDirectory(rawDirectory)
  if (!(await isDirectory(directory))) {
    return { directory, exists: false, isRepo: false, hasCommits: false, remoteUrl: null, branch: '' }
  }
  // A subfolder of a repo counts as a repo: git resolves the root by itself.
  const inside = await git(directory, ['rev-parse', '--is-inside-work-tree'])
  if (inside !== 'true') {
    return { directory, exists: true, isRepo: false, hasCommits: false, remoteUrl: null, branch: '' }
  }
  const [head, branch, remotes] = await Promise.all([
    git(directory, ['rev-parse', '--verify', 'HEAD']),
    git(directory, ['branch', '--show-current']),
    git(directory, ['remote']),
  ])
  const names = (remotes ?? '').split('\n').filter(Boolean)
  const remote = names.includes('origin') ? 'origin' : names[0]
  const remoteUrl = remote ? await git(directory, ['remote', 'get-url', remote]) : null
  return {
    directory,
    exists: true,
    isRepo: true,
    hasCommits: head !== null,
    remoteUrl: remoteUrl || null,
    branch: branch ?? '',
  }
}

export interface FolderDeps {
  initStatus: (directory: string) => Promise<FolderInitStatusResponse>
  createRemoteRepo: (directory: string, name: string, isPrivate: boolean) => Promise<unknown>
}

export async function folderInitStatus(rawDirectory: unknown, deps: FolderDeps): Promise<FolderInitStatusResponse> {
  const directory = safeDirectory(rawDirectory)
  if (!(await isDirectory(directory))) throw new FolderRequestError('The folder does not exist')
  return deps.initStatus(directory)
}

export async function folderCreateRemote(
  req: FolderCreateRemoteRequest,
  deps: FolderDeps,
): Promise<FolderCreateRemoteResponse> {
  const directory = safeDirectory(req.directory)
  if (typeof req.name !== 'string' || typeof req.isPrivate !== 'boolean') {
    throw new FolderRequestError('Invalid request')
  }
  const info = await folderGitInfo(directory)
  if (!info.exists) throw new FolderRequestError('The folder does not exist')
  if (!info.isRepo) throw new FolderRequestError('The folder is not a git repository')
  // Never overwrite a remote that is already configured.
  if (info.remoteUrl) throw new FolderRequestError('The repository already has a remote')

  const result = (await deps.createRemoteRepo(directory, req.name, req.isPrivate)) as
    | FolderCreateRemoteResponse
    | { ok: false; kind: 'noCredential'; hint: 'ghMissing' | 'ghOther'; detail?: unknown }
  // The raw credential output stays on the desktop: only the hint travels.
  if (!result.ok && result.kind === 'noCredential') {
    return { ok: false, kind: 'noCredential', hint: result.hint }
  }
  return result as FolderCreateRemoteResponse
}
