import { describe, expect, it, vi } from 'vitest'

// Sem permissions.json do usuário: só a allowlist do código vale.
vi.mock('../storage', () => ({ dataDir: () => '/tmp/orbit-rules-test-inexistente' }))
// Os nomes de servidor MCP vêm da configuração (../mcp). Aqui, um servidor de
// mentira: o que se testa é a REGRA, não o cadastro — e o cadastro real ainda
// faria o teste depender da máquina de quem roda.
vi.mock('../mcp', () => ({ isMcpServerName: (name: string) => name === 'Nodara' || name === 'code' }))

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
    // Buscar imagem em acervo aberto e importar a escolhida.
    expect(assess('image_search', { query: 'lion' }, null)).toBeNull()
    expect(assess('image_import', { ids: ['wc:1'] }, null)).toBeNull()
  })

  it('as tools do índice de código são nativas: não pedem nem com servidor MCP homônimo', () => {
    expect(assess('code_search', { query: 'retry' }, null)).toBeNull()
    expect(assess('code_outline', {}, null)).toBeNull()
    expect(assess('code_refs', { symbol: 'buildToolSet', depth: 3 }, null)).toBeNull()
  })

  it('uma tool de servidor MCP de verdade continua pedindo', () => {
    const claim = assess('Nodara_search', {}, null)
    expect(claim?.ruleId).toBe('mcp:Nodara')
  })
})

describe('computer use', () => {
  it('leitura não pede; agir pede por app', async () => {
    const { isForbidden } = await import('./rules')
    expect(assess('cu_observe', { app: 'com.apple.TextEdit' }, null)).toBeNull()
    expect(assess('cu_apps', {}, null)).toBeNull()
    const pedido = assess('cu_computer', { action: 'left_click', app: 'com.apple.TextEdit', element: 3 }, null)
    expect(pedido).toMatchObject({ ruleId: 'cu:app:com.apple.TextEdit', claim: { tool: 'cu_computer' } })
    expect(pedido?.claim.detail).toContain('elemento 3')
    expect(assess('cu_computer', { action: 'wait', seconds: 1 }, null)).toBeNull()
    expect(isForbidden('cu_computer', { action: 'left_click', app: 'TextEdit' }, null)).toBe(false)
  })

  it('cofres de senha e ajustes do sistema são bloqueio duro, inclusive para observar', async () => {
    const { isForbidden } = await import('./rules')
    expect(isForbidden('cu_observe', { app: 'com.1password.1password' }, null)).toBe(true)
    expect(isForbidden('cu_computer', { action: 'type', app: 'System Settings' }, null)).toBe(true)
    expect(isForbidden('cu_query', { app: 'Keychain Access', text: 'x' }, null)).toBe(true)
  })

  it('navegador: a aprovação é pelo site que foi observado', async () => {
    const { computerRegistry } = await import('../computer/registry')
    computerRegistry.record({
      id: 'obs_x',
      sessionId: 's1',
      createdAt: Date.now(),
      app: { pid: 321, bundleId: 'com.apple.Safari', name: 'Safari', active: true, hidden: false },
      window: { id: 1, pid: 321, title: 'Banco', frame: [0, 0, 10, 10] },
      geometry: { frame: [0, 0, 10, 10], width: 10, height: 10 },
      hasScreenshot: true,
      url: 'https://banco.com.br/extrato',
      elements: new Map(),
      digest: null,
    })
    const pedido = assess('cu_computer', { action: 'left_click', app: 'Safari', x: 1, y: 1 }, null)
    expect(pedido?.ruleId).toBe('cu:app:com.apple.Safari@banco.com.br')
    expect(pedido?.claim.title).toBe('Controlar Safari em banco.com.br')
  })
})

describe('controle de tela pelo bash', () => {
  it('osascript com System Events pede aprovação — passa por fora do Computer Use', () => {
    const pedido = assess('bash', { command: `osascript -e 'tell application "TextEdit" to activate' -e 'tell application "System Events" to keystroke "oi"'` }, '/repo')
    expect(pedido?.ruleId).toBe('bash:gui-automation')
    expect(assess('bash', { command: 'osascript -e \'display notification "ok"\'' }, '/repo')).toBeNull()
  })
})
