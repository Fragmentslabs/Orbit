import { execFile, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import { accessSync, constants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import { perfSpan } from '../perf'

/**
 * Filesystem snapshot engine per message (opencode style): an auxiliary git
 * repository per project in userData/snapshots/<hash>, using
 * --git-dir + --work-tree to version the project folder without touching its
 * own .git. Snapshots are tree hashes (write-tree) — no commits, no refs.
 */

const execFileAsync = promisify(execFile)
const MAX_BUFFER = 50 * 1024 * 1024

/**
 * B3 — Resolution of the git binary at module load.
 *
 * When the app is opened from Finder/dock or from the Start menu, and not from the
 * terminal, the process PATH may not have the git directory, and execFile
 * fails with ENOENT. The resolution looks for git in the PATH, then in the places
 * where the installers leave it, and finally hands over `git` with the PATH widened.
 *
 * This was born for macOS only, and on Windows the snapshot broke ALWAYS: the PATH
 * was joined with ":" (there it is ";"), the file looked for was "git" (there it is
 * "git.exe") and, since the Windows variable is called "Path", the code created
 * a SECOND "PATH" key with only macOS directories — git ran in a PATH
 * where it does not exist, and every code-mode turn lost the snapshot, the revert
 * per message and the check of changes. Now the separator, the file
 * name and the variable key come from the platform.
 */
const KNOWN_GIT_PATHS: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: ['/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git'],
  linux: ['/usr/bin/git', '/usr/local/bin/git'],
  win32: [
    'C:\\Program Files\\Git\\cmd\\git.exe',
    'C:\\Program Files\\Git\\bin\\git.exe',
    'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
  ],
}
/** Directories added to the inherited PATH — only where the minimal PATH is a risk. */
const EXTRA_PATH: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/opt/homebrew/bin', '/usr/local/bin'],
  linux: ['/usr/bin', '/bin', '/usr/local/bin'],
}

export function resolveGitBinary(
  platform: NodeJS.Platform,
  // An arbitrary environment, and not the ProcessEnv of this app: the global type declares
  // the Orbit variables as required, and a child process environment
  // has no reason to have any of them.
  baseEnv: Record<string, string | undefined>,
  isExecutable: (file: string) => boolean,
): { binary: string; env: NodeJS.ProcessEnv } {
  const paths = platform === 'win32' ? path.win32 : path.posix
  const env = { ...baseEnv } as NodeJS.ProcessEnv

  // The key as it CAME: "Path" on Windows. Writing to "PATH" would create a
  // second variable, and which of the two the child process sees is not a decision
  // of ours.
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
  const inherited = (env[pathKey] ?? '').split(paths.delimiter).filter(Boolean)
  const extra = (EXTRA_PATH[platform] ?? []).filter((dir) => !inherited.includes(dir))
  const searchPath = [...inherited, ...extra]
  env[pathKey] = searchPath.join(paths.delimiter)

  // 1. The PATH, in order (what the user configured takes precedence)
  const names = platform === 'win32' ? ['git.exe', 'git.cmd'] : ['git']
  for (const dir of searchPath) {
    for (const name of names) {
      const candidate = paths.join(dir, name)
      if (isExecutable(candidate)) return { binary: candidate, env }
    }
  }

  // 2. Where the installers usually leave git
  const localPrograms =
    platform === 'win32' && env.LOCALAPPDATA
      ? [paths.join(env.LOCALAPPDATA, 'Programs', 'Git', 'cmd', 'git.exe')]
      : []
  for (const candidate of [...(KNOWN_GIT_PATHS[platform] ?? []), ...localPrograms]) {
    if (isExecutable(candidate)) return { binary: candidate, env }
  }

  // 3. Let the extended PATH decide
  return { binary: 'git', env }
}

