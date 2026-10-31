import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ToolSet } from 'ai'
import type { Hook } from '@shared/hooks'

const dir = vi.hoisted(() => ({ data: '' }))
vi.mock('../storage', () => ({ dataDir: () => dir.data }))

import { __setHooksForTest, addHook, hooksFor, listHooks, validateHook } from './store'
import { attachPostToolHooks, runPostToolHooks, runPreToolHooks } from './run'

const isWin = process.platform === 'win32'

function hook(partial: Partial<Hook>): Hook {
  return { id: 'h1', event: 'pre_tool_call', match: '*', command: 'true', enabled: true, createdAt: 0, createdBy: 'user', ...partial }
}

const call = { toolName: 'bash', input: { command: 'git push --force' }, sessionId: 's1', directory: null }

beforeEach(() => {
  dir.data = mkdtempSync(path.join(tmpdir(), 'orbit-hooks-'))
  __setHooksForTest([])
})

describe('hook matching', () => {
  it('matches the whole tool name, by event, scope and enabled flag', () => {
    __setHooksForTest([
      hook({ id: 'a', match: 'bash' }),
      hook({ id: 'b', match: 'edit|write' }),
      hook({ id: 'c', match: 'bash', enabled: false }),
      hook({ id: 'd', match: 'bash', event: 'post_tool_call' }),
      hook({ id: 'e', match: 'bash', directory: '/repo' }),
      hook({ id: 'f', match: 'ba' }),
    ])
    expect(hooksFor('pre_tool_call', 'bash', null).map((h) => h.id)).toEqual(['a'])
    expect(hooksFor('pre_tool_call', 'bash', '/repo/pkg').map((h) => h.id)).toEqual(['a', 'e'])
    expect(hooksFor('pre_tool_call', 'bash', '/repository').map((h) => h.id)).toEqual(['a'])
    expect(hooksFor('pre_tool_call', 'write', null).map((h) => h.id)).toEqual(['b'])
  })

  it('refuses an empty command or a regex that does not compile', async () => {
    expect(validateHook({ event: 'pre_tool_call', match: '(', command: 'true' })).toMatch(/regular expression/)
    expect(validateHook({ event: 'pre_tool_call', match: '*', command: '  ' })).toMatch(/empty/)
    await expect(addHook({ event: 'pre_tool_call', match: '(', command: 'true' }, 'user')).rejects.toThrow()
    const added = await addHook({ event: 'post_tool_call', match: '', command: ' echo hi ' }, 'agent')
    expect(added).toMatchObject({ match: '*', command: 'echo hi', enabled: true, createdBy: 'agent' })
  })
})

describe.skipIf(isWin)('running hooks', () => {
  it('exit 2 blocks with stderr as the reason; the run is recorded', async () => {
    __setHooksForTest([
      hook({ command: 'grep -q -- "--force" && { echo "no force push" >&2; exit 2; }; exit 0' }),
    ])
    expect(await runPreToolHooks(call)).toBe('no force push')
    expect(listHooks()[0].lastRun).toMatchObject({ tool: 'bash', exitCode: 2, blocked: true })
    expect(await runPreToolHooks({ ...call, input: { command: 'git push' } })).toBeNull()
  })

  it('another exit code or a timeout lets the call through', async () => {
    __setHooksForTest([hook({ id: 'x', command: 'exit 1' }), hook({ id: 'y', command: 'sleep 5', timeoutMs: 300 })])
    expect(await runPreToolHooks(call)).toBeNull()
    const runs = listHooks()
    expect(runs[0].lastRun?.exitCode).toBe(1)
    expect(runs[1].lastRun?.timedOut).toBe(true)
  })

  it('passes the touched file in the env and the output on stdin to post hooks', async () => {
    __setHooksForTest([
      hook({ event: 'post_tool_call', command: 'echo "$ORBIT_TOOL_NAME $ORBIT_FILE $(cat)" >&2; exit 2' }),
    ])
    const feedback = await runPostToolHooks({
      toolName: 'edit',
      input: { filePath: 'src/a.ts' },
      output: 'edited',
      sessionId: 's1',
      directory: dir.data,
    })
    expect(feedback).toContain(`edit ${path.join(dir.data, 'src/a.ts')}`)
    expect(feedback).toContain('"output":"edited"')
  })

  it('appends post hook feedback to a text result, and leaves other results alone', async () => {
    __setHooksForTest([hook({ event: 'post_tool_call', match: 'edit', command: 'echo "type error" >&2; exit 2' })])
    const tools = {
      edit: { execute: async () => 'done' },
      read: { execute: async () => 'content' },
    } as unknown as ToolSet
    attachPostToolHooks(tools, { sessionId: 's1', directory: null })
    const exec = (name: string) => (tools[name].execute as (i: unknown, o: unknown) => Promise<unknown>)({}, {})
    expect(await exec('edit')).toBe('done\n\n[post_tool_call hook]\ntype error')
    expect(await exec('read')).toBe('content')
  })
})
