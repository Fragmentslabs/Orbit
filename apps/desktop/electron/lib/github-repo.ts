import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { userShellEnv } from './shell-env'

/**
 * Creation of the remote repository on GitHub from a folder that does not yet
 * have a remote — the case where `git push` fails with kind "noRemote".
 *
 * The token is NOT requested from the user nor stored by us: it is read from the credential
 * helper that git itself already uses to authenticate pushes (Git Credential
 * Manager on Windows, keychain on macOS) and, in its absence, from `gh auth token`.
 *
 * Whoever authenticates over SSH has no HTTPS credential at all — the push works
 * through the keys, but the GitHub API requires a token, and an SSH key does not become a token.
 * In that case `gh` is the source that remains — and the error points to installing and
 * authenticating it instead of asking for a typed token. The remote created follows the
 * protocol the machine knows how to use: HTTPS when there is an HTTPS credential, SSH
 * otherwise — otherwise the push right after creation would fail.
 */

const execFileAsync = promisify(execFile)

const API = 'https://api.github.com'

/**
 * Full user PATH, not the sanitized one macOS hands to GUI
 * apps. Without this the Homebrew `gh` (/opt/homebrew/bin) is invisible —
 * `git` escapes because it lives in /usr/bin, which is in the minimal PATH.
 * userShellEnv reads the disk, so the result is memoized.
 */
let envCache: NodeJS.ProcessEnv | undefined
function gitEnv(): NodeJS.ProcessEnv {
  envCache ??= userShellEnv()
  return { ...envCache, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' }
}

export type CreateRepoResult =
  | { ok: true; url: string; fullName: string; pushed: boolean }
  | {
      ok: false
      kind: 'noCredential'
      hint: CredentialHint
      // Raw data of both attempts — the UI assembles the text in the active language.
      detail: { git: GitCredDetail; gh: GhCredDetail }
    }
  | { ok: false; kind: Exclude<CreateRepoErrorKind, 'noCredential'>; message: string }

/**
 * Instruction that the UI shows to unlock repository creation:
 * `ghMissing` = `gh` is not installed (install and authenticate);
 * `ghOther` = `gh` exists but provided no token (authenticate).
 */
export type CredentialHint = 'ghMissing' | 'ghOther'

export type CreateRepoErrorKind =
  /** No GitHub credential in the git helper — nothing to reuse. */
  | 'noCredential'
  /** Token exists but was refused or has no scope to create a repository. */
  | 'auth'
  /** A repository with that name already exists in the account. */
  | 'nameTaken'
  /** Name outside GitHub's rules. */
  | 'invalidName'
  /** The folder has no commit yet — there is nothing to publish. */
  | 'noCommits'
  | 'other'

/** GitHub's rules for a repository name: letters, numbers, `.`, `-` and `_`. */
export function isValidRepoName(name: string): boolean {
  return /^[A-Za-z0-9._-]{1,100}$/.test(name) && name !== '.' && name !== '..'
}

interface TokenLookup {
  token: string | null
  /**
   * There is an HTTPS credential in the git helper. It decides the remote's protocol:
   * without it, the machine authenticates over SSH and an HTTPS origin would not push.
   */
  hasHttpsCredential: boolean
  /** When no token came, how the read failed — the UI translates from this. */
  detail: GitCredDetail | null
}

/**
 * How `git credential fill` ended without a token. `output` is the tool's raw output
 * (stderr — never translated); `mode` and `code` become localized text
 * in the UI.
 */
export type GitCredDetail = {
  mode: 'exit' | 'spawn' | 'timeout'
  /** Git exit code ('exit' mode); null in the other modes. */
  code: number | null
  output: string
}

/** State of `gh auth token` when no token came — the UI localizes it, `output` raw apart. */
export type GhCredDetail = {
  status: 'missing' | 'other'
  output: string
}

/** GitHub CLI token, when installed and authenticated. */
async function readGhToken(
  cwd: string,
): Promise<{ token: string | null; status: 'ok' | 'missing' | 'other'; output: string }> {
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], {
      cwd,
      env: gitEnv(),
      timeout: 10_000,
    })
    const token = stdout.trim()
    return token
      ? { token, status: 'ok', output: '' }
      : { token: null, status: 'other', output: '' }
  } catch (err) {
    const e = err as { code?: string; stderr?: string }
    // ENOENT = binary missing; any other output = gh exists but refused.
    // The gh raw output goes to the UI untranslated — only the frame is localized.
    const missing = e.code === 'ENOENT'
    return {
      token: null,
      status: missing ? 'missing' : 'other',
      output: missing ? '' : (e.stderr ?? '').trim().slice(0, 200) || String(err).slice(0, 200),
    }
  }
}

/**
 * Reads the github.com credential through the git helper.
 *
 * It runs with explicit stdin because `git credential fill` expects the query
 * there. Every output without a token returns the REASON: a bare "no credential" does not
 * distinguish a missing helper, a timeout and git not found, and without that
 * distinction there is no way for the user to act.
 */
