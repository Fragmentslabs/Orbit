import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import { accessSync, constants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'

/**
 * Engine de snapshots do filesystem por mensagem (padrão opencode): um
 * repositório git auxiliar por projeto em userData/snapshots/<hash>, usando
 * --git-dir + --work-tree para versionar a pasta do projeto sem tocar no
 * .git dele. Snapshots são tree hashes (write-tree) — sem commits, sem refs.
 */

const execFileAsync = promisify(execFile)
const MAX_BUFFER = 50 * 1024 * 1024

/**
 * B3 — Resolução do binário do git no carregamento do módulo.
 *
 * Quando o app é aberto via Finder/dock (não pelo terminal), o PATH do
 * processo pode ser mínimo (ex.: sem /opt/homebrew/bin), fazendo `git`
 * falhar com ENOENT silencioso no execFile. Estratégia, em ordem:
 *   1. `which git` (scan do PATH, equivalente ao which do shell);
 *   2. caminhos conhecidos de instalação no macOS;
 *   3. fallback: `git` com PATH injetado (PATH padrão do macOS mesclado ao
 *      PATH atual) no env do execFile.
 */
const KNOWN_GIT_PATHS = ['/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git']
const DEFAULT_PATH = '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin'

function findGitInPath(pathValue: string): string | undefined {
  for (const dir of pathValue.split(':').filter(Boolean)) {
    const candidate = path.join(dir, 'git')
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // candidato não executável; segue para o próximo diretório
    }
  }
  return undefined
}

function resolveGit(): { binary: string; env: NodeJS.ProcessEnv } {
  const env = { ...process.env }
  const currentPath = env.PATH ?? ''
  env.PATH = currentPath ? `${currentPath}:${DEFAULT_PATH}` : DEFAULT_PATH

  // 1. `which git` via scan do PATH completo (PATH atual tem precedência)
  const fromPath = findGitInPath(env.PATH)
  if (fromPath) return { binary: fromPath, env }

  // 2. Caminhos conhecidos de instalação do git no macOS
  for (const candidate of KNOWN_GIT_PATHS) {
    try {
      accessSync(candidate, constants.X_OK)
      return { binary: candidate, env }
    } catch {
      // caminho não existe ou não é executável; segue
    }
  }

  // 3. Fallback: deixa o PATH injetado decidir (ainda resolve em ambientes
  //    não-macOS onde o git esteja em outro diretório do PATH)
  return { binary: 'git', env }
}

/** Binário do git e PATH resolvidos no load — exportado para ferramentas
 * externas (ex.: verify_changes) que precisem invocar git com a mesma
 * resolução (B3: Finder/PATH mínimo) sem duplicá-la. */
export const gitBinary = resolveGit()

/** Excludes padrão além do .gitignore do projeto (projetos sem .gitignore) */
const DEFAULT_EXCLUDES = ['node_modules/', '.git/', 'dist/', 'dist-electron/', 'build/', 'out/', '.next/', 'target/']

const GC_INTERVAL = 60 * 60 * 1000 // 1h
const lastGc = new Map<string, number>()

function gitDirFor(directory: string): string {
  const hash = crypto.createHash('sha1').update(path.resolve(directory)).digest('hex').slice(0, 16)
  return path.join(app.getPath('userData'), 'snapshots', hash)
}

/**
 * Executa git no repositório auxiliar de snapshots (--git-dir em
 * userData/snapshots/<hash> + --work-tree no projeto) usando o binário e o
 * PATH resolvidos no load. Único ponto de verdade da invocação — exportado
 * para ferramentas externas (ex.: verify_changes) não duplicarem gitDirFor
 * nem a resolução do binário.
 */
export async function snapshotGit(directory: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    gitBinary.binary,
    ['--git-dir', gitDirFor(directory), '--work-tree', directory, ...args],
    { cwd: directory, env: gitBinary.env, maxBuffer: MAX_BUFFER },
  )
  return stdout
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
    await fs.mkdir(path.join(gitDir, 'info'), { recursive: true })
    await fs.writeFile(path.join(gitDir, 'info', 'exclude'), DEFAULT_EXCLUDES.join('\n') + '\n', 'utf8')
  }
}

/** git gc --prune=7.days em background, no máximo 1x/hora por projeto. */
function maybeGc(directory: string) {
  const key = gitDirFor(directory)
  const last = lastGc.get(key) ?? 0
  if (Date.now() - last < GC_INTERVAL) return
  lastGc.set(key, Date.now())
  void snapshotGit(directory, ['gc', '--quiet', '--prune=7.days']).catch(() => {})
}

/** Captura o estado atual do worktree como tree hash. */
export async function capture(directory: string): Promise<string> {
  await ensureRepo(directory)
  // B4 — Limitação documentada: `git add --all` NÃO versiona arquivos
  // ignorados pelo .gitignore do projeto (nem pelos excludes deste módulo).
  // Logo, esses arquivos nunca entram no snapshot e não são revertidos pelo
  // restore — comportamento intencional. Não usamos -f de propósito: ele
  // quebraria os excludes de node_modules/ etc. e incharia o repositório
  // auxiliar com lixo que não devemos restaurar.
  await snapshotGit(directory, ['add', '--all'])
  const tree = (await snapshotGit(directory, ['write-tree'])).trim()
  maybeGc(directory)
  return tree
}

/**
 * Restaura o worktree para um tree hash. O índice é sincronizado com o
 * estado atual antes (add --all) para que read-tree --reset -u também
 * remova arquivos criados depois do snapshot.
 */
export async function restore(directory: string, tree: string): Promise<void> {
  await ensureRepo(directory)
  await snapshotGit(directory, ['add', '--all'])
  await snapshotGit(directory, ['read-tree', '--reset', '-u', tree])
}

export interface SnapshotDiff {
  files: string[]
  /** Diff unificado (pode ser grande — truncado em ~200kB) */
  patch: string
}

const MAX_PATCH_CHARS = 200_000

/** Diferença entre dois snapshots (tree hashes). */
export async function diff(directory: string, from: string, to: string): Promise<SnapshotDiff> {
  const files = (await snapshotGit(directory, ['diff', '--name-only', from, to]))
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean)
  let patch = ''
  if (files.length > 0) {
    patch = await snapshotGit(directory, ['diff', from, to])
    if (patch.length > MAX_PATCH_CHARS) {
      patch = patch.slice(0, MAX_PATCH_CHARS) + '\n… (diff truncado)'
    }
  }
  return { files, patch }
}
