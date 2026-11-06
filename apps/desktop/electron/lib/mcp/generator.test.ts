import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))
vi.mock('ai', () => ({ streamText: vi.fn() }))
vi.mock('../catalog', () => ({ getProvider: vi.fn() }))
vi.mock('../providers', () => ({ resolveModel: vi.fn() }))
vi.mock('../reasoning', () => ({ interleavedReasoningField: vi.fn(), normalizeMessages: vi.fn() }))

import { suggestionFrom } from './generator'

describe('mcp suggestionFrom', () => {
  it('builds a stdio server with args and env placeholders', () => {
    expect(
      suggestionFrom({
        name: 'GitHub',
        type: 'stdio',
        command: ' npx ',
        args: ['-y', '@modelcontextprotocol/server-github', 3],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: '<YOUR_GITHUB_TOKEN>', '': 'x' },
      }),
    ).toEqual({
      name: 'github',
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      enabled: true,
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: '<YOUR_GITHUB_TOKEN>' },
    })
  })

  it('builds an http server and infers the type from a bare url', () => {
    expect(suggestionFrom({ name: 'docs', url: 'https://x.dev/mcp', headers: { Authorization: 'Bearer <T>' } })).toEqual({
      name: 'docs',
      type: 'http',
      url: 'https://x.dev/mcp',
      enabled: true,
      headers: { Authorization: 'Bearer <T>' },
    })
  })

  it('normalizes the name and drops what the model should not set', () => {
    const server = suggestionFrom({ name: 'Meu Servidor!!', type: 'stdio', command: 'uvx', cwd: '/etc', oauth: { clientId: 'x' } })
    expect(server?.name).toBe('meu-servidor')
    expect(server).not.toHaveProperty('cwd')
    expect(server).not.toHaveProperty('oauth')
  })

  it('refuses an answer that cannot run', () => {
    expect(suggestionFrom({ name: 'x', type: 'stdio' })).toBeNull()
    expect(suggestionFrom({ name: 'x', type: 'http' })).toBeNull()
    expect(suggestionFrom({ type: 'stdio', command: 'npx' })).toBeNull()
  })
})