function canExecute(file: string): boolean {
  try {
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** git binary and PATH resolved at load — exported for external tools
 * (e.g. verify_changes) that need to invoke git with the same
 * resolution (B3: Finder/minimal PATH) without duplicating it. */
export const gitBinary = resolveGitBinary(process.platform, process.env, canExecute)

/** Default excludes beyond the project's .gitignore (projects without .gitignore) */
/**
 * `.orbit/`: Orbit worktrees in "inside the project" mode. The auxiliary repository
 * does not read the project's .git/info/exclude — without this every snapshot
 * would carry whole copies of the repository, and undoing a turn would delete a
 * worktree created after it.
 */
const DEFAULT_EXCLUDES = ['node_modules/', '.git/', '.orbit/', 'dist/', 'dist-electron/', 'build/', 'out/', '.next/', 'target/']
/** Auxiliary repositories whose exclude was already checked in this run. */
const excludesChecked = new Set<string>()

const GC_INTERVAL = 60 * 60 * 1000 // 1h
const lastGc = new Map<string, number>()

function gitDirFor(directory: string): string {
  const hash = crypto.createHash('sha1').update(path.resolve(directory)).digest('hex').slice(0, 16)
  return path.join(app.getPath('userData'), 'snapshots', hash)
}

/**
 * Queue of operations per folder (key = auxiliary repository).
 *
 * The snapshot repository is PER FOLDER (`gitDirFor`), so workers running in
 * parallel in the SAME folder — the orchestra default, when there is no
 * worktree — hit the same `.git/index`: `git add`, `write-tree` and `git gc`
 * fight over the `index.lock`, and whoever loses writes no snapshot at all. The
 * turn ends with the verdict 'unknown', and from there come the two symptoms
 * seen in the field: the chat shows no change badge and the reviewer's
 * `show_diff` answers "no changes found" for a turn that did work.
 *
 * It is a chain of promises per folder: one git operation at a time in that
 * folder, and different folders go on in parallel. No public function takes the
 * lock twice (inside, all of them use `snapshotGitCru`), so there is no
 * reentrancy and no deadlock.
 */
const queues = new Map<string, Promise<unknown>>()

function withLock<T>(gitDir: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(gitDir) ?? Promise.resolve()
  // `fn` in both branches: one operation's failure cannot lock the folder.
  const current = previous.then(fn, fn)
  // The stored tail already comes resolved — an error from one turn does not contaminate the
  // next ones. Without this, a single `index.lock` would sour the whole folder's queue.
  const tail = current.then(
    () => {},
    () => {},
  )
  queues.set(gitDir, tail)
  // Key released when the queue empties; if someone entered behind, the tail is already another.
  void tail.then(() => {
    if (queues.get(gitDir) === tail) queues.delete(gitDir)
  })
  return current
}

/**
 * RAW invocation of git in the auxiliary repository — without the folder's lock.
 * Internal on purpose: it is what the operations below use when they ALREADY hold
 * the folder's queue (taking the lock in here would be reentrancy).
 *
 * `--literal-pathspecs`: the paths passed after `--` are file NAMES,
 * not patterns. Without this, `checkout <tree> -- app/[id]/page.tsx`
 * would also match `app/i/page.tsx` and the revert would overwrite a file that
 * the transition had classified as a conflict.
 */
async function snapshotGitCru(directory: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    gitBinary.binary,
    ['--literal-pathspecs', '--git-dir', gitDirFor(directory), '--work-tree', directory, ...args],
    { cwd: directory, env: gitBinary.env, maxBuffer: MAX_BUFFER },
  )
  return stdout
}

/**
 * Runs git in the snapshot auxiliary repository (--git-dir in
 * userData/snapshots/<hash> + --work-tree in the project) using the binary and the
 * PATH resolved at load. Single point of truth of the invocation — exported
 * so that external tools (e.g. verify_changes) do not duplicate gitDirFor
 * nor the binary resolution.
 *
 * Goes through the folder's queue: one invocation at a time in that repository, so
 * as not to dispute the `index.lock` with a capture of the same project.
 */
export function snapshotGit(directory: string, args: string[]): Promise<string> {
  return withLock(gitDirFor(directory), () => snapshotGitCru(directory, args))
}

async function ensureRepo(directory: string): Promise<void> {
  const gitDir = gitDirFor(directory)
  try {
    await fs.access(path.join(gitDir, 'HEAD'))
  } catch {
    await fs.mkdir(gitDir, { recursive: true })
    await execFileAsync(gitBinary.binary, ['--git-dir', gitDir, 'init', '--quiet'], {
      cwd: directory,
      env: gitBinary.env,
    })
  }
  // Also in the repositories that already existed: the excludes list grows between
  // versions (e.g. .orbit/), and only writing it at init would leave the old ones without it.
  if (excludesChecked.has(gitDir)) return
  const exclude = path.join(gitDir, 'info', 'exclude')
  const current = await fs.readFile(exclude, 'utf8').catch(() => '')
  const lines = new Set(current.split('\n').map((l) => l.trim()))
  const missing = DEFAULT_EXCLUDES.filter((e) => !lines.has(e))
  if (missing.length > 0) {
    await fs.mkdir(path.dirname(exclude), { recursive: true })
    const prefixo = current && !current.endsWith('\n') ? '\n' : ''
    await fs.appendFile(exclude, prefixo + missing.join('\n') + '\n', 'utf8')
  }
  excludesChecked.add(gitDir)
}

/**
 * `git gc --prune=7.days`, at most once an hour per project.
 *
 * It goes through the folder's queue (`snapshotGit`), and not in front of it: the gc waits for the
 * capture that is running and never holds the `index.lock` in the middle of an
 * `add --all` — it was this race that made the turn lose the snapshot.
 */
function maybeGc(directory: string) {
  const key = gitDirFor(directory)
  const last = lastGc.get(key) ?? 0
  if (Date.now() - last < GC_INTERVAL) return
  lastGc.set(key, Date.now())
  void snapshotGit(directory, ['gc', '--quiet', '--prune=7.days']).catch(() => {})
}

/**
 * Deletes the snapshot side-repository of a folder that no longer exists
 * (e.g. the worktree of a pipeline task, when it is removed).
 *
 * Through the folder queue: whatever is running finishes first, and no git
 * keeps the repository open at the moment of the removal.
 */
export async function discardSnapshots(directory: string): Promise<void> {
  const gitDir = gitDirFor(directory)
  lastGc.delete(gitDir)
  await withLock(gitDir, () => fs.rm(gitDir, { recursive: true, force: true }))
}

/**
 * Captures the current state of the worktree as a tree hash.
 *
 * `add --all` + `write-tree` are a single operation: the lock stays with the folder until
 * the end, otherwise another capture of the same project would enter between the two commands.
 */
export async function capture(directory: string): Promise<string> {
  // The span opens BEFORE the lock on purpose: the difference between opening the
  // lock at once and getting it minutes later is exactly how much the workers of
  // the same folder are queueing behind each other.
  const perf = perfSpan('snapshot:capture', { directory })
  try {
    return await withLock(gitDirFor(directory), async () => {
      await ensureRepo(directory)
      // B4 — Documented limitation: `git add --all` does NOT version files
      // ignored by the project's .gitignore (nor by the excludes of this module).
      // Therefore, those files never enter the snapshot and are not reverted by the
      // restore — intentional behavior. We do not use -f on purpose: it
      // would break the excludes of node_modules/ etc. and would bloat the auxiliary
      // repository with junk we should not restore.
      await snapshotGitCru(directory, ['add', '--all'])
      const tree = (await snapshotGitCru(directory, ['write-tree'])).trim()
      // Fire-and-forget: the gc only enters the queue (it is not awaited here).
      maybeGc(directory)
      return tree
    })
  } finally {
    perf.end()
  }
}

/**
 * The GLOBAL restore of the folder (`read-tree --reset -u`) was removed on
 * purpose: it took the whole repository back to the start of the turn and swallowed
 * the work of another conversation in the same folder. The revert now uses
 * `transition` (S/E/C per path), which only touches what the turn changed and is still
 * as it left it.
 */
export interface SnapshotDiff {
  files: string[]
  /** Unified diff (can be large — truncated at ~200kB) */
  patch: string
}

const MAX_PATCH_CHARS = 200_000

/** Difference between two snapshots (tree hashes). */
export async function diff(directory: string, from: string, to: string): Promise<SnapshotDiff> {
  const perf = perfSpan('snapshot:diff', { directory })
  try {
    return await withLock(gitDirFor(directory), async () => {
      const files = (await snapshotGitCru(directory, ['diff', '--name-only', from, to]))
        .split('\n')
        .map((f) => f.trim())
        .filter(Boolean)
      let patch = ''
      if (files.length > 0) {
        patch = await snapshotGitCru(directory, ['diff', from, to])
        if (patch.length > MAX_PATCH_CHARS) {
          patch = patch.slice(0, MAX_PATCH_CHARS) + '\n… (diff truncado)'
        }
      }
      perf.end({ files: files.length, patchChars: patch.length })
      return { files, patch }
    })
  } catch (err) {
    perf.end({ failed: true })
    throw err
  }
}

/**
 * State of a path in a tree hash or in the worktree.
 *
 * `hash` is the git blob (the same one `add`/`write-tree` wrote); `mode`
 * separates ordinary file, executable and symlink. Comparing hash + mode is what
 * answers "is the worktree STILL as the turn left it?" without looking at file
 * content one by one in Node.
 */
export interface PathState {
  exists: boolean
  hash: string | null
  mode: string | null
}

export interface TransitionResult {
  /** Paths that went back to the `to` state (what the revert actually undid). */
  applied: string[]
  /** Paths that changed after the turn — preserved, not touched. */
  conflicts: string[]
  /** Paths that were already in the `to` state (nothing to do). */
  already: string[]
}

/**
 * Same blob in both: the git sha1 for a symlink is the blob of the TEXT of the
 * target, and `git hash-object <symlink>` follows the link (it fails if the target does not
 * exist). Here the content goes through stdin, in the object format of the auxiliary
 * repository (sha1 by default, sha256 if the user's git is configured that way).
 */
function gitHashStdin(directory: string, content: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      gitBinary.binary,
      ['--git-dir', gitDirFor(directory), '--work-tree', directory, 'hash-object', '--stdin'],
      { cwd: directory, env: gitBinary.env },
    )
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (out += chunk))
    child.stderr.on('data', (chunk: string) => (err += chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(out.trim())
      else reject(new Error(err.trim() || `git hash-object exited ${code}`))
    })
    child.stdin.end(content)
  })
}

