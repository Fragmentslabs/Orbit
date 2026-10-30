import { ipcMain } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRemoteRepo } from '../github-repo'
import { discoverWorkspaceRepos } from '../git-repos'

/**
 * Git core: log, working tree status, diffs, branches and the network
 * operations (pull/push/commit). `registerGitIpc()` wires the channels; the rest of
 * the file are the functions the handlers use.
 *
 * Channel contract (consumed by the renderer's git panel — DO NOT rename):
 *   invoke "git:repos"            root          -> { ok, repos } | { ok:false, error }
 *   invoke "git:log"              repoPath, skip -> { ok, commits, hasMore } | { ok:false, error }
 *   invoke "git:showFile"         repoPath, hash, relPath, deleted -> { content } | { error }
 *   invoke "git:status"           repoPath      -> { ok, entries } | { ok:false, error }
 *   invoke "git:workingNumstat"   repoPath      -> { ok, stats } | { ok:false, error }
 *   invoke "git:workingDiff"      repoPath      -> { ok, patch } | { ok:false, error }
 *   invoke "git:diffWorkingFile"  repoPath, relPath -> { ok, patch } | { ok:false, error }
 *   invoke "git:showCommitDiff"   repoPath, hash, relPath -> { ok, patch } | { ok:false, error }
 *   invoke "git:branches"         repoPath      -> { ok, branches, current } | { ok:false, error }
 *   invoke "git:checkout"         repoPath, branch -> { ok } | { ok:false, error }
 *   invoke "git:createBranch"     repoPath, branch -> { ok } | { ok:false, error }
 *   invoke "git:commitAll"        repoPath, message -> { ok } | { ok:false, error }
 *   invoke "git:branchInfo"       repoPath      -> { ok, info } | { ok:false, error }
 *   invoke "git:pull"             repoPath      -> { ok } | { ok:false, ...gitError }
 *   invoke "git:createRemoteRepo" repoPath, name, isPrivate (delegated to ../github-repo)
 *   invoke "git:push"             repoPath      -> { ok, created } | { ok:false, ...gitError }
 */

const execFileAsync = promisify(execFile)

interface CommitFileEntry {
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  path: string
}

/** Status of a file in the working tree (git status --porcelain). */
interface GitStatusEntry {
  /** Path relative to the repo ('/' separator). */
  path: string
  status: 'added' | 'modified' | 'deleted' | 'untracked' | 'renamed'
}

interface CommitEntry {
  hash: string
  author: string
  date: string
  message: string
  body: string
  files: CommitFileEntry[]
  /** Refs (local/remote branches and tags) that point exactly at this commit. */
  refs: string[]
  /** The commit is an ancestor of the default branch (main/master). */
  onDefault: boolean
  /** The commit is reachable from the current branch's upstream (it is already on the remote). */
  pushed: boolean
}

const STATUS_MAP: Record<string, CommitFileEntry['status']> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
}

const FIELD_SEP = '\x1f'
const RECORD_SEP = '\x1e'

/** Page size of the commit log (paging by --skip for the infinite scroll). */
const GIT_LOG_PAGE_SIZE = 30

