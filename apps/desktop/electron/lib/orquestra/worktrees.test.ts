import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrchestrationTask } from '@shared/chat'

const userData = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => userData.dir } }))
vi.mock('../shell-env', () => ({ userShellEnv: () => process.env }))
vi.mock('../snapshot', () => ({ descartarSnapshots: vi.fn(async () => {}) }))
vi.mock('../app-settings', () => ({ getAppSettings: () => ({ worktrees: { local: 'padrao', pasta: null } }) }))

const { commitarTrabalho, criarWorktreeDoWorker, diffDoWorktree, juntarBranches, removerWorktreeDoWorker } = await import('./worktrees')

let tmp: string
let repo: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim()
}

const tarefa = (id: string, title: string): OrchestrationTask => ({ id, title, prompt: '', options: {}, status: 'idle' })

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-orq-wt-')))
  userData.dir = path.join(tmp, 'userData')
  repo = path.join(tmp, 'repo')
  fs.mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  // O git no Windows vem com core.autocrlf=true e reescreve os arquivos com
  // CRLF no checkout; os testes leem o conteúdo esperando \n. O repositório é
  // temporário, então a configuração fica local.
  git(repo, 'config', 'core.autocrlf', 'false')
  fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'linha 1\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'init')
  fs.writeFileSync(path.join(repo, '.env'), 'SEGREDO=1')
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('worktree por worker', () => {
  it('cria no branch orquestra/<plano>/<tarefa>, commita sem levar o .env e junta no chat', async () => {
    const { worktree: wa } = await criarWorktreeDoWorker({ pastaDoChat: repo, planId: 'plan_abc123', task: tarefa('a', 'Parte A'), dependencias: [] })
    expect(wa.branch).toBe('orquestra/abc123/parte-a')
    expect(wa.base).toBe('main')
    expect(fs.readFileSync(path.join(wa.caminho, '.env'), 'utf8')).toBe('SEGREDO=1')

    fs.writeFileSync(path.join(wa.caminho, 'b.txt'), 'novo\n')
    expect(await diffDoWorktree(wa)).toContain('b.txt')
    expect(await commitarTrabalho(wa, 'Parte A')).toBe(true)
    expect(git(wa.caminho, 'show', '--stat', '--format=%s', 'HEAD')).not.toContain('.env')

    const r = await juntarBranches(repo, [{ titulo: 'Parte A', worktree: wa }])
    expect(r).toEqual({ juntados: ['Parte A'] })
    expect(fs.readFileSync(path.join(repo, 'b.txt'), 'utf8')).toBe('novo\n')

    await removerWorktreeDoWorker(wa, true)
    expect(fs.existsSync(wa.caminho)).toBe(false)
    expect(git(repo, 'branch', '--list', wa.branch)).toBe('')
  })

  it('dependente parte do branch da dependência', async () => {
    const { worktree: api } = await criarWorktreeDoWorker({ pastaDoChat: repo, planId: 'plan_1', task: tarefa('api', 'API'), dependencias: [] })
    fs.writeFileSync(path.join(api.caminho, 'api.txt'), 'api\n')
    await commitarTrabalho(api, 'API')
    const { worktree: testes } = await criarWorktreeDoWorker({ pastaDoChat: repo, planId: 'plan_1', task: tarefa('t', 'Testes'), dependencias: [api] })
    expect(testes.base).toBe(api.branch)
    expect(fs.existsSync(path.join(testes.caminho, 'api.txt'))).toBe(true)
  })

  it('conflito no merge desfaz aquele merge e para, informando os arquivos', async () => {
    const { worktree: wa } = await criarWorktreeDoWorker({ pastaDoChat: repo, planId: 'plan_1', task: tarefa('a', 'A'), dependencias: [] })
    const { worktree: wb } = await criarWorktreeDoWorker({ pastaDoChat: repo, planId: 'plan_1', task: tarefa('b', 'B'), dependencias: [] })
    fs.writeFileSync(path.join(wa.caminho, 'a.txt'), 'versão A\n')
    fs.writeFileSync(path.join(wb.caminho, 'a.txt'), 'versão B\n')
    await commitarTrabalho(wa, 'A')
    await commitarTrabalho(wb, 'B')

    const r = await juntarBranches(repo, [
      { titulo: 'A', worktree: wa },
      { titulo: 'B', worktree: wb },
    ])
    expect(r.juntados).toEqual(['A'])
    expect(r.conflito).toEqual({ titulo: 'B', arquivos: ['a.txt'] })
    // O chat fica limpo, com o A juntado e sem merge pela metade
    expect(git(repo, 'status', '--porcelain')).toBe('')
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('versão A\n')
  })

  it('alteração não commitada no chat num arquivo que o worker mudou: nada é juntado e o arquivo é apontado', async () => {
    const { worktree: wa } = await criarWorktreeDoWorker({ pastaDoChat: repo, planId: 'plan_1', task: tarefa('a', 'A'), dependencias: [] })
    fs.writeFileSync(path.join(wa.caminho, 'a.txt'), 'do worker\n')
    await commitarTrabalho(wa, 'A')
    fs.writeFileSync(path.join(repo, 'a.txt'), 'meu rascunho\n')

    const r = await juntarBranches(repo, [{ titulo: 'A', worktree: wa }])
    expect(r).toEqual({ juntados: [], bloqueio: { arquivos: ['a.txt'] } })
    // O rascunho do usuário fica intacto
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('meu rascunho\n')
  })

  it('alteração não commitada em arquivo que nenhum worker tocou não atrapalha', async () => {
    const { worktree: wa } = await criarWorktreeDoWorker({ pastaDoChat: repo, planId: 'plan_1', task: tarefa('a', 'A'), dependencias: [] })
    fs.writeFileSync(path.join(wa.caminho, 'novo.txt'), 'x\n')
    await commitarTrabalho(wa, 'A')
    fs.writeFileSync(path.join(repo, 'a.txt'), 'meu rascunho\n')

    const r = await juntarBranches(repo, [{ titulo: 'A', worktree: wa }])
    expect(r).toEqual({ juntados: ['A'] })
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('meu rascunho\n')
  })
})
