import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { CriarWorktreeResultado, ListaWorktrees, WorktreeInfo } from '@shared/worktrees'
import { killProcess, listProcesses } from '../process-manager'
import { descartarSnapshots } from '../snapshot'
import { baseAtual, branchExiste, existe, git, pastaDosWorktrees, prepararDependencias, raizDoRepositorio, slug } from './nucleo'
import { pastaNoRepositorioPrincipal } from './principal'

/**
 * Worktrees nos chats: o seletor de worktree (header) e as ferramentas do
 * agente (worktree_*) passam por aqui.
 *
 * A lista vem do próprio git (`git worktree list`), então aparecem também os
 * worktrees criados fora do Orbit. Os criados pelos chats moram em
 * orbit-data/worktrees/chats/<repo>/<nome>, num branch `orbit/<nome>`; os da
 * esteira (orbit-data/worktrees/<projeto>/<task>) aparecem, mas quem cuida
 * deles é a esteira.
 */

const PASTA_CHATS = 'chats'

function pastaDosChats(): string {
  return path.join(pastaDosWorktrees(), PASTA_CHATS)
}

/** `<nome>-<hash>`: legível no Finder e sem colidir entre repositórios homônimos. */
function idDoRepositorio(repo: string): string {
  const hash = crypto.createHash('sha1').update(path.resolve(repo)).digest('hex').slice(0, 6)
  return `${slug(path.basename(repo))}-${hash}`
}

function dentro(pasta: string, raiz: string): boolean {
  const relativo = path.relative(raiz, pasta)
  return relativo === '' || (!relativo.startsWith('..') && !path.isAbsolute(relativo))
}

async function real(pasta: string): Promise<string> {
  return fs.realpath(pasta).catch(() => path.resolve(pasta))
}

interface BlocoPorcelain {
  caminho: string
  head: string
  branch?: string
  bare: boolean
  prunable: boolean
  travado: boolean
}

