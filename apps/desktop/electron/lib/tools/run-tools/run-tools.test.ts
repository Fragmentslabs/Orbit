import { describe, expect, it } from 'vitest'
import type { ToolSet } from 'ai'
import { z } from 'zod'
import { createToolBridge, toText, type BridgeCall } from './bridge'
import { runScript, type ScriptOptions, type ScriptRun } from './sandbox'
import { formatRun } from './result'

/**
 * The two halves of the mechanism, tested without the app: the sandbox (what the
 * script can reach and what comes back) and the bridge (which tools it may call,
 * and through which gate).
 */

function run(code: string, extra: Partial<ScriptOptions> = {}) {
  return runScript({ code, names: [], bridge: async () => '', timeoutMs: 2000, ...extra })
}

/** A ToolSet whose tools just record the input and answer a fixed text. */
function fakeTools(impl: Record<string, (input: Record<string, unknown>) => unknown>) {
  const set: Record<string, unknown> = {}
  for (const [name, fn] of Object.entries(impl)) {
    set[name] = {
      execute: async (input: Record<string, unknown>, options: { toolCallId: string }) => fn({ ...input, _call: options.toolCallId }),
    }
  }
  return () => set as unknown as ToolSet
}

describe('sandbox', () => {
  it('sends back what the script returned and what it printed', async () => {
    const result = await run('console.log("passo 1")\nreturn 2 + 2')
    expect(result.returned).toBe(4)
    expect(result.output).toContain('passo 1')
    expect(result.printed).toBe(1)
    expect(result.error).toBeNull()
  })

  it('exposes the tools as async functions and hands their answer to the script', async () => {
    const result = await run('const a = await tools.read({ filePath: "x.ts" })\nconsole.log(a)\nreturn a.length', {
      names: ['read'],
      bridge: async (name, input) => `${name}:${(input as { filePath: string }).filePath}`,
    })
    expect(result.returned).toBe(9)
    expect(result.output).toBe('read:x.ts')
  })

  it('is a bare JavaScript context: no process, no require, no filesystem, no timers', async () => {
    const result = await run('console.log(typeof process, typeof require, typeof setTimeout, typeof fetch)')
    expect(result.output).toBe('undefined undefined undefined undefined')
  })

  it('turns an error into a message, with the stack pointing at the script own line', async () => {
    const result = await run('const x = null\nx.y')
    expect(result.error).toMatch(/TypeError/)
    // line 2 of the script, not of the wrapped source
    expect(result.error).toMatch(/run_tools\.js:2/)
  })

  it('cuts a synchronous infinite loop at the sync limit instead of freezing everything', async () => {
    const result = await run('while (true) {}', { syncLimitMs: 100 })
    expect(result.stopped).toBe('timeout')
  })

  it('cuts a script that never settles at the wall clock', async () => {
    const result = await run('await new Promise(() => {})', { timeoutMs: 150 })
    expect(result.stopped).toBe('timeout')
    expect(result.ms).toBeGreaterThanOrEqual(100)
  })

  it('stops on abort and keeps the output produced so far', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    const result = await run('console.log("antes")\nawait new Promise(() => {})', {
      timeoutMs: 2000,
      signal: controller.signal,
    })
    expect(result.stopped).toBe('aborted')
    expect(result.output).toContain('antes')
  })

  it('keeps the middle out of a very long output, without losing the end', async () => {
    const result = await run('console.log("x".repeat(30000))', { timeoutMs: 4000 })
    expect(result.output.length).toBeLessThan(20_000)
    expect(result.output).toMatch(/omitted from the middle/)
  })
})

