import { beforeEach, describe, expect, it, vi } from 'vitest'

const pedidos = vi.hoisted(() => ({ claims: [] as Array<Record<string, unknown>>, resposta: 'allow' as unknown }))
vi.mock('../ask-broker', () => ({ newRequestId: () => 'req_1' }))
vi.mock('../ask-dispatch', () => ({
  dispatchAsk: vi.fn(async (_alvo: string, pedido: { claim: Record<string, unknown> }) => {
    pedidos.claims.push(pedido.claim)
    return pedidos.resposta
  }),
}))
vi.mock('../broadcast', () => ({ broadcastChatEvent: vi.fn() }))
vi.mock('../mcp', () => ({
  getMcpPermissionMode: () => undefined,
  // O teste usa "servidor_acao" como se fosse uma tool de MCP: é o catch-all de
  // permission/rules.ts que a reconhece assim — e ele só trata como MCP quando
  // o prefixo é um servidor cadastrado.
  isMcpServerName: (name: string) => name === 'servidor',
}))
vi.mock('./trust-rules', () => ({ checkTrust: () => false, addTrust: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

const { createToolApproval } = await import('./index')
const { definirModoGlobal, modoGlobal } = await import('./modo-global')

const chamada = (toolName: string, input: unknown = {}) => ({
  toolCall: { toolCallId: `c_${Math.random()}`, toolName, input },
})

beforeEach(() => {
  pedidos.claims = []
  pedidos.resposta = 'allow'
})

describe('modo de permissão ao vivo', () => {
  it('modoGlobal usa o inicial até o seletor publicar um modo', () => {
    expect(modoGlobal('ask')).toBe('ask')
    definirModoGlobal('full')
    expect(modoGlobal('ask')).toBe('full')
    definirModoGlobal(undefined)
    expect(modoGlobal('ask')).toBe('full')
  })

  it('turno que segue o seletor: trocar no meio vale na próxima ferramenta', async () => {
    let modo: 'ask' | 'full' = 'full'
    const aprovar = createToolApproval(() => modo, 's1', '/repo', 'm1')

    // Irrestrito: ferramenta de servidor MCP passa sem perguntar
    expect(await aprovar(chamada('servidor_acao'))).toBe('approved')
    expect(pedidos.claims).toHaveLength(0)

    // Trocou para Ask no meio: a próxima já pergunta
    modo = 'ask'
    pedidos.resposta = 'deny'
    const negado = await aprovar(chamada('servidor_acao'))
    expect(pedidos.claims).toHaveLength(1)
    expect(negado).toMatchObject({ type: 'denied' })
  })

  it('modo fixo (plano, rotina) não muda', async () => {
    const aprovar = createToolApproval('full', 's1', '/repo', 'm1')
    expect(await aprovar(chamada('servidor_acao'))).toBe('approved')
    expect(pedidos.claims).toHaveLength(0)
  })

  it('remover worktree pergunta mesmo em irrestrito, marcado para a tela não aprovar sozinha', async () => {
    const aprovar = createToolApproval(() => 'full', 's1', '/repo', 'm1')
    await aprovar(chamada('worktree_remove', { destino: 'login' }))
    expect(pedidos.claims).toHaveLength(1)
    expect(pedidos.claims[0].alwaysAsk).toBe(true)
  })
})

describe('permitir vale pelo turno', () => {
  const agir = (app: string) => chamada('cu_computer', { action: 'left_click', app, x: 1, y: 1 })

  it('"Permitir" libera a mesma regra até o fim do turno; o turno seguinte pergunta de novo', async () => {
    pedidos.resposta = 'allow'
    const turno = createToolApproval('ask', 'chat_a', null, 'm1')
    expect(await turno(agir('com.apple.TextEdit'))).toBe('approved')
    expect(await turno(agir('com.apple.TextEdit'))).toBe('approved')
    expect(await turno(agir('com.apple.TextEdit'))).toBe('approved')
    expect(pedidos.claims).toHaveLength(1)
    // Outro app no mesmo turno: pergunta.
    await turno(agir('com.apple.Notes'))
    expect(pedidos.claims).toHaveLength(2)
    // Turno novo (novo gate) na mesma conversa: pergunta de novo.
    const proximo = createToolApproval('ask', 'chat_a', null, 'm2')
    await proximo(agir('com.apple.TextEdit'))
    expect(pedidos.claims).toHaveLength(3)
  })

  it('ação que pergunta sempre continua uma a uma, mesmo aprovada', async () => {
    pedidos.resposta = 'allow'
    const turno = createToolApproval('ask', 'chat_b', null, 'm1')
    await turno(chamada('worktree_remove', { destino: 'feature-x' }))
    await turno(chamada('worktree_remove', { destino: 'feature-x' }))
    expect(pedidos.claims).toHaveLength(2)
  })

  it('"Sempre" grava a regra do app (vale daqui para frente)', async () => {
    const { addTrust } = await import('./trust-rules')
    pedidos.resposta = 'always'
    const turno = createToolApproval('ask', 'chat_c', null, 'm1')
    expect(await turno(agir('com.apple.TextEdit'))).toBe('approved')
    expect(addTrust).toHaveBeenCalledWith('cu:app:com.apple.TextEdit')
  })

  it('modo irrestrito aprova sozinho, como o bash', async () => {
    const aprovar = createToolApproval('full', 'chat_d', null, 'm1')
    expect(await aprovar(agir('com.apple.TextEdit'))).toBe('approved')
    expect(pedidos.claims).toHaveLength(0)
  })
})
