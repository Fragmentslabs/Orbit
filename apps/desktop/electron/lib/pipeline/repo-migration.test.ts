import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The real module reads the app data folder; here it is a temp folder.
const userData = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => userData.dir } }))

import { listPipelines, listProjects, listTasks } from './repo'

/**
 * The migration is one-shot per process, so the legacy data has to be in place
 * before the first read of the file: it all happens in this first test.
 */
const legacyProject = {
  id: 'proj_1',
  nome: 'My Project',
  pastas: ['/repo'],
  criadoEm: '2024-01-02T03:04:05.000Z',
  esteiras: ['est_1'],
}

const legacyPipeline = {
  id: 'est_1',
  projetoId: 'proj_1',
  nome: 'Board',
  fases: [
    {
      id: 'fase_1',
      nome: 'Development',
      descricao: 'Implementa',
      prompt: 'Do it',
      providerId: 'prov',
      modelId: 'model',
      thinkingNivel: 2,
      ordem: 0,
      tipo: 'desenvolvimento',
      templateId: 'validacao',
      tools: ['leitura', 'memoria', 'edit'],
    },
  ],
  branch: 'pipeline/board',
  worktree: '/w/board',
  worktreePorTask: true,
  modoOperacao: 'automatico',
  pushAoFinal: false,
  commitAoFinal: true,
  commitPrompt: 'msg',
  printsDoResultado: true,
  politicaComandos: { bloqueados: ['rm -rf'], controlados: ['git push'] },
  templateId: 'desenvolvimento,validacao,infra',
  criadoEm: '2024-01-02T03:04:05.000Z',
}

const legacyTask = {
  id: 'task_1',
  esteiraId: 'est_1',
  titulo: 'T',
  descricao: 'D',
  status: 'pendente',
  faseAtual: 'fase_1',
  faseInterrompida: true,
  pausaMotivo: 'erro',
  dependeDe: [],
  anotacoes: [
    {
      faseId: 'fase_1',
      faseNome: 'Development',
      status: 'pulada',
      conteudo: 'nota',
      comandosControlados: ['git push'],
      custo: 0.5,
      iniciadoEm: '2024-01-02T03:05:00.000Z',
      concluidoEm: '2024-01-02T03:06:00.000Z',
      rodada: 2,
    },
  ],
  devolucoes: [{ rodada: 1, texto: 'volta', faseInicial: 'fase_1', criadoEm: '2024-01-02T03:07:00.000Z' }],
  instrucoes: [{ texto: 'do X', rodada: 2, faseId: 'fase_1', faseNome: 'Development', criadoEm: '2024-01-02T03:08:00.000Z' }],
  worktree: {
    caminho: '/w/task_1',
    pasta: '/w/task_1',
    branch: 'pipeline/t',
    base: 'main',
    dependencias: 'clonadas',
    criadoEm: '2024-01-02T03:04:05.000Z',
  },
  commitsAnteriores: ['abc123'],
  diff: { inicio: 'abc123', arquivos: ['a.ts'], patch: 'diff' },
  rodada: 2,
  tempoTrabalhoMs: 1000,
  custo: 0.5,
  tokens: 42,
  criadoEm: '2024-01-02T03:04:05.000Z',
}

const legacyTemplate = {
  id: 'desenvolvimento',
  nome: 'Development',
  descricao: 'Implementa',
  prompt: 'Do it',
  tools: ['leitura'],
  padrao: true,
  custom: true,
  doUsuario: true,
  i18nKey: 'desenvolvimento',
  tipo: 'desenvolvimento',
}

let tmp: string

// The migration runs once per process, so both tests below share the same data
// folder: the first one migrates it, the second one checks that reading it
// again rewrites nothing.
beforeEach(() => {
  if (tmp) return
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-pipeline-mig-'))
  userData.dir = path.join(tmp, 'userData')
  const legacyDir = path.join(userData.dir, 'orbit-data', 'esteira')
  fs.mkdirSync(legacyDir, { recursive: true })
  fs.writeFileSync(path.join(legacyDir, 'projetos.json'), JSON.stringify([legacyProject], null, 2))
  fs.writeFileSync(path.join(legacyDir, 'esteiras.json'), JSON.stringify([legacyPipeline], null, 2))
  fs.writeFileSync(path.join(legacyDir, 'tasks-est_1.json'), JSON.stringify([legacyTask], null, 2))
  fs.writeFileSync(path.join(legacyDir, 'templates.json'), JSON.stringify([legacyTemplate], null, 2))
})

