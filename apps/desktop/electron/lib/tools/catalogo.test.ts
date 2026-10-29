import { describe, expect, it } from 'vitest'
import type { ToolSet } from 'ai'
import type { SendMessageInput } from '@shared/chat'
import {
  aplicarFreio,
  classificarFamilias,
  montarMapa,
  orcamentoDoMapa,
  estimarTokens,
  NUCLEO_SET,
} from './catalogo'
import { buscar } from './busca'
import { derivarAtivas } from './ativas'

/**
 * O catálogo é o que impede a deriva: se uma tool conhecida cair em "outras",
 * ela só é alcançável por nome — e ninguém descobre por nome o que não sabe
 * que existe. Estes testes existem para falhar quando isso acontecer.
 */

function entrada(patch: Partial<SendMessageInput> = {}): SendMessageInput {
  return {
    mode: 'code',
    text: 'oi',
    options: { plan: false, browser: false, research: false, brain: false, subagents: false },
    ...patch,
  } as unknown as SendMessageInput
}

const TOOLS = {
  read: {},
  bash: {},
  edit: {},
  tools_load: {},
  tools_list: {},
  doc_search: {},
  pdf_merge: {},
  video_probe: {},
  design_write: {},
  motion_write: {},
  Fragments_Supabase_run_query: {},
  mystery_tool: {},
} as unknown as ToolSet

describe('classificarFamilias', () => {
  const familias = classificarFamilias(TOOLS as unknown as ToolSet, entrada(), ['Fragments_Supabase'])

  it('agrupa por família e tira o núcleo do catálogo', () => {
    const documents = familias.find((f) => f.id === 'documents')
    expect(documents?.tools).toContain('pdf_merge')
    // Núcleo não vira família: ele já está sempre no request.
    for (const nome of NUCLEO_SET) {
      expect(familias.some((f) => f.tools.includes(nome))).toBe(false)
    }
  })

  it('servidor MCP vira família pelo prefixo sanitizado', () => {
    const mcp = familias.find((f) => f.id === 'mcp:Fragments_Supabase')
    expect(mcp?.tools).toEqual(['Fragments_Supabase_run_query'])
    expect(mcp?.mcp).toBe(true)
  })

  it('servidor MCP que falhou aparece desativado e com motivo — não some do mapa', () => {
    const comFalha = classificarFamilias(
      TOOLS as unknown as ToolSet,
      entrada(),
      ['Fragments_Supabase'],
      [{ prefix: 'Nodara', reason: 'ECONNREFUSED' }],
    )
    const nodara = comFalha.find((f) => f.id === 'mcp:Nodara')
    expect(nodara?.tools).toEqual([])
    expect(nodara?.indisponivel).toMatch(/ECONNREFUSED/)
    // O servidor que está de pé não é afetado pelo que caiu.
    expect(comFalha.find((f) => f.id === 'mcp:Fragments_Supabase')?.tools).toEqual([
      'Fragments_Supabase_run_query',
    ])
  })

  it('tool desconhecida não fica inalcançável — cai em "outras"', () => {
    expect(familias.find((f) => f.id === 'outras')?.tools).toEqual(['mystery_tool'])
  })

  it('família sem tool no turno aparece com o motivo, quando há motivo', () => {
    const chat = classificarFamilias({ doc_search: {} } as unknown as ToolSet, entrada({ mode: 'chat' }), [])
    const files = chat.find((f) => f.id === 'files')
    expect(files?.tools).toEqual([])
    expect(files?.indisponivel).toMatch(/modo código/)
  })
})

describe('montarMapa', () => {
  it('marca ATIVO e DESATIVADA, e é determinístico', () => {
    const familias = classificarFamilias(TOOLS as unknown as ToolSet, entrada(), ['Fragments_Supabase'])
    const a = montarMapa(familias, { ativas: new Set(['documents']) }).texto
    const b = montarMapa(familias, { ativas: new Set(['documents']) }).texto
    expect(a).toBe(b)
    expect(a).toMatch(/documents — .*\(ATIVO\)/)
    expect(a).toMatch(/desativado:/)
  })

  it('família grande degrada para "use tools_load" em vez de estourar o orçamento', () => {
    const grande = {
      id: 'mcp:gigante',
      label: '@mcp:gigante',
      descricao: 'Servidor grande.',
      tools: Array.from({ length: 80 }, (_, i) => `gigante_tool_${i}`),
      mcp: true,
    }
    const { texto, tokens } = montarMapa([grande], { orcamento: 30 })
    // O piso do orçamento real continua valendo (120 tokens).
    expect(orcamentoDoMapa(8000, 200)).toBe(200)
    expect(texto).toMatch(/use tools_load/)
    expect(tokens).toBeLessThan(400)
  })

  it('estimativa subestima de propósito (4 chars por token)', () => {
    expect(estimarTokens('abcd')).toBe(1)
    expect(estimarTokens('a'.repeat(401))).toBe(101)
  })
})

