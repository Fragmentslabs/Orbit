import { describe, expect, it, vi } from 'vitest'

// Sem permissions.json do usuário: só a allowlist do código vale.
vi.mock('../storage', () => ({ dataDir: () => '/tmp/orbit-rules-test-inexistente' }))
// Os nomes de servidor MCP vêm da configuração (../mcp). Aqui, um servidor de
// mentira: o que se testa é a REGRA, não o cadastro — e o cadastro real ainda
// faria o teste depender da máquina de quem roda.
vi.mock('../mcp', () => ({ isMcpServerName: (name: string) => name === 'Nodara' }))

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

  it('as tools de vídeo e motion são nativas: não pedem permissão', () => {
    expect(assess('motion_preview', { path: 'edit/anim' }, null)).toBeNull()
    expect(assess('motion_render', { path: 'edit/anim' }, null)).toBeNull()
    expect(assess('video_render', { path: 'edit/anim' }, null)).toBeNull()
    expect(assess('show_video', { path: 'edit/anim/render.mp4' }, null)).toBeNull()
    // Copiar um anexo do chat para a peça: a referência é a única entrada.
    expect(assess('motion_asset', { ref: 'vdo_x.mp4', path: 'edit/anim' }, null)).toBeNull()
  })

  it('uma tool de servidor MCP de verdade continua pedindo', () => {
    const claim = assess('Nodara_search', {}, null)
    expect(claim?.ruleId).toBe('mcp:Nodara')
  })
})
