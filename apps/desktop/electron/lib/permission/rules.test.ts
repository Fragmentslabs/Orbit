import { describe, expect, it, vi } from 'vitest'

// No user permissions.json: only the allowlist from the code counts.
vi.mock('../storage', () => ({ dataDir: () => '/tmp/orbit-rules-test-inexistente' }))
// The MCP server names come from the config (../mcp). Here, a fake server:
// what is under test is the RULE, not the registry — and the real registry
// would also make the test depend on the machine of whoever runs it.
vi.mock('../mcp', () => ({ isMcpServerName: (name: string) => name === 'Nodara' || name === 'code' }))

// The permission dialog text comes from the main i18n; the assertions below are the
// product's default language.
const { setMainLocale } = await import('../i18n')
setMainLocale('Portuguese')

const { assess } = await import('./rules')

/**
 * Native tools with "_" in the name must not fall into the MCP catch-all (which
 * reads the prefix as a server name). That is what happened with audio_generate:
 * it asked permission as "Tool from MCP server "audio"".
 */
describe('assess — nativas x MCP', () => {
  it('audio tools are native: they do not ask for permission', () => {
    expect(assess('audio_generate', { text: 'Oi' }, null)).toBeNull()
  })

  it('video and motion tools are native: they do not ask for permission', () => {
    // There is a single transcription, for audio and video.
    expect(assess('transcribe', { sources: [{ path: 'aud_x.m4a' }] }, null)).toBeNull()
    expect(assess('motion_preview', { path: 'edit/anim' }, null)).toBeNull()
    expect(assess('motion_render', { path: 'edit/anim' }, null)).toBeNull()
    expect(assess('video_render', { path: 'edit/anim' }, null)).toBeNull()
    expect(assess('show_video', { path: 'edit/anim/render.mp4' }, null)).toBeNull()
    // Copying a chat attachment into the piece: the reference is the only input.
    expect(assess('motion_asset', { ref: 'vdo_x.mp4', path: 'edit/anim' }, null)).toBeNull()
    // Searching an image in an open collection and importing the chosen one.
    expect(assess('image_search', { query: 'lion' }, null)).toBeNull()
    expect(assess('image_import', { ids: ['wc:1'] }, null)).toBeNull()
  })

  it('code index tools are native: they do not ask even with a same-name MCP server', () => {
    expect(assess('code_search', { query: 'retry' }, null)).toBeNull()
    expect(assess('code_outline', {}, null)).toBeNull()
    expect(assess('code_refs', { symbol: 'buildToolSet', depth: 3 }, null)).toBeNull()
  })

  it('a real MCP server tool still asks', () => {
    const claim = assess('Nodara_search', {}, null)
    expect(claim?.ruleId).toBe('mcp:Nodara')
  })
})

