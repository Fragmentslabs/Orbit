import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpConfig, McpServerStatus } from '@shared/mcp'

const stored: { config: McpConfig } = { config: { servers: [] } }
const saveMcpConfig = vi.fn(async (config: McpConfig): Promise<McpServerStatus[]> => {
  stored.config = config
  return config.servers.map((s) => ({ config: s, state: 'connected', toolNames: [] }))
})
const addHook = vi.fn(async (input: unknown, by: string) => ({ id: 'h', ...(input as object), createdBy: by }))
const removeTrust = vi.fn()
const saveSkill = vi.fn(async () => ({ filePath: '/x' }))

vi.mock('../mcp', () => ({
  readMcpConfig: async () => stored.config,
  saveMcpConfig,
  listMcpStatus: () => stored.config.servers.map((s) => ({ config: s, state: 'connected', toolNames: [] })),
  reconnectMcp: async () => [],
  mcpDescriptionsState: () => ({ optimized: false, count: 0, tools: 0 }),
  optimizeMcpServer: async () => ({}),
}))
vi.mock('../hooks/store', () => ({ addHook, listHooks: () => [], removeHook: vi.fn(), setHookEnabled: vi.fn(), updateHook: vi.fn() }))
vi.mock('../permission/trust-rules', () => ({ removeTrust }))
vi.mock('../skills', () => ({ loadSkills: async () => [] }))
vi.mock('../skills/actions', () => ({
  approveSkill: vi.fn(),
  discardSkill: vi.fn(),
  optimizeSkillBySlug: vi.fn(),
  removeSkill: vi.fn(),
  saveSkill,
  setSkillPref: vi.fn(),
  skillMeta: async () => [],
}))
vi.mock('../skills/pending', () => ({ listPendingSkills: async () => [] }))

const { handleToolsRequest, cleanMcpConfig, cleanHookInput } = await import('./tools-requests')
const MASK = '••••••••'

const server = {
  name: 'gh',
  type: 'http' as const,
  url: 'https://api.example.com/mcp?key=sk-live-123',
  headers: { Authorization: 'Bearer secret-token' },
  env: { TOKEN: 'ghp_abc' },
  oauth: { clientId: 'id', clientSecret: 'shh' },
}

beforeEach(() => {
  stored.config = { servers: [server] }
  vi.clearAllMocks()
})

describe('MCP over the companion API', () => {
  it('never sends a secret in the config nor in the status', async () => {
    const config = JSON.stringify(await handleToolsRequest({ type: 'mcp:config' }))
    const status = JSON.stringify(await handleToolsRequest({ type: 'mcp:status' }))
    for (const text of [config, status]) {
      for (const secret of ['sk-live-123', 'secret-token', 'ghp_abc', 'shh']) expect(text).not.toContain(secret)
      expect(text).toContain('TOKEN') // the keys stay readable
      expect(text).toContain('"clientId":"id"')
    }
  })

  it('keeps the saved secrets when the peer saves back what it read', async () => {
    const read = (await handleToolsRequest({ type: 'mcp:config' })) as McpConfig
    read.servers[0].enabled = false
    await handleToolsRequest({ type: 'mcp:save', config: read })
    expect(stored.config.servers[0]).toMatchObject({ ...server, enabled: false })
  })

  it('replaces a secret the peer typed and drops a mask with nothing behind it', async () => {
    const read = (await handleToolsRequest({ type: 'mcp:config' })) as McpConfig
    read.servers[0].env = { TOKEN: 'new-token', GHOST: MASK }
    await handleToolsRequest({ type: 'mcp:save', config: read })
    expect(stored.config.servers[0].env).toEqual({ TOKEN: 'new-token' })
    expect(stored.config.servers[0].headers).toEqual(server.headers)
  })

  it('refuses a malformed config before touching the disk', async () => {
    await expect(handleToolsRequest({ type: 'mcp:save', config: { servers: [{ name: 'x', type: 'ftp' }] } })).rejects.toThrow('invalid')
    await expect(handleToolsRequest({ type: 'mcp:save', config: { servers: [{ name: 'x', type: 'http' }, { name: 'x', type: 'http' }] } })).rejects.toThrow('invalid')
    expect(saveMcpConfig).not.toHaveBeenCalled()
  })

  it('takes back the always-allow rule of the named server', async () => {
    await handleToolsRequest({ type: 'mcp:revoke-trust', name: 'gh' })
    expect(removeTrust).toHaveBeenCalledWith('mcp:gh')
  })

  it('keeps only known fields of a server', () => {
    const clean = cleanMcpConfig({ servers: [{ name: 'a', type: 'stdio', command: 'x', env: { A: 1, B: 'b' }, evil: true, permissionMode: 'root' }] })
    expect(clean.servers[0]).toEqual({ name: 'a', type: 'stdio', command: 'x', env: { B: 'b' } })
  })
})

describe('hooks and skills over the companion API', () => {
  it('writes a hook as the user and refuses a bad event', async () => {
    await handleToolsRequest({ type: 'hooks:add', input: { event: 'pre_tool_call', match: 'bash', command: 'echo', extra: 1 } })
    expect(addHook).toHaveBeenCalledWith({ event: 'pre_tool_call', match: 'bash', command: 'echo' }, 'user')
    expect(() => cleanHookInput({ event: 'nope', command: 'x' })).toThrow('invalid')
    expect(() => cleanHookInput({ event: 'pre_tool_call' })).toThrow('invalid')
  })

  it('passes a skill through the shared save, with no unknown fields', async () => {
    await handleToolsRequest({ type: 'skills:create', data: { name: 'Deploy', content: 'do', slug: 'deploy', admin: true } })
    expect(saveSkill).toHaveBeenCalledWith({ name: 'Deploy', content: 'do', slug: 'deploy' })
  })

  it('rejects what it does not know', async () => {
    await expect(handleToolsRequest({ type: 'mcp:auth', name: 'gh' })).rejects.toThrow('unknown_request')
    await expect(handleToolsRequest({ type: 'skills:import' })).rejects.toThrow('unknown_request')
  })
})
