import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_APP_SETTINGS, normalizeAppSettings } from '@shared/app-settings'
import type { SendMessageInput } from '@shared/chat'

vi.mock('./storage', () => ({ readJson: vi.fn(async () => null), writeJson: vi.fn(async () => {}) }))

const { agentMayUseBrowser, setAppSettings } = await import('./app-settings')

const input = (fromBrowser?: boolean): SendMessageInput => ({
  sessionId: 's1',
  text: 'test the screen',
  providerId: 'p',
  modelId: 'm',
  mode: 'code',
  options: { fromBrowser },
})

describe('normalizeAppSettings', () => {
  it('with nothing saved, the behavior from before the options existed applies', () => {
    expect(normalizeAppSettings(undefined)).toEqual(DEFAULT_APP_SETTINGS)
  })

  it('discards values outside the domain and fills in what is missing', () => {
    const settings = normalizeAppSettings({
      chatView: 'huge',
      autoArchiveDays: 5,
      deleteArchivedDays: 2,
      autoCompact: 'off',
      transientRetries: 99,
      autoContinues: 2,
      browser: { cookies: 'until-quit' },
    })
    expect(settings.chatView).toBe('summary')
    expect(settings.autoArchiveDays).toBeNull()
    expect(settings.deleteArchivedDays).toBeNull()
    // "Off" no longer exists: the choice saved by an old version goes back to the default.
    expect(settings.autoCompact).toBe('auto')
    expect(settings.transientRetries).toBe(3)
    expect(settings.autoContinues).toBe(2)
    expect(settings.browser).toEqual({ links: 'integrated', agentTools: true, cookies: 'until-quit' })
  })

  it('accepts the short archival periods', () => {
    expect(normalizeAppSettings({ autoArchiveDays: 2 }).autoArchiveDays).toBe(2)
    expect(normalizeAppSettings({ autoArchiveDays: 3 }).autoArchiveDays).toBe(3)
    expect(normalizeAppSettings({ deleteArchivedDays: 30 }).deleteArchivedDays).toBe(30)
  })

  it('the sidebar width stays within the draggable range, with the usual size by default', () => {
    expect(normalizeAppSettings(undefined).sidebarWidth).toBe(256)
    expect(normalizeAppSettings({ sidebarWidth: 300 }).sidebarWidth).toBe(300)
    // Saved outside the domain (window of another size, corrupted value): the
    // width is brought to the edge instead of discarded.
    expect(normalizeAppSettings({ sidebarWidth: 9999 }).sidebarWidth).toBe(420)
    expect(normalizeAppSettings({ sidebarWidth: 10 }).sidebarWidth).toBe(240)
    expect(normalizeAppSettings({ sidebarWidth: Number.NaN }).sidebarWidth).toBe(256)
  })

  it('call mode: fills in what is missing and only accepts the offered pauses', () => {
    expect(normalizeAppSettings({}).voice.call).toEqual({ enabled: true, silenceMs: 1300 })
    // Settings saved before call mode existed: tts/stt stay, call gets the default.
    const old = normalizeAppSettings({ voice: { tts: { voice: 'M1' }, stt: { engine: 'whisper' } } })
    expect(old.voice.tts.voice).toBe('M1')
    expect(old.voice.call).toEqual({ enabled: true, silenceMs: 1300 })
    expect(normalizeAppSettings({ voice: { call: { enabled: false, silenceMs: 1800 } } }).voice.call).toEqual({
      enabled: false,
      silenceMs: 1800,
    })
    expect(normalizeAppSettings({ voice: { call: { silenceMs: 37 } } }).voice.call.silenceMs).toBe(1300)
  })
})

describe('agentMayUseBrowser', () => {
  it('with the option on, the agent uses the browser on its own', async () => {
    await setAppSettings({ browser: { agentTools: true } })
    expect(agentMayUseBrowser(input())).toBe(true)
  })

  it('off, only when the request came from the full-screen browser chat', async () => {
    await setAppSettings({ browser: { agentTools: false } })
    expect(agentMayUseBrowser(input())).toBe(false)
    expect(agentMayUseBrowser(input(true))).toBe(true)
  })
})

