import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from './context'

/**
 * Design no MODO CÓDIGO: a tool só registra e abre uma pasta que o agente já
 * escreveu com write/edit — espelha o mock de video-chat.test.ts.
 */

const userData = path.join(os.tmpdir(), `orbit-design-code-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userData, getAppPath: () => userData, isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  net: {},
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
  session: {},
  dialog: {},
}))

const { createDesignTools } = await import('./design')

type Exec = (input: unknown, options: unknown) => Promise<unknown>
const run = (tools: Record<string, unknown>, name: string, input: unknown) =>
  (tools[name] as { execute: Exec }).execute(input, { toolCallId: 'call1', messages: [], abortSignal: undefined }) as Promise<string>

afterAll(async () => {
  await fsp.rm(userData, { recursive: true, force: true })
})

describe('design_preview', () => {
  it('registra e abre um canvas que já existe na pasta de trabalho', async () => {
    const directory = path.join(userData, 'proj')
    const canvasFolder = path.join(directory, 'design', 'logo')
    await fsp.mkdir(canvasFolder, { recursive: true })
    await fsp.writeFile(
      path.join(canvasFolder, 'canvas.json'),
      JSON.stringify({ v: 1, boards: { 'Main.html': { x: 0, y: 0, w: 400, h: 400 } }, order: ['Main.html'] }),
      'utf8',
    )
    await fsp.writeFile(path.join(canvasFolder, 'Main.html'), '<!doctype html><title>F</title><body>F</body>', 'utf8')

    const ctx: ToolContext = { sessionId: 'sess1', directory, extraDirectories: [], abort: new AbortController().signal }
    const tools = createDesignTools(ctx, { sessionId: 'sess1' })

    const report = await run(tools, 'design_preview', { path: 'design/logo' })
    expect(report).toContain('is open in the Design tab')
    expect(report).toContain('with 1 artboard')
  })

  it('recusa um caminho fora da pasta de trabalho', async () => {
    const directory = path.join(userData, 'proj2')
    await fsp.mkdir(directory, { recursive: true })
    const ctx: ToolContext = { sessionId: 'sess1', directory, extraDirectories: [], abort: new AbortController().signal }
    const tools = createDesignTools(ctx, { sessionId: 'sess1' })
    await expect(run(tools, 'design_preview', { path: '../../etc' })).rejects.toThrow(/Access denied/)
  })
})
