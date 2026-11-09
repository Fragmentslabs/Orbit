import { describe, expect, it } from 'vitest'
import { emptyAgentInput, type AgentDefinition } from '@shared/agents'
import { agentCatalogBlock, suggestibleAgents, workerAgentsBlock } from './suggestions'

function agent(id: string, over: Partial<AgentDefinition> = {}): AgentDefinition {
  return { ...emptyAgentInput(), version: 1, id, origin: 'user', createdAt: 1, updatedAt: 1, name: `Agent ${id}`, prompt: 'Do the thing.', whenToUse: `work type ${id}`, ...over }
}

describe('agent suggestions', () => {
  it('lists only agents with a "when to use" line and a prompt', () => {
    const list = suggestibleAgents([agent('a'), agent('b', { whenToUse: '  ' }), agent('c', { prompt: '' })])
    expect(list.map((a) => a.id)).toEqual(['a'])
  })

  it('says nothing when no agent qualifies', () => {
    expect(agentCatalogBlock([])).toBe('')
    expect(agentCatalogBlock([agent('b', { whenToUse: '' })])).toBe('')
  })

  it('writes one line per agent with its profile id and the rules that keep the chat quiet', () => {
    const block = agentCatalogBlock([agent('a'), agent('b')])
    expect(block).toContain('- agent:a — Agent a: work type a')
    expect(block).toContain('- agent:b — Agent b: work type b')
    expect(block).toContain('suggest_subchat({ agent:')
    expect(block).toContain('Silence is the default')
    expect(block).toContain('never suggest that agent again')
  })

  it('caps the catalog', () => {
    const many = Array.from({ length: 40 }, (_, i) => agent(`x${i}`))
    expect(suggestibleAgents(many)).toHaveLength(20)
  })

  it('never carries a prompt: only the one-line description', () => {
    expect(agentCatalogBlock([agent('a', { prompt: 'SECRET PROMPT BODY' })])).not.toContain('SECRET PROMPT BODY')
  })

  it('tells the orchestrator which agents a task can run as, and when not to', () => {
    const block = workerAgentsBlock([agent('a')])
    expect(block).toContain('create_task({ agent:')
    expect(block).toContain('- agent:a — Agent a: work type a')
    expect(block).toContain('Most tasks need no agent')
    expect(workerAgentsBlock([])).toBe('')
  })
})
