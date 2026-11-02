import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@shared/chat'

// chat-engine pulls in the whole main process; a stub of electron is enough to load
// the pure history → model messages conversion.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => '0', isPackaged: false },
  BrowserWindow: class {},
  ipcMain: { handle() {}, on() {} },
  shell: {},
  dialog: {},
  nativeImage: {},
  net: {},
  session: {},
  webContents: {},
}))

const { toModelMessages } = await import('./chat-engine')
const { SUBCHAT_RESULT_MARKER } = await import('./subchats')
const { stripEngineMarkers } = await import('./todo-context')

function msg(role: 'user' | 'assistant', text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: Math.random().toString(36),
    role,
    parts: [{ id: 'p', type: 'text', text, state: 'done' }],
    createdAt: 0,
    ...extra,
  } as ChatMessage
}

const RESULT = 'The subchat "Fix login" (#ses_child) finished:\n\nDone: fixed src/login.ts'

describe('subchat result marker', () => {
  it('the model reads a subchat result with the marker first, the stored text untouched', () => {
    const history = [msg('user', 'Fix the login and the parser'), msg('assistant', 'Opened a subchat.'), msg('user', RESULT, { origin: 'subchat' })]
    const last = toModelMessages(history).at(-1)
    expect(last?.role).toBe('user')
    expect(last?.content).toBe(`${SUBCHAT_RESULT_MARKER}\n\n${RESULT}`)
    // Persisted text stays what the screens show.
    expect((history[2].parts[0] as { text: string }).text).toBe(RESULT)
  })

  it('a message the user typed gets no marker', () => {
    const out = toModelMessages([msg('user', 'hello')])
    expect(out[0].content).toBe('hello')
  })

  it('says it was not typed by the user and what to do', () => {
    expect(SUBCHAT_RESULT_MARKER).toMatch(/did not type/)
    expect(SUBCHAT_RESULT_MARKER).toMatch(/unblocks/)
    expect(SUBCHAT_RESULT_MARKER).toMatch(/line or two/)
  })

  it('never survives in a visible reply that echoes it', () => {
    expect(SUBCHAT_RESULT_MARKER).not.toContain('\n')
    expect(stripEngineMarkers(`${SUBCHAT_RESULT_MARKER}\nThe login is fixed.`)).toBe('The login is fixed.')
  })
})
