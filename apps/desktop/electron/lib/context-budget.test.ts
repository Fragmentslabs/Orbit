import { describe, expect, it } from 'vitest'
import type { ModelMessage } from 'ai'

import type { CatalogModel } from '@shared/chat'
import {
  contextBudget,
  createTrimState,
  estimateTokens,
  maxStepsFor,
  trimTurnContext,
  workingBudget,
} from './context-budget'

/**
 * This cut is the only thing between the tool loop and a request the provider
 * refuses entirely. Erring low lets the turn blow up again (it was the original
 * bug: 3.4M tokens requested on a 1M model); erring high erases the model's
 * workbench in the middle of the task, and it re-reads everything in a loop.
 *
 * The tool-call/tool-result pair is also fragile: providers refuse with a 400 a
 * history in which the call exists and the result vanished, so what this
 * module does is EMPTY the result, never remove it.
 */

const model = (context: number, output = 8_000): CatalogModel =>
  ({ id: 'm', name: 'M', limit: { context, output } }) as CatalogModel

/** An assistant(tool-call) + tool(tool-result) pair, as the SDK assembles it. */
function toolPair(id: string, tool: string, input: unknown, output: string): ModelMessage[] {
  return [
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName: tool, input }] },
    {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: id, toolName: tool, output: { type: 'text', value: output } }],
    },
  ] as ModelMessage[]
}

const filler = (chars: number) => 'x'.repeat(chars)

function outputsOf(messages: ModelMessage[]): string[] {
  const values: string[] = []
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      const p = part as unknown as Record<string, unknown>
      if (p.type !== 'tool-result') continue
      const out = p.output as { value?: unknown }
      values.push(typeof out?.value === 'string' ? out.value : '')
    }
  }
  return values
}

describe('estimateTokens', () => {
  it('charges a binary attachment by fixed size, not by base64 character', () => {
    // A 1MB PNG becomes ~250k characters of base64 and ~1.5k tokens at the
    // provider. Counting it by character would make the budget think it overflowed and
    // discard half a turn in a turn that fit comfortably.
    const withImage: ModelMessage[] = [
      { role: 'user', content: [{ type: 'file', data: filler(250_000), mediaType: 'image/png' }] },
    ] as ModelMessage[]
    expect(estimateTokens(withImage)).toBeLessThan(5_000)
  })

  it('counts text at the right order of magnitude', () => {
    const messages: ModelMessage[] = [{ role: 'user', content: filler(40_000) }]
    expect(estimateTokens(messages)).toBe(10_000)
  })
})

describe('maxStepsFor', () => {
  it('scales by the context, within the floor and the ceiling', () => {
    expect(maxStepsFor(model(200_000))).toBe(120)
    expect(maxStepsFor(model(1_048_576))).toBe(300)
    expect(maxStepsFor(model(400_000))).toBeGreaterThanOrEqual(117)
  })

  it('uses the floor when the catalog does not announce a context', () => {
    expect(maxStepsFor(undefined)).toBe(120)
    expect(maxStepsFor({ id: 'm', name: 'M' } as CatalogModel)).toBe(120)
  })
})

describe('contextBudget', () => {
  it('respects the absolute ceiling on giant-window models', () => {
    // Without the ceiling, a 1M model would only cut near 1M — the conversation
    // would routinely operate with hundreds of thousands of tokens per step.
    expect(contextBudget(model(1_048_576, 128_000))).toBeLessThanOrEqual(300_000)
  })

  it('discounts the output and the system prompt from the model window', () => {
    expect(contextBudget(model(200_000, 8_000))).toBe(162_000)
  })
})

