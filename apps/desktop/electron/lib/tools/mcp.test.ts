import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServerStatus } from '@shared/mcp'

/**
 * The MCP connection tools only PROPOSE: nothing is written by them — what writes is
 * the card in the conversation. These tests pin the contract the model reads (error
 * messages it can correct) and the guarantee that there is no write.
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

/** Calls the tool's execute directly (the SDK is what validates the zod before, in a real turn). */
async function call(toolDef: unknown, input: Record<string, unknown>): Promise<string> {
  const execute = (toolDef as { execute: (i: Record<string, unknown>, o: unknown) => Promise<string> }).execute
  return execute(input, {})
}

beforeEach(() => {
  status.mockReset()
  status.mockReturnValue([])
})

describe('mcp_connect', () => {
  it('requires url when the type is http', async () => {
    const out = await call(createMcpConnectTool(), { name: 'notion', type: 'http' })
    expect(out).toContain('requires "url"')
  })

  it('requires command when the type is stdio', async () => {
    const out = await call(createMcpConnectTool(), { name: 'local', type: 'stdio' })
    expect(out).toContain('requires "command"')
  })

  it('does not overwrite an existing connection: tells you to use mcp_update', async () => {
    status.mockReturnValue([server()])
    const out = await call(createMcpConnectTool(), {
      name: 'figma',
      type: 'http',
      url: 'https://other.example/mcp',
    })
    expect(out).toContain('already exists')
    expect(out).toContain('mcp_update')
  })

  it('proposes without writing anything and tells you to wait for the card', async () => {
    const out = await call(createMcpConnectTool(), {
      name: 'notion',
      type: 'http',
      url: 'https://mcp.notion.com/mcp',
    })
    expect(out).toContain('proposed')
    expect(out).toContain('card appeared')
    expect(out).toContain('Nothing has been saved')
  })
})

describe('mcp_update', () => {
  it('refuses a name that does not exist', async () => {
    const out = await call(createMcpUpdateTool(), { name: 'inexistente', type: 'http', url: 'https://x/mcp' })
    expect(out).toContain('no connection named')
    expect(out).toContain('mcp_servers')
  })

  it('refuses when no field changes', async () => {
    status.mockReturnValue([server()])
    const out = await call(createMcpUpdateTool(), { name: 'figma', type: 'http' })
    expect(out).toContain('no field to change')
  })

  it('proposes swapping a header (the expired token case)', async () => {
    status.mockReturnValue([server({ state: 'error', error: '401 Unauthorized' })])
    const out = await call(createMcpUpdateTool(), {
      name: 'figma',
      type: 'http',
      headers: { Authorization: 'Bearer new' },
      reason: 'token expired',
    })
    expect(out).toContain('proposed')
    expect(out).toContain('figma')
    expect(out).toContain('Nothing has been saved')
  })
})

describe('mcp_servers', () => {
  it('says when there is none', async () => {
    expect(await call(createMcpServersTool(), {})).toContain('No MCP servers')
  })

  it('brings status, error, oauth and tools', async () => {
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
    expect(out).toContain('oauth: not authorized')
    expect(out).toContain('error: Authorization required')
    expect(out).toContain('figma_get_file')
  })
})
