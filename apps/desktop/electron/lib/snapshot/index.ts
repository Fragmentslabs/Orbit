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
 * Quando o app é aberto pelo Finder/dock ou pelo Menu Iniciar, e não pelo
 * terminal, o PATH do processo pode não ter o diretório do git, e o execFile
 * falha com ENOENT. A resolução procura o git no PATH, depois nos lugares
 * onde os instaladores o deixam, e por fim entrega `git` com o PATH ampliado.
 *
 * Isto nasceu só para macOS, e no Windows o snapshot quebrava SEMPRE: o PATH
 * era juntado com ":" (lá é ";"), o arquivo procurado era "git" (lá é
 * "git.exe") e, como a variável do Windows se chama "Path", o código criava
 * uma SEGUNDA chave "PATH" só com diretórios do macOS — o git rodava num PATH
 * onde ele não existe, e todo turno do modo código perdia o snapshot, o revert
 * por mensagem e a verificação de mudanças. Agora o separador, o nome do
 * arquivo e a chave da variável vêm da plataforma.
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
/** Diretórios somados ao PATH herdado — só onde o PATH mínimo é um risco. */
const EXTRA_PATH: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/opt/homebrew/bin', '/usr/local/bin'],
  linux: ['/usr/bin', '/bin', '/usr/local/bin'],
}

export function resolveGitBinary(
  platform: NodeJS.Platform,
  // Um ambiente qualquer, e não o ProcessEnv deste app: o tipo global declara
  // as variáveis do Orbit como obrigatórias, e o ambiente de um processo filho
  // não tem por que ter nenhuma delas.
  baseEnv: Record<string, string | undefined>,
  isExecutable: (file: string) => boolean,
): { binary: string; env: NodeJS.ProcessEnv } {
  const paths = platform === 'win32' ? path.win32 : path.posix
  const env = { ...baseEnv } as NodeJS.ProcessEnv

  // A chave como ela VEIO: "Path" no Windows. Escrever em "PATH" criaria uma
  // segunda variável, e qual das duas o processo filho enxerga não é decisão
  // nossa.
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
  const inherited = (env[pathKey] ?? '').split(paths.delimiter).filter(Boolean)
  const extra = (EXTRA_PATH[platform] ?? []).filter((dir) => !inherited.includes(dir))
  const searchPath = [...inherited, ...extra]
  env[pathKey] = searchPath.join(paths.delimiter)

  // 1. O PATH, na ordem (o que o usuário configurou tem precedência)
  const names = platform === 'win32' ? ['git.exe', 'git.cmd'] : ['git']
  for (const dir of searchPath) {
    for (const name of names) {
      const candidate = paths.join(dir, name)
      if (isExecutable(candidate)) return { binary: candidate, env }
    }
  }

  // 2. Onde os instaladores costumam deixar o git
  const localPrograms =
    platform === 'win32' && env.LOCALAPPDATA
      ? [paths.join(env.LOCALAPPDATA, 'Programs', 'Git', 'cmd', 'git.exe')]
      : []
  for (const candidate of [...(KNOWN_GIT_PATHS[platform] ?? []), ...localPrograms]) {
    if (isExecutable(candidate)) return { binary: candidate, env }
  }

  // 3. Deixa o PATH ampliado decidir
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

/** Binário do git e PATH resolvidos no load — exportado para ferramentas
 * externas (ex.: verify_changes) que precisem invocar git com a mesma
 * resolução (B3: Finder/PATH mínimo) sem duplicá-la. */
export const gitBinary = resolveGitBinary(process.platform, process.env, canExecute)

/** Excludes padrão além do .gitignore do projeto (projetos sem .gitignore) */
/**
 * `.orbit/`: worktrees do Orbit no modo "dentro do projeto". O repositório
 * auxiliar não lê o .git/info/exclude do projeto — sem isto cada snapshot
 * levaria cópias inteiras do repositório, e desfazer um turno apagaria um
 * worktree criado depois dele.
 */
const DEFAULT_EXCLUDES = ['node_modules/', '.git/', '.orbit/', 'dist/', 'dist-electron/', 'build/', 'out/', '.next/', 'target/']
/** Repositórios auxiliares cujo exclude já foi conferido nesta execução. */
const excludesConferidos = new Set<string>()

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
  }
  // Também nos repositórios que já existiam: a lista de excludes cresce entre
  // versões (ex.: .orbit/), e só escrevê-la no init deixaria os antigos sem.
  if (excludesConferidos.has(gitDir)) return
  const exclude = path.join(gitDir, 'info', 'exclude')
  const atual = await fs.readFile(exclude, 'utf8').catch(() => '')
  const linhas = new Set(atual.split('\n').map((l) => l.trim()))
  const faltando = DEFAULT_EXCLUDES.filter((e) => !linhas.has(e))
  if (faltando.length > 0) {
    await fs.mkdir(path.dirname(exclude), { recursive: true })
    const prefixo = atual && !atual.endsWith('\n') ? '\n' : ''
    await fs.appendFile(exclude, prefixo + faltando.join('\n') + '\n', 'utf8')
  }
  excludesConferidos.add(gitDir)
}

/** git gc --prune=7.days em background, no máximo 1x/hora por projeto. */
function maybeGc(directory: string) {
  const key = gitDirFor(directory)
  const last = lastGc.get(key) ?? 0
  if (Date.now() - last < GC_INTERVAL) return
  lastGc.set(key, Date.now())
  void snapshotGit(directory, ['gc', '--quiet', '--prune=7.days']).catch(() => {})
}

/**
 * Apaga o repositório auxiliar de snapshots de uma pasta que deixou de existir
 * (ex.: o worktree de uma task da esteira, ao ser removido).
 */
export async function descartarSnapshots(directory: string): Promise<void> {
  lastGc.delete(gitDirFor(directory))
  await fs.rm(gitDirFor(directory), { recursive: true, force: true })
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
