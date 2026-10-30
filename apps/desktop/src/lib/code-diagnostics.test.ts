import { describe, expect, it } from 'vitest'

import { eslintDiagnostics, jsonDiagnostics, jsonErrorOffset } from './code-diagnostics'

/**
 * A position outside the document limits takes the whole CodeMirror down — being
 * red is not worth breaking the editor. And the buffer changes between the lint request and
 * the response, so the case "the message points to a place that no longer
 * exists" is not exotic: it is what happens when you keep typing.
 */

/** A CodeMirror `Text` with the minimum the mapping uses. */
function doc(text: string) {
  const lines = text.split('\n')
  const starts: number[] = []
  let at = 0
  for (const line of lines) {
    starts.push(at)
    at += line.length + 1
  }
  return {
    lines: lines.length,
    length: text.length,
    line: (n: number) => ({
      from: starts[n - 1],
      to: starts[n - 1] + lines[n - 1].length,
    }),
  }
}

const msg = (over: Partial<Parameters<typeof eslintDiagnostics>[1][number]> = {}) => ({
  line: 1,
  column: 1,
  message: 'algo',
  ruleId: 'regra',
  severity: 2,
  ...over,
})

describe('eslintDiagnostics', () => {
  const text = 'const a = 1\nconst b = 2\n'

  it('converts line/column into an offset', () => {
    const [d] = eslintDiagnostics(doc(text), [msg({ line: 2, column: 7, endLine: 2, endColumn: 8 })])
    expect(text.slice(d.from, d.to)).toBe('b')
  })

  it("translates the eslint severity", () => {
    const [error] = eslintDiagnostics(doc(text), [msg({ severity: 2 })])
    const [warning] = eslintDiagnostics(doc(text), [msg({ severity: 1 })])
    expect(error.severity).toBe('error')
    expect(warning.severity).toBe('warning')
  })

  it('never produces a zero-width mark', () => {
    // Without endLine/endColumn the mark would have no width and would not show.
    const [d] = eslintDiagnostics(doc(text), [msg({ line: 1, column: 1 })])
    expect(d.to).toBeGreaterThan(d.from)
  })

  it('clamps positions past the end of the document', () => {
    // The buffer shrank after the lint was requested.
    const [d] = eslintDiagnostics(doc('a\n'), [
      msg({ line: 99, column: 99, endLine: 99, endColumn: 200 }),
    ])
    expect(d.from).toBeLessThanOrEqual(2)
    expect(d.to).toBeLessThanOrEqual(2)
  })

  it('uses the rule name as the source, with a fallback', () => {
    expect(eslintDiagnostics(doc(text), [msg({ ruleId: 'no-unused-vars' })])[0].source).toBe(
      'no-unused-vars',
    )
    expect(eslintDiagnostics(doc(text), [msg({ ruleId: null })])[0].source).toBe('eslint')
  })
})

describe('jsonDiagnostics', () => {
  it('reports nothing on valid JSON, nor on an empty file', () => {
    expect(jsonDiagnostics('{"a": 1}')).toEqual([])
    expect(jsonDiagnostics('   \n')).toEqual([])
  })

  it("reports invalid JSON and keeps the parser message", () => {
    // The JSON.parse message says what happened; the Lezer error node would only
    // say that there is one.
    const [d] = jsonDiagnostics('{"a": }')
    expect(d.severity).toBe('error')
    expect(d.message.length).toBeGreaterThan(0)
    expect(d.to).toBeGreaterThan(d.from)
  })
})

describe('jsonErrorOffset', () => {
  it('extracts the position from the V8 message', () => {
    expect(jsonErrorOffset('Unexpected token } in JSON at position 6', 100)).toBe(6)
    // The new V8 adds line and column after the position.
    expect(jsonErrorOffset("Expected ',' or '}' at position 12 (line 2 column 3)", 100)).toBe(12)
  })

  it('falls back to the beginning when the message does not state the position', () => {
    expect(jsonErrorOffset('Unexpected end of JSON input', 100)).toBe(0)
  })

  it('does not go past the end of the document', () => {
    expect(jsonErrorOffset('at position 9999', 10)).toBe(9)
  })
})
