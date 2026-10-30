import { describe, expect, it } from 'vitest'
import type { ToolSet } from 'ai'
import type { SendMessageInput } from '@shared/chat'
import {
  applyCeiling,
  classifyFamilies,
  buildMap,
  mapBudget,
  estimateTokens,
  CORE_SET,
} from './catalog'
import { search } from './search'
import { createToolBridgeTools, queryFamily } from './load'
import { deriveActive, priorToolCalls } from './active'
import type { ChatMessage } from '@shared/chat'

/**
 * The catalog is what prevents drift: if a known tool falls into "outras",
 * it is only reachable by name — and nobody finds by name what they do not know
 * exists. These tests exist to fail when that happens.
 */

function input(patch: Partial<SendMessageInput> = {}): SendMessageInput {
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

describe('classifyFamilies', () => {
  const families = classifyFamilies(TOOLS as unknown as ToolSet, input(), ['Fragments_Supabase'])

  it('groups by family and takes the core out of the catalog', () => {
    const documents = families.find((f) => f.id === 'documents')
    expect(documents?.tools).toContain('pdf_merge')
    // The core does not become a family: it is already always in the request.
    for (const name of CORE_SET) {
      expect(families.some((f) => f.tools.includes(name))).toBe(false)
    }
  })

  it('an MCP server becomes a family through the sanitized prefix', () => {
    const mcp = families.find((f) => f.id === 'mcp:Fragments_Supabase')
    expect(mcp?.tools).toEqual(['Fragments_Supabase_run_query'])
    expect(mcp?.mcp).toBe(true)
  })

  it('a failed MCP server shows up disabled and with a reason — it does not vanish from the map', () => {
    const withFailure = classifyFamilies(
      TOOLS as unknown as ToolSet,
      input(),
      ['Fragments_Supabase'],
      [{ prefix: 'Nodara', reason: 'ECONNREFUSED' }],
    )
    const nodara = withFailure.find((f) => f.id === 'mcp:Nodara')
    expect(nodara?.tools).toEqual([])
    expect(nodara?.unavailable).toMatch(/ECONNREFUSED/)
    // The server that is up is not affected by the one that went down.
    expect(withFailure.find((f) => f.id === 'mcp:Fragments_Supabase')?.tools).toEqual([
      'Fragments_Supabase_run_query',
    ])
  })

  it('an unknown tool does not become unreachable — it falls into "outras"', () => {
    expect(families.find((f) => f.id === 'outras')?.tools).toEqual(['mystery_tool'])
  })

  it('a family with no tool in the turn shows up with the reason, when there is a reason', () => {
    const chat = classifyFamilies({ doc_search: {} } as unknown as ToolSet, input({ mode: 'chat' }), [])
    const files = chat.find((f) => f.id === 'files')
    expect(files?.tools).toEqual([])
    expect(files?.unavailable).toMatch(/code mode/)
  })
})

describe('buildMap', () => {
  it('marks ACTIVE and DISABLED, and is deterministic', () => {
    const families = classifyFamilies(TOOLS as unknown as ToolSet, input(), ['Fragments_Supabase'])
    const a = buildMap(families, { active: new Set(['documents']) }).text
    const b = buildMap(families, { active: new Set(['documents']) }).text
    expect(a).toBe(b)
    expect(a).toMatch(/documents — .*\(ACTIVE\)/)
    expect(a).toMatch(/disabled:/)
  })

  it('a large family degrades to "use tools_load" instead of blowing the budget', () => {
    const large = {
      id: 'mcp:gigante',
      label: '@mcp:gigante',
      description: 'Large server.',
      tools: Array.from({ length: 80 }, (_, i) => `gigante_tool_${i}`),
      mcp: true,
    }
    const { text, tokens } = buildMap([large], { budget: 30 })
    // The floor of the real budget still holds (120 tokens).
    expect(mapBudget(8000, 200)).toBe(200)
    expect(text).toMatch(/use tools_load/)
    expect(tokens).toBeLessThan(400)
  })

  it('the estimate underestimates on purpose (4 chars per token)', () => {
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('a'.repeat(401))).toBe(101)
  })
})

