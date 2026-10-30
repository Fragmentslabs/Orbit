import { beforeEach, describe, expect, it, vi } from 'vitest'

const machine = { memGb: 16, cpus: 8, arch: 'arm64' }

vi.mock('node:os', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:os')>()
  const os = {
    ...real,
    arch: () => machine.arch,
    totalmem: () => machine.memGb * 1024 ** 3,
    cpus: () => Array.from({ length: machine.cpus }, () => real.cpus()[0]),
  }
  return { ...os, default: os }
})

const { detectMachine, machineTier, scoreMachine } = await import('./machine')

beforeEach(() => {
  machine.memGb = 16
  machine.cpus = 8
  machine.arch = 'arm64'
})

describe('scoreMachine', () => {
  it('an 8-core, 16 GB Apple Silicon clears the strong tier with room to spare', () => {
    const score = scoreMachine({ cpus: 8, totalMemGb: 15.3, platform: 'darwin', arch: 'arm64' })
    expect(machineTier(score)).toBe('strong')
  })

  it('the same Apple Silicon with 8 GB stays in the balanced tier, not the strong one', () => {
    const score = scoreMachine({ cpus: 8, totalMemGb: 8, platform: 'darwin', arch: 'arm64' })
    expect(machineTier(score)).toBe('balanced')
  })

  it('an old 4-core, 8 GB x64 is weak', () => {
    const score = scoreMachine({ cpus: 4, totalMemGb: 8, platform: 'win32', arch: 'x64' })
    expect(machineTier(score)).toBe('weak')
  })

  it('a 32 GB, 12-core machine on Windows is strong without needing the Apple bonus', () => {
    const score = scoreMachine({ cpus: 12, totalMemGb: 32, platform: 'win32', arch: 'x64' })
    expect(machineTier(score)).toBe('strong')
  })

  it('never scores negative, not even with 1 core and 2 GB', () => {
    const score = scoreMachine({ cpus: 1, totalMemGb: 2, platform: 'linux', arch: 'x64' })
    expect(score).toBe(0)
    expect(machineTier(score)).toBe('weak')
  })

  it('the first 4 cores do not count — only the slack above them', () => {
    const four = scoreMachine({ cpus: 4, totalMemGb: 32, platform: 'linux', arch: 'x64' })
    const eight = scoreMachine({ cpus: 8, totalMemGb: 32, platform: 'linux', arch: 'x64' })
    expect(eight - four).toBe(4)
  })
})

describe('detectMachine', () => {
  it('reads cores, RAM and arch from the system and settles the tier', () => {
    const info = detectMachine()
    expect(info.cpus).toBe(8)
    expect(info.totalMemGb).toBe(16)
    expect(info.arch).toBe('arm64')
    expect(info.score).toBe(
      scoreMachine({ cpus: 8, totalMemGb: 16, platform: process.platform, arch: 'arm64' }),
    )
    expect(info.tier).toBe(machineTier(info.score))
  })

  it('rounds RAM to one decimal, as the voice already did', () => {
    machine.memGb = 15.34
    expect(detectMachine().totalMemGb).toBe(15.3)
  })

  it('a 1-core machine does not become zero cores', () => {
    machine.cpus = 1
    expect(detectMachine().cpus).toBe(1)
  })
})
