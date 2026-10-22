import { beforeEach, describe, expect, it, vi } from 'vitest'

const maquina = { memGb: 16, cpus: 8, arch: 'arm64' }

vi.mock('node:os', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:os')>()
  const os = {
    ...real,
    arch: () => maquina.arch,
    totalmem: () => maquina.memGb * 1024 ** 3,
    cpus: () => Array.from({ length: maquina.cpus }, () => real.cpus()[0]),
  }
  return { ...os, default: os }
})

const { detectMachine, machineTier, scoreMachine } = await import('./machine')

beforeEach(() => {
  maquina.memGb = 16
  maquina.cpus = 8
  maquina.arch = 'arm64'
})

describe('scoreMachine', () => {
  it('um Apple Silicon de 8 núcleos e 16 GB passa de largo do degrau forte', () => {
    const score = scoreMachine({ cpus: 8, totalMemGb: 15.3, platform: 'darwin', arch: 'arm64' })
    expect(machineTier(score)).toBe('strong')
  })

  it('o mesmo Apple Silicon com 8 GB fica no equilibrado, não no forte', () => {
    const score = scoreMachine({ cpus: 8, totalMemGb: 8, platform: 'darwin', arch: 'arm64' })
    expect(machineTier(score)).toBe('balanced')
  })

  it('um x64 antigo de 4 núcleos e 8 GB é fraco', () => {
    const score = scoreMachine({ cpus: 4, totalMemGb: 8, platform: 'win32', arch: 'x64' })
    expect(machineTier(score)).toBe('weak')
  })

  it('máquina de 32 GB e 12 núcleos no Windows é forte sem precisar do bônus da Apple', () => {
    const score = scoreMachine({ cpus: 12, totalMemGb: 32, platform: 'win32', arch: 'x64' })
    expect(machineTier(score)).toBe('strong')
  })

  it('nunca pontua negativo, nem com 1 núcleo e 2 GB', () => {
    const score = scoreMachine({ cpus: 1, totalMemGb: 2, platform: 'linux', arch: 'x64' })
    expect(score).toBe(0)
    expect(machineTier(score)).toBe('weak')
  })

  it('os 4 primeiros núcleos não contam — só a folga acima deles', () => {
    const quatro = scoreMachine({ cpus: 4, totalMemGb: 32, platform: 'linux', arch: 'x64' })
    const oito = scoreMachine({ cpus: 8, totalMemGb: 32, platform: 'linux', arch: 'x64' })
    expect(oito - quatro).toBe(4)
  })
})

describe('detectMachine', () => {
  it('lê núcleos, RAM e arch do sistema e fecha o tier', () => {
    const info = detectMachine()
    expect(info.cpus).toBe(8)
    expect(info.totalMemGb).toBe(16)
    expect(info.arch).toBe('arm64')
    expect(info.score).toBe(
      scoreMachine({ cpus: 8, totalMemGb: 16, platform: process.platform, arch: 'arm64' }),
    )
    expect(info.tier).toBe(machineTier(info.score))
  })

  it('arredonda a RAM a uma casa, como a voz já fazia', () => {
    maquina.memGb = 15.34
    expect(detectMachine().totalMemGb).toBe(15.3)
  })

  it('máquina de 1 núcleo não vira zero núcleos', () => {
    maquina.cpus = 1
    expect(detectMachine().cpus).toBe(1)
  })
})
