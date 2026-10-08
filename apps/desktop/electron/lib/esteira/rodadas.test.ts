import { describe, expect, it, vi } from 'vitest'
import type { AnotacaoFase, Esteira, Task } from '@shared/esteira'
import { anotacoesDaRodada, devolucaoDaRodada, rodadaDaTask } from '@shared/esteira'

// O runner puxa catálogo, providers e tools; o prompt não usa nada disso.
vi.mock('../catalog', () => ({ getProvider: vi.fn(), modelSupportsVision: vi.fn() }))
vi.mock('../providers', () => ({ resolveModel: vi.fn() }))

const { montarMensagem } = await import('./runner')

function anotacao(faseId: string, conteudo: string, rodada?: number, status: AnotacaoFase['status'] = 'ok'): AnotacaoFase {
  return {
    faseId,
    faseNome: faseId.toUpperCase(),
    status,
    conteudo,
    comandosControlados: [],
    tokens: 0,
    custo: 0,
    iniciadoEm: '2026-10-07T00:00:00.000Z',
    concluidoEm: '2026-10-07T00:00:00.000Z',
    ...(rodada ? { rodada } : {}),
  }
}

const esteira = {
  id: 'est_1',
  projetoId: 'proj_1',
  nome: 'E',
  fases: [
    { id: 'dev', nome: 'Dev', descricao: 'd', prompt: '', providerId: 'p', modelId: 'm', thinkingNivel: 0, tools: [], ordem: 0 },
    { id: 'val', nome: 'Val', descricao: 'v', prompt: '', providerId: 'p', modelId: 'm', thinkingNivel: 0, tools: [], ordem: 1, tipo: 'validacao' },
  ],
  modoOperacao: 'manual',
  pushAoFinal: false,
  commitAoFinal: true,
  politicaComandos: { bloqueados: [], controlados: [] },
  criadoEm: '2026-10-07T00:00:00.000Z',
} as Esteira

function task(extra: Partial<Task>): Task {
  return {
    id: 't1',
    esteiraId: 'est_1',
    titulo: 'Frete',
    descricao: 'Calcular o frete',
    status: 'em_progresso',
    faseAtual: 0,
    dependeDe: [],
    anotacoes: [],
    criadoEm: '2026-10-07T00:00:00.000Z',
    tempoTrabalhoMs: 0,
    tokens: 0,
    custo: 0,
    ...extra,
  }
}

function prompt(t: Task, indice = 0): string {
  return montarMensagem({
    esteira,
    task: t,
    fase: esteira.fases[indice],
    indiceFase: indice,
    pastas: ['/repo'],
    tentativa: 1,
    abort: new AbortController().signal,
  })
}

describe('helpers de rodada', () => {
  it('task anterior às rodadas conta como rodada 1, com todas as anotações', () => {
    const t = task({ anotacoes: [anotacao('dev', 'a'), anotacao('val', 'b')] })
    expect(rodadaDaTask(t)).toBe(1)
    expect(anotacoesDaRodada(t, 1)).toHaveLength(2)
    expect(devolucaoDaRodada(t, 1)).toBeUndefined()
  })

  it('separa as anotações por rodada', () => {
    const t = task({
      rodada: 2,
      anotacoes: [anotacao('dev', 'r1'), anotacao('val', 'r1v'), anotacao('dev', 'r2', 2)],
      devolucoes: [{ rodada: 2, texto: 'corrige', faseInicial: 0, criadoEm: '' }],
    })
    expect(anotacoesDaRodada(t, 1).map((a) => a.conteudo)).toEqual(['r1', 'r1v'])
    expect(anotacoesDaRodada(t, 2).map((a) => a.conteudo)).toEqual(['r2'])
    expect(devolucaoDaRodada(t, 2)?.texto).toBe('corrige')
  })
})

describe('prompt da fase com rodadas', () => {
  it('rodada 1 não fala de revisão', () => {
    const texto = prompt(task({ anotacoes: [anotacao('dev', 'feito')] }), 1)
    expect(texto).not.toContain('Review feedback')
    expect(texto).toContain('## Notes from previous phases')
    expect(texto).toContain('feito')
  })

  it('rodada de revisão traz o comentário, o resumo da anterior e só as notas da rodada atual', () => {
    const t = task({
      rodada: 2,
      faseAtual: 1,
      anotacoes: [
        anotacao('dev', 'nota dev rodada 1'),
        anotacao('val', 'resumo final da rodada 1'),
        anotacao('dev', 'nota dev rodada 2', 2),
      ],
      devolucoes: [{ rodada: 2, texto: 'Errou no peso cubado', faseInicial: 0, criadoEm: '' }],
    })
    const texto = prompt(t, 1)
    expect(texto).toContain('## Review feedback (round 2)')
    expect(texto).toContain('Errou no peso cubado')
    expect(texto).toContain('this is review round 2')
    expect(texto).toContain('## Previous round summary (round 1, VAL)')
    expect(texto).toContain('resumo final da rodada 1')
    expect(texto).toContain('nota dev rodada 2')
    // A nota da fase 1 da rodada anterior não volta inteira
    expect(texto).not.toContain('nota dev rodada 1')
    // O comentário vem antes do pipeline: é a instrução prioritária
    expect(texto.indexOf('Errou no peso cubado')).toBeLessThan(texto.indexOf('## Pipeline'))
  })

  it('lista as devoluções anteriores em uma linha cada', () => {
    const t = task({
      rodada: 3,
      devolucoes: [
        { rodada: 2, texto: 'primeira correção', faseInicial: 0, criadoEm: '' },
        { rodada: 3, texto: 'segunda correção', faseInicial: 0, criadoEm: '' },
      ],
    })
    const texto = prompt(t)
    expect(texto).toContain('## Review feedback (round 3)')
    expect(texto).toContain('- Round 2: primeira correção')
  })

  it('instrução ao retomar: prioritária na fase dela, contexto nas outras da rodada', () => {
    const instrucoes = [
      { texto: 'use npm run test:unit', rodada: 1, faseId: 'val', faseNome: 'Val', criadoEm: '' },
      { texto: 'não mexa no schema', rodada: 1, faseId: 'dev', faseNome: 'Dev', criadoEm: '' },
      { texto: 'instrução de outra rodada', rodada: 2, faseId: 'val', faseNome: 'Val', criadoEm: '' },
    ]
    const texto = prompt(task({ faseAtual: 1, instrucoes }), 1)
    expect(texto).toContain('## Instructions from the user for this phase\n')
    expect(texto).toContain('- use npm run test:unit')
    expect(texto).toContain('## Instructions the user gave to other phases (context)\n- Dev: não mexa no schema')
    expect(texto).not.toContain('instrução de outra rodada')
  })
})
