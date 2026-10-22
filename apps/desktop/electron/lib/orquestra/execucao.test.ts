import { describe, expect, it, vi } from 'vitest'
import type { OrchestrationPlan, OrchestrationSettings, OrchestrationTask } from '@shared/chat'
import { executarPlano, MAX_PARALELO, type AcoesRevisao, type PedidoRevisao } from './execucao'

function tarefa(id: string, extra: Partial<OrchestrationTask> = {}): OrchestrationTask {
  return { id, title: id.toUpperCase(), prompt: `faça ${id}`, options: {}, status: 'idle', ...extra }
}

function plano(tasks: OrchestrationTask[]): OrchestrationPlan {
  return { id: 'plan_1', tasks, status: 'running' }
}

const config = (c: Partial<OrchestrationSettings> = {}): OrchestrationSettings => ({
  comportamento: 'acompanhar',
  ajustesPorWorker: 2,
  aprovarTarefaUnica: false,
  worktrees: false,
  ...c,
})

/** Worker falso que termina quando o teste manda (ou na hora). */
function workers() {
  const chamadas: Array<{ id: string; texto: string }> = []
  const rodarWorker = vi.fn(async (t: OrchestrationTask, texto: string) => {
    chamadas.push({ id: t.id, texto })
    await new Promise((r) => setTimeout(r, 1))
    return { text: `resultado de ${t.id} (${chamadas.filter((c) => c.id === t.id).length})` }
  })
  return { chamadas, rodarWorker }
}

const base = (p: OrchestrationPlan, extra: Partial<Parameters<typeof executarPlano>[0]> = {}) => ({
  plan: p,
  config: config(),
  signal: new AbortController().signal,
  persistir: async () => {},
  ...extra,
})

