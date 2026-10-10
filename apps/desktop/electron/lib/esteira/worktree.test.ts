import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const userData = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => userData.dir } }))
vi.mock('../shell-env', () => ({ userShellEnv: () => process.env }))
vi.mock('../snapshot', () => ({ descartarSnapshots: vi.fn(async () => {}) }))

const { acharExtras, criarWorktree, limparOrfaos, nomeDoBranch, removerWorktree, slug } = await import('./worktree')

let tmp: string
let repo: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function escrever(raiz: string, relativo: string, conteudo = 'x') {
  const caminho = path.join(raiz, relativo)
  fs.mkdirSync(path.dirname(caminho), { recursive: true })
  fs.writeFileSync(caminho, conteudo)
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-wt-')))
  userData.dir = path.join(tmp, 'userData')
  repo = path.join(tmp, 'repo')
  fs.mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 't@t')
  git(repo, 'config', 'user.name', 't')
  escrever(repo, '.gitignore', 'node_modules/\n.env*\n!.env.example\n')
  escrever(repo, 'package.json', '{}')
  escrever(repo, 'apps/web/package.json', '{}')
  escrever(repo, '.env.example', 'EXEMPLO=1')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'init')
  // Ignorados: precisam ser levados ao worktree à parte
  escrever(repo, 'node_modules/lib/index.js', 'raiz')
  escrever(repo, 'node_modules/lib/node_modules/sub/index.js', 'aninhado')
  escrever(repo, 'apps/web/node_modules/react/index.js', 'web')
  escrever(repo, '.env', 'SEGREDO=1')
  escrever(repo, 'apps/web/.env.local', 'WEB=1')
})

afterEach(() => {
  try {
    git(repo, 'worktree', 'prune')
  } catch {
    // repo pode não existir
  }
  fs.rmSync(tmp, { recursive: true, force: true })
})

const task = { id: 'task_abc123XYZ', titulo: 'Calcular frete (v2)!', worktree: undefined }

describe('nomes', () => {
  it('slug tira acento e símbolo', () => {
    expect(slug('Ação: Calcular Frete (v2)!')).toBe('acao-calcular-frete-v2')
    expect(slug('!!!')).toBe('task')
  })
  it('branch legível e único pelo id', () => {
    expect(nomeDoBranch(task)).toBe('esteira/calcular-frete-v2-123xyz')
  })
})

describe('acharExtras', () => {
  it('acha os node_modules dos workspaces sem descer neles, e os .env', async () => {
    const { modulos, envs } = await acharExtras(repo)
    expect(modulos.sort()).toEqual(['apps/web/node_modules', 'node_modules'])
    expect(envs.sort()).toEqual(['.env', '.env.example', 'apps/web/.env.local'])
  })
})

