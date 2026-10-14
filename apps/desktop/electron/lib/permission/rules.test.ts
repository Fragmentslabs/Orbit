import { describe, expect, it, vi } from 'vitest'

// Sem permissions.json do usuário: só a allowlist do código vale.
vi.mock('../storage', () => ({ dataDir: () => '/tmp/orbit-rules-test-inexistente' }))

const { assess } = await import('./rules')

/**
 * Tools nativas com "_" no nome não podem cair no catch-all de MCP (que lê o
 * prefixo como nome de servidor). Foi o que aconteceu com audio_generate:
 * pedia permissão como "Ferramenta do servidor MCP "audio"".
 */
describe('assess — nativas x MCP', () => {
  it('as tools de áudio são nativas: não pedem permissão', () => {
    expect(assess('audio_generate', { text: 'Oi' }, null)).toBeNull()
    expect(assess('audio_transcribe', { ref: 'aud_x.m4a' }, null)).toBeNull()
  })

  it('uma tool de servidor MCP de verdade continua pedindo', () => {
    const claim = assess('Nodara_search', {}, null)
    expect(claim?.ruleId).toBe('mcp:Nodara')
  })
})
