import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Esteira, Projeto, Task } from '@shared/esteira'

// Repositório em memória: o engine lê e grava por aqui.
const db = vi.hoisted(() => ({
  esteiras: [] as Esteira[],
  projetos: [] as Projeto[],
  tasks: [] as Task[],
}))

vi.mock('./repo', () => ({
  listarEsteiras: async () => db.esteiras,
  listarProjetos: async () => db.projetos,
  listarTasks: async () => db.tasks,
  modificarTasks: async () => undefined,
  atualizarTask: async (_esteiraId: string, taskId: string, patch: (t: Task) => Task) => {
    const i = db.tasks.findIndex((t) => t.id === taskId)
    if (i < 0) return null
    db.tasks[i] = patch(db.tasks[i])
    return db.tasks[i]
  },
}))
const executarFase = vi.hoisted(() => vi.fn())
vi.mock('./runner', () => ({ executarFase }))
vi.mock('../snapshot', () => ({ capture: vi.fn(async () => undefined), diff: vi.fn() }))
vi.mock('../broadcast', () => ({ broadcastEsteiraEvent: vi.fn() }))
vi.mock('../memory/service', () => ({ loadPromptContext: vi.fn(), search: vi.fn() }))
vi.mock('../catalog', () => ({ getProvider: vi.fn() }))
vi.mock('../providers', () => ({ resolveModel: vi.fn() }))

const { devolverTask } = await import('./engine')

const fase = (id: string, ordem: number) => ({
  id,
  nome: id,
  descricao: '',
  prompt: '',
  providerId: 'p',
  modelId: 'm',
  thinkingNivel: 0,
  tools: [],
  ordem,
})

function concluida(extra: Partial<Task> = {}): Task {
  return {
    id: 't1',
    esteiraId: 'est_1',
    titulo: 'T',
    descricao: 'd',
    status: 'concluida',
    faseAtual: 1,
    dependeDe: [],
    anotacoes: [],
    criadoEm: '',
    concluidoEm: '2026-10-07T00:00:00.000Z',
    tempoTrabalhoMs: 10,
    tokens: 5,
    custo: 0.1,
    commitFinalHash: 'abc123',
    commitFalha: 'falhou antes',
    ...extra,
  }
}

/** Deixa a execução disparada (fire-and-forget) terminar. */
const esperarExecucao = () => new Promise((r) => setTimeout(r, 20))

beforeEach(() => {
  db.projetos = [{ id: 'proj_1', nome: 'P', pastas: ['/repo'], criadoEm: '', esteiras: ['est_1'] }]
  db.esteiras = [
    {
      id: 'est_1',
      projetoId: 'proj_1',
      nome: 'E',
      fases: [fase('dev', 0), fase('val', 1)],
      modoOperacao: 'manual',
      pushAoFinal: false,
      commitAoFinal: false,
      politicaComandos: { bloqueados: [], controlados: [] },
      criadoEm: '',
    },
  ]
  db.tasks = [concluida()]
  executarFase.mockReset()
  executarFase.mockResolvedValue({ texto: 'ok', anotacao: 'feito', comandosControlados: [], tokens: 1, custo: 0 })
})

describe('devolverTask', () => {
  it('abre a rodada 2, roda a esteira de novo e marca as anotações com a rodada', async () => {
    await devolverTask('est_1', 't1', '  Errou no frete  ', 0)
    await esperarExecucao()

    const t = db.tasks[0]
    expect(t.rodada).toBe(2)
    expect(t.devolucoes).toEqual([{ rodada: 2, texto: 'Errou no frete', faseInicial: 0, criadoEm: expect.any(String) }])
    expect(t.status).toBe('concluida')
    expect(executarFase).toHaveBeenCalledTimes(2)
    expect(t.anotacoes.map((a) => [a.faseId, a.rodada])).toEqual([
      ['dev', 2],
      ['val', 2],
    ])
    // Falhas da rodada anterior saem; o commit final anterior vai para o histórico
    expect(t.commitFalha).toBeUndefined()
    expect(t.commitsAnteriores).toEqual(['abc123'])
  })

  it('recomeça na fase escolhida sem registrar as anteriores como puladas', async () => {
    await devolverTask('est_1', 't1', 'só revalidar', 1)
    await esperarExecucao()

    const t = db.tasks[0]
    expect(executarFase).toHaveBeenCalledTimes(1)
    expect(executarFase.mock.calls[0][0].indiceFase).toBe(1)
    expect(t.anotacoes.map((a) => a.faseId)).toEqual(['val'])
    expect(t.devolucoes?.[0].faseInicial).toBe(1)
  })

  it('recusa task que não está concluída', async () => {
    db.tasks = [concluida({ status: 'pausada' })]
    await expect(devolverTask('est_1', 't1', 'x')).rejects.toThrow()
    expect(db.tasks[0].rodada).toBeUndefined()
  })

  it('recusa comentário vazio', async () => {
    await expect(devolverTask('est_1', 't1', '   ')).rejects.toThrow()
    expect(db.tasks[0].status).toBe('concluida')
  })

  it('limita a fase inicial às fases que existem', async () => {
    await devolverTask('est_1', 't1', 'x', 99)
    await esperarExecucao()
    expect(db.tasks[0].devolucoes?.[0].faseInicial).toBe(1)
  })
})
