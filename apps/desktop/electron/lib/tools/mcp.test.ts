import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServerStatus } from '@shared/mcp'

/**
 * As tools de conexão MCP só PROPÕEM: nada é gravado por elas — quem grava é
 * o card na conversa. Estes testes fixam o contrato que o modelo lê (mensagens
 * de erro que ele consegue corrigir) e a garantia de que não há escrita.
 */

const { status } = vi.hoisted(() => ({ status: vi.fn<() => McpServerStatus[]>() }))
vi.mock('../mcp', () => ({ listMcpStatus: status }))

const { createMcpConnectTool, createMcpServersTool, createMcpUpdateTool } = await import('./mcp')

function server(over: Partial<McpServerStatus> = {}): McpServerStatus {
  return {
    config: { name: 'figma', type: 'http', url: 'https://mcp.figma.com/mcp' },
    state: 'connected',
    toolNames: [],
    ...over,
  }
}

/** Chama o execute da tool direto (o SDK é quem valida o zod antes, num turno real). */
async function call(toolDef: unknown, input: Record<string, unknown>): Promise<string> {
  const execute = (toolDef as { execute: (i: Record<string, unknown>, o: unknown) => Promise<string> }).execute
  return execute(input, {})
}

beforeEach(() => {
  status.mockReset()
  status.mockReturnValue([])
})

describe('mcp_connect', () => {
  it('exige url quando o tipo é http', async () => {
    const out = await call(createMcpConnectTool(), { name: 'notion', type: 'http' })
    expect(out).toContain('exige "url"')
  })

  it('exige command quando o tipo é stdio', async () => {
    const out = await call(createMcpConnectTool(), { name: 'local', type: 'stdio' })
    expect(out).toContain('exige "command"')
  })

  it('não sobrescreve uma conexão existente: manda usar mcp_update', async () => {
    status.mockReturnValue([server()])
    const out = await call(createMcpConnectTool(), {
      name: 'figma',
      type: 'http',
      url: 'https://outro.exemplo/mcp',
    })
    expect(out).toContain('já existe uma conexão')
    expect(out).toContain('mcp_update')
  })

  it('propõe sem gravar nada e manda esperar o card', async () => {
    const out = await call(createMcpConnectTool(), {
      name: 'notion',
      type: 'http',
      url: 'https://mcp.notion.com/mcp',
    })
    expect(out).toContain('proposta')
    expect(out).toContain('card apareceu')
    expect(out).toContain('Nada foi gravado')
  })
})

describe('mcp_update', () => {
  it('recusa um nome que não existe', async () => {
    const out = await call(createMcpUpdateTool(), { name: 'inexistente', type: 'http', url: 'https://x/mcp' })
    expect(out).toContain('não existe conexão')
    expect(out).toContain('mcp_servers')
  })

  it('recusa quando nenhum campo muda', async () => {
    status.mockReturnValue([server()])
    const out = await call(createMcpUpdateTool(), { name: 'figma', type: 'http' })
    expect(out).toContain('nenhum campo')
  })

  it('propõe a troca de um header (o caso do token expirado)', async () => {
    status.mockReturnValue([server({ state: 'error', error: '401 Unauthorized' })])
    const out = await call(createMcpUpdateTool(), {
      name: 'figma',
      type: 'http',
      headers: { Authorization: 'Bearer novo' },
      reason: 'token expirado',
    })
    expect(out).toContain('proposta')
    expect(out).toContain('figma')
    expect(out).toContain('Nada foi gravado')
  })
})

describe('mcp_servers', () => {
  it('diz quando não há nenhum', async () => {
    expect(await call(createMcpServersTool(), {})).toContain('Nenhum servidor MCP')
  })

  it('traz estado, erro, oauth e tools', async () => {
    status.mockReturnValue([
      server({
        state: 'unauthorized',
        usesOAuth: true,
        authorized: false,
        error: 'Authorization required',
        toolNames: ['figma_get_file', 'figma_list'],
      }),
    ])
    const out = await call(createMcpServersTool(), {})
    expect(out).toContain('figma (http) — unauthorized')
    expect(out).toContain('oauth: sem autorização')
    expect(out).toContain('erro: Authorization required')
    expect(out).toContain('figma_get_file')
  })
})
