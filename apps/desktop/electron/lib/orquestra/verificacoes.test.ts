import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../shell-env', () => ({ userShellEnv: () => process.env }))

const { descobrirVerificacoes, rodarVerificacao } = await import('./verificacoes')

let tmp: string

function escrever(relativo: string, conteudo: string) {
  const caminho = path.join(tmp, relativo)
  fs.mkdirSync(path.dirname(caminho), { recursive: true })
  fs.writeFileSync(caminho, conteudo)
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-verif-')))
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('descobrirVerificacoes', () => {
  it('pega só scripts que verificam e terminam, com o gerenciador do lockfile', async () => {
    escrever('package.json', JSON.stringify({
      scripts: {
        typecheck: 'tsc --noEmit',
        lint: 'eslint .',
        test: 'vitest run',
        'test:watch': 'vitest',
        'test:e2e': 'playwright test --ui',
        dev: 'vite',
        build: 'vite build',
      },
    }))
    escrever('pnpm-lock.yaml', '')
    const v = await descobrirVerificacoes(tmp)
    expect(v.map((x) => x.nome).sort()).toEqual(['lint', 'test', 'typecheck'])
    expect(v.find((x) => x.nome === 'test')).toMatchObject({ comando: 'pnpm', args: ['run', 'test'] })
  })

  it('em monorepo, junta os da subpasta e os da raiz', async () => {
    escrever('package.json', JSON.stringify({ scripts: { lint: 'eslint .' } }))
    escrever('apps/web/package.json', JSON.stringify({ scripts: { typecheck: 'tsc' } }))
    escrever('Makefile', 'test:\n\tgo test ./...\nbuild:\n\tgo build\n')
    const v = await descobrirVerificacoes(path.join(tmp, 'apps/web'), tmp)
    expect(v.map((x) => x.nome).sort()).toEqual(['lint (raiz)', 'make test (raiz)', 'typecheck'])
  })

  it('projeto sem scripts não tem verificações', async () => {
    expect(await descobrirVerificacoes(tmp)).toEqual([])
  })
})

describe('rodarVerificacao', () => {
  it('passa e falha pelo código de saída, com a saída junto', async () => {
    const ok = await rodarVerificacao({ nome: 'ok', comando: 'sh', args: ['-c', 'echo tudo certo'], pasta: tmp })
    expect(ok).toEqual({ ok: true, saida: 'tudo certo' })
    const falha = await rodarVerificacao({ nome: 'x', comando: 'sh', args: ['-c', 'echo erro em a.ts >&2; exit 2'], pasta: tmp })
    expect(falha.ok).toBe(false)
    expect(falha.saida).toContain('erro em a.ts')
  })
})