describe('trimTurnContext', () => {
  it('returns the SAME reference when it fits the budget', () => {
    // prepareStep answers `{}` in that case and the SDK skips rewriting the
    // messages — comparing by reference is what signals that.
    const messages = [...toolPair('a', 'read', { filePath: 'a.ts' }, filler(200))]
    expect(trimTurnContext(messages, 100_000)).toBe(messages)
  })

  it('empties the oldest result, preserving the tool call', () => {
    const messages = [
      ...toolPair('1', 'bash', { command: 'npm test' }, filler(120_000)),
      ...toolPair('2', 'bash', { command: 'npm run lint' }, filler(120_000)),
      ...toolPair('3', 'bash', { command: 'git status' }, filler(120_000)),
    ]
    const trimmed = trimTurnContext(messages, 65_000)

    // No message vanishes: breaking the call/result pair brings the turn down with a 400.
    expect(trimmed).toHaveLength(messages.length)
    const calls = trimmed.filter((m) => m.role === 'assistant')
    expect(calls).toHaveLength(3)
    // The oldest became the notice; the most recent stays intact.
    const outputs = outputsOf(trimmed)
    expect(outputs[0]).toContain('tool output dropped')
    expect(outputs[2]).toBe(filler(120_000))
  })

  it('discards a repeated call with the same arguments, keeping the last one', () => {
    // `read` of the same file three times in a turn is by far the most
    // common case — in real data `read` alone was half of the tools payload.
    const messages = [
      ...toolPair('1', 'read', { filePath: 'src/app.ts' }, filler(60_000)),
      ...toolPair('2', 'bash', { command: 'npm test' }, filler(60_000)),
      ...toolPair('3', 'read', { filePath: 'src/app.ts' }, filler(60_000)),
    ]
    const outputs = outputsOf(trimTurnContext(messages, 30_000))

    expect(outputs[0]).toContain('repeated later in the turn')
    expect(outputs[2]).toBe(filler(60_000))
  })

  it('does not touch repeated tool calls with a side effect', () => {
    // The second `git status` does not invalidate the first as a record of what
    // happened in the turn — and `write`/`edit` change the disk between calls.
    const messages = [
      ...toolPair('1', 'bash', { command: 'git status' }, filler(40_000)),
      ...toolPair('2', 'bash', { command: 'git status' }, filler(40_000)),
    ]
    expect(trimTurnContext(messages, 60_000)).toBe(messages)
  })

  it('preserves the workbench while the age cut resolves', () => {
    // Discarding what the model just read would make it re-read in a loop and never
    // converge — it burns tokens without moving forward.
    const messages = Array.from({ length: 14 }, (_, i) =>
      toolPair(String(i), 'bash', { command: `cmd ${i}` }, filler(40_000)),
    ).flat()
    // Budget in which the age cut alone already solves it: the last 10
    // (KEEP_RECENT_RESULTS) never even get touched.
    const outputs = outputsOf(trimTurnContext(messages, 105_000))

    expect(outputs.slice(-10).every((o) => o === filler(40_000))).toBe(true)
    expect(outputs.some((o) => o.includes('tool output dropped'))).toBe(true)
  })

  it('in the worst case advances over the recent ones, stopping at the last two when they fit', () => {
    // A few giant outputs alone already go past the budget. Here the age cut
    // has nothing to discard, and stopping there would return to the provider the
    // same request it refuses — the original defect.
    const messages = Array.from({ length: 6 }, (_, i) =>
      toolPair(String(i), 'bash', { command: `cmd ${i}` }, filler(80_000)),
    ).flat()
    const outputs = outputsOf(trimTurnContext(messages, 45_000))

    expect(outputs.slice(0, 4).every((o) => o.includes('tool output dropped'))).toBe(true)
    expect(outputs.slice(-2).every((o) => o === filler(80_000))).toBe(true)
  })

  it('discards even a recent result when it alone does not fit', () => {
    // The real case: an MCP screenshot serialized as 3.3M characters of
    // base64 was the LAST result of the turn. The floor of the two recent ones
    // protected it and the request went out with 917k tokens on a 1M model.
    const messages = [
      ...toolPair('a', 'read', { filePath: 'src/app.ts' }, filler(4_000)),
      ...toolPair('b', 'Nodara_adb_screenshot', {}, filler(3_300_000)),
    ]
    const budget = 200_000
    const trimmed = trimTurnContext(messages, budget)
    const outputs = outputsOf(trimmed)

    expect(outputs[0]).toBe(filler(4_000))
    expect(outputs[1]).toContain('too large to fit')
    expect(estimateTokens(trimmed)).toBeLessThanOrEqual(budget)
  })

  it('holds the turn that caused the bug: 1M window, the whole step ceiling', () => {
    // Reconstruction of the real case (mimo-v2-pro on Console Go, window of
    // 1,048,576): the turn requested 3,463,912 tokens and the provider refused the
    // whole request. Mix measured in the user's sessions — `bash` at the
    // 30k chars ceiling, `read` averaging 4.4k, and re-reading of the same
    // files, which alone was half of the tools payload.
    const catalog = model(1_048_576, 128_000)
    const budget = contextBudget(catalog)
    const files = ['src/app.ts', 'src/engine.ts', 'src/ui.tsx', 'src/store.ts']

    const messages = Array.from({ length: maxStepsFor(catalog) }, (_, i) => {
      // Real averages per tool, measured in the sessions: bash at the 30k
      // chars, websearch ~15k, read ~4.4k.
      if (i % 3 === 0) return toolPair(String(i), 'bash', { command: `npm run task-${i}` }, filler(30_000))
      if (i % 3 === 1) return toolPair(String(i), 'websearch', { query: `q${i}` }, filler(15_000))
      return toolPair(String(i), 'read', { filePath: files[i % files.length] }, filler(4_400))
    }).flat()

    expect(estimateTokens(messages)).toBeGreaterThan(1_048_576)
    expect(estimateTokens(trimTurnContext(messages, budget))).toBeLessThanOrEqual(budget)
  })

  it('shortens the input of the call whose result was discarded', () => {
    // The `content` of a large `write` stays in the context forever; once
    // the result is discarded, it is no longer good for anything.
    const messages = [
      ...toolPair('1', 'write', { filePath: 'a.ts', content: filler(200_000) }, 'ok'),
      ...toolPair('2', 'bash', { command: 'npm test' }, filler(4_000)),
      ...toolPair('3', 'bash', { command: 'npm run lint' }, filler(4_000)),
    ]
    const trimmed = trimTurnContext(messages, 5_000)
    const call = (trimmed[0].content as unknown as Array<Record<string, unknown>>)[0]
    const input = call.input as { filePath: string; content: string }

    // The keys stay: the provider validates the input against the tool's schema.
    expect(input.filePath).toBe('a.ts')
    expect(input.content.length).toBeLessThan(600)
    expect(input.content).toContain('chars dropped')
  })

  it('is idempotent — what was already cut is not reprocessed on every step', () => {
    const messages = Array.from({ length: 4 }, (_, i) =>
      toolPair(String(i), 'bash', { command: `cmd ${i}` }, filler(90_000)),
    ).flat()
    const first = trimTurnContext(messages, 20_000)
    expect(first).not.toBe(messages)
    // Second pass over the result: nothing new to discard, the same
    // reference back. Without this prepareStep would rewrite the messages on
    // every step of the turn.
    expect(trimTurnContext(first, 20_000)).toBe(first)
  })
})

