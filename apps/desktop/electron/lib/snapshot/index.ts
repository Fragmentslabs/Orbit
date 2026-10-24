import { execFile, spawn } from 'node:child_process'
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
 * Fila de operações por pasta (chave = repositório auxiliar).
 *
 * O repositório de snapshot é POR PASTA (`gitDirFor`), então workers em
 * paralelo na MESMA pasta — o padrão da orquestra, quando não há worktree —
 * batem no mesmo `.git/index`: `git add`, `write-tree` e `git gc` disputam o
 * `index.lock`, e quem perde não grava snapshot nenhum. O turno termina com o
 * veredito 'unknown' e daí saem os dois sintomas vistos em campo: o chat não
 * mostra o badge de alterações e o `ver_diff` do revisor responde "no changes
 * found" para um turno que trabalhou.
 *
 * É um encadeamento de promises por pasta: uma operação de git por vez naquela
 * pasta, e pastas diferentes seguem em paralelo. Nenhuma função pública pega a
 * trava duas vezes (por dentro todas usam `snapshotGitCru`), então não há
 * reentrância nem deadlock.
 */
const filas = new Map<string, Promise<unknown>>()

function comTrava<T>(gitDir: string, fn: () => Promise<T>): Promise<T> {
  const anterior = filas.get(gitDir) ?? Promise.resolve()
  // `fn` nos dois ramos: a falha de uma operação não pode travar a pasta.
  const atual = anterior.then(fn, fn)
  // A cauda guardada já vem resolvida — um erro de um turno não contamina os
  // próximos. Sem isto, um único `index.lock` azedaria a fila da pasta toda.
  const cauda = atual.then(
    () => {},
    () => {},
  )
  filas.set(gitDir, cauda)
  // Chave liberada quando a fila esvazia; se alguém entrou atrás, a cauda já é outra.
  void cauda.then(() => {
    if (filas.get(gitDir) === cauda) filas.delete(gitDir)
  })
  return atual
}

/**
 * Invocação CRUA do git no repositório auxiliar — sem a trava da pasta.
 * Interna de propósito: é o que as operações abaixo usam quando JÁ estão com a
 * fila da pasta nas mãos (pegar a trava aqui dentro seria reentrância).
 *
 * `--literal-pathspecs`: os caminhos passados depois de `--` são NOMES de
 * arquivo, não padrões. Sem isso, `checkout <tree> -- app/[id]/page.tsx`
 * também casaria `app/i/page.tsx` e o revert sobrescreveria um arquivo que
 * a transição tinha classificado como conflito.
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
 * Executa git no repositório auxiliar de snapshots (--git-dir em
 * userData/snapshots/<hash> + --work-tree no projeto) usando o binário e o
 * PATH resolvidos no load. Único ponto de verdade da invocação — exportado
 * para ferramentas externas (ex.: verify_changes) não duplicarem gitDirFor
 * nem a resolução do binário.
 *
 * Passa pela fila da pasta: uma invocação por vez naquele repositório, para
 * não disputar o `index.lock` com uma captura do mesmo projeto.
 */
