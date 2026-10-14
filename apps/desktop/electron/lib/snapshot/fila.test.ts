import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A fila por pasta do engine de snapshots.
 *
 * O repositório auxiliar é POR PASTA (gitDirFor), então workers em paralelo na
 * mesma pasta — o padrão da orquestra, quando não há worktree — batem no mesmo
 * `.git/index` e disputam o `index.lock`; quem perde não grava snapshot nenhum
 * e o turno termina 'unknown' (sem badge no chat e sem diff para o revisor).
 *
 * O que se testa aqui não é o git: `execFile` é dublado para medir quantos
 * processos ficariam vivos ao mesmo tempo. Com a fila, é um por pasta; sem ela,
 * seriam 2+ e o teste quebra.
 */
const estado = vi.hoisted(() => ({
  emVoo: 0,
  pico: 0,
  falharUmaVez: false,
  userData: '',
}))

vi.mock('node:child_process', () => ({
  execFile: (
    _file: string,
    _args: string[],
    _opts: unknown,
    cb: (erro: Error | null, saida?: { stdout: string; stderr: string }) => void,
  ) => {
    estado.emVoo += 1
    estado.pico = Math.max(estado.pico, estado.emVoo)
    const falha = estado.falharUmaVez
    estado.falharUmaVez = false
    setTimeout(() => {
      estado.emVoo -= 1
      if (falha) cb(new Error('fatal: Unable to create index.lock: File exists.'))
      else cb(null, { stdout: '', stderr: '' })
    }, 25)
  },
}))

vi.mock('electron', () => ({ app: { getPath: () => estado.userData } }))

const { capture, snapshotGit } = await import('./index')

describe('fila de snapshots por pasta', () => {
  let tmp: string
  let pastaA: string
  let pastaB: string

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-fila-')))
    pastaA = path.join(tmp, 'projeto-a')
    pastaB = path.join(tmp, 'projeto-b')
    fs.mkdirSync(pastaA)
    fs.mkdirSync(pastaB)
    estado.userData = path.join(tmp, 'userData')
    estado.emVoo = 0
    estado.pico = 0
    estado.falharUmaVez = false
  })

  afterEach(async () => {
    // O gc da captura entra na fila como fire-and-forget: sem esta espera ele
    // ainda estaria de pé quando o diretório temporário fosse apagado.
    await new Promise((resolve) => setTimeout(resolve, 100))
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('não cruza operações da mesma pasta', async () => {
    // Três turnos da mesma pasta ao mesmo tempo: um de cada vez.
    await Promise.all([capture(pastaA), capture(pastaA), capture(pastaA)])
    expect(estado.pico).toBe(1)
  })

  it('o gc entra na fila e não roda no meio da captura', async () => {
    await Promise.all([capture(pastaA), snapshotGit(pastaA, ['gc', '--quiet', '--prune=7.days'])])
    expect(estado.pico).toBe(1)
  })

  it('pastas diferentes seguem em paralelo', async () => {
    // A fila é por pasta, não global: um projeto não espera pelo outro.
    await Promise.all([capture(pastaA), capture(pastaB)])
    expect(estado.pico).toBe(2)
  })

  it('captura que falha com index.lock não azeda a fila da pasta', async () => {
    estado.falharUmaVez = true
    await expect(capture(pastaA)).rejects.toThrow(/index\.lock/)
    // A próxima operação da mesma pasta roda normalmente (a cauda engole o erro).
    await expect(capture(pastaA)).resolves.toBe('')
    expect(estado.pico).toBe(1)
  })
})
