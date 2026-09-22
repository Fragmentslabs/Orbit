import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, SessionInfo } from '@shared/chat'

/**
 * O relatório de horas é o que o agente lê quando alguém pergunta "quanto
 * trabalhei no projeto X". Se ele contar o que está fora do período pedido, ou
 * atribuir a um projeto o tempo de outro, a resposta sai errada com cara de
 * precisa — por isso o recorte e a separação por pasta são testados aqui.
 */

const armazenamento = new Map<string, unknown>()

vi.mock('./storage', () => ({
  listKeys: async (prefix: string) =>
    [...armazenamento.keys()].filter((k) => k.startsWith(prefix)),
  readJson: async (key: string) => armazenamento.get(key) ?? null,
}))

vi.mock('./memory/domain', () => ({
  projectIdOf: (dir: string) => dir.toLowerCase(),
}))

const { computeWorkReport } = await import('./analytics')

const DIA = (dia: number, hora: number, minuto = 0) =>
  new Date(2026, 2, dia, hora, minuto, 0, 0).getTime()

let seq = 0
function msg(role: 'user' | 'assistant', at: number, texto: string): ChatMessage {
  return {
    id: `m${++seq}`,
    role,
    parts: [{ type: 'text', text: texto }],
    createdAt: at,
    ...(role === 'assistant'
      ? { providerId: 'anthropic', modelId: 'opus', tokens: { input: 100, output: 50, cost: 0.25 } }
      : {}),
  } as ChatMessage
}

function gravarSessao(id: string, directory: string | undefined, messages: ChatMessage[]) {
  const session: SessionInfo = {
    id,
    title: `conversa ${id}`,
    mode: directory ? 'code' : 'chat',
    pinned: false,
    archived: false,
    folderId: null,
    directory,
    createdAt: messages[0].createdAt,
    updatedAt: messages[messages.length - 1].createdAt,
  }
  armazenamento.set(`session/${id}`, session)
  armazenamento.set(`messages/${id}`, messages)
}

beforeEach(() => {
  armazenamento.clear()
  seq = 0
})

describe('computeWorkReport', () => {
  it('conta a geração e o intervalo curto, e separa por projeto', async () => {
    // Projeto A: pedido 10:00 → resposta 10:30 (30min de geração), leitura de
    // 15min e novo pedido 10:45 → resposta 11:00 (15min). Total: 1h.
    gravarSessao('a', '/repo/alpha', [
      msg('user', DIA(10, 10, 0), 'faz isso'),
      msg('assistant', DIA(10, 10, 30), 'feito'),
      msg('user', DIA(10, 10, 45), 'agora aquilo'),
      msg('assistant', DIA(10, 11, 0), 'feito'),
    ])
    // Projeto B: meia hora no mesmo dia.
    gravarSessao('b', '/repo/beta', [
      msg('user', DIA(10, 14, 0), 'outro projeto'),
      msg('assistant', DIA(10, 14, 30), 'ok'),
    ])

    const r = await computeWorkReport({ since: DIA(10, 0), until: DIA(10, 23, 59) })

    expect(r.projects.map((p) => p.name)).toEqual(['alpha', 'beta'])
    expect(r.projects[0].hours).toBeCloseTo(1, 5)
    expect(r.projects[1].hours).toBeCloseTo(0.5, 5)
    expect(r.totalHours).toBeCloseTo(1.5, 5)
  })

  it('não conta o gap longo entre uma resposta e o pedido seguinte', async () => {
    // Almoço de 2h no meio: as duas pontas contam, o vazio não.
    gravarSessao('a', '/repo/alpha', [
      msg('user', DIA(11, 9, 0), 'manhã'),
      msg('assistant', DIA(11, 10, 0), 'ok'),
      msg('user', DIA(11, 12, 0), 'tarde'),
      msg('assistant', DIA(11, 13, 0), 'ok'),
    ])

    const r = await computeWorkReport({ since: DIA(11, 0), until: DIA(11, 23, 59) })
    expect(r.totalHours).toBeCloseTo(2, 5)
  })

  it('recorta pelo período mesmo quando a sessão começou antes', async () => {
    gravarSessao('a', '/repo/alpha', [
      msg('user', DIA(10, 9, 0), 'dia um'),
      msg('assistant', DIA(10, 10, 0), 'ok'),
      msg('user', DIA(12, 9, 0), 'dia três'),
      msg('assistant', DIA(12, 9, 30), 'ok'),
    ])

    const r = await computeWorkReport({ since: DIA(12, 0), until: DIA(12, 23, 59) })
    expect(r.projects).toHaveLength(1)
    expect(r.totalHours).toBeCloseTo(0.5, 5)
    expect(r.projects[0].days.map((d) => d.date)).toEqual(['2026-03-12'])
  })

  it('guarda o que o usuário pediu em cada dia e o custo do dia', async () => {
    gravarSessao('a', '/repo/alpha', [
      msg('user', DIA(10, 9, 0), 'sobe o gráfico por projeto'),
      msg('assistant', DIA(10, 9, 30), 'ok'),
    ])

    const r = await computeWorkReport({ since: DIA(10, 0), until: DIA(10, 23, 59) })
    const dia = r.projects[0].days[0]
    expect(dia.sessions[0].prompts).toEqual(['sobe o gráfico por projeto'])
    expect(dia.cost).toBeCloseTo(0.25, 5)
    expect(dia.messages).toBe(1)
  })

  it('filtra por nome de pasta e lista os projetos existentes quando não casa', async () => {
    gravarSessao('a', '/repo/alpha', [
      msg('user', DIA(10, 9, 0), 'oi'),
      msg('assistant', DIA(10, 9, 30), 'ok'),
    ])
    gravarSessao('b', '/repo/beta', [
      msg('user', DIA(10, 14, 0), 'oi'),
      msg('assistant', DIA(10, 14, 30), 'ok'),
    ])

    const certo = await computeWorkReport({
      since: DIA(10, 0),
      until: DIA(10, 23, 59),
      project: 'beta',
    })
    expect(certo.projects.map((p) => p.name)).toEqual(['beta'])

    const errado = await computeWorkReport({
      since: DIA(10, 0),
      until: DIA(10, 23, 59),
      project: 'gama',
    })
    expect(errado.projects).toHaveLength(0)
    expect(errado.knownProjects).toEqual(['alpha', 'beta'])
  })
})