describe('computer', () => {
  it('off by default, directed pointer and 1280 px', () => {
    expect(normalizeAppSettings(undefined).computer).toEqual({ enabled: false, pointer: 'directed', maxScreenshotEdge: 1280, model: null })
  })

  it('only accepts the values offered on screen', () => {
    expect(normalizeAppSettings({ computer: { enabled: true, pointer: 'global', maxScreenshotEdge: 1600 } }).computer).toEqual({
      enabled: true,
      pointer: 'global',
      maxScreenshotEdge: 1600,
      model: null,
    })
    expect(normalizeAppSettings({ computer: { pointer: 'mouse', maxScreenshotEdge: 999 } }).computer).toEqual({
      enabled: false,
      pointer: 'directed',
      maxScreenshotEdge: 1280,
      model: null,
    })
  })
})

describe('agentMayControlComputer', () => {
  const request = (over: Partial<SendMessageInput> = {}, computer = true): SendMessageInput => ({
    ...input(),
    ...over,
    options: { computer },
  })

  it('needs both keys: Preferences and the conversation mode', async () => {
    const { agentMayControlComputer } = await import('./app-settings')
    await setAppSettings({ computer: { enabled: false } })
    expect(agentMayControlComputer(request(), true)).toBe(false)
    await setAppSettings({ computer: { enabled: true } })
    expect(agentMayControlComputer(request({}, false), true)).toBe(false)
    expect(agentMayControlComputer(request(), true)).toBe(true)
  })

  it('never in a worker nor where there is no driver', async () => {
    const { agentMayControlComputer } = await import('./app-settings')
    await setAppSettings({ computer: { enabled: true } })
    expect(agentMayControlComputer(request({ orchestrationRole: 'worker' }), true)).toBe(false)
    expect(agentMayControlComputer(request(), false)).toBe(false)
  })
})

describe('computer.model', () => {
  it('computer agent model: null by default, valid kept, junk discarded', () => {
    expect(normalizeAppSettings(undefined).computer.model).toBeNull()
    expect(normalizeAppSettings({ computer: { model: { providerId: 'anthropic', modelId: 'claude-haiku' } } }).computer.model).toEqual({
      providerId: 'anthropic',
      modelId: 'claude-haiku',
    })
    expect(normalizeAppSettings({ computer: { model: 'haiku' } }).computer.model).toBeNull()
  })
})

describe('worktrees settings — legacy saved format', () => {
  it('translates the old key and values at read time', () => {
    // Fixture in the format written before the English standardization: `pasta`
    // instead of `folder`, `padrao`/`projeto`/`personalizada` instead of
    // `default`/`project`/`custom`.
    expect(normalizeAppSettings({ worktrees: { local: 'personalizada', pasta: ' /tmp/wt ' } }).worktrees).toEqual({
      local: 'custom',
      folder: '/tmp/wt',
    })
    expect(normalizeAppSettings({ worktrees: { local: 'padrao' } }).worktrees).toEqual({ local: 'default', folder: null })
    expect(normalizeAppSettings({ worktrees: { local: 'projeto' } }).worktrees).toEqual({ local: 'project', folder: null })
  })

  it('is idempotent: normalizing what is already normalized changes nothing', () => {
    const once = normalizeAppSettings({ worktrees: { local: 'personalizada', pasta: '/tmp/wt' } })
    expect(normalizeAppSettings(once)).toEqual(once)
    expect(normalizeAppSettings(normalizeAppSettings(once))).toEqual(once)
    const current = normalizeAppSettings({ worktrees: { local: 'custom', folder: '/tmp/wt' } })
    expect(normalizeAppSettings(current)).toEqual(current)
  })

  it('custom without a folder falls back to the default, which has no folder', () => {
    expect(normalizeAppSettings({ worktrees: { local: 'personalizada', pasta: null } }).worktrees).toEqual({
      local: 'default',
      folder: null,
    })
    expect(normalizeAppSettings({ worktrees: { local: 'custom', folder: '/tmp/wt' } }).worktrees).toEqual({
      local: 'custom',
      folder: '/tmp/wt',
    })
  })
})