async function getGitLog(
  repoPath: string,
  skip = 0,
): Promise<{ ok: true; commits: CommitEntry[]; hasMore: boolean } | { ok: false; error: string }> {
  try {
    const [{ stdout: metaOut }, { stdout: filesOut }] = await Promise.all([
      execFileAsync(
        'git',
        ['log', '-n', String(GIT_LOG_PAGE_SIZE), '--skip', String(skip), `--pretty=format:%H${FIELD_SEP}%an${FIELD_SEP}%aI${FIELD_SEP}%s${FIELD_SEP}%b${RECORD_SEP}`],
        { cwd: repoPath, maxBuffer: 10 * 1024 * 1024 },
      ),
      execFileAsync(
        'git',
        ['log', '-n', String(GIT_LOG_PAGE_SIZE), '--skip', String(skip), '--name-status', '--pretty=format:COMMIT|%H'],
        { cwd: repoPath, maxBuffer: 10 * 1024 * 1024 },
      ),
    ])

    const filesByHash = new Map<string, CommitFileEntry[]>()
    let currentHash: string | null = null
    for (const rawLine of filesOut.split('\n')) {
      const line = rawLine.trimEnd()
      if (!line) continue
      const commitMatch = line.match(/^COMMIT\|([0-9a-f]+)$/)
      if (commitMatch) {
        currentHash = commitMatch[1]
        filesByHash.set(currentHash, [])
        continue
      }
      const fileMatch = line.match(/^([AMDR])\d*\t(.+)$/)
      if (fileMatch && currentHash) {
        const parts = fileMatch[2].split('\t')
        filesByHash.get(currentHash)!.push({ status: STATUS_MAP[fileMatch[1]] ?? 'modified', path: parts[parts.length - 1] })
      }
    }

    // ── Branch context for badges/regions in the log ───────────────────
    // Map hash -> full refs (refs/heads, refs/remotes, refs/tags)
    const refsByHash = new Map<string, string[]>()
    try {
      const { stdout: refsOut } = await execFileAsync(
        'git',
        ['for-each-ref', '--format=%(refname)%1F%(objectname)%1F%(*objectname)', 'refs/heads', 'refs/remotes', 'refs/tags'],
        { cwd: repoPath, maxBuffer: 10 * 1024 * 1024 },
      )
      for (const line of refsOut.split('\n')) {
        const parts = line.split('\x1f')
        if (parts.length < 2 || !parts[0]) continue
        const ref = parts[0]
        // Annotated tags: %(objectname) is the tag object; %(*objectname) is the
        // target commit (peeled). For branches/remotes/lightweight tags the
        // peeled value comes out empty and we use objectname directly.
        const hash = (parts[2] || parts[1]).trim()
        if (!hash) continue
        const arr = refsByHash.get(hash) ?? []
        arr.push(ref)
        refsByHash.set(hash, arr)
      }
    } catch {
      // repo with no refs
    }

    let currentBranch: string | null = null
    try {
      const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd: repoPath })
      currentBranch = stdout.trim() || null
    } catch {
      // detached/error
    }

    // Default branch: origin/HEAD -> fallback to local main/master
    let defaultBranch: string | null = null
    try {
      const { stdout } = await execFileAsync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: repoPath })
      defaultBranch = stdout.trim().replace(/^origin\//, '') || null
    } catch {
      for (const candidate of ['main', 'master']) {
        try {
          await execFileAsync('git', ['rev-parse', '--verify', '--quiet', candidate], { cwd: repoPath })
          defaultBranch = candidate
          break
        } catch {
          // candidate does not exist
        }
      }
    }

    // Upstream of the current branch (e.g. origin/feature)
    let upstream: string | null = null
    if (currentBranch) {
      try {
        const { stdout } = await execFileAsync(
          'git',
          ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
          { cwd: repoPath },
        )
        upstream = stdout.trim() || null
      } catch {
        // no upstream yet
      }
    }

    // Sets of reachable hashes (it grows with skip to cover deep pages
    // of the log: a commit on the current page is at most
    // skip + GIT_LOG_PAGE_SIZE commits away from the branch tip).
    const pushedSet = new Set<string>()
    if (upstream) {
      try {
        const { stdout } = await execFileAsync('git', ['rev-list', '-n', String(60 + skip), upstream], { cwd: repoPath, maxBuffer: 10 * 1024 * 1024 })
        for (const h of stdout.split('\n')) pushedSet.add(h.trim())
      } catch {
        // invalid upstream
      }
    }
    const defaultSet = new Set<string>()
    if (defaultBranch) {
      try {
        const { stdout } = await execFileAsync('git', ['rev-list', '-n', String(60 + skip), defaultBranch], { cwd: repoPath, maxBuffer: 10 * 1024 * 1024 })
        for (const h of stdout.split('\n')) defaultSet.add(h.trim())
      } catch {
        // invalid default branch
      }
    }

    const commits: CommitEntry[] = metaOut
      .split(RECORD_SEP)
      .map(rec => rec.replace(/^\n+/, '').trim())
      .filter(Boolean)
      .map(rec => {
        const [hash, author, date, subject, body = ''] = rec.split(FIELD_SEP)
        return {
          hash,
          author,
          date,
          message: subject,
          body: body.trim(),
          files: filesByHash.get(hash) ?? [],
          refs: refsByHash.get(hash) ?? [],
          onDefault: defaultSet.has(hash),
          pushed: pushedSet.has(hash),
        }
      })

    return { ok: true, commits, hasMore: commits.length === GIT_LOG_PAGE_SIZE }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** Runs git with the terminal prompt disabled (fails fast instead of
 *  hanging while asking for credentials) and without opening the merge editor. */