describe('criarWorktree', () => {
  it('cria o branch a partir da base, leva .env e node_modules', async () => {
    const wt = await criarWorktree({ pastaPrincipal: repo, projetoId: 'proj_1', task })

    expect(wt.caminho).toBe(path.join(userData.dir, 'orbit-data', 'worktrees', 'proj_1', task.id))
    expect(wt.pasta).toBe(wt.caminho)
    expect(wt.branch).toBe('esteira/calcular-frete-v2-123xyz')
    expect(wt.base).toBe('main')
    expect(git(wt.caminho, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(wt.branch)
    expect(fs.readFileSync(path.join(wt.caminho, '.env'), 'utf8')).toBe('SEGREDO=1')
    expect(fs.readFileSync(path.join(wt.caminho, 'apps/web/.env.local'), 'utf8')).toBe('WEB=1')
    expect(fs.readFileSync(path.join(wt.caminho, 'apps/web/node_modules/react/index.js'), 'utf8')).toBe('web')
    expect(fs.readFileSync(path.join(wt.caminho, 'node_modules/lib/node_modules/sub/index.js'), 'utf8')).toBe('aninhado')
    if (process.platform === 'darwin') expect(wt.dependencias).toBe('clonadas')

    // Clonado (ou vinculado), mexer no worktree não pode mudar o principal quando clonado
    if (wt.dependencias === 'clonadas') {
      fs.writeFileSync(path.join(wt.caminho, 'node_modules/lib/index.js'), 'mudou')
      expect(fs.readFileSync(path.join(repo, 'node_modules/lib/index.js'), 'utf8')).toBe('raiz')
    }
  })

  it('pasta principal numa subpasta do repositório: a pasta de trabalho é a mesma subpasta no worktree', async () => {
    const wt = await criarWorktree({ pastaPrincipal: path.join(repo, 'apps/web'), projetoId: 'proj_1', task })
    expect(wt.pasta).toBe(path.join(wt.caminho, 'apps/web'))
  })

  it('parte da base pedida (branch de uma dependência)', async () => {
    git(repo, 'branch', 'esteira/dependencia')
    const wt = await criarWorktree({ pastaPrincipal: repo, projetoId: 'proj_1', task, base: 'esteira/dependencia' })
    expect(wt.base).toBe('esteira/dependencia')
  })

  it('recria no mesmo branch quando a pasta sumiu, com o trabalho commitado', async () => {
    const wt = await criarWorktree({ pastaPrincipal: repo, projetoId: 'proj_1', task })
    escrever(wt.caminho, 'feito.txt', 'trabalho')
    git(wt.caminho, 'add', 'feito.txt')
    git(wt.caminho, 'commit', '-qm', 'trabalho')
    fs.rmSync(wt.caminho, { recursive: true, force: true })

    const recriado = await criarWorktree({ pastaPrincipal: repo, projetoId: 'proj_1', task: { ...task, worktree: wt } })
    expect(recriado.branch).toBe(wt.branch)
    expect(fs.readFileSync(path.join(recriado.caminho, 'feito.txt'), 'utf8')).toBe('trabalho')
  })

  it('recusa pasta que não é repositório git', async () => {
    const solta = path.join(tmp, 'solta')
    fs.mkdirSync(solta)
    await expect(criarWorktree({ pastaPrincipal: solta, projetoId: 'p', task })).rejects.toThrow(/não é um repositório git/)
  })

  it('recusa repositório sem commits', async () => {
    const vazio = path.join(tmp, 'vazio')
    fs.mkdirSync(vazio)
    git(vazio, 'init', '-q')
    await expect(criarWorktree({ pastaPrincipal: vazio, projetoId: 'p', task })).rejects.toThrow(/nenhum commit/)
  })
})

describe('removerWorktree e limparOrfaos', () => {
  it('remove a pasta e mantém o branch, a menos que peça para apagar', async () => {
    const wt = await criarWorktree({ pastaPrincipal: repo, projetoId: 'proj_1', task })
    await removerWorktree(repo, wt)
    expect(fs.existsSync(wt.caminho)).toBe(false)
    expect(git(repo, 'branch', '--list', wt.branch)).toContain(wt.branch)
    // O node_modules do principal não pode ir junto (caso vinculado)
    expect(fs.existsSync(path.join(repo, 'node_modules/lib/index.js'))).toBe(true)

    const outro = await criarWorktree({ pastaPrincipal: repo, projetoId: 'proj_1', task: { ...task, id: 'task_outra000' } })
    await removerWorktree(repo, outro, { apagarBranch: true })
    expect(git(repo, 'branch', '--list', outro.branch)).toBe('')
  })

  it('apaga worktrees de tasks que não existem mais e mantém as vivas', async () => {
    const viva = await criarWorktree({ pastaPrincipal: repo, projetoId: 'proj_1', task })
    const orfa = await criarWorktree({ pastaPrincipal: repo, projetoId: 'proj_1', task: { ...task, id: 'task_orfa0000' } })

    await limparOrfaos([{ id: 'proj_1', pastas: [repo] }], new Map([['proj_1', new Set([task.id])]]))

    expect(fs.existsSync(viva.caminho)).toBe(true)
    expect(fs.existsSync(orfa.caminho)).toBe(false)
    expect(git(repo, 'worktree', 'list')).not.toContain('task_orfa0000')
  })

  it('não toca nos worktrees dos chats, que moram na mesma raiz', async () => {
    const doChat = path.join(userData.dir, 'orbit-data', 'worktrees', 'chats', 'repo-abc123', 'login')
    fs.mkdirSync(doChat, { recursive: true })
    fs.writeFileSync(path.join(doChat, 'trabalho.txt'), 'nao commitado')

    await limparOrfaos([{ id: 'proj_1', pastas: [repo] }], new Map())

    expect(fs.readFileSync(path.join(doChat, 'trabalho.txt'), 'utf8')).toBe('nao commitado')
  })
})