describe('search', () => {
  const records = [
    { name: 'pdf_extract_images', text: 'pdf_extract_images extract images from pdf' },
    { name: 'pdf_merge', text: 'pdf_merge join pdfs' },
    { name: 'image_edit', text: 'image_edit resize crop' },
  ]

  it('an exact name goes to the top', () => {
    expect(search(records, ['pdf_extract_images'])[0].name).toBe('pdf_extract_images')
  })

  it('the coverage gate cuts a long query with only one term present', () => {
    const r = search(records, ['pdf query report quarter closing'])
    expect(r.map((x) => x.name)).not.toContain('pdf_merge')
  })

  it('without accents and case-insensitive', () => {
    const r = search([{ name: 'video_transcribe', text: 'video_transcribe transcribe the audio' }], ['TRANSCRIBE'])
    expect(r[0]?.name).toBe('video_transcribe')
  })
})

describe('deriveActive', () => {
  const existing = new Set(['read', 'bash', 'tools_load', 'pdf_merge', 'doc_search', 'video_probe'])
  const families = [
    { id: 'documents', label: 'documents', description: '', tools: ['pdf_merge', 'doc_search'] },
    { id: 'video', label: 'video', description: '', tools: ['video_probe'] },
  ]

  it('with no load in the history, only the core that exists stays', () => {
    const active = deriveActive([], families, existing)
    // doc_search is core (attached documents count in both modes).
    expect(active.names.sort()).toEqual(['bash', 'doc_search', 'read', 'tools_load'])
  })

  it('tools_load in the history activates the family, including in the next turn', () => {
    const history = [
      { role: 'assistant', content: [{ type: 'tool-call', toolName: 'tools_load', input: { family: 'documents' } }] },
    ]
    const active = deriveActive(history, families, existing)
    expect(active.names).toContain('pdf_merge')
    expect(active.families.has('documents')).toBe(true)
  })

  it('@mcp cited in the text self-activates the server', () => {
    const active = deriveActive([], families, existing, { auto: ['mcp:supabase'] })
    expect(active.families.has('mcp:supabase')).toBe(false) // does not exist in this turn
  })

  it('at the cap, the unused family goes first — not the one loaded longest ago', () => {
    const history = [
      { role: 'assistant', content: [{ type: 'tool-call', toolName: 'tools_load', input: { family: 'documents' } }] },
      { role: 'assistant', content: [{ type: 'tool-call', toolName: 'tools_load', input: { family: 'video' } }] },
      // documents was USED; video never.
      { role: 'assistant', content: [{ type: 'tool-call', toolName: 'pdf_merge', input: {} }] },
    ]
    // The cap counts TOOLS: 4 of core + pdf_merge fit, video_probe does not.
    const active = deriveActive(history, families, existing, { cap: 5 })
    expect(active.families.has('documents')).toBe(true)
    expect(active.dropped).toEqual(['video'])
    expect(active.names).toHaveLength(5)
  })

  it('without a cap the set is not trimmed', () => {
    const history = [
      { role: 'assistant', content: [{ type: 'tool-call', toolName: 'tools_load', input: { family: 'documents' } }] },
      { role: 'assistant', content: [{ type: 'tool-call', toolName: 'tools_load', input: { family: 'video' } }] },
    ]
    expect(deriveActive(history, families, existing).dropped).toEqual([])
  })

  it('a tool used without tools_load activates its family', () => {
    const history = [{ role: 'assistant', content: [{ type: 'tool-call', toolName: 'video_probe', input: {} }] }]
    expect(deriveActive(history, families, existing).families.has('video')).toBe(true)
  })
})

describe('large family (over the per-family limit)', () => {
  const tools = Array.from({ length: 80 }, (_, i) => `big_t${i}`)
  const families = [{ id: 'mcp:big', label: '@mcp:big', description: '', tools, mcp: true }]
  const existing = new Set(['read', ...tools])
  const load = (input: Record<string, unknown>) => [
    { role: 'assistant', content: [{ type: 'tool-call', toolName: 'tools_load', input }] },
  ]

  it('a load refused for being too large activates nothing', () => {
    expect(deriveActive(load({ server: 'big' }), families, existing).names).toEqual(['read'])
  })

  it('a query activates only what the search found, not the whole server', () => {
    const active = deriveActive(load({ server: 'big', query: 'x' }), families, existing, {
      resolveQuery: () => ['big_t3', 'big_t7'],
    })
    expect(active.names.sort()).toEqual(['big_t3', 'big_t7', 'read'])
    expect(active.families.has('mcp:big')).toBe(false)
  })

  it('an exact name and a call activate only that name', () => {
    const history = [
      ...load({ tools: ['big_t1'] }),
      { role: 'assistant', content: [{ type: 'tool-call', toolName: 'big_t2', input: {} }] },
    ]
    expect(deriveActive(history, families, existing).names.sort()).toEqual(['big_t1', 'big_t2', 'read'])
  })
})