/** `git worktree list --porcelain`: blocos separados por linha em branco. */
export function lerPorcelain(saida: string): BlocoPorcelain[] {
  const blocos: BlocoPorcelain[] = []
  for (const bloco of saida.split(/\n\s*\n/)) {
    const linhas = bloco.split('\n').map((l) => l.trim()).filter(Boolean)
    const caminho = linhas.find((l) => l.startsWith('worktree '))?.slice('worktree '.length)
    if (!caminho) continue
    const ref = linhas.find((l) => l.startsWith('branch '))?.slice('branch '.length)
    blocos.push({
      caminho,
      head: linhas.find((l) => l.startsWith('HEAD '))?.slice('HEAD '.length) ?? '',
      branch: ref?.replace(/^refs\/heads\//, ''),
      bare: linhas.includes('bare'),
      prunable: linhas.some((l) => l.startsWith('prunable')),
      travado: linhas.some((l) => l.startsWith('locked')),
    })
  }
  return blocos
}

async function contarAlteracoes(caminho: string): Promise<number> {
  try {
    const saida = await git(caminho, ['status', '--porcelain'])
    return saida ? saida.split('\n').length : 0
  } catch {
    return 0
  }
}

async function commitsAFrente(repo: string, base: string | undefined, branch: string | undefined): Promise<number> {
  if (!base || !branch || base === branch) return 0
  try {
    return Number(await git(repo, ['rev-list', '--count', `${base}..${branch}`])) || 0
  } catch {
    return 0
  }
}

/**
 * Worktrees do repositório da pasta, com o estado de cada um e a pasta
 * equivalente nele (mesma subpasta em que o chat está). null quando a pasta
 * não está num repositório git.
 */
export async function listarWorktrees(pasta: string): Promise<ListaWorktrees | null> {
  const principal = await pastaNoRepositorioPrincipal(pasta)
  let repo: string
  try {
    repo = await raizDoRepositorio(principal)
  } catch {
    return null
  }
  const blocos = lerPorcelain(await git(repo, ['worktree', 'list', '--porcelain'])).filter((b) => !b.bare)
  if (blocos.length === 0) return null

  // Subpasta em que o chat está, relativa ao worktree atual — o equivalente
  // em cada worktree é a mesma subpasta (monorepo).
  const pastaReal = await real(pasta)
  const raizesReais = await Promise.all(blocos.map((b) => real(b.caminho)))
  let atual = 0
  let melhor = -1
  raizesReais.forEach((raiz, i) => {
    if (dentro(pastaReal, raiz) && raiz.length > melhor) {
      atual = i
      melhor = raiz.length
    }
  })
  const relativo = melhor >= 0 ? path.relative(raizesReais[atual], pastaReal) : ''

  const doOrbit = pastaDosWorktrees()
  const dosChats = pastaDosChats()
  const branchPrincipal = blocos[0].branch
  const worktrees: WorktreeInfo[] = await Promise.all(
    blocos.map(async (bloco, i): Promise<WorktreeInfo> => {
      const principalDoRepo = i === 0
      const ativo = !bloco.prunable && (await existe(bloco.caminho))
      // A subpasta do chat pode não existir em outro worktree (criada só num
      // branch): aí o chat vai para a raiz dele, em vez de uma pasta inexistente.
      const equivalente = relativo ? path.join(bloco.caminho, relativo) : bloco.caminho
      return {
        caminho: bloco.caminho,
        pasta: equivalente !== bloco.caminho && !(await existe(equivalente)) ? bloco.caminho : equivalente,
        nome: path.basename(bloco.caminho),
        branch: bloco.branch,
        head: bloco.head.slice(0, 7),
        principal: principalDoRepo,
        origem: principalDoRepo
          ? 'principal'
          : dentro(bloco.caminho, dosChats)
            ? 'chat'
            : dentro(bloco.caminho, doOrbit)
              ? 'esteira'
              : 'externo',
        disponivel: ativo,
        travado: bloco.travado,
        alteracoes: ativo ? await contarAlteracoes(bloco.caminho) : 0,
        aFrente: principalDoRepo ? 0 : await commitsAFrente(repo, branchPrincipal, bloco.branch),
      }
    }),
  )
  return { repo, atual: worktrees[atual].caminho, worktrees }
}

/**
 * Cria um worktree para os chats, num branch `orbit/<nome>` a partir de
 * `base` (padrão: o branch atual do principal). Nome repetido ganha sufixo.
 */
export async function criarWorktreeDoChat(opts: {
  pasta: string
  nome: string
  base?: string
  signal?: AbortSignal
}): Promise<CriarWorktreeResultado> {
  const principal = await pastaNoRepositorioPrincipal(opts.pasta)
  const repo = await raizDoRepositorio(principal)
  try {
    await git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  } catch {
    throw new Error('O repositório ainda não tem nenhum commit — o worktree precisa de um ponto de partida.')
  }
  const base = opts.base?.trim() || (await baseAtual(repo))
  const raizChats = path.join(pastaDosChats(), idDoRepositorio(repo))
  const nomeBase = slug(opts.nome)
  let nome = nomeBase
  for (let n = 2; (await branchExiste(repo, `orbit/${nome}`)) || (await existe(path.join(raizChats, nome))); n++) {
    nome = `${nomeBase}-${n}`
  }
  const caminho = path.join(raizChats, nome)
  const branch = `orbit/${nome}`

  await git(repo, ['worktree', 'prune']).catch(() => {})
  await fs.mkdir(raizChats, { recursive: true })
  await git(repo, ['worktree', 'add', '-b', branch, caminho, base], opts.signal)
  const dependencias = await prepararDependencias(repo, caminho)

  // A mesma subpasta do principal (monorepo): o chat continua onde estava.
  const relativo = path.relative(repo, await real(principal))
  const pasta = relativo && !relativo.startsWith('..') ? path.join(caminho, relativo) : caminho
  return { caminho, pasta, branch, base, dependencias }
}

/**
 * Remove um worktree (pasta, registro no git, snapshots e processos em
 * background rodando lá dentro). O branch só sai com `apagarBranch`.
 * Recusa o principal e os da esteira (a esteira remove os dela).
 *
 * `pasta`: uma pasta viva do mesmo repositório (a do chat). A lista é
 * consultada a partir dela — o worktree a remover pode ser justamente um cuja
 * pasta já sumiu, e a partir dele o git não acharia o repositório.
 */
export async function removerWorktreeDoChat(opts: {
  pasta: string
  caminho: string
  apagarBranch?: boolean
}): Promise<void> {
  const lista = await listarWorktrees(opts.pasta)
  if (!lista) throw new Error('A pasta não está num repositório git.')
  const alvo = lista.worktrees.find((w) => path.resolve(w.caminho) === path.resolve(opts.caminho))
  if (!alvo) throw new Error(`Worktree não encontrado: ${opts.caminho}`)
  if (alvo.principal) throw new Error('O repositório principal não é um worktree removível.')
  if (alvo.origem === 'esteira') throw new Error('Este worktree é de uma task da esteira — remova pela esteira.')

  const raizReal = await real(alvo.caminho)
  for (const processo of listProcesses()) {
    if (processo.status === 'running' && processo.cwd && dentro(await real(processo.cwd), raizReal)) {
      await killProcess(processo.pid).catch(() => false)
    }
  }
  await git(lista.repo, ['worktree', 'remove', '--force', alvo.caminho]).catch(() => {})
  await fs.rm(alvo.caminho, { recursive: true, force: true })
  await git(lista.repo, ['worktree', 'prune']).catch(() => {})
  if (opts.apagarBranch && alvo.branch) await git(lista.repo, ['branch', '-D', alvo.branch]).catch(() => {})
  await descartarSnapshots(alvo.caminho).catch(() => {})
  if (alvo.pasta !== alvo.caminho) await descartarSnapshots(alvo.pasta).catch(() => {})
}