describe('trimTurnContext — redundancy between reads', () => {
  const readOut = (file: string, body: string) => `<file path="${file}">\n${body}\n</file>`

  it('discards the read whose lines a later read of the same file covers', () => {
    const messages = [
      ...toolPair('1', 'read', { filePath: 'src/a.ts', offset: 40, limit: 20 }, readOut('/repo/src/a.ts', filler(40_000))),
      ...toolPair('2', 'read', { filePath: '/repo/src/a.ts' }, readOut('/repo/src/a.ts', filler(40_000))),
    ]
    const outputs = outputsOf(trimTurnContext(messages, 30_000))
    expect(outputs[0]).toContain('read again later')
    expect(outputs[1]).toContain(filler(100))
  })

  it('keeps the read when the later one shows another range', () => {
    const messages = [
      ...toolPair('1', 'read', { filePath: 'a.ts', offset: 1, limit: 50 }, readOut('/repo/a.ts', filler(40_000))),
      ...toolPair('2', 'read', { filePath: 'a.ts', offset: 30, limit: 50 }, readOut('/repo/a.ts', filler(40_000))),
    ]
    expect(trimTurnContext(messages, 30_000)).toBe(messages)
  })

  it('treats cat and sed -n in bash as reading the same file', () => {
    const messages = [
      ...toolPair('1', 'bash', { command: "sed -n '10,30p' src/a.ts" }, filler(40_000)),
      ...toolPair('2', 'read', { filePath: 'src/a.ts' }, readOut('/repo/src/a.ts', filler(40_000))),
      ...toolPair('3', 'bash', { command: 'cd src && cat a.ts' }, filler(40_000)),
    ]
    const outputs = outputsOf(trimTurnContext(messages, 60_000, { directory: '/repo' }))
    expect(outputs[0]).toContain('read again later')
    expect(outputs[1]).toContain('read again later')
    expect(outputs[2]).toBe(filler(40_000))
  })

  it('discards the repeated search in bash, but not a command with a side effect', () => {
    const messages = [
      ...toolPair('1', 'bash', { command: 'grep -rn foo src' }, filler(40_000)),
      ...toolPair('2', 'bash', { command: 'npm test' }, filler(40_000)),
      ...toolPair('3', 'bash', { command: 'npm test' }, filler(40_000)),
      ...toolPair('4', 'bash', { command: 'grep -rn foo src' }, filler(40_000)),
    ]
    const outputs = outputsOf(trimTurnContext(messages, 60_000, { directory: '/repo' }))
    expect(outputs[0]).toContain('identical arguments')
    expect(outputs[1]).toBe(filler(40_000))
    expect(outputs[3]).toBe(filler(40_000))
  })

  it('a cat with the middle cut does not cover the previous read', () => {
    const messages = [
      ...toolPair('1', 'read', { filePath: 'a.ts', offset: 900, limit: 50 }, readOut('/repo/a.ts', filler(40_000))),
      ...toolPair('2', 'bash', { command: 'cat a.ts' }, `${filler(6_000)}\n… (90000 characters omitted from the middle of the output) …\n${filler(10_000)}`),
    ]
    expect(trimTurnContext(messages, 20_000, { directory: '/repo' })).toBe(messages)
  })

  it('a read that failed does not replace the previous one', () => {
    const messages = [
      ...toolPair('1', 'bash', { command: 'cat a.ts' }, filler(40_000)),
      ...toolPair('2', 'bash', { command: 'cat a.ts' }, 'cat: a.ts: No such file or directory\n(exit code: 1)'),
    ]
    expect(trimTurnContext(messages, 60_000, { directory: '/repo' })).toBe(messages)
  })

  it('the write of the whole file makes the previous reads obsolete', () => {
    const messages = [
      ...toolPair('1', 'read', { filePath: 'a.ts' }, readOut('/repo/a.ts', filler(40_000))),
      ...toolPair('2', 'write', { filePath: 'a.ts', content: 'x' }, 'File written: /repo/a.ts (1 characters)'),
    ]
    const outputs = outputsOf(trimTurnContext(messages, 15_000))
    expect(outputs[0]).toContain('rewritten later')
  })
})