describe('buscar', () => {
  const registros = [
    { nome: 'pdf_extract_images', texto: 'pdf_extract_images extract images from pdf' },
    { nome: 'pdf_merge', texto: 'pdf_merge join pdfs' },
    { nome: 'image_edit', texto: 'image_edit resize crop' },
  ]

  it('nome exato sobe para o topo', () => {
    expect(buscar(registros, ['pdf_extract_images'])[0].nome).toBe('pdf_extract_images')
  })

  it('coverage gate corta query longa com só um termo presente', () => {
    const r = buscar(registros, ['pdf query relatorio trimestre fechamento'])
    expect(r.map((x) => x.nome)).not.toContain('pdf_merge')
  })

  it('sem acento e sem caixa', () => {
    const r = buscar([{ nome: 'video_transcribe', texto: 'video_transcribe transcreve áudio' }], ['TRANScreve'])
    expect(r[0]?.nome).toBe('video_transcribe')
  })
})

describe('derivarAtivas', () => {
  const existentes = new Set(['read', 'bash', 'tools_load', 'pdf_merge', 'doc_search', 'video_probe'])
  const familias = [
    { id: 'documents', label: 'documents', descricao: '', tools: ['pdf_merge', 'doc_search'] },
    { id: 'video', label: 'video', descricao: '', tools: ['video_probe'] },
  ]

  it('sem carga no histórico, fica só o núcleo que existe', () => {
    const ativas = derivarAtivas([], familias, existentes)
    // doc_search é núcleo (documentos anexados valem nos dois modos).
    expect(ativas.nomes.sort()).toEqual(['bash', 'doc_search', 'read', 'tools_load'])
  })

  it('tools_load no histórico ativa a família, inclusive em turno seguinte', () => {
    const historico = [
      { role: 'assistant', content: [{ type: 'tool-call', toolName: 'tools_load', input: { family: 'documents' } }] },
    ]
    const ativas = derivarAtivas(historico, familias, existentes)
    expect(ativas.nomes).toContain('pdf_merge')
    expect(ativas.familias.has('documents')).toBe(true)
  })

  it('@mcp citado no texto auto-ativa o servidor', () => {
    const ativas = derivarAtivas([], familias, existentes, { auto: ['mcp:supabase'] })
    expect(ativas.familias.has('mcp:supabase')).toBe(false) // não existe neste turno
  })

  it('no teto, cai primeiro a família sem uso — não a carregada há mais tempo', () => {
    const historico = [
      { role: 'assistant', content: [{ type: 'tool-call', toolName: 'tools_load', input: { family: 'documents' } }] },
      { role: 'assistant', content: [{ type: 'tool-call', toolName: 'tools_load', input: { family: 'video' } }] },
      // documents foi USADA; video nunca.
      { role: 'assistant', content: [{ type: 'tool-call', toolName: 'pdf_merge', input: {} }] },
    ]
    const ativas = derivarAtivas(historico, familias, existentes, { cap: 1 })
    expect(ativas.familias.has('documents')).toBe(true)
    expect(ativas.cortadas).toContain('video')
  })
})

describe('freio de mão (teto de tools do provedor)', () => {
  it('corta os servidores MCP primeiro e deixa o motivo no mapa', () => {
    const tools = {
      read: {},
      tools_load: {},
      a_x: {},
      a_y: {},
      solto: {},
      avulso: {},
    } as unknown as ToolSet
    const familias = classificarFamilias(tools, entrada(), ['a'])
    const cortadas = aplicarFreio(tools, familias, 4)

    expect(cortadas.length).toBeGreaterThan(0)
    // O núcleo sobrevive; a família MCP sumiu do ToolSet.
    expect(Object.keys(tools)).toContain('read')
    expect(Object.keys(tools)).not.toContain('a_x')
    expect(Object.keys(tools)).toHaveLength(4)
    // E não desaparece do catálogo: vira "desativada" com o motivo.
    const mcp = familias.find((f) => f.id === 'mcp:a')
    expect(mcp?.tools).toHaveLength(0)
    expect(mcp?.indisponivel).toMatch(/teto de 4 tools/)
  })

  it('sem teto conhecido não corta nada', () => {
    const tools = { read: {}, video_probe: {} } as unknown as ToolSet
    expect(aplicarFreio(tools, [], undefined)).toEqual([])
    expect(Object.keys(tools)).toHaveLength(2)
  })
})
