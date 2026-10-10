import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const userData = vi.hoisted(() => ({ dir: '' }))
const processos = vi.hoisted(() => ({ lista: [] as Array<{ pid: number; cwd: string; status: string }>, mortos: [] as number[] }))
vi.mock('electron', () => ({ app: { getPath: () => userData.dir } }))
vi.mock('../shell-env', () => ({ userShellEnv: () => process.env }))
vi.mock('../snapshot', () => ({ descartarSnapshots: vi.fn(async () => {}) }))
vi.mock('../process-manager', () => ({
  listProcesses: () => processos.lista,
  killProcess: vi.fn(async (pid: number) => {
    processos.mortos.push(pid)
    return true
  }),
}))

const { criarWorktreeDoChat, lerPorcelain, listarWorktrees, removerWorktreeDoChat } = await import('./servico')
const { limparCachePrincipal } = await import('./principal')

let tmp: string
let repo: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim()
}

function escrever(raiz: string, relativo: string, conteudo = 'x') {
  const caminho = path.join(raiz, relativo)
  fs.mkdirSync(path.dirname(caminho), { recursive: true })
  fs.writeFileSync(caminho, conteudo)
}

beforeEach(() => {
  limparCachePrincipal()
  processos.lista = []
  processos.mortos = []
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-wt-chat-')))
  userData.dir = path.join(tmp, 'userData')
  repo = path.join(tmp, 'Meu Projeto')
  fs.mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  escrever(repo, '.gitignore', 'node_modules/\n.env\n')
  escrever(repo, 'apps/web/index.ts')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'init')
  escrever(repo, '.env', 'SEGREDO=1')
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('lerPorcelain', () => {
  it('lê branch, detached, bare e prunable', () => {
    const blocos = lerPorcelain(
      [
        'worktree /r',
        'HEAD aaa',
        'branch refs/heads/main',
        '',
        'worktree /w1',
        'HEAD bbb',
        'detached',
        '',
        'worktree /w2',
        'HEAD ccc',
        'branch refs/heads/orbit/x',
        'prunable gitdir file points to non-existent location',
        '',
      ].join('\n'),
    )
    expect(blocos.map((b) => [b.caminho, b.branch, b.prunable])).toEqual([
      ['/r', 'main', false],
      ['/w1', undefined, false],
      ['/w2', 'orbit/x', true],
    ])
  })
})

describe('criar e listar', () => {
  it('cria no branch orbit/<nome>, com sufixo quando o nome já existe, e leva o .env', async () => {
    const a = await criarWorktreeDoChat({ pasta: repo, nome: 'Refatorar Login' })
    const b = await criarWorktreeDoChat({ pasta: repo, nome: 'Refatorar Login' })

    expect(a.branch).toBe('orbit/refatorar-login')
    expect(b.branch).toBe('orbit/refatorar-login-2')
    expect(a.base).toBe('main')
    expect(a.caminho.startsWith(path.join(userData.dir, 'orbit-data', 'worktrees', 'chats', 'meu-projeto-'))).toBe(true)
    expect(fs.readFileSync(path.join(a.caminho, '.env'), 'utf8')).toBe('SEGREDO=1')
    expect(git(a.caminho, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('orbit/refatorar-login')
  })

  it('chat numa subpasta continua na mesma subpasta do worktree', async () => {
    const criado = await criarWorktreeDoChat({ pasta: path.join(repo, 'apps/web'), nome: 'x' })
    expect(criado.pasta).toBe(path.join(criado.caminho, 'apps/web'))
  })

  it('lista principal primeiro, com origem, estado e a pasta equivalente em cada um', async () => {
    const chat = await criarWorktreeDoChat({ pasta: repo, nome: 'chat' })
    escrever(chat.caminho, 'novo.txt')
    git(chat.caminho, 'add', 'novo.txt')
    git(chat.caminho, 'commit', '-qm', 'novo')
    escrever(chat.caminho, 'sujo.txt')

    const externo = path.join(tmp, 'externo')
    git(repo, 'worktree', 'add', '-q', '-b', 'feito-a-mao', externo)
    const daEsteira = path.join(userData.dir, 'orbit-data', 'worktrees', 'proj_1', 'task_1')
    git(repo, 'worktree', 'add', '-q', '-b', 'esteira/t', daEsteira)

    const lista = await listarWorktrees(path.join(chat.caminho, 'apps/web'))
    expect(lista).not.toBeNull()
    expect(lista!.repo).toBe(repo)
    expect(lista!.atual).toBe(chat.caminho)
    const porOrigem = Object.fromEntries(lista!.worktrees.map((w) => [w.origem, w]))
    expect(lista!.worktrees[0].principal).toBe(true)
    expect(porOrigem.principal.pasta).toBe(path.join(repo, 'apps/web'))
    expect(porOrigem.chat.alteracoes).toBe(1)
    expect(porOrigem.chat.aFrente).toBe(1)
    expect(porOrigem.externo.branch).toBe('feito-a-mao')
    expect(porOrigem.esteira.caminho).toBe(daEsteira)
  })

  it('pasta fora de repositório git não tem worktrees', async () => {
    const solta = path.join(tmp, 'solta')
    fs.mkdirSync(solta)
    expect(await listarWorktrees(solta)).toBeNull()
  })
})

describe('remover', () => {
  it('apaga a pasta, encerra processos lá dentro e mantém o branch', async () => {
    const criado = await criarWorktreeDoChat({ pasta: repo, nome: 'tchau' })
    processos.lista = [
      { pid: 11, cwd: path.join(criado.caminho, 'apps/web'), status: 'running' },
      { pid: 22, cwd: repo, status: 'running' },
    ]
    await removerWorktreeDoChat({ pasta: repo, caminho: criado.caminho })

    expect(fs.existsSync(criado.caminho)).toBe(false)
    expect(processos.mortos).toEqual([11])
    expect(git(repo, 'branch', '--list', 'orbit/tchau')).toContain('orbit/tchau')
    expect(git(repo, 'worktree', 'list')).not.toContain('tchau')
  })

  it('apaga o branch quando pedido', async () => {
    const criado = await criarWorktreeDoChat({ pasta: repo, nome: 'tchau' })
    await removerWorktreeDoChat({ pasta: repo, caminho: criado.caminho, apagarBranch: true })
    expect(git(repo, 'branch', '--list', 'orbit/tchau')).toBe('')
  })

  it('recusa o principal e os da esteira', async () => {
    await expect(removerWorktreeDoChat({ pasta: repo, caminho: repo })).rejects.toThrow(/principal/)
    const daEsteira = path.join(userData.dir, 'orbit-data', 'worktrees', 'proj_1', 'task_1')
    git(repo, 'worktree', 'add', '-q', '-b', 'esteira/t', daEsteira)
    await expect(removerWorktreeDoChat({ pasta: repo, caminho: daEsteira })).rejects.toThrow(/esteira/)
    expect(fs.existsSync(daEsteira)).toBe(true)
  })

  it('remove um worktree cuja pasta já foi apagada à mão', async () => {
    const criado = await criarWorktreeDoChat({ pasta: repo, nome: 'sumiu' })
    fs.rmSync(criado.caminho, { recursive: true, force: true })
    const antes = await listarWorktrees(repo)
    expect(antes!.worktrees.find((w) => w.caminho === criado.caminho)?.disponivel).toBe(false)

    await removerWorktreeDoChat({ pasta: repo, caminho: criado.caminho })
    expect(git(repo, 'worktree', 'list')).not.toContain('sumiu')
  })
})

describe('pasta equivalente', () => {
  it('cai na raiz do worktree quando a subpasta do chat não existe nele', async () => {
    const criado = await criarWorktreeDoChat({ pasta: repo, nome: 'outro' })
    escrever(repo, 'so-no-principal/a.txt')
    const lista = await listarWorktrees(path.join(repo, 'so-no-principal'))
    expect(lista!.worktrees.find((w) => w.caminho === criado.caminho)?.pasta).toBe(criado.caminho)
  })
})