export function snapshotGit(directory: string, args: string[]): Promise<string> {
  return comTrava(gitDirFor(directory), () => snapshotGitCru(directory, args))
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

/**
 * `git gc --prune=7.days`, no máximo 1x/hora por projeto.
 *
 * Vai pela fila da pasta (`snapshotGit`), e não na frente dela: o gc espera a
 * captura que estiver rodando e nunca segura o `index.lock` no meio de um
 * `add --all` — era essa corrida que fazia o turno perder o snapshot.
 */
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
 *
 * Pela fila da pasta: o que estiver rodando termina antes, e nenhum git fica
 * com o repositório aberto no instante da remoção.
 */
export async function descartarSnapshots(directory: string): Promise<void> {
  const gitDir = gitDirFor(directory)
  lastGc.delete(gitDir)
  await comTrava(gitDir, () => fs.rm(gitDir, { recursive: true, force: true }))
}

/**
 * Captura o estado atual do worktree como tree hash.
 *
 * `add --all` + `write-tree` são uma operação só: a trava fica com a pasta até
 * o fim, senão outra captura do mesmo projeto entraria entre os dois comandos.
 */
export async function capture(directory: string): Promise<string> {
  return comTrava(gitDirFor(directory), async () => {
    await ensureRepo(directory)
    // B4 — Limitação documentada: `git add --all` NÃO versiona arquivos
    // ignorados pelo .gitignore do projeto (nem pelos excludes deste módulo).
    // Logo, esses arquivos nunca entram no snapshot e não são revertidos pelo
    // restore — comportamento intencional. Não usamos -f de propósito: ele
    // quebraria os excludes de node_modules/ etc. e incharia o repositório
    // auxiliar com lixo que não devemos restaurar.
    await snapshotGitCru(directory, ['add', '--all'])
    const tree = (await snapshotGitCru(directory, ['write-tree'])).trim()
    // Fire-and-forget: o gc só entra na fila (não é aguardado aqui).
    maybeGc(directory)
    return tree
  })
}

/**
 * A restauração GLOBAL da pasta (`read-tree --reset -u`) foi removida de
 * propósito: ela devolvia o repositório inteiro ao início do turno e engolia
 * o trabalho de outra conversa na mesma pasta. O revert agora usa
 * `transition` (S/E/C por caminho), que só toca no que o turno mudou e ainda
 * está como ele deixou.
 */
export interface SnapshotDiff {
  files: string[]
  /** Diff unificado (pode ser grande — truncado em ~200kB) */
  patch: string
}

const MAX_PATCH_CHARS = 200_000

/** Diferença entre dois snapshots (tree hashes). */
export async function diff(directory: string, from: string, to: string): Promise<SnapshotDiff> {
  return comTrava(gitDirFor(directory), async () => {
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
    return { files, patch }
  })
}

/**
 * Estado de um caminho num tree hash ou no worktree.
 *
 * `hash` é o blob do git (o mesmo que `add`/`write-tree` gravaram); `mode`
 * separa arquivo comum, executável e symlink. Comparar hash + modo é o que
 * responde "o worktree AINDA está como o turno deixou?" sem olhar conteúdo de
 * arquivo por arquivo em Node.
 */
export interface PathState {
  exists: boolean
  hash: string | null
  mode: string | null
}

export interface TransitionResult {
  /** Caminhos que voltaram ao estado `to` (o que o revert realmente desfez). */
  applied: string[]
  /** Caminhos que mudaram depois do turno — preservados, não tocados. */
  conflicts: string[]
  /** Caminhos que já estavam no estado `to` (nada a fazer). */
  already: string[]
}

/**
 * Mesmo blob em ambos: o sha1 do git para um symlink é o blob do TEXTO do
 * alvo, e `git hash-object <symlink>` segue o link (falha se o alvo não
 * existe). Aqui o conteúdo vai por stdin, no formato de objeto do repositório
 * auxiliar (sha1 por padrão, sha256 se o git do usuário configurou assim).
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

/** Estado de `rel` dentro de um tree hash (sem tocar no worktree). */
async function entryState(directory: string, tree: string, rel: string): Promise<PathState> {
  const out = (await snapshotGitCru(directory, ['ls-tree', tree, '--', rel])).trim()
  if (!out) return { exists: false, hash: null, mode: null }
  // "<mode> <type> <hash>\t<path>" — o path pode vir citado, mas os três
  // primeiros campos nunca vêm.
  const [mode, type, hash] = out.split('\t')[0].split(/\s+/)
  if (!mode || !hash || type !== 'blob') return { exists: true, hash: hash ?? null, mode: mode ?? null }
  return { exists: true, hash, mode }
}

/** Estado de `rel` no worktree agora. */
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
 * Transição S/E/C POR CAMINHO — o coração do revert sem restauração global.
 *
 * `from` é o estado que o worktree deveria ter (o `end` do turno, no revert;
 * o estado pós-revert, no unrevert) e `to` é o estado a que ele deve voltar.
 * Para cada caminho que difere entre os dois:
 *
 * - worktree == `from` → AINDA é o que o turno deixou: volta para `to`;
 * - worktree == `to`   → já está desfeito: nada a fazer;
 * - qualquer outra coisa → alguém mexeu depois (outra conversa, o usuário
 *   fora do Orbit, um agente externo): NÃO toca e reporta conflito.
 *
 * O resto da pasta não é lido além dos caminhos do diff, e nada é apagado em
 * bloco. `skip` são caminhos que o turno mudou mas que não são dele (saves
 * manuais do painel) — entram como conflito, preservados. `paths` limita a
 * transição a esses caminhos (os de autoria confirmada do turno); sem ele,
 * vale todo o diff entre `from` e `to`.
 */
export async function transition(
  directory: string,
  from: string,
  to: string,
  options: { skip?: Set<string>; paths?: string[] } = {},
): Promise<TransitionResult> {
  const { skip } = options
  return comTrava(gitDirFor(directory), async () => {
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
            // checkout restaura conteúdo, modo e symlink de uma vez.
            await snapshotGitCru(directory, ['checkout', to, '--', rel])
          } else {
            await fs.rm(path.join(directory, rel), { force: true })
            await removeEmptyParents(directory, rel)
            // Mantém o índice coerente com o que sobrou; o próximo capture
            // faria isso de qualquer forma.
            await snapshotGitCru(directory, ['rm', '--cached', '--ignore-unmatch', '--', rel]).catch(() => '')
          }
          applied.push(rel)
        } else if (samePathState(current, target)) {
          already.push(rel)
        } else {
          conflicts.push(rel)
        }
      } catch (err) {
        // Um caminho ilegível não pode derrubar o revert inteiro — e não é
        // seguro sobrescrevê-lo sem saber o estado atual.
        console.error('[snapshot] transição falhou em', rel, err)
        conflicts.push(rel)
      }
    }

    return { applied, conflicts, already }
  })
}

/**
 * Caminhos que diferem entre dois trees, sem renomeação e sem mexer no nome:
 * `-z` entrega o nome cru (espaço no começo ou no fim é parte dele).
 */
async function changedPathsCru(directory: string, from: string, to: string): Promise<string[]> {
  const raw = await snapshotGitCru(directory, ['diff', '--name-only', '-z', '--no-renames', from, to])
  return raw.split('\0').filter(Boolean)
}

export async function changedPaths(directory: string, from: string, to: string): Promise<string[]> {
  if (from === to) return []
  return comTrava(gitDirFor(directory), async () => {
    await ensureRepo(directory)
    return changedPathsCru(directory, from, to)
  })
}

/**
 * Apagar o arquivo que o turno criou deixava a pasta dele para trás (o
 * `read-tree -u` antigo levava junto). Sobe removendo só as pastas que
 * ficaram VAZIAS, e nunca a raiz.
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

/** Diff entre dois trees limitado a caminhos — é o que a barra de revert mostra. */
export async function diffPaths(
  directory: string,
  from: string,
  to: string,
  paths: string[],
): Promise<SnapshotDiff> {
  if (paths.length === 0) return { files: [], patch: '' }
  return comTrava(gitDirFor(directory), async () => {
    let patch = await snapshotGitCru(directory, ['diff', '--no-ext-diff', from, to, '--', ...paths])
    if (patch.length > MAX_PATCH_CHARS) {
      patch = patch.slice(0, MAX_PATCH_CHARS) + '\n… (diff truncado)'
    }
    return { files: paths, patch }
  })
}
