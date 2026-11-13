import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The real module reads the app data folder; here it is a temp folder.
const userData = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => userData.dir } }))

import { listRoutines, listRuns } from './repo'

/**
 * The migration runs once per process, so the legacy data has to be in place
 * before the first read: it all happens in this first test.
 */
const legacyRoutine = {
  id: 'rot_1',
  titulo: 'Revisar PRs',
  prompt: 'Revise os PRs abertos',
  agenda: { horario: '09:00', dias: [1, 3] },
  modelo: { providerId: 'anthropic', modelId: 'claude' },
  modos: { loop: true, brain: false, web: true, allowAll: false, permissionMode: 'acceptEdits' },
  pastas: ['/repo'],
  visionModel: { providerId: 'anthropic', modelId: 'claude' },
  ativa: true,
  criadoEm: 1704164645000,
  ultimaExecucao: 1704272400000,
}

const legacyIntervalRoutine = {
  id: 'rot_2',
  titulo: 'Backup',
  prompt: 'Faça o backup',
  agenda: { intervaloDias: 7, intervaloHoras: 6, umaVezData: '2024-05-01' },
  modelo: { providerId: 'anthropic', modelId: 'claude' },
  modos: { loop: false, brain: false, web: false, allowAll: true },
  mode: 'code',
  pastas: [],
  ativa: false,
  criadoEm: 1706843045000,
}

const legacyRuns = [
  {
    rotinaId: 'rot_1',
    sessionId: 'rotina_abc',
    iniciadoEm: 1700000000000,
    concluidoEm: 1700000060000,
    status: 'ok',
    tokens: 1200,
    custo: 0.25,
  },
  {
    rotinaId: 'rot_1',
    sessionId: 'rotina_def',
    iniciadoEm: 1700000100000,
    status: 'rodando',
    tokens: 0,
    custo: 0,
  },
  {
    rotinaId: 'rot_1',
    sessionId: 'rotina_ghi',
    iniciadoEm: 1700000200000,
    concluidoEm: 1700000300000,
    status: 'erro',
    erro: 'estourou',
    tokens: 10,
    custo: 0.01,
  },
]

const legacyProposal = {
  id: 'rotprop_1',
  titulo: 'Proposta',
  prompt: 'Resuma o dia',
  agenda: { horario: '18:00', dias: [1, 2, 3, 4, 5] },
  modos: { loop: false, brain: true, web: false, allowAll: false },
  mode: 'chat',
  pastas: ['/repo'],
  modelo: { providerId: 'anthropic', modelId: 'claude' },
  criadoEm: 1700000000000,
}

let tmp: string

// The migration runs once per process, so both tests below share the same data
// folder: the first one migrates it, the second one checks that reading it
// again rewrites nothing.
beforeEach(() => {
  if (tmp) return
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-routines-mig-'))
  userData.dir = path.join(tmp, 'userData')
  const legacyDir = path.join(userData.dir, 'orbit-data', 'rotinas')
  fs.mkdirSync(legacyDir, { recursive: true })
  fs.writeFileSync(path.join(legacyDir, 'rotinas.json'), JSON.stringify([legacyRoutine, legacyIntervalRoutine], null, 2))
  fs.writeFileSync(path.join(legacyDir, 'runs.json'), JSON.stringify(legacyRuns, null, 2))
  const legacyProposals = path.join(userData.dir, 'orbit-data', 'rotinas-pending')
  fs.mkdirSync(legacyProposals, { recursive: true })
  fs.writeFileSync(path.join(legacyProposals, 'rotprop_1.json'), JSON.stringify(legacyProposal, null, 2))
})

describe('legacy data migration', () => {
  it('writes routines.json and runs.json in the new format, translating keys and enum values', async () => {
    const routines = await listRoutines()
    const runs = await listRuns()

    const dir = path.join(userData.dir, 'orbit-data', 'routines')
    expect(fs.existsSync(path.join(dir, 'routines.json'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'runs.json'))).toBe(true)
    // The legacy folder is preserved, not moved.
    expect(fs.existsSync(path.join(userData.dir, 'orbit-data', 'rotinas', 'rotinas.json'))).toBe(true)

    expect(routines).toHaveLength(2)
    expect(routines[0]).toMatchObject({
      id: 'rot_1',
      title: 'Revisar PRs',
      prompt: 'Revise os PRs abertos',
      schedule: { time: '09:00', days: [1, 3] },
      model: { providerId: 'anthropic', modelId: 'claude' },
      modes: { loop: true, brain: false, web: true, allowAll: false, permissionMode: 'acceptEdits' },
      folders: ['/repo'],
      visionModel: { providerId: 'anthropic', modelId: 'claude' },
      active: true,
      createdAt: 1704164645000,
      lastRun: 1704272400000,
    })
    expect(routines[1]).toMatchObject({
      id: 'rot_2',
      title: 'Backup',
      schedule: { intervalDays: 7, intervalHours: 6, onceDate: '2024-05-01' },
      folders: [],
      active: false,
    })

    expect(runs).toHaveLength(3)
    expect(runs[0]).toMatchObject({
      routineId: 'rot_1',
      sessionId: 'rotina_abc',
      startedAt: 1700000000000,
      completedAt: 1700000060000,
      status: 'ok',
      tokens: 1200,
      cost: 0.25,
    })
    expect(runs[1]).toMatchObject({ sessionId: 'rotina_def', status: 'running' })
    expect(runs[2]).toMatchObject({ status: 'error', error: 'estourou' })

    // Pending proposals: new folder, new keys, legacy file kept.
    const proposalFile = path.join(userData.dir, 'orbit-data', 'routine-proposals', 'rotprop_1.json')
    expect(fs.existsSync(proposalFile)).toBe(true)
    expect(fs.existsSync(path.join(userData.dir, 'orbit-data', 'rotinas-pending', 'rotprop_1.json'))).toBe(true)
    const proposal = JSON.parse(fs.readFileSync(proposalFile, 'utf8'))
    expect(proposal).toMatchObject({
      id: 'rotprop_1',
      title: 'Proposta',
      schedule: { time: '18:00', days: [1, 2, 3, 4, 5] },
      modes: { loop: false, brain: true, web: false, allowAll: false },
      folders: ['/repo'],
      createdAt: 1700000000000,
    })
    expect(proposal.titulo).toBeUndefined()

    // The rewrite really happened on disk, not just in the returned object.
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'routines.json'), 'utf8'))
    expect(onDisk[0].title).toBe('Revisar PRs')
    expect(onDisk[0].titulo).toBeUndefined()
    expect(onDisk[0].agenda).toBeUndefined()
  })

  it('is idempotent: a second read rewrites nothing and keeps the legacy files', async () => {
    await listRoutines()
    const file = path.join(userData.dir, 'orbit-data', 'routines', 'routines.json')
    const before = fs.readFileSync(file, 'utf8')
    const beforeStat = fs.statSync(file).mtimeMs

    await new Promise((resolve) => setTimeout(resolve, 25))
    const again = await listRoutines()

    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(fs.statSync(file).mtimeMs).toBe(beforeStat)
    expect(again).toHaveLength(2)
    expect(fs.existsSync(path.join(userData.dir, 'orbit-data', 'rotinas', 'rotinas.json'))).toBe(true)
  })
})