describe('executarPlano', () => {
  it('só orquestrar: roda tudo, aceita sem revisão', async () => {
    const p = plano([tarefa('a'), tarefa('b')])
    const w = workers()
    const revisar = vi.fn()
    await executarPlano({ ...base(p), config: config({ comportamento: 'orquestrar' }), rodarWorker: w.rodarWorker, revisar })
    expect(revisar).not.toHaveBeenCalled()
    expect(p.tasks.map((t) => t.fase)).toEqual(['aceita', 'aceita'])
  })

  it('revisa cada worker ao terminar e aceita quando o revisor não decide', async () => {
    const p = plano([tarefa('a'), tarefa('b')])
    const w = workers()
    const revisados: string[] = []
    const revisar = vi.fn(async (pedido: PedidoRevisao) => {
      if (pedido.tipo === 'worker') revisados.push(pedido.task.id)
    })
    await executarPlano({ ...base(p), rodarWorker: w.rodarWorker, revisar })
    expect(revisados.sort()).toEqual(['a', 'b'])
    expect(p.tasks.every((t) => t.fase === 'aceita')).toBe(true)
    // integração rodou uma vez e, sem ações, encerrou
    expect(revisar.mock.calls.filter(([pd]) => (pd as PedidoRevisao).tipo === 'integracao')).toHaveLength(1)
  })

  it('pedido de ajuste roda o mesmo worker de novo e respeita o limite por worker', async () => {
    const p = plano([tarefa('a')])
    const w = workers()
    const respostas: string[] = []
    const revisar = async (pedido: PedidoRevisao, acoes: AcoesRevisao) => {
      if (pedido.tipo === 'worker') respostas.push(acoes.pedirAjuste('a', 'corrija o teste'))
    }
    await executarPlano({ ...base(p), config: config({ ajustesPorWorker: 2 }), rodarWorker: w.rodarWorker, revisar })

    expect(w.chamadas.map((c) => c.texto)).toEqual(['faça a', '[Ajuste pedido pelo orquestrador]\ncorrija o teste', '[Ajuste pedido pelo orquestrador]\ncorrija o teste'])
    expect(respostas[2]).toContain('Sem orçamento')
    expect(p.tasks[0].revisions).toBe(2)
    expect(p.tasks[0].fase).toBe('aceita')
    expect(p.revisao?.ajustesUsados).toBe(2)
  })

  it('dependente só começa depois de a dependência ser aceita, e recebe o resumo dela', async () => {
    const p = plano([tarefa('api'), tarefa('testes', { dependeDe: ['api'] })])
    const w = workers()
    await executarPlano({ ...base(p), rodarWorker: w.rodarWorker, revisar: async () => {} })
    expect(w.chamadas.map((c) => c.id)).toEqual(['api', 'testes'])
    expect(w.chamadas[1].texto).toContain('resultado de api (1)')
  })

  it('dependência que falhou derruba quem depende dela', async () => {
    const p = plano([tarefa('api'), tarefa('testes', { dependeDe: ['api'] })])
    const w = workers()
    const revisar = async (pedido: PedidoRevisao, acoes: AcoesRevisao) => {
      if (pedido.tipo === 'worker' && pedido.task.id === 'api') acoes.marcarFalha('api', 'quebrou')
    }
    await executarPlano({ ...base(p), rodarWorker: w.rodarWorker, revisar })
    expect(p.tasks[1].fase).toBe('falhou')
    expect(p.tasks[1].notaRevisao).toContain('API')
    expect(w.chamadas.map((c) => c.id)).toEqual(['api'])
  })

  it('no máximo MAX_PARALELO workers ao mesmo tempo', async () => {
    const p = plano(Array.from({ length: 7 }, (_, i) => tarefa(`t${i}`)))
    let ativos = 0
    let pico = 0
    const rodarWorker = async () => {
      ativos++
      pico = Math.max(pico, ativos)
      await new Promise((r) => setTimeout(r, 5))
      ativos--
      return { text: 'ok' }
    }
    await executarPlano({ ...base(p), config: config({ comportamento: 'orquestrar' }), rodarWorker })
    expect(pico).toBe(MAX_PARALELO)
    expect(p.tasks.every((t) => t.fase === 'aceita')).toBe(true)
  })

  it('a integração pode criar um worker extra, que roda e é revisado', async () => {
    const p = plano([tarefa('a')])
    const w = workers()
    let criou = false
    const revisar = async (pedido: PedidoRevisao, acoes: AcoesRevisao) => {
      if (pedido.tipo === 'integracao' && !criou) {
        criou = true
        acoes.criarWorker({ titulo: 'Testes de integração', prompt: 'teste tudo', dependeDe: ['A'] })
      }
    }
    await executarPlano({ ...base(p), rodarWorker: w.rodarWorker, revisar, novoId: () => 'extra_1' })
    const extra = p.tasks.find((t) => t.id === 'extra_1')
    expect(extra).toMatchObject({ extra: true, fase: 'aceita', dependeDe: ['a'] })
    expect(w.chamadas.map((c) => c.id)).toEqual(['a', 'extra_1'])
  })

  it('erro do worker sem decisão vira falha; revisor fora do ar não trava', async () => {
    const p = plano([tarefa('a'), tarefa('b')])
    const rodarWorker = async (t: OrchestrationTask) => (t.id === 'a' ? { text: '', error: 'timeout' } : { text: 'ok' })
    const revisar = async () => {
      throw new Error('modelo indisponível')
    }
    await executarPlano({ ...base(p), rodarWorker, revisar })
    expect(p.tasks.map((t) => t.fase)).toEqual(['falhou', 'aceita'])
    // status acompanha a etapa (o app do celular só lê o status)
    expect(p.tasks.map((t) => t.status)).toEqual(['error', 'idle'])
  })

  it('tarefa na fila ou em revisão não aparece como concluída para quem só lê o status', async () => {
    const p = plano([tarefa('api'), tarefa('testes', { dependeDe: ['api'] })])
    const vistos: string[] = []
    const revisar = async (pedido: PedidoRevisao) => {
      if (pedido.tipo === 'worker' && pedido.task.id === 'api') vistos.push(`api:${pedido.task.status} testes:${p.tasks[1].status}`)
    }
    await executarPlano({ ...base(p), rodarWorker: workers().rodarWorker, revisar })
    expect(vistos).toEqual(['api:streaming testes:submitted'])
  })

  it('prepararTarefa roda uma vez por tarefa e os avisos vão para o prompt', async () => {
    const p = plano([tarefa('a')])
    const w = workers()
    const prepararTarefa = vi.fn(async () => ['branch X não juntou'])
    const revisar = async (pedido: PedidoRevisao, acoes: AcoesRevisao) => {
      if (pedido.tipo === 'worker' && (pedido.task.revisions ?? 0) === 0) acoes.pedirAjuste('a', 'mais')
    }
    await executarPlano({ ...base(p), rodarWorker: w.rodarWorker, revisar, prepararTarefa })
    expect(prepararTarefa).toHaveBeenCalledTimes(1)
    expect(w.chamadas[0].texto).toContain('branch X não juntou')
  })
})