describe('trimTurnContext — batch work ceiling', () => {
  it('the work ceiling stays below the safety one', () => {
    expect(workingBudget(model(1_048_576, 128_000))).toBe(100_000)
    expect(workingBudget(model(64_000, 8_000))).toBe(contextBudget(model(64_000, 8_000)))
  })

  it('going past the ceiling, drops well below it at once, preserving the recent ones', () => {
    const messages = Array.from({ length: 30 }, (_, i) =>
      toolPair(String(i), 'bash', { command: `npm run t${i}` }, filler(16_000)),
    ).flat()
    const soft = 100_000
    const trimmed = trimTurnContext(messages, 238_000, { softBudget: soft })
    expect(estimateTokens(trimmed)).toBeLessThanOrEqual(soft * 0.6)
    expect(outputsOf(trimmed).slice(-10).every((o) => o === filler(16_000))).toBe(true)
  })

  it('with the turn memory, the cut does not slip on every step', () => {
    // The SDK hands the ORIGINAL messages on every step. Without memory, each
    // new step would discard one more old result — and the prefix sent to the
    // provider would change on every step, invalidating the cache.
    const state = createTrimState()
    const step = (n: number) =>
      Array.from({ length: n }, (_, i) => toolPair(String(i), 'bash', { command: `npm run t${i}` }, filler(16_000))).flat()
    const opts = { softBudget: 100_000, state }

    const first = outputsOf(trimTurnContext(step(30), 238_000, opts))
    const droppedAfterFirst = state.dropped.size
    const next = outputsOf(trimTurnContext(step(32), 238_000, opts))

    // Two steps later, no new discard: the batch opened slack.
    expect(state.dropped.size).toBe(droppedAfterFirst)
    // And what has already been sent is identical — the cache prefix holds.
    expect(next.slice(0, first.length)).toEqual(first)
  })

  it('without a work ceiling, keeps the previous behavior', () => {
    const messages = Array.from({ length: 30 }, (_, i) =>
      toolPair(String(i), 'bash', { command: `npm run t${i}` }, filler(16_000)),
    ).flat()
    expect(trimTurnContext(messages, 238_000)).toBe(messages)
  })
})