function runGit(repoPath: string, args: string[], timeout = 120_000) {
  return execFileAsync('git', args, {
    cwd: repoPath,
    maxBuffer: 10 * 1024 * 1024,
    timeout,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' },
  })
}

function gitError(err: unknown): { message: string; kind: 'auth' | 'noUpstream' | 'noRemote' | 'other' } {
  const e = err as { message?: string; stderr?: string }
  const message = (e.stderr?.trim() || e.message || String(err)).replace(/\s+/g, ' ').trim()
  const lower = message.toLowerCase()
  if (/authentication failed|could not read username|could not read password|permission denied|publickey|401|403/.test(lower)) {
    return { message, kind: 'auth' }
  }
  if (/no tracking information|no upstream/i.test(lower)) {
    return { message, kind: 'noUpstream' }
  }
  return { message, kind: 'other' }
}

interface BranchSyncInfo {
  current: string | null
  defaultBranch: string | null
  ahead: number
  behind: number
  upstream: string | null
  hasRemote: boolean
  dirty: boolean
}

/** VS Code style indicator: current branch vs default branch (main/master),
 *  ahead/behind, upstream, dirty (uncommitted changes). */
async function getBranchInfo(repoPath: string): Promise<BranchSyncInfo> {
  const info: BranchSyncInfo = {
    current: null,
    defaultBranch: null,
    ahead: 0,
    behind: 0,
    upstream: null,
    hasRemote: false,
    dirty: false,
  }
  try {
    const [{ stdout: branchOut }, { stdout: remoteOut }, { stdout: statusOut }] = await Promise.all([
      runGit(repoPath, ['branch', '--show-current'], 15_000),
      runGit(repoPath, ['remote'], 15_000),
      runGit(repoPath, ['status', '--porcelain'], 15_000),
    ])
    info.current = branchOut.trim() || null
    info.hasRemote = remoteOut.trim().length > 0
    info.dirty = statusOut.trim().length > 0

    // Default branch: origin/HEAD (remote) -> fallback to local main/master
    try {
      const { stdout: headOut } = await runGit(
        repoPath,
        ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
        15_000,
      )
      info.defaultBranch = headOut.trim().replace(/^origin\//, '') || null
    } catch {
      for (const candidate of ['main', 'master']) {
        try {
          await runGit(repoPath, ['rev-parse', '--verify', '--quiet', candidate], 15_000)
          info.defaultBranch = candidate
          break
        } catch {
          // candidate does not exist
        }
      }
    }

    if (info.current) {
      try {
        const { stdout: upOut } = await runGit(
          repoPath,
          ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
          15_000,
        )
        info.upstream = upOut.trim() || null
      } catch {
        // no upstream
      }
      if (info.defaultBranch && info.defaultBranch !== info.current) {
        try {
          const { stdout } = await runGit(
            repoPath,
            ['rev-list', '--left-right', '--count', `${info.defaultBranch}...HEAD`],
            15_000,
          )
          const [left, right] = stdout.trim().split(/\s+/).map(Number)
          info.behind = left || 0
          info.ahead = right || 0
        } catch {
          // default branch with no local ref, or a repo with no commits
        }
      }
    }
  } catch {
    // invalid/inaccessible repo — return the bare minimum
  }
  return info
}

async function getFileAtCommit(
  repoPath: string,
  hash: string,
  relPath: string,
  deleted: boolean,
): Promise<{ content: string } | { error: string }> {
  try {
    const ref = deleted ? `${hash}^:${relPath}` : `${hash}:${relPath}`
    const { stdout } = await execFileAsync('git', ['show', ref], {
      cwd: repoPath,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf8',
    })
    return { content: stdout }
  } catch (err) {
    return { error: (err as Error).message }
  }
}

function classifyGitStatus(code: string): GitStatusEntry['status'] {
  if (code.startsWith('?')) return 'untracked'
  if (code.includes('D')) return 'deleted'
  if (code.includes('A')) return 'added'
  // M (modified) and T (type change) are treated as a modification
  return 'modified'
}

/** Lists the files changed in the working tree (`git status` style). */
async function getGitStatus(
  repoPath: string,
): Promise<{ ok: true; entries: GitStatusEntry[] } | { ok: false; error: string }> {
  try {
    const { stdout } = await runGit(repoPath, ['status', '--porcelain', '-z'], 15_000)
    const entries: GitStatusEntry[] = []
    const parts = stdout.split('\0')
    for (let i = 0; i < parts.length; i++) {
      const raw = parts[i]
      if (!raw) continue
      // "XY path" record — with -z the path is not escaped (path separated by \0).
      const code = raw.slice(0, 2)
      const path = raw.slice(3)
      // Rename/copy with -z: "R  new\0old\0" — -z REVERSES the order of the
      // readable format ("old -> new"), so the first field already is the
      // path that exists now; the next one is the old one, which left the disk.
      if ((code.startsWith('R') || code.startsWith('C')) && parts[i + 1]) {
        entries.push({
          path,
          status: code.startsWith('R') ? 'renamed' : 'added',
        })
        i++
        continue
      }
      entries.push({ path, status: classifyGitStatus(code) })
    }
    return { ok: true, entries }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/**
 * Lines added/removed per file, from the working tree against HEAD.
 *
 * Feeds the "+N -N" of the change list. Untracked files are left out: they do
 * not exist in any git tree, so there is nothing to compare them with — for
 * them the list shows only the status indicator.
 */
async function getWorkingNumstat(
  repoPath: string,
): Promise<
  | { ok: true; stats: Record<string, { added: number; deleted: number }> }
  | { ok: false; error: string }
> {
  try {
    // --no-renames: a rename becomes deleted + added, each side with a
    // single path. Without it git writes "dir/{old => new}", which does not
    // match the path that `git status` reports.
    const { stdout } = await runGit(
      repoPath,
      ['diff', 'HEAD', '--numstat', '--no-renames'],
      30_000,
    )
    const stats: Record<string, { added: number; deleted: number }> = {}
    for (const line of stdout.split('\n')) {
      if (!line) continue
      const [addedRaw, deletedRaw, ...pathParts] = line.split('\t')
      const path = pathParts.join('\t')
      if (!path) continue
      const added = Number(addedRaw)
      const deleted = Number(deletedRaw)
      // Binary: git writes "-" in both fields.
      if (!Number.isFinite(added) || !Number.isFinite(deleted)) continue
      stats[path] = { added, deleted }
    }

    // An untracked file does not show up in the diff against HEAD: git can only
    // count it by comparing against empty, and that is one command per file. The cap
    // exists because a tree with hundreds of new files would become hundreds
    // of processes just to draw a number.
    const { stdout: others } = await runGit(
      repoPath,
      ['ls-files', '--others', '--exclude-standard'],
      20_000,
    )
    const added = others.split('\n').filter(Boolean).slice(0, 40)
    await Promise.all(
      added.map(async (rel) => {
        const apply = (stdout: string) => {
          const [addedRaw, deletedRaw] = stdout.split('\t')
          const added = Number(addedRaw)
          const deleted = Number(deletedRaw)
          if (!Number.isFinite(added) || !Number.isFinite(deleted)) return
          stats[rel] = { added, deleted }
        }
        try {
          const { stdout } = await runGit(
            repoPath,
            ['diff', '--no-index', '--numstat', '--', '/dev/null', rel],
            15_000,
          )
          apply(stdout)
        } catch (err) {
          // `--no-index` exits with code 1 when there are differences — stdout
          // still carries the numstat.
          const e = err as { stdout?: string }
          if (e.stdout) apply(e.stdout)
        }
      }),
    )

    return { ok: true, stats }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/**
 * Full working tree patch: everything the change list shows, in a single
 * command. Untracked files come in afterwards, one by one — the diff against
 * HEAD does not see them, and without them the stacked view would end up with
 * holes that the list beside it announces.
 */
async function getWorkingDiff(
  repoPath: string,
): Promise<{ ok: true; patch: string } | { ok: false; error: string }> {
  try {
    const { stdout } = await runGit(repoPath, ['diff', 'HEAD'], 60_000)
    const { stdout: others } = await runGit(
      repoPath,
      ['ls-files', '--others', '--exclude-standard'],
      20_000,
    )
    const patches = await Promise.all(
      others
        .split('\n')
        .filter(Boolean)
        .map(async (rel) => {
          try {
            const { stdout: out } = await runGit(
              repoPath,
              ['diff', '--no-index', '--', '/dev/null', rel],
              20_000,
            )
            return out
          } catch (err) {
            // `--no-index` exits with code 1 when there are differences.
            const e = err as { stdout?: string }
            return e.stdout ?? ''
          }
        }),
    )
    return { ok: true, patch: [stdout, ...patches].filter(Boolean).join('\n') }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** Working tree diff against HEAD for one file (unified patch). */
async function getWorkingFileDiff(
  repoPath: string,
  relPath: string,
): Promise<{ ok: true; patch: string } | { ok: false; error: string }> {
  try {
    const isTracked = await runGit(repoPath, ['ls-files', '--error-unmatch', '--', relPath], 15_000)
      .then(() => true)
      .catch(() => false)
    if (isTracked) {
      const { stdout } = await runGit(repoPath, ['diff', 'HEAD', '--', relPath])
      return { ok: true, patch: stdout }
    }
    // Untracked (new) file: a diff against /dev/null shows it all as added.
    const { stdout } = await runGit(repoPath, ['diff', '--no-index', '--', '/dev/null', relPath])
    return { ok: true, patch: stdout }
  } catch (err) {
    // `git diff --no-index` exits with code 1 when there are differences — stdout
    // still carries the complete patch.
    const e = err as { stdout?: string; message?: string }
    if (e.stdout) return { ok: true, patch: e.stdout }
    return { ok: false, error: e.message ?? String(err) }
  }
}

/** Diff a commit introduced in one file (diff against its parent). */
async function getCommitFileDiff(
  repoPath: string,
  hash: string,
  relPath: string,
): Promise<{ ok: true; patch: string } | { ok: false; error: string }> {
  try {
    const { stdout } = await runGit(repoPath, ['show', hash, '--', relPath])
    return { ok: true, patch: stdout }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export function registerGitIpc(): void {
  // Which repositories live in these working folders: in each of them, the folder
  // itself when it is a repo plus the subfolders with their own git (front/back of a
  // space). The list covers ALL the chat folders — the main one and the attached
  // ones —, and the panel uses the list to pick who to talk to; with no list it talks to
  // the main folder.
  ipcMain.handle('git:repos', async (_event, root: string | string[]) => {
    try {
      const roots = Array.isArray(root) ? root : [root]
      return { ok: true as const, repos: await discoverWorkspaceRepos(roots) }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message }
    }
  })

  ipcMain.handle('git:log', async (_event, repoPath: string, skip?: number) => {
    return getGitLog(repoPath, skip ?? 0)
  })

  ipcMain.handle('git:showFile', async (_event, repoPath: string, hash: string, relPath: string, deleted: boolean) => {
    return getFileAtCommit(repoPath, hash, relPath, deleted)
  })

  ipcMain.handle('git:status', async (_event, repoPath: string) => {
    return getGitStatus(repoPath)
  })

  ipcMain.handle('git:workingNumstat', async (_event, repoPath: string) => {
    return getWorkingNumstat(repoPath)
  })

  ipcMain.handle('git:workingDiff', async (_event, repoPath: string) => {
    return getWorkingDiff(repoPath)
  })

  ipcMain.handle('git:diffWorkingFile', async (_event, repoPath: string, relPath: string) => {
    return getWorkingFileDiff(repoPath, relPath)
  })

  ipcMain.handle('git:showCommitDiff', async (_event, repoPath: string, hash: string, relPath: string) => {
    return getCommitFileDiff(repoPath, hash, relPath)
  })

  ipcMain.handle('git:branches', async (_event, repoPath: string) => {
    try {
      const [{ stdout: list }, { stdout: current }] = await Promise.all([
        execFileAsync('git', ['branch', '--list', '--format=%(refname:short)'], { cwd: repoPath }),
        execFileAsync('git', ['branch', '--show-current'], { cwd: repoPath }),
      ])
      const branches = list.trim().split('\n').filter(Boolean)
      return { ok: true as const, branches, current: current.trim() }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message }
    }
  })

  ipcMain.handle('git:checkout', async (_event, repoPath: string, branch: string) => {
    try {
      await execFileAsync('git', ['checkout', branch], { cwd: repoPath })
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message }
    }
  })

  ipcMain.handle('git:createBranch', async (_event, repoPath: string, branch: string) => {
    try {
      await execFileAsync('git', ['checkout', '-b', branch], { cwd: repoPath })
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message }
    }
  })

  ipcMain.handle('git:commitAll', async (_event, repoPath: string, message: string) => {
    try {
      await execFileAsync('git', ['add', '-A'], { cwd: repoPath })
      await execFileAsync('git', ['commit', '-m', message], { cwd: repoPath })
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message }
    }
  })

  ipcMain.handle('git:branchInfo', async (_event, repoPath: string) => {
    try {
      return { ok: true as const, info: await getBranchInfo(repoPath) }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message }
    }
  })

  ipcMain.handle('git:pull', async (_event, repoPath: string) => {
    try {
      await runGit(repoPath, ['pull', '--no-edit'])
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, ...gitError(err) }
    }
  })

  // Creates the repository on GitHub when the folder has no remote yet — the
  // token comes from the git credential helper or from `gh`, never from the user
  // (see github-repo.ts).
  ipcMain.handle('git:createRemoteRepo', (_event, repoPath: string, name: string, isPrivate: boolean) =>
    createRemoteRepo(repoPath, name, isPrivate))

  ipcMain.handle('git:push', async (_event, repoPath: string) => {
    try {
      const { stdout: branchOut } = await runGit(repoPath, ['branch', '--show-current'], 15_000)
      const branch = branchOut.trim()
      if (!branch) {
        return { ok: false as const, message: 'No current branch', kind: 'other' as const }
      }

      let upstream: string | null = null
      try {
        const { stdout: upOut } = await runGit(
          repoPath,
          ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
          15_000,
        )
        upstream = upOut.trim() || null
      } catch {
        // no upstream yet
      }

      if (upstream) {
        await runGit(repoPath, ['push'])
        return { ok: true as const, created: false }
      }

      const { stdout: remoteOut } = await runGit(repoPath, ['remote'], 15_000)
      if (!remoteOut.trim()) {
        return { ok: false as const, message: 'No remote configured', kind: 'noRemote' as const }
      }
      // No remote branch: create it via -u origin <branch> (authenticated by the
      // credentials already configured in git — token/SSH; never prompts in the terminal)
      await runGit(repoPath, ['push', '-u', 'origin', branch])
      return { ok: true as const, created: true }
    } catch (err) {
      return { ok: false as const, ...gitError(err) }
    }
  })
}