afterEach(() => {})

describe('legacy data migration', () => {
  it('moves the folder, renames the files and translates keys and enum values', async () => {
    const projects = await listProjects()
    const pipelines = await listPipelines()
    const tasks = await listTasks('est_1')

    const dir = path.join(userData.dir, 'orbit-data', 'pipeline')
    expect(fs.existsSync(path.join(userData.dir, 'orbit-data', 'esteira'))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'projects.json'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'pipelines.json'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'tasks-est_1.json'))).toBe(true)

    expect(projects[0]).toMatchObject({
      id: 'proj_1',
      name: 'My Project',
      folders: ['/repo'],
      createdAt: '2024-01-02T03:04:05.000Z',
      pipelines: ['est_1'],
    })

    expect(pipelines[0]).toMatchObject({
      id: 'est_1',
      projectId: 'proj_1',
      name: 'Board',
      worktreePerTask: true,
      operationMode: 'automatic',
      commitAtEnd: true,
      commandPolicy: { blocked: ['rm -rf'], controlled: ['git push'] },
      // The built-in template ids are English now; `infra` never changed.
      templateId: 'development,validation,infra',
      createdAt: '2024-01-02T03:04:05.000Z',
    })
    expect(pipelines[0].phases[0]).toMatchObject({
      id: 'fase_1',
      name: 'Development',
      description: 'Implementa',
      thinkingLevel: 2,
      order: 0,
      templateId: 'validation',
      tools: ['read', 'memory', 'edit'],
    })

    expect(tasks[0]).toMatchObject({
      id: 'task_1',
      pipelineId: 'est_1',
      title: 'T',
      description: 'D',
      status: 'pending',
      currentPhase: 'fase_1',
      phaseInterrupted: true,
      pauseReason: 'error',
      dependsOn: [],
      round: 2,
      workTimeMs: 1000,
      previousCommits: ['abc123'],
      diff: { start: 'abc123', files: ['a.ts'], patch: 'diff' },
    })
    expect(tasks[0].notes[0]).toMatchObject({
      phaseId: 'fase_1',
      phaseName: 'Development',
      status: 'skipped',
      content: 'nota',
      controlledCommands: ['git push'],
      cost: 0.5,
      round: 2,
    })
    expect(tasks[0].returns?.[0]).toMatchObject({ round: 1, text: 'volta', startPhase: 'fase_1' })
    expect(tasks[0].instructions?.[0]).toMatchObject({ text: 'do X', round: 2, phaseId: 'fase_1' })
    expect(tasks[0].worktree).toMatchObject({
      path: '/w/task_1',
      folder: '/w/task_1',
      branch: 'pipeline/t',
      dependencies: 'cloned',
    })

    // The rewrite really happened on disk, not just in the returned object.
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'projects.json'), 'utf8'))
    expect(onDisk[0].name).toBe('My Project')
    expect(onDisk[0].nome).toBeUndefined()
    const templates = JSON.parse(fs.readFileSync(path.join(dir, 'templates.json'), 'utf8'))
    expect(templates[0]).toMatchObject({
      id: 'development',
      i18nKey: 'development',
      isDefault: true,
      userCreated: true,
      tools: ['read'],
    })
  })

  it('is idempotent: a second read rewrites nothing and does not bring the legacy folder back', async () => {
    await listProjects()
    const dir = path.join(userData.dir, 'orbit-data', 'pipeline')
    const file = path.join(dir, 'projects.json')
    const before = fs.readFileSync(file, 'utf8')
    const beforeStat = fs.statSync(file).mtimeMs

    await new Promise((resolve) => setTimeout(resolve, 25))
    await listProjects()

    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(fs.statSync(file).mtimeMs).toBe(beforeStat)
    expect(fs.existsSync(path.join(userData.dir, 'orbit-data', 'esteira'))).toBe(false)
  })
})