/** State of `rel` inside a tree hash (without touching the worktree). */
async function entryState(directory: string, tree: string, rel: string): Promise<PathState> {
  const out = (await snapshotGitCru(directory, ['ls-tree', tree, '--', rel])).trim()
  if (!out) return { exists: false, hash: null, mode: null }
  // "<mode> <type> <hash>\t<path>" — the path may come quoted, but the three
  // first fields never do.
  const [mode, type, hash] = out.split('\t')[0].split(/\s+/)
  if (!mode || !hash || type !== 'blob') return { exists: true, hash: hash ?? null, mode: mode ?? null }
  return { exists: true, hash, mode }
}

/** State of `rel` in the worktree right now. */
async function worktreeState(directory: string, rel: string): Promise<PathState> {
  const abs = path.join(directory, rel)
  const st = await fs.lstat(abs).catch(() => null)
  if (!st) return { exists: false, hash: null, mode: null }
  if (st.isSymbolicLink()) {
    const target = await fs.readlink(abs).catch(() => null)
    if (target === null) return { exists: true, hash: null, mode: '120000' }
    return { exists: true, hash: await gitHashStdin(directory, target), mode: '120000' }
  }
  if (!st.isFile()) return { exists: true, hash: null, mode: null }
  const hash = (
    await snapshotGitCru(directory, ['hash-object', `--path=${rel}`, '--', abs])
  ).trim()
  const mode = process.platform === 'win32' ? '100644' : st.mode & 0o111 ? '100755' : '100644'
  return { exists: true, hash, mode }
}

