import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const userData = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => userData.dir } }))
vi.mock('../shell-env', () => ({ userShellEnv: () => process.env }))
vi.mock('../app-settings', () => ({ getAppSettings: () => ({ worktrees: { local: 'padrao', pasta: null } }) }))

const { diffDaPasta, diffDosTurnos } = await import('./diff')

describe('diffDosTurnos', () => {
  it('monta o patch dos turnos capturados e não avisa nada', () => {
    const r = diffDosTurnos([
      { files: ['a.ts'], patch: 'patch-a', verified: 'changed' },
      { verified: 'unchanged' },
    ])
    expect(r.indisponivel).toBeUndefined()
    expect(r.patch).toContain('- a.ts')
    expect(r.patch).toContain('patch-a')
  })

  it('captura inicial falhada vira aviso com o motivo — nunca "diff vazio"', () => {
    const r = diffDosTurnos([{ failed: true, captureError: 'index.lock: File exists' }])
    expect(r.patch).toBe('')
    expect(r.indisponivel).toContain('UNAVAILABLE')
    expect(r.indisponivel).toContain('index.lock: File exists')
    expect(r.indisponivel).toContain('does NOT mean')
  })

  it("captura final falhada (verified 'unknown') também vira aviso", () => {
    const r = diffDosTurnos([{ verified: 'unknown' }])
    expect(r.patch).toBe('')
    expect(r.indisponivel).toContain('UNAVAILABLE')
  })

  it('mistura: o patch dos turnos capturados vai junto do aviso', () => {
    const r = diffDosTurnos([
      { files: ['a.ts'], patch: 'patch-a', verified: 'changed' },
      { failed: true, captureError: 'lock' },
    ])
    expect(r.patch).toContain('patch-a')
    expect(r.indisponivel).toContain('only the turns that were captured')
  })

  it('sem nenhum snapshot registrado, o canal está vazio — e isso é dito', () => {
    const r = diffDosTurnos([])
    expect(r.patch).toBe('')
    expect(r.indisponivel).toContain('UNAVAILABLE')
  })
})

describe('diffDaPasta', () => {
  let tmp: string
  let repo: string

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim()

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-orq-diff-')))
    userData.dir = path.join(tmp, 'userData')
    repo = path.join(tmp, 'repo')
    fs.mkdirSync(repo)
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'core.autocrlf', 'false')
    fs.writeFileSync(path.join(repo, 'a.txt'), 'linha 1\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'init')
  })
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it('mostra o que está alterado na pasta — inclusive staged (o worker dá git add)', async () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'mudou\n')
    git(repo, 'add', 'a.txt')
    const d = await diffDaPasta(repo)
    expect(d).toContain('a.txt')
    expect(d).toContain('compartilhada')
    expect(d).toContain('mudou')
  })

  it('pasta limpa não devolve nada', async () => {
    expect(await diffDaPasta(repo)).toBe('')
  })

  it('pasta que não é repositório não devolve nada (nem lança)', async () => {
    const solta = path.join(tmp, 'solta')
    fs.mkdirSync(solta)
    expect(await diffDaPasta(solta)).toBe('')
  })
})