describe('bridge', () => {
  it('only exposes the tools of the turn, never run_tools itself', () => {
    const bridge = createToolBridge({
      tools: fakeTools({ read: () => 'ok', run_tools: () => 'nope' }),
      idPrefix: 's',
    })
    expect(bridge.names).toEqual(['read'])
  })

  it('answers with the text the tool returned, and counts the call', async () => {
    const bridge = createToolBridge({
      tools: fakeTools({ grep: (input) => `achou ${input.pattern}` }),
      approve: async () => 'approved',
      idPrefix: 's',
    })
    await expect(bridge.call('grep', { pattern: 'x' })).resolves.toBe('achou x')
    expect(bridge.calls).toEqual([{ name: 'grep', ok: true }])
  })

  it('records the exit code a command reported — the script would otherwise hide it', async () => {
    const bridge = createToolBridge({
      tools: fakeTools({ bash: () => 'find: electron/lib/tools: No such file or directory\n(exit code: 1)' }),
      approve: async () => 'approved',
      idPrefix: 's',
    })
    await bridge.call('bash', { command: 'find electron/lib/tools' })
    expect(bridge.calls).toEqual([
      { name: 'bash', ok: true, exit: 1, head: 'find: electron/lib/tools: No such file or directory' },
    ])
  })

  it('explains a name that does not exist instead of failing inside the script silently', async () => {
    const bridge = createToolBridge({ tools: fakeTools({ read: () => 'ok' }), approve: async () => 'approved', idPrefix: 's' })
    await expect(bridge.call('read_all', {})).rejects.toThrow(/no tool called "read_all".*Available: read/)
  })

  it('does not run what the gate denies', async () => {
    let executed = false
    const bridge = createToolBridge({
      tools: fakeTools({
        write: () => {
          executed = true
          return 'escrito'
        },
      }),
      approve: async () => ({ type: 'denied', reason: 'Denied by the user.' }),
      idPrefix: 's',
    })
    await expect(bridge.call('write', { filePath: 'a' })).rejects.toThrow(/NOT run/)
    expect(executed).toBe(false)
    expect(bridge.calls[0].ok).toBe(false)
  })

  it('validates the input against the tool schema before calling it', async () => {
    const set = {
      read: {
        inputSchema: z.object({ filePath: z.string() }),
        execute: async () => 'ok',
      },
    } as unknown as ToolSet
    const bridge = createToolBridge({ tools: () => set, approve: async () => 'approved', idPrefix: 's' })
    await expect(bridge.call('read', { filePath: 42 })).rejects.toThrow(/invalid input/)
  })

  it('stops a runaway loop instead of letting it hammer the project', async () => {
    const bridge = createToolBridge({ tools: fakeTools({ ls: () => 'a' }), approve: async () => 'approved', idPrefix: 's' })
    const code = 'let n = 0\nwhile (true) { await tools.ls({}); n++ }'
    const result = await run(code, { names: bridge.names, bridge: bridge.call, timeoutMs: 5000, syncLimitMs: 5000 })
    expect(result.error).toMatch(/more than 200 tool calls/)
    expect(bridge.calls.length).toBe(200)
  })
})

describe('result', () => {
  const run = (patch: Partial<ScriptRun> = {}): ScriptRun => ({
    returned: undefined,
    output: '',
    printed: 0,
    error: null,
    stopped: null,
    ms: 1200,
    ...patch,
  })

  it('sends back the value and the printed lines, with what the run cost', () => {
    const text = formatRun(run({ returned: 'achado: 3', output: 'lendo a.ts', printed: 1 }), [{ name: 'read', ok: true }], 120_000)
    expect(text).toContain('achado: 3')
    expect(text).toContain('Printed:\nlendo a.ts')
    expect(text).toContain('[1.2s · 1 tool call: read×1 · 1 console line]')
  })

  it('says plainly when the script produced nothing — the classic forgotten return', () => {
    expect(formatRun(run(), [], 120_000)).toMatch(/printed nothing and returned nothing/)
  })

  it('on a timeout it says how long it waited and keeps the output produced', () => {
    const text = formatRun(run({ stopped: 'timeout', output: 'parcial' }), [], 120_000)
    expect(text).toMatch(/stopped after 120s/)
    expect(text).toContain('Output so far:\nparcial')
  })

  it('shows the error with the output that came before it', () => {
    const text = formatRun(run({ error: 'TypeError: x is null', output: 'antes' }), [], 120_000)
    expect(text.startsWith('TypeError: x is null')).toBe(true)
    expect(text).toContain('Output so far:\nantes')
  })

  it('summarizes the calls that failed — a swallowed error must not look like "nothing found"', () => {
    const calls: BridgeCall[] = [
      { name: 'read', ok: true },
      { name: 'read', ok: false, error: 'ENOENT: no such file' },
    ]
    expect(formatRun(run({ returned: 'ok' }), calls, 120_000)).toMatch(/2 tool calls: read×2 · 1 failed \(ENOENT/)
  })

  it('names the step that exited non-zero — a swallowed failure must not read as an answer', () => {
    const calls: BridgeCall[] = [
      { name: 'bash', ok: true, exit: 1, head: 'find: electron/lib/tools: No such file or directory' },
    ]
    expect(formatRun(run({ returned: 'arquivos .ts: 0' }), calls, 120_000)).toMatch(
      /1 exited non-zero \(bash → 1: find: electron\/lib\/tools: No such file or directory\)/,
    )
  })

  it('nudges the run that made a single call — the shallow REPL pattern', () => {
    const calls: BridgeCall[] = [{ name: 'ls', ok: true }]
    expect(formatRun(run({ returned: '80 files' }), calls, 120_000)).toContain('Only 1 tool call in this run')
  })

  it('stays quiet when the run did the whole job', () => {
    const calls: BridgeCall[] = Array.from({ length: 8 }, () => ({ name: 'read', ok: true }))
    expect(formatRun(run({ returned: 'ok' }), calls, 120_000)).not.toContain('Only')
  })
})

describe('toText', () => {
  it('flattens what a tool returns into the text the model would have read', () => {
    expect(toText('texto')).toBe('texto')
    expect(toText({ message: 'com imagem', url: 'x' })).toBe('com imagem')
    expect(toText({ a: 1 })).toBe('{"a":1}')
    expect(toText(null)).toBe('')
  })
})