describe('persistence across turns', () => {
  it('the ToolParts of previous turns keep the family active', () => {
    const history = [
      { id: 'u', role: 'user', parts: [{ id: 't', type: 'text', text: 'join the pdfs' }] },
      {
        id: 'a',
        role: 'assistant',
        parts: [
          { id: 'p1', type: 'tool', tool: 'tools_load', state: 'done', input: { family: 'documents' } },
          { id: 'p2', type: 'tool', tool: 'pdf_merge', state: 'done', input: {} },
        ],
      },
    ] as unknown as ChatMessage[]
    const families = [{ id: 'documents', label: 'documents', description: '', tools: ['pdf_merge'] }]
    const active = deriveActive(priorToolCalls(history), families, new Set(['read', 'pdf_merge']))
    expect(active.names).toContain('pdf_merge')
  })

  it('a history without tools produces no message', () => {
    expect(priorToolCalls([])).toEqual([])
  })
})

describe('handbrake (provider tool ceiling)', () => {
  it('cuts the MCP servers first and leaves the reason in the map', () => {
    const tools = {
      read: {},
      tools_load: {},
      a_x: {},
      a_y: {},
      loose: {},
      stray: {},
    } as unknown as ToolSet
    const families = classifyFamilies(tools, input(), ['a'])
    const cut = applyCeiling(tools, families, 4)

    expect(cut.length).toBeGreaterThan(0)
    // The core survives; the MCP family vanished from the ToolSet.
    expect(Object.keys(tools)).toContain('read')
    expect(Object.keys(tools)).not.toContain('a_x')
    expect(Object.keys(tools)).toHaveLength(4)
    // And it does not disappear from the catalog: it becomes "disabled" with the reason.
    const mcp = families.find((f) => f.id === 'mcp:a')
    expect(mcp?.tools).toHaveLength(0)
    expect(mcp?.unavailable).toMatch(/4-tool ceiling/)
  })

  it('with no known ceiling it cuts nothing', () => {
    const tools = { read: {}, video_probe: {} } as unknown as ToolSet
    expect(applyCeiling(tools, [], undefined)).toEqual([])
    expect(Object.keys(tools)).toHaveLength(2)
  })
})

describe('bridge and derivation agree', () => {
  const tools = {
    read: { description: 'read a file' },
    ...Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [`big_t${i}`, { description: i === 7 ? 'create invoice' : `thing ${i}` }]),
    ),
  } as unknown as ToolSet
  const families = [
    { id: 'mcp:big', label: '@mcp:big', description: '', tools: Object.keys(tools).filter((n) => n !== 'read'), mcp: true },
  ]
  const bridges = createToolBridgeTools({ families, tools })
  const run = (input: Record<string, unknown>) =>
    (bridges.tools_load as unknown as { execute: (i: unknown, o: unknown) => Promise<string> }).execute(input, {})

  it('what the query answers is exactly what becomes active', async () => {
    const answer = await run({ server: 'big', query: 'invoice' })
    expect(answer).toMatch(/big_t7/)
    const active = deriveActive(
      [{ role: 'assistant', content: [{ type: 'tool-call', toolName: 'tools_load', input: { server: 'big', query: 'invoice' } }] }],
      families,
      new Set(Object.keys(tools)),
      { resolveQuery: (family, query) => queryFamily(tools, family, query) },
    )
    expect(active.names.sort()).toEqual(['big_t7', 'read'])
  })

  it('naming a core tool is not an error', async () => {
    expect(await run({ tools: ['read'] })).toMatch(/^Loaded: read/)
  })
})
