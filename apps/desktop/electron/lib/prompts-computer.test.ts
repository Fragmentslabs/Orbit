import { describe, expect, it } from 'vitest'
import { computerInstruction } from './prompts'

describe('computerInstruction', () => {
  it('macOS mantém o texto de sempre', () => {
    const text = computerInstruction('darwin')
    expect(text).toContain('(macOS)')
    expect(text).toContain('"cmd+s"')
    expect(text).toContain('Accessibility or Screen Recording')
  })

  it('Windows: sem permissões do macOS, teclas com Ctrl e aprovação do navegador explicada', () => {
    const text = computerInstruction('win32')
    expect(text).toContain('(Windows)')
    expect(text).not.toContain('macOS')
    expect(text).not.toContain('Screen Recording')
    expect(text).not.toContain('cmd+')
    expect(text).toContain('"ctrl+s"')
    expect(text).toMatch(/administrator/)
    expect(text).toMatch(/approving the browser lets you act in EVERY tab/)
  })
})