async function readGitHubToken(cwd: string): Promise<TokenLookup> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('git', ['credential', 'fill'], { cwd, env: gitEnv() })
    } catch (err) {
      resolve({
        token: null,
        hasHttpsCredential: false,
        detail: { mode: 'spawn', code: null, output: err instanceof Error ? err.message : String(err) },
      })
      return
    }

    let out = ''
    let errOut = ''
    let settled = false
    const finish = (result: TokenLookup) => {
      if (settled) return
      settled = true
      child.kill()
      resolve(result)
    }
    // 20s: Git Credential Manager is a .NET app and the first invocation in a
    // cold process goes past the 10s I used before.
    const timer = setTimeout(
      () => finish({ token: null, hasHttpsCredential: false, detail: { mode: 'timeout', code: null, output: '' } }),
      20_000,
    )

    child.stdout?.on('data', (chunk) => {
      out += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      errOut += String(chunk)
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      finish({ token: null, hasHttpsCredential: false, detail: { mode: 'spawn', code: null, output: err.message } })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const password = out
        .split(/\r?\n/)
        .find((line) => line.startsWith('password='))
        ?.slice('password='.length)
        .trim()
      if (password) {
        finish({ token: password, hasHttpsCredential: true, detail: null })
        return
      }
      // Any output without `password=` means the same thing: there is no
      // HTTPS credential. On an SSH-only machine git even tries to ask
      // the user and exits 128 with "terminal prompts disabled". The raw tail of the
      // stderr goes to the UI; the textual frame is assembled there, in the active language.
      const output = errOut.trim().split(/\r?\n/).slice(-2).join(' ').slice(0, 300)
      finish({
        token: null,
        hasHttpsCredential: false,
        detail: { mode: 'exit', code: code, output },
      })
    })

    child.stdin?.write('protocol=https\nhost=github.com\n\n')
    child.stdin?.end()
  })
}

interface GitHubRepo {
  /** HTTPS */
  clone_url: string
  /** git@github.com:owner/name.git */
  ssh_url: string
  full_name: string
  html_url: string
}

async function createOnGitHub(
  name: string,
  isPrivate: boolean,
  token: string,
): Promise<{ ok: true; repo: GitHubRepo } | { ok: false; kind: Exclude<CreateRepoErrorKind, 'noCredential'>; message: string }> {
  let response: Response
  try {
    response = await fetch(`${API}/user/repos`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'Orbit',
      },
      body: JSON.stringify({ name, private: isPrivate, auto_init: false }),
      signal: AbortSignal.timeout(20_000),
    })
  } catch (err) {
    return { ok: false, kind: 'other', message: err instanceof Error ? err.message : String(err) }
  }

  if (response.status === 201) {
    return { ok: true, repo: (await response.json()) as GitHubRepo }
  }

  const body = (await response.json().catch(() => null)) as
    | { message?: string; errors?: { message?: string }[] }
    | null
  const detail = body?.errors?.[0]?.message ?? body?.message ?? `HTTP ${response.status}`

  if (response.status === 401 || response.status === 403) {
    return { ok: false, kind: 'auth', message: detail }
  }
  if (response.status === 422) {
    // GitHub returns 422 for both a repeated name and an invalid name.
    const kind: CreateRepoErrorKind = /already exists/i.test(detail) ? 'nameTaken' : 'invalidName'
    return { ok: false, kind, message: detail }
  }
  return { ok: false, kind: 'other', message: detail }
}

/**
 * Creates the repository on GitHub, points the `origin` remote to it and publishes the
 * current branch. It returns `pushed: false` when the repository was created but the
 * push failed — the remote stays configured, so the user can try again
 * through the send button itself.
 */
export async function createRemoteRepo(
  repoPath: string,
  name: string,
  isPrivate: boolean,
): Promise<CreateRepoResult> {
  const trimmed = name.trim()
  if (!isValidRepoName(trimmed)) {
    return { ok: false, kind: 'invalidName', message: trimmed }
  }

  // Publishing requires at least one commit: without HEAD, the push has nothing to send and
  // the remote repository would be born orphaned from the local one.
  try {
    await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, env: gitEnv(), timeout: 15_000 })
  } catch {
    return { ok: false, kind: 'noCommits', message: 'HEAD is missing' }
  }

  // The read also defines the remote's protocol: without an HTTPS credential the
  // machine authenticates over SSH and the origin is born with the SSH URL.
  const lookup = await readGitHubToken(repoPath)
  let token = lookup.token
  if (!token) {
    // Without an HTTPS credential (typical of SSH users) gh is the only source that
    // remains — the hint tells the UI whether it is necessary to install or just authenticate.
    const gh = await readGhToken(repoPath)
    token = gh.token
    if (!token) {
      // Both attempts go into the detail: knowing which one failed and why
      // is what allows the user to correct instead of guessing. The UI receives
      // the raw data and assembles the text in the active language.
      return {
        ok: false,
        kind: 'noCredential',
        hint: gh.status === 'missing' ? 'ghMissing' : 'ghOther',
        detail: {
          git: lookup.detail ?? { mode: 'exit', code: null, output: '' },
          gh: { status: gh.status === 'ok' ? 'other' : gh.status, output: gh.output },
        },
      }
    }
  }

  const created = await createOnGitHub(trimmed, isPrivate, token)
  if (!created.ok) return created

  // Protocol this machine can authenticate: with an HTTPS credential it goes
  // over HTTPS; without it the push only works through the SSH keys.
  const remoteUrl = lookup.hasHttpsCredential ? created.repo.clone_url : created.repo.ssh_url

  try {
    await execFileAsync('git', ['remote', 'add', 'origin', remoteUrl], {
      cwd: repoPath,
      env: gitEnv(),
      timeout: 15_000,
    })
  } catch (err) {
    return {
      ok: false,
      kind: 'other',
      message: err instanceof Error ? err.message : String(err),
    }
  }

  try {
    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
      cwd: repoPath,
      env: gitEnv(),
      timeout: 15_000,
    })
    const branch = stdout.trim()
    if (!branch) throw new Error('no current branch')
    await execFileAsync('git', ['push', '-u', 'origin', branch], {
      cwd: repoPath,
      env: gitEnv(),
      timeout: 120_000,
    })
    return { ok: true, url: created.repo.html_url, fullName: created.repo.full_name, pushed: true }
  } catch {
    // The repository exists and the origin is configured; only the send failed.
    return { ok: true, url: created.repo.html_url, fullName: created.repo.full_name, pushed: false }
  }
}