function samePathState(a: PathState, b: PathState): boolean {
  return a.exists === b.exists && a.hash === b.hash && (a.mode ?? null) === (b.mode ?? null)
}

/**
 * S/E/C transition PER PATH — the heart of the revert without a global restore.
 *
 * `from` is the state the worktree should have (the `end` of the turn, on revert;
 * the post-revert state, on unrevert) and `to` is the state it should go back to.
 * For each path that differs between the two:
 *
 * - worktree == `from` → it is STILL what the turn left: goes back to `to`;
 * - worktree == `to`   → already undone: nothing to do;
 * - anything else → someone touched it afterwards (another conversation, the user
 *   outside Orbit, an external agent): does NOT touch it and reports a conflict.
 *
 * The rest of the folder is not read beyond the paths of the diff, and nothing is deleted in
 * bulk. `skip` are paths the turn changed but that are not its own (manual
 * saves from the panel) — they come in as a conflict, preserved. `paths` limits the
 * transition to those paths (the ones with confirmed authorship of the turn); without it,
 * the whole diff between `from` and `to` applies.
 */
export async function transition(
  directory: string,
  from: string,
  to: string,
  options: { skip?: Set<string>; paths?: string[] } = {},
): Promise<TransitionResult> {
  const { skip } = options
  return withLock(gitDirFor(directory), async () => {
    await ensureRepo(directory)
    const paths = options.paths ?? (await changedPathsCru(directory, from, to))
    const applied: string[] = []
    const conflicts: string[] = []
    const already: string[] = []

    for (const rel of paths) {
      if (skip?.has(rel)) {
        conflicts.push(rel)
        continue
      }
      try {
        const expected = await entryState(directory, from, rel)
        const target = await entryState(directory, to, rel)
        const current = await worktreeState(directory, rel)
        if (samePathState(current, expected)) {
          if (target.exists) {
            // checkout restores content, mode and symlink at once.
            await snapshotGitCru(directory, ['checkout', to, '--', rel])
          } else {
            await fs.rm(path.join(directory, rel), { force: true })
            await removeEmptyParents(directory, rel)
            // Keeps the index consistent with what is left; the next capture
            // would do that anyway.
            await snapshotGitCru(directory, ['rm', '--cached', '--ignore-unmatch', '--', rel]).catch(() => '')
          }
          applied.push(rel)
        } else if (samePathState(current, target)) {
          already.push(rel)
        } else {
          conflicts.push(rel)
        }
      } catch (err) {
        // An unreadable path cannot bring down the whole revert — and it is not
        // safe to overwrite it without knowing the current state.
        console.error('[snapshot] transition failed at', rel, err)
        conflicts.push(rel)
      }
    }

    return { applied, conflicts, already }
  })
}

