import { describe, expect, it } from 'vitest'
import type { McpConfig } from '@shared/mcp'
import { MCP_SECRET_MASK, isToolsRequestType, maskMcpConfig, maskUrlSecrets, restoreMcpSecrets } from '@shared/tools-remote'

describe('maskUrlSecrets', () => {
  it('hides query values and the password, keeps host and path', () => {
    const masked = maskUrlSecrets('https://u:pw@host.io/mcp?key=abc&x=1')
    expect(masked).not.toContain('abc')
    expect(masked).not.toContain('pw@')
    expect(masked).toContain('host.io/mcp')
    expect(masked).toContain('key=')
  })

  it('leaves a URL with nothing secret byte for byte', () => {
    expect(maskUrlSecrets('https://host.io/mcp')).toBe('https://host.io/mcp')
    expect(maskUrlSecrets('not a url')).toBe('not a url')
  })
})

describe('mask and restore', () => {
  const stored: McpConfig = {
    servers: [
      { name: 'a', type: 'http', url: 'https://h/mcp?k=1', headers: { A: 'x' }, oauth: { clientId: 'c', clientSecret: 's' } },
      { name: 'b', type: 'stdio', command: 'run', env: { T: 't', U: 'u' } },
    ],
  }

  it('round-trips untouched and never saves a mask', () => {
    const back = restoreMcpSecrets(maskMcpConfig(stored), stored)
    expect(back).toEqual(stored)
    expect(JSON.stringify(back)).not.toContain(MCP_SECRET_MASK)
  })

  it('honours edits next to masked values', () => {
    const masked = maskMcpConfig(stored)
    masked.servers[1].env = { T: MCP_SECRET_MASK, V: 'new' }
    masked.servers[0].oauth = { clientId: 'c2', clientSecret: MCP_SECRET_MASK }
    const back = restoreMcpSecrets(masked, stored)
    expect(back.servers[1].env).toEqual({ T: 't', V: 'new' })
    expect(back.servers[0].oauth).toEqual({ clientId: 'c2', clientSecret: 's' })
  })

  it('takes a URL the peer retyped as it is', () => {
    const masked = maskMcpConfig(stored)
    masked.servers[0].url = 'https://other/mcp'
    expect(restoreMcpSecrets(masked, stored).servers[0].url).toBe('https://other/mcp')
  })

  it('drops a mask for a server that is new or renamed', () => {
    const back = restoreMcpSecrets({ servers: [{ name: 'c', type: 'stdio', command: 'x', env: { T: MCP_SECRET_MASK } }] }, stored)
    expect(back.servers[0].env).toEqual({})
  })
})

describe('isToolsRequestType', () => {
  it('knows the Tools screen and nothing else', () => {
    expect(isToolsRequestType('hooks:list')).toBe(true)
    expect(isToolsRequestType('mcp:auth')).toBe(false)
    expect(isToolsRequestType('memory:list')).toBe(false)
  })
})
