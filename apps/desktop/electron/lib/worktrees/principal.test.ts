import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../shell-env', () => ({ userShellEnv: () => process.env }))

const { limparCachePrincipal, pastaNoRepositorioPrincipal } = await import('./principal')

let tmp: string
let repo: string
let worktree: string

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-principal-')))
  repo = path.join(tmp, 'repo')
  fs.mkdirSync(path.join(repo, 'apps/web'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'apps/web/index.ts'), '')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A')
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init')
  worktree = path.join(tmp, 'fora', 'wt')
  git(repo, 'worktree', 'add', '-q', '-b', 'outro', worktree)
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

beforeEach(() => limparCachePrincipal())

describe('pastaNoRepositorioPrincipal', () => {
  it('raiz de um worktree vira a raiz do principal', async () => {
    expect(await pastaNoRepositorioPrincipal(worktree)).toBe(repo)
  })

  it('subpasta de um worktree vira a mesma subpasta no principal (monorepo)', async () => {
    expect(await pastaNoRepositorioPrincipal(path.join(worktree, 'apps/web'))).toBe(path.join(repo, 'apps/web'))
  })

  it('o principal e suas subpastas ficam como estão', async () => {
    expect(await pastaNoRepositorioPrincipal(repo)).toBe(repo)
    expect(await pastaNoRepositorioPrincipal(path.join(repo, 'apps'))).toBe(path.join(repo, 'apps'))
  })

  it('pasta sem git ou inexistente volta como veio', async () => {
    const solta = path.join(tmp, 'solta')
    fs.mkdirSync(solta, { recursive: true })
    expect(await pastaNoRepositorioPrincipal(solta)).toBe(solta)
    expect(await pastaNoRepositorioPrincipal(path.join(tmp, 'nao-existe'))).toBe(path.join(tmp, 'nao-existe'))
  })
})