describe('trimTurnContext — expired observations from Computer Use', () => {
  const full = (pid: number, n: number) =>
    `App: TextEdit (com.apple.TextEdit, pid ${pid})\nWindow 99: "Doc"\nObservation obs_${n}\nTree (4 elements):\n<screen_content>\n0 window\n</screen_content>`
  const diff = (pid: number, n: number) =>
    `App: TextEdit (com.apple.TextEdit, pid ${pid})\nObservation obs_${n}\nTree: changes since obs_${n - 1} (3 other elements unchanged, same indices)`
  const action = (summary: string, observation: string) => `${summary}\n\n${observation}`

  it('what comes before the last complete app tree goes out in a batch, keeping what the action did', () => {
    const messages = [
      ...toolPair('1', 'cu_observe', { app: 'TextEdit' }, full(10, 1)),
      ...toolPair('2', 'cu_computer', { action: 'left_click' }, action('Pressed element 2 (button "Save").', diff(10, 2))),
      ...toolPair('3', 'cu_computer', { action: 'type' }, action('Typed 3 character(s).', diff(10, 3))),
      ...toolPair('4', 'cu_observe', { app: 'TextEdit' }, full(10, 4)),
      ...toolPair('5', 'cu_computer', { action: 'key' }, action('Pressed return.', diff(10, 5))),
    ]
    const out = outputsOf(trimTurnContext(messages, 200_000))
    expect(out[0]).toMatch(/^\[SYSTEM: tool output dropped — an older screen observation/)
    expect(out[1]).toContain('What this call did: Pressed element 2 (button "Save").')
    expect(out[2]).toContain('What this call did: Typed 3 character(s).')
    // The newest complete tree and the diff that relies on it stay.
    expect(out[3]).toBe(full(10, 4))
    expect(out[4]).toContain('changes since obs_4')
  })

  it('below the batch, nothing changes (the prefix cache is not invalidated on every step)', () => {
    const messages = [
      ...toolPair('1', 'cu_observe', { app: 'TextEdit' }, full(10, 1)),
      ...toolPair('2', 'cu_computer', { action: 'left_click' }, action('Pressed.', diff(10, 2))),
      ...toolPair('3', 'cu_observe', { app: 'TextEdit' }, full(10, 3)),
    ]
    expect(trimTurnContext(messages, 200_000)).toBe(messages)
  })

  it('another app does not win over its observation', () => {
    const messages = [
      ...toolPair('1', 'cu_observe', { app: 'TextEdit' }, full(10, 1)),
      ...toolPair('2', 'cu_observe', { app: 'Safari' }, full(20, 2)),
      ...toolPair('3', 'cu_observe', { app: 'Safari' }, full(20, 3)),
      ...toolPair('4', 'cu_observe', { app: 'Safari' }, full(20, 4)),
      ...toolPair('5', 'cu_observe', { app: 'Safari' }, full(20, 5)),
    ]
    const out = outputsOf(trimTurnContext(messages, 200_000))
    expect(out[0]).toBe(full(10, 1))
    expect(out.slice(1, 4).every((o) => o.startsWith('[SYSTEM: tool output dropped'))).toBe(true)
    expect(out[4]).toBe(full(20, 5))
  })
})
