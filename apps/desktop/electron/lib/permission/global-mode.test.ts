import { beforeEach, describe, expect, it, vi } from 'vitest'

const requests = vi.hoisted(() => ({ claims: [] as Array<Record<string, unknown>>, answer: 'allow' as unknown }))
vi.mock('../ask-broker', () => ({ newRequestId: () => 'req_1' }))
vi.mock('../ask-dispatch', () => ({
  dispatchAsk: vi.fn(async (_target: string, request: { claim: Record<string, unknown> }) => {
    requests.claims.push(request.claim)
    return requests.answer
  }),
}))
vi.mock('../broadcast', () => ({ broadcastChatEvent: vi.fn() }))
vi.mock('../mcp', () => ({
  getMcpPermissionMode: () => undefined,
  // The test uses "server_action" as if it were an MCP tool: it is the catch-all
  // in permission/rules.ts that recognizes it as such — and it only treats it as
  // MCP when the prefix is a registered server.
  isMcpServerName: (name: string) => name === 'server',
}))
vi.mock('./trust-rules', () => ({ checkTrust: () => false, addTrust: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

const { createToolApproval } = await import('./index')
const { setGlobalMode, setSessionModes, globalMode } = await import('./global-mode')

const makeCall = (toolName: string, input: unknown = {}) => ({
  toolCall: { toolCallId: `c_${Math.random()}`, toolName, input },
})

beforeEach(() => {
  requests.claims = []
  requests.answer = 'allow'
})

describe('live permission mode', () => {
  it('globalMode uses the initial one until the selector publishes a mode', () => {
    expect(globalMode('s1', 'ask')).toBe('ask')
    setGlobalMode('full')
    expect(globalMode('s1', 'ask')).toBe('full')
    setGlobalMode(undefined)
    expect(globalMode('s1', 'ask')).toBe('full')
  })

  it('one chat mode does not leak into the other', () => {
    setSessionModes({ s_full: 'full', s_ask: 'ask' })
    expect(globalMode('s_full', 'ask')).toBe('full')
    expect(globalMode('s_ask', 'full')).toBe('ask')
    // A chat with no entry of its own (child session, worker) falls back to the last published one
    setGlobalMode('ask')
    expect(globalMode('s_worker_without_input', 'approve')).toBe('ask')
  })

  it('turn that follows the selector: switching mid-way counts on the next tool', async () => {
    let mode: 'ask' | 'full' = 'full'
    const approve = createToolApproval(() => mode, 's1', '/repo', 'm1')

    // Unrestricted: an MCP server tool goes through without asking
    expect(await approve(makeCall('server_action'))).toBe('approved')
    expect(requests.claims).toHaveLength(0)

    // Switched to Ask midway: the next one already asks
    mode = 'ask'
    requests.answer = 'deny'
    const denied = await approve(makeCall('server_action'))
    expect(requests.claims).toHaveLength(1)
    expect(denied).toMatchObject({ type: 'denied' })
  })

  it('fixed mode (plan, routine) does not change', async () => {
    const approve = createToolApproval('full', 's1', '/repo', 'm1')
    expect(await approve(makeCall('server_action'))).toBe('approved')
    expect(requests.claims).toHaveLength(0)
  })

  it('removing a worktree asks even in unrestricted mode, flagged so the screen does not approve on its own', async () => {
    const approve = createToolApproval(() => 'full', 's1', '/repo', 'm1')
    await approve(makeCall('worktree_remove', { target: 'login' }))
    expect(requests.claims).toHaveLength(1)
    expect(requests.claims[0].alwaysAsk).toBe(true)
  })
})

describe('allow lasts for the turn', () => {
  const act = (app: string) => makeCall('cu_computer', { action: 'left_click', app, x: 1, y: 1 })

  it('"Allow" frees the same rule until the end of the turn; the next turn asks again', async () => {
    requests.answer = 'allow'
    const turn = createToolApproval('ask', 'chat_a', null, 'm1')
    expect(await turn(act('com.apple.TextEdit'))).toBe('approved')
    expect(await turn(act('com.apple.TextEdit'))).toBe('approved')
    expect(await turn(act('com.apple.TextEdit'))).toBe('approved')
    expect(requests.claims).toHaveLength(1)
    // Another app in the same turn: asks.
    await turn(act('com.apple.Notes'))
    expect(requests.claims).toHaveLength(2)
    // A new turn (new gate) in the same conversation: asks again.
    const nextTurn = createToolApproval('ask', 'chat_a', null, 'm2')
    await nextTurn(act('com.apple.TextEdit'))
    expect(requests.claims).toHaveLength(3)
  })

  it('an action that always asks keeps going one by one, even when approved', async () => {
    requests.answer = 'allow'
    const turn = createToolApproval('ask', 'chat_b', null, 'm1')
    await turn(makeCall('worktree_remove', { target: 'feature-x' }))
    await turn(makeCall('worktree_remove', { target: 'feature-x' }))
    expect(requests.claims).toHaveLength(2)
  })

  it('"Always" records the app rule (it holds from now on)', async () => {
    const { addTrust } = await import('./trust-rules')
    requests.answer = 'always'
    const turn = createToolApproval('ask', 'chat_c', null, 'm1')
    expect(await turn(act('com.apple.TextEdit'))).toBe('approved')
    expect(addTrust).toHaveBeenCalledWith('cu:app:com.apple.TextEdit')
  })

  it('unrestricted mode approves on its own, like bash', async () => {
    const approve = createToolApproval('full', 'chat_d', null, 'm1')
    expect(await approve(act('com.apple.TextEdit'))).toBe('approved')
    expect(requests.claims).toHaveLength(0)
  })
})
