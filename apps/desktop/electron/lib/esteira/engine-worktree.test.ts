import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Esteira, Projeto, Task, WorktreeDaTask } from '@shared/esteira'

const db = vi.hoisted(() => ({
  esteiras: [] as Esteira[],
  projetos: [] as Projeto[],
  tasks: [] as Task[],
}))

vi.mock('./repo', () => ({
  listarEsteiras: async () => db.esteiras,
  listarProjetos: async () => db.projetos,
  listarTasks: async () => db.tasks,
  modificarTasks: async (_e: string, fn: (tasks: Task[]) => unknown) => fn(db.tasks),
  atualizarTask: async (_e: string, taskId: string, patch: (t: Task) => Task) => {
    const i = db.tasks.findIndex((t) => t.id === taskId)
    if (i < 0) return null
    db.tasks[i] = patch(db.tasks[i])
    return db.tasks[i]
  },
}))
const executarFase = vi.hoisted(() => vi.fn())
vi.mock('./runner', () => ({ executarFase }))
const wt = vi.hoisted(() => ({
  criarWorktree: vi.fn(),
  removerWorktree: vi.fn(async () => {}),
  existe: vi.fn(async () => true),
  limparOrfaos: vi.fn(async () => {}),
}))
vi.mock('./worktree', () => wt)
vi.mock('../process-manager', () => ({ listProcesses: () => [], killProcess: vi.fn() }))
vi.mock('../snapshot', () => ({ capture: vi.fn(async () => undefined), diff: vi.fn() }))
vi.mock('../broadcast', () => ({ broadcastEsteiraEvent: vi.fn() }))
vi.mock('../memory/service', () => ({ loadPromptContext: vi.fn(), search: vi.fn() }))
vi.mock('../catalog', () => ({ getProvider: vi.fn() }))
vi.mock('../providers', () => ({ resolveModel: vi.fn() }))

const { iniciarTask, removerTask } = await import('./engine')

const worktree = (id: string): WorktreeDaTask => ({
  caminho: `/wt/${id}`,
  pasta: `/wt/${id}`,
  branch: `esteira/${id}`,
  base: 'main',
  dependencias: 'clonadas',
  criadoEm: '',
})

function nova(id: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    esteiraId: 'est_1',
    titulo: id,
    descricao: '',
    status: 'pendente',
    faseAtual: null,
    dependeDe: [],
    anotacoes: [],
    criadoEm: '',
    tempoTrabalhoMs: 0,
    tokens: 0,
    custo: 0,
    ...extra,
  }
}

const esperar = () => new Promise((r) => setTimeout(r, 20))

beforeEach(() => {
  db.projetos = [{ id: 'proj_1', nome: 'P', pastas: ['/repo', '/extra'], criadoEm: '', esteiras: ['est_1'] }]
  db.esteiras = [
    {
      id: 'est_1',
      projetoId: 'proj_1',
      nome: 'E',
      fases: [{ id: 'dev', nome: 'dev', descricao: '', prompt: '', providerId: 'p', modelId: 'm', thinkingNivel: 0, tools: [], ordem: 0 }],
      modoOperacao: 'manual',
      pushAoFinal: false,
      commitAoFinal: false,
      politicaComandos: { bloqueados: [], controlados: [] },
      worktreePorTask: true,
      criadoEm: '',
    },
  ]
  db.tasks = [nova('t1')]
  executarFase.mockReset()
  executarFase.mockResolvedValue({ texto: 'ok', anotacao: 'feito', comandosControlados: [], tokens: 0, custo: 0 })
  wt.criarWorktree.mockReset()
  wt.criarWorktree.mockImplementation(async ({ task }: { task: Task }) => worktree(task.id))
  wt.removerWorktree.mockClear()
  wt.existe.mockReset()
  wt.existe.mockResolvedValue(true)
})

describe('worktree por task no engine', () => {
  it('cria o worktree na primeira execução e roda as fases nele (pastas extras seguem iguais)', async () => {
    await iniciarTask('est_1', 't1')
    await esperar()

    expect(wt.criarWorktree).toHaveBeenCalledTimes(1)
    expect(db.tasks[0].worktree?.branch).toBe('esteira/t1')
    expect(executarFase.mock.calls[0][0].pastas).toEqual(['/wt/t1', '/extra'])
    expect(db.tasks[0].status).toBe('concluida')
  })

  it('reaproveita o worktree existente', async () => {
    db.tasks = [nova('t1', { status: 'pausada', faseAtual: 0, worktree: worktree('t1') })]
    await iniciarTask('est_1', 't1')
    await esperar()

    expect(wt.criarWorktree).not.toHaveBeenCalled()
    expect(executarFase.mock.calls[0][0].pastas[0]).toBe('/wt/t1')
  })

  it('recria quando a pasta do worktree sumiu', async () => {
    db.tasks = [nova('t1', { status: 'pausada', faseAtual: 0, worktree: worktree('t1') })]
    wt.existe.mockResolvedValue(false)
    await iniciarTask('est_1', 't1')
    await esperar()

    expect(wt.criarWorktree).toHaveBeenCalledTimes(1)
    expect(wt.criarWorktree.mock.calls[0][0].task.worktree.branch).toBe('esteira/t1')
  })

  it('não cria worktree para task que já rodou sem ele (opção ligada no meio)', async () => {
    db.tasks = [
      nova('t1', {
        status: 'pausada',
        faseAtual: 0,
        anotacoes: [{ faseId: 'x', faseNome: 'x', status: 'ok', conteudo: '', comandosControlados: [], tokens: 0, custo: 0, iniciadoEm: '', concluidoEm: '' }],
      }),
    ]
    await iniciarTask('est_1', 't1')
    await esperar()

    expect(wt.criarWorktree).not.toHaveBeenCalled()
    expect(executarFase.mock.calls[0][0].pastas[0]).toBe('/repo')
  })

  it('sem a opção, roda no repositório principal', async () => {
    db.esteiras[0].worktreePorTask = false
    await iniciarTask('est_1', 't1')
    await esperar()

    expect(wt.criarWorktree).not.toHaveBeenCalled()
    expect(executarFase.mock.calls[0][0].pastas[0]).toBe('/repo')
  })

  it('falha ao criar o worktree pausa a task com o motivo, sem rodar fase', async () => {
    wt.criarWorktree.mockRejectedValue(new Error('A pasta principal não é um repositório git: /repo'))
    await iniciarTask('est_1', 't1')
    await esperar()

    expect(executarFase).not.toHaveBeenCalled()
    expect(db.tasks[0].status).toBe('pausada')
    expect(db.tasks[0].pausaMotivo).toBe('erro')
    expect(db.tasks[0].erro).toContain('não é um repositório git')
  })

  it('parte do branch da dependência quando há exatamente uma com worktree', async () => {
    db.tasks = [nova('dep', { status: 'concluida', worktree: worktree('dep') }), nova('t1', { dependeDe: ['dep'] })]
    await iniciarTask('est_1', 't1')
    await esperar()

    expect(wt.criarWorktree.mock.calls[0][0].base).toBe('esteira/dep')
  })

  it('remover a task remove o worktree dela', async () => {
    db.tasks = [nova('t1', { status: 'concluida', worktree: worktree('t1') })]
    await removerTask('est_1', 't1')

    expect(wt.removerWorktree).toHaveBeenCalledWith('/repo', worktree('t1'))
    expect(db.tasks).toHaveLength(0)
  })
})