describe('computer use', () => {
  it('reading does not ask; acting asks per app', async () => {
    const { isForbidden } = await import('./rules')
    expect(assess('cu_observe', { app: 'com.apple.TextEdit' }, null)).toBeNull()
    expect(assess('cu_apps', {}, null)).toBeNull()
    const request = assess('cu_computer', { action: 'left_click', app: 'com.apple.TextEdit', element: 3 }, null)
    expect(request).toMatchObject({ ruleId: 'cu:app:com.apple.TextEdit', claim: { tool: 'cu_computer' } })
    expect(request?.claim.detail).toContain('elemento 3')
    expect(assess('cu_computer', { action: 'wait', seconds: 1 }, null)).toBeNull()
    expect(isForbidden('cu_computer', { action: 'left_click', app: 'TextEdit' }, null)).toBe(false)
  })

  it('password vaults and system settings are a hard block, even for observing', async () => {
    const { isForbidden } = await import('./rules')
    expect(isForbidden('cu_observe', { app: 'com.1password.1password' }, null)).toBe(true)
    expect(isForbidden('cu_computer', { action: 'type', app: 'System Settings' }, null)).toBe(true)
    expect(isForbidden('cu_query', { app: 'Keychain Access', text: 'x' }, null)).toBe(true)
  })

  it('browser: approval is per site that was observed', async () => {
    const { computerRegistry } = await import('../computer/registry')
    computerRegistry.record({
      id: 'obs_x',
      sessionId: 's1',
      createdAt: Date.now(),
      app: { pid: 321, bundleId: 'com.apple.Safari', name: 'Safari', active: true, hidden: false },
      window: { id: 1, pid: 321, title: 'Banco', frame: [0, 0, 10, 10] },
      geometry: { frame: [0, 0, 10, 10], width: 10, height: 10 },
      hasScreenshot: true,
      url: 'https://banco.com.br/extrato',
      elements: new Map(),
      digest: null,
    })
    const request = assess('cu_computer', { action: 'left_click', app: 'Safari', x: 1, y: 1 }, null)
    expect(request?.ruleId).toBe('cu:app:com.apple.Safari@banco.com.br')
    expect(request?.claim.title).toBe('Controlar Safari em banco.com.br')
  })

  it('Windows: browser without a URL (UIA has none) approves the whole browser and warns', async () => {
    const { computerRegistry } = await import('../computer/registry')
    computerRegistry.record({
      id: 'obs_w',
      sessionId: 's1',
      createdAt: Date.now(),
      app: { pid: 654, bundleId: 'firefox.exe', exe: 'firefox.exe', name: 'Firefox', active: true, hidden: false },
      window: { id: 2, pid: 654, title: 'Any', frame: [0, 0, 10, 10] },
      geometry: { frame: [0, 0, 10, 10], width: 10, height: 10 },
      hasScreenshot: true,
      url: null,
      elements: new Map(),
      digest: null,
    })
    const request = assess('cu_computer', { action: 'left_click', app: 'firefox', x: 1, y: 1 }, null)
    expect(request?.ruleId).toBe('cu:app:firefox.exe')
    expect(request?.claim.detail).toContain('TODAS as abas')
    // With the URL read from the address bar, it goes back to being per site.
    computerRegistry.record({
      id: 'obs_w2',
      sessionId: 's1',
      createdAt: Date.now(),
      app: { pid: 655, bundleId: 'chrome.exe', exe: 'chrome.exe', name: 'Google Chrome', active: true, hidden: false },
      window: { id: 3, pid: 655, title: 'Banco', frame: [0, 0, 10, 10] },
      geometry: { frame: [0, 0, 10, 10], width: 10, height: 10 },
      hasScreenshot: true,
      url: 'https://banco.com.br/extrato',
      elements: new Map(),
      digest: null,
    })
    const bySite = assess('cu_computer', { action: 'left_click', app: 'chrome', x: 1, y: 1 }, null)
    expect(bySite?.ruleId).toBe('cu:app:chrome.exe@banco.com.br')
    expect(bySite?.claim.detail).not.toContain('TODAS as abas')
  })
})

describe('screen control through bash', () => {
  it('osascript with System Events asks for approval — it goes around Computer Use', () => {
    const request = assess('bash', { command: `osascript -e 'tell application "TextEdit" to activate' -e 'tell application "System Events" to keystroke "oi"'` }, '/repo')
    expect(request?.ruleId).toBe('bash:gui-automation')
    expect(assess('bash', { command: 'osascript -e \'display notification "ok"\'' }, '/repo')).toBeNull()
    const win = assess('bash', { command: `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('hi')"` }, '/repo')
    expect(win?.ruleId).toBe('bash:gui-automation')
    expect(assess('bash', { command: 'powershell -Command "Get-Date"' }, '/repo')).toBeNull()
  })
})

describe('cu_batch', () => {
  it('asks the same per-app approval, with the number of steps', () => {
    const request = assess('cu_batch', { app: 'com.apple.TextEdit', steps: [{ action: 'left_click' }, { action: 'type' }] }, null)
    expect(request?.ruleId).toBe('cu:app:com.apple.TextEdit')
    expect(request?.claim.detail).toContain('2 ações em sequência')
    expect(assess('computer_task', { goal: 'x' }, null)).toBeNull()
  })
})



describe('assess — subchats', () => {
  it('instructing a subchat asks for permission and shows the instruction', () => {
    const a = assess('send_to_subchat', { subchatId: 'ses_f1', message: 'Agora cubra aspas escapadas' }, null)
    expect(a).not.toBeNull()
    expect(a!.ruleId).toBe('subchat:send')
    // It is not "always": the unrestricted mode and the "allow for the turn" count as in the others.
    expect(a!.alwaysAsk).toBeUndefined()
    expect(a!.claim.detail).toContain('Agora cubra aspas escapadas')
  })

  it('reading and opening a subchat do not fall into the MCP catch-all, not even with a same-name server', () => {
    expect(assess('read_subchat', { subchatId: 'ses_f1' }, null)).toBeNull()
    expect(assess('open_subchat', { title: 'X', brief: 'Y'.repeat(30) }, null)).toBeNull()
    expect(assess('suggest_subchat', { title: 'X', brief: 'Y'.repeat(30) }, null)).toBeNull()
  })
})
