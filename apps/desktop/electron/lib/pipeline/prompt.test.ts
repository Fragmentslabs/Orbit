import { describe, expect, it } from 'vitest'
import { noteSection, phaseRules, phaseSystemPrompt, specialistIdentity, toolCatalogRules, toolRules } from './prompt'

describe('phaseRules', () => {
  it('says the phase runs alone and that asking is not an option', () => {
    const text = phaseRules('Portuguese')
    expect(text).toContain('Nobody is watching')
    expect(text).toContain('Never end the turn to ask')
    expect(text).toContain("Do only your phase's job")
  })

  it('asks for the note in the app language', () => {
    expect(phaseRules('Portuguese')).toContain('Write the note in Portuguese')
    expect(phaseRules()).toContain('Write the note in the language of the task description')
  })
})

describe('toolRules', () => {
  it('guides only the tools that exist in the phase', () => {
    const text = toolRules(new Set(['read', 'code_search', 'verify_changes'])).join('\n')
    expect(text).toContain('code_search')
    expect(text).toContain('verify_changes')
    expect(text).not.toContain('panel_navigate')
    expect(text).not.toContain('websearch')
  })

  it('speaks about the shell only when the phase may run commands', () => {
    expect(toolRules(new Set(['bash'])).join('\n')).toContain('command policy')
    expect(toolRules(new Set(['read'])).join('\n')).not.toContain('command policy')
  })

  it('gives every capability the editor offers a guide on how to use it', () => {
    // One representative tool per capability: if a tool is renamed the guide
    // would vanish silently, and a phase would carry the mode with no instruction.
    const guides: [string, string][] = [
      ['code_search', 'code_search'],
      ['edit', 'edit/write'],
      ['verify_changes', 'verify_changes'],
      ['bash', 'command policy'],
      ['run_tools', 'run_tools'],
      ['panel_navigate', 'panel_navigate'],
      ['websearch', 'websearch'],
      ['memory_search', 'project memories'],
    ]
    for (const [tool, guide] of guides) {
      expect(toolRules(new Set([tool])).join('\n')).toContain(guide)
    }
  })
})

describe('specialistIdentity', () => {
  it('keeps the phase above the agent identity', () => {
    const text = specialistIdentity({ name: 'Roberto', prompt: 'You are a reviewer.' })
    expect(text).toContain('You are a reviewer.')
    expect(text).toContain('phase instructions win')
  })

  it('adds nothing when the agent has no prompt', () => {
    expect(specialistIdentity({ name: 'Empty', prompt: '   ' })).toBe('')
  })
})

describe('toolCatalogRules', () => {
  it('explains the funnel and carries the map', () => {
    const text = toolCatalogRules('documents — read, write and convert documents.')
    expect(text).toContain('tools_load')
    expect(text).toContain('documents — read, write and convert documents.')
  })
})

describe('noteSection', () => {
  it('labels what the phase records and disappears when empty', () => {
    expect(noteSection('Record: files changed.')).toContain('## What the note records')
    expect(noteSection('   ')).toBe('')
    expect(noteSection()).toBe('')
  })
})

describe('phaseSystemPrompt', () => {
  it('puts the engine rules before the phase text and ends with the contract', () => {
    const text = phaseSystemPrompt({
      language: 'Portuguese',
      tools: new Set(['read', 'code_search', 'verify_changes']),
      specialist: { name: 'Roberto', prompt: 'You are a reviewer.' },
      instructions: 'Review the diff.',
      contract: 'CONTRACT',
    })
    const order = [
      text.indexOf('PRIMARY brief'),
      text.indexOf('Nobody is watching'),
      text.indexOf('## Using the tools'),
      text.indexOf('You are a reviewer.'),
      text.indexOf('Review the diff.'),
      text.indexOf('CONTRACT'),
    ]
    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('adds the note contract of the phase right before the engine rule', () => {
    const text = phaseSystemPrompt({
      tools: new Set(['read']),
      instructions: 'Review the diff.',
      noteContract: 'Record: findings.',
      contract: 'CONTRACT',
    })
    expect(text.indexOf('## What the note records')).toBeGreaterThan(text.indexOf('Review the diff.'))
    expect(text.indexOf('CONTRACT')).toBeGreaterThan(text.indexOf('Record: findings.'))
  })

  it('runs on General: no specialist, no memories, same rules', () => {
    const text = phaseSystemPrompt({ tools: new Set(['read']), instructions: 'Do it.', contract: 'C' })
    expect(text).not.toContain('Specialist identity')
    expect(text).toContain("Do only your phase's job")
    expect(text).toContain('Write the note in the language of the task description')
  })
})