/**
 * Paths that differ between two trees, without rename detection and without touching the name:
 * `-z` delivers the raw name (a space at the start or end is part of it).
 */
async function changedPathsCru(directory: string, from: string, to: string): Promise<string[]> {
  const raw = await snapshotGitCru(directory, ['diff', '--name-only', '-z', '--no-renames', from, to])
  return raw.split('\0').filter(Boolean)
}

export async function changedPaths(directory: string, from: string, to: string): Promise<string[]> {
  if (from === to) return []
  return withLock(gitDirFor(directory), async () => {
    await ensureRepo(directory)
    return changedPathsCru(directory, from, to)
  })
}

/**
 * Deleting the file the turn created left its folder behind (the old
 * `read-tree -u` took it along). Goes up removing only the folders that became
 * EMPTY, and never the root.
 */
async function removeEmptyParents(directory: string, rel: string): Promise<void> {
  const root = path.resolve(directory)
  let dir = path.dirname(path.join(root, rel))
  while (dir !== root && dir.startsWith(root + path.sep)) {
    const entries = await fs.readdir(dir).catch(() => null)
    if (!entries || entries.length > 0) return
    await fs.rmdir(dir).catch(() => {})
    dir = path.dirname(dir)
  }
}

/** Diff between two trees limited to paths — it is what the revert bar shows. */
export async function diffPaths(
  directory: string,
  from: string,
  to: string,
  paths: string[],
): Promise<SnapshotDiff> {
  if (paths.length === 0) return { files: [], patch: '' }
  return withLock(gitDirFor(directory), async () => {
    let patch = await snapshotGitCru(directory, ['diff', '--no-ext-diff', from, to, '--', ...paths])
    if (patch.length > MAX_PATCH_CHARS) {
      patch = patch.slice(0, MAX_PATCH_CHARS) + '\n… (diff truncado)'
    }
    return { files: paths, patch }
  })
}
