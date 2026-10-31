import type { ToolSet } from 'ai'
import type { SendMessageInput } from '@shared/chat'

/**
 * On-demand tool catalog — the plan's four-layer funnel
 * (core → family → MCP server → search).
 *
 * Rules this module guarantees:
 * - **Nothing is truncated silently.** An unavailable family appears in the map
 *   WITH the reason ("code mode only", "plan mode is read-only"), because the
 *   model must not discover the unavailability by calling the tool.
 * - **Determinism.** Fixed order of families and names: the block is byte-stable,
 *   and that is what preserves the prompt's cache prefix.
 * - **Derived, never mutated.** The catalog is rebuilt on every assembly
 *   from the real ToolSet; no session state that could drift.
 */

/** Family = the set of tools the model loads at once. */
export interface ToolFamily {
  id: string
  /** Short label for the map. */
  label: string
  /** ONE line: what the family solves. It is what decides the model's choice. */
  description: string
  /** Instructions that travel in the `tools_load` result (the family's manual). */
  manual?: string
  /** Names that exist in THIS turn. Empty = unavailable now. */
  tools: string[]
  /** Why it is unavailable when `tools` is empty. */
  unavailable?: string
  /** MCP server family (the id is the server name). */
  mcp?: boolean
  /**
   * Words the user would type to ask for this family, pt and en together. Code, not a
   * generated card. Only `familiesMentionedInText` reads them — they never enter the
   * prompt map (the description line already says what the family is).
   */
  tags?: readonly string[]
}

/**
 * Deliberately conservative token estimate: 4 chars per token
 * UNDERESTIMATES the real cost, and underestimating errs toward activating fewer
 * families — the cheap error. Same choice as Hermes (`CHARS_PER_TOKEN = 4.0`).
 */
export const CHARS_PER_TOKEN = 4

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/** Tokens of a tool definition, measured by the schema JSON. */
export function schemaTokens(tool: unknown): number {
  try {
    return estimateTokens(JSON.stringify(tool))
  } catch {
    return 0
  }
}

/**
 * Core: always active, in fixed order (it is the cache prefix).
 *
 * `question` and `todowrite` are here by EVIDENCE, not by taste: Hermes' A/B
 * shows that deferring the clarifying tool drops usage from 18/18
 * to 7/18 — the model simply stops asking and guesses. `todowrite`
 * for the same reason: it is cheap and used in almost every turn.
 */
export const CORE: readonly string[] = [
  'read',
  'write',
  'edit',
  'bash',
  'grep',
  'glob',
  'ls',
  'code_search',
  'code_outline',
  'code_refs',
  'todowrite',
  'question',
  'verify_changes',
  'session_context',
  'doc_list',
  'doc_search',
  'doc_read',
  'pdf_view_page',
  'sheet_query',
  'show_image',
  // The mechanism's two bridges: without them the funnel has no door.
  'tools_load',
  'tools_list',
  // The other way around the round trip: one script that calls many tools. It is
  // what keeps a loop over 20 files from costing 20 sends of this conversation,
  // so it is worthless behind a family it would have to be loaded first to use.
  'run_tools',
]

export const CORE_SET: ReadonlySet<string> = new Set(CORE)

/**
 * A family above this does not load whole: it goes through search (`query`), and
 * only what the search found becomes active. Lives here, not in `load.ts`, because
 * the bridge (what it answers) and the derivation (what it activates) must agree.
 */
export const MAX_TOOLS_PER_FAMILY = 40

/**
 * Families active from the FIRST turn, without the model having to load them.
 *
 * `skills` for the same reason: the prompt tells the model to call `skill_read`, which
 * lives in that family.
 *
 * `subchats` is here by evidence: the system prompt orders `suggest_subchat` on the
 * agent's own initiative, but a tool that is not declared cannot be called — with
 * the family behind `tools_load`, the suggestion only appeared when the user asked
 * for a new chat out loud.
 */
export const DEFAULT_ACTIVE_FAMILIES: readonly string[] = ['subchats', 'history', 'skills']

/** Declared families. The order here is the map's order (deterministic). */
interface FamilyDecl {
  id: string
  label: string
  description: string
  manual?: string
  /** Name prefixes that belong to the family. */
  prefixes: string[]
  /** See `ToolFamily.tags`. Curated: whole words, nothing from everyday speech. */
  tags?: readonly string[]
  /** Exact names that do not follow a prefix. */
  exact?: string[]
  /** Unavailability rule, when the family has no tool at all. */
  unavailable?: (input: SendMessageInput) => string | undefined
}

const FAMILIES: readonly FamilyDecl[] = [
  {
    id: 'files',
    label: 'files',
    description: 'Read, write, edit and run commands in the working folder.',
    prefixes: ['bash_', 'background_'],
    exact: ['read', 'write', 'edit', 'bash', 'grep', 'glob', 'ls'],
    unavailable: (i) => (i.mode === 'chat' ? 'code mode only' : i.options.plan ? 'plan mode is read-only' : undefined),
  },
  {
    id: 'code-index',
    label: 'code-index',
    description: 'Symbol index: where something is defined, the signature, who calls it.',
    prefixes: ['code_'],
    unavailable: (i) => (i.mode === 'chat' ? 'code mode only' : undefined),
  },
  {
    id: 'documents',
    label: 'documents',
    description: 'PDF, DOCX, spreadsheets and Orbit documents: read, query, extract, create.',
    tags: ['pdf', 'docx', 'xlsx', 'planilha', 'spreadsheet'],
    prefixes: ['doc_', 'docx_', 'pdf_', 'document_'],
    exact: ['sheet_query', 'create_document', 'update_document', 'read_document', 'list_documents'],
  },
  {
    id: 'image',
    label: 'image',
    description: 'Edit images pixel by pixel: crop, compress, color, background, text.',
    tags: ['remover fundo', 'remove background', 'recortar imagem', 'crop image'],
    prefixes: ['image_', 'describe_image'],
    exact: ['show_image'],
  },
  {
    id: 'svg',
    label: 'svg',
    description: 'Vector: create, recolor, rasterize and vectorize.',
    tags: ['svg', 'vetorizar', 'vectorize'],
    prefixes: ['svg_'],
  },
  {
    id: 'video',
    label: 'video',
    description: 'EDL-based video editing: probe, transcribe, timeline, render, cut.',
    tags: ['legenda', 'legendas', 'shorts', 'clipe', 'ffmpeg'],
    prefixes: ['video_'],
    exact: ['transcribe'],
    unavailable: (i) => (i.mode === 'chat' ? undefined : undefined),
  },
  {
    id: 'media',
    label: 'media',
    description: 'Compress/convert video and audio to a byte ceiling.',
    tags: ['comprimir video', 'compress video', 'comprimir audio', 'compress audio'],
    prefixes: ['media_'],
  },
  {
    id: 'ytdlp',
    label: 'ytdlp',
    description: 'Media from a link: download video/audio and read the transcript.',
    tags: ['youtube', 'yt-dlp', 'baixar video', 'baixar audio', 'download video'],
    prefixes: ['ytdlp_'],
  },
  {
    id: 'motion',
    label: 'motion',
    description: 'Animated piece (intro, kinetic text, lower third) in the Motion tab.',
    tags: ['animacao', 'animacoes', 'animar', 'animation', 'animate', 'motion graphics'],
    prefixes: ['motion_'],
  },
  {
    id: 'design',
    label: 'design',
    description: 'Design canvas: screens, mockups, logos, variants.',
    tags: ['mockup', 'wireframe', 'logotipo'],
    prefixes: ['design_'],
  },
  {
    id: 'slides',
    label: 'slides',
    description: 'Slide presentation, with speaker notes.',
    tags: ['slides', 'slide', 'pptx', 'powerpoint'],
    prefixes: ['slides_'],
  },
  {
    id: 'pieces',
    label: 'pieces',
    description: 'Export an Orbit piece to folders in the project.',
    prefixes: ['piece_'],
  },
  {
    id: 'fonts',
    label: 'fonts',
    description: 'Font catalog: search and install into the app library.',
    tags: ['fonts', 'tipografia', 'typeface'],
    prefixes: ['font_'],
  },
  {
    id: 'browser',
    label: 'browser',
    description: 'Panel browser: open a page, extract links.',
    prefixes: ['browser_'],
    unavailable: (i) => (i.mode === 'chat' && !i.options.browser ? 'the Browser toggle is off in this conversation' : undefined),
  },
  {
    id: 'browser-test',
    label: 'browser-test',
    description: 'Test a web app: click, read the page, console, screenshots, record a demo.',
    prefixes: ['panel_', 'run_browser_', 'capture_'],
    exact: ['browser_record'],
    unavailable: (i) => (i.mode === 'chat' ? 'code mode only' : 'browser tools are off in Preferences'),
  },
  {
    id: 'research',
    label: 'research',
    description: 'Search and read on the web, and look for images.',
    prefixes: ['web', 'image_search'],
    unavailable: (i) => (i.options.research ? undefined : 'the Research toggle is off in this conversation'),
  },
  {
    id: 'artifacts',
    label: 'artifacts',
    description: 'Interactive HTML page inside the response (dashboard, prototype, simulator).',
    tags: ['dashboard', 'artifact', 'artefato'],
    prefixes: ['create_artifact', 'update_artifact', 'edit_artifact', 'read_artifact'],
  },
  {
    id: 'panel',
    label: 'panel',
    description: 'Read what is open in the side panel.',
    prefixes: ['read_open_panel'],
  },
  {
    id: 'skills',
    label: 'skills',
    description: 'Read or search a skill on demand and propose a new one.',
    prefixes: ['skill_', 'create_skill'],
  },
  {
    id: 'memory',
    label: 'memory',
    description: 'Project memory: tree, search, save and link nodes.',
    prefixes: ['memory_'],
    exact: ['set_user_name'],
    unavailable: (i) => (i.options.brain ? undefined : 'the Brain is off in this conversation'),
  },
  {
    id: 'subagent',
    label: 'subagent',
    description: 'Delegate a subtask to an isolated worker.',
    tags: ['subagent', 'subagente'],
    prefixes: ['subagent'],
    unavailable: (i) => (i.options.subagents ? undefined : 'delegation is off in this conversation'),
  },
  {
    id: 'subchats',
    label: 'subchats',
    description: 'Open/read conversations attached to this one and send instructions to them.',
    prefixes: ['suggest_subchat', 'open_subchat', 'send_to_subchat', 'read_subchat'],
  },
  {
    // Before `sessions`, whose `chat_` prefix would otherwise take these two. Active from the
    // first turn like `subchats`: the prompt tells the agent to call chat_search on its own
    // initiative, and a tool that is not declared cannot be called.
    id: 'history',
    label: 'history',
    description: 'Search what was said in past conversations and read the surroundings of a passage.',
    exact: ['chat_search', 'chat_read'],
    prefixes: [],
  },
  {
    id: 'sessions',
    label: 'sessions',
    description: 'Chat maintenance: list by inactivity, archive, delete.',
    prefixes: ['chat_'],
  },
  {
    id: 'pipeline',
    label: 'pipeline',
    description: 'Turn work into a task on a board and read the state.',
    tags: ['kanban'],
    prefixes: ['pipeline_'],
  },
  {
    id: 'routines',
    label: 'routines',
    description: 'Schedule: create, list, run, pause and remove routines.',
    tags: ['cron'],
    prefixes: ['routines_'],
    unavailable: (i) => (i.options.plan ? 'plan mode does not create routines' : undefined),
  },
  {
    id: 'hooks',
    label: 'hooks',
    description: 'Automate around your own tool calls ("every time you X, do Y"): create, list and remove shell hooks.',
    tags: ['hook', 'hooks'],
    prefixes: ['hook_'],
  },
  {
    id: 'worktrees',
    label: 'worktrees',
    description: 'Isolated copies of the repository on another branch.',
    tags: ['worktree', 'worktrees'],
    prefixes: ['worktree_'],
  },
  {
    id: 'usage',
    label: 'usage',
    description: 'Report of hours and cost per day/project.',
    prefixes: ['usage_', 'work_report'],
  },
  {
    id: 'computer',
    label: 'computer',
    description: 'Control the computer: see the screen, click, type.',
    prefixes: ['computer_'],
    unavailable: () => 'Computer use is off in Preferences',
  },
  {
    id: 'audio',
    label: 'audio',
    description: 'Generate speech from text.',
    tags: ['tts', 'narracao', 'text to speech'],
    prefixes: ['audio_'],
    unavailable: () => '"Text to speech" is off in Preferences',
  },
  {
    id: 'overlay',
    label: 'overlay',
    description: 'Global shortcut panel: see the screen and end the spoken conversation.',
    prefixes: ['overlay_', 'end_call'],
    unavailable: () => 'only in the shortcut window (⇧⌘space)',
  },
  {
    id: 'mcp-connect',
    label: 'mcp-connect',
    description: 'Propose a new MCP connection, fix an existing one, read the state.',
    prefixes: ['mcp_'],
  },
  {
    id: 'todo',
    label: 'todo',
    description: "Live list of the turn's tasks.",
    prefixes: ['todowrite'],
  },
  {
    id: 'question',
    label: 'question',
    description: 'Ask the user with options.',
    prefixes: ['question'],
  },
]

/** Family of a tool name — or null when it is from an MCP server. */
function familyDecl(name: string): FamilyDecl | null {
  for (const family of FAMILIES) {
    if (family.exact?.includes(name)) return family
    if (family.prefixes.some((p) => name.startsWith(p))) return family
  }
  return null
}

/**
 * MCP server by the tool name (`<server>_<tool>`). The prefix only counts
 * as a server if the name is in the assembled ToolSet — which eliminates the false
 * positive that once haunted `permission/rules.ts`.
 */
function mcpServer(name: string, servers: ReadonlySet<string>): string | null {
  for (const server of servers) {
    if (name.startsWith(`${server}_`)) return server
  }
  return null
}

/**
 * Groups the REAL ToolSet into families.
 *
 * The classification is done after assembly (and not with `add()` on each
 * `Object.assign`) because `buildToolSet` has ~40 conditional branches: rewriting it
 * to gain the same names would be blast radius with no gain. The
 * `catalog.test.ts` test guarantees that every known tool falls into a family — it is
 * what prevents the drift the static table usually suffers.
 */
export function classifyFamilies(
  tools: ToolSet,
  input: SendMessageInput,
  /** MCP servers whose prefix counts as a family (`<server>_`). */
  mcpServers: readonly string[] = [],
  /** Servers turned on that did not come up: an empty family, with the reason. */
  unavailableMcp: readonly { prefix: string; reason: string }[] = [],
): ToolFamily[] {
  const names = Object.keys(tools)
  const servers = new Set(mcpServers)
  const byFamily = new Map<string, string[]>()
  const mcpByServer = new Map<string, string[]>()
  const loose: string[] = []

  for (const name of names) {
    if (CORE_SET.has(name)) continue
    const server = mcpServer(name, servers)
    if (server) {
      mcpByServer.set(server, [...(mcpByServer.get(server) ?? []), name])
      continue
    }
    const family = familyDecl(name)
    if (!family) {
      loose.push(name)
      continue
    }
    byFamily.set(family.id, [...(byFamily.get(family.id) ?? []), name])
  }

  const families: ToolFamily[] = []
  // Declared families, in the table's order (determinism). Present even
  // when they have no tool right now — with the reason, so the map hides nothing.
  for (const family of FAMILIES) {
    const present = (byFamily.get(family.id) ?? []).sort()
    if (present.length > 0) {
      families.push({
        id: family.id,
        label: family.label,
        description: family.description,
        manual: family.manual,
        tools: present,
        ...(family.tags ? { tags: family.tags } : {}),
      })
    } else {
      const reason = family.unavailable?.(input)
      // With no declared reason, the family simply does not exist in this turn
      // (e.g. `fonts` in the chat is never assembled) — it does not go to the map as
      // "disabled" so as not to suggest a capability the mode does not have.
      if (reason) {
        families.push({
          id: family.id,
          label: family.label,
          description: family.description,
          tools: [],
          unavailable: reason,
          ...(family.tags ? { tags: family.tags } : {}),
        })
      }
    }
  }
  // MCP servers: derived, ordered by name. The ones that failed enter the
  // SAME list, empty and with the reason — vanishing from the map would be saying the
  // capability does not exist, when what happened was a server down.
  const failedMcp = new Map(unavailableMcp.map((s) => [s.prefix, s.reason]))
  for (const server of [...new Set([...mcpByServer.keys(), ...failedMcp.keys()])].sort()) {
    const present = (mcpByServer.get(server) ?? []).sort()
    families.push({
      id: `mcp:${server}`,
      label: `@mcp:${server}`,
      description: `MCP server ${server}.`,
      tools: present,
      ...(present.length === 0
        ? { unavailable: `failed to connect: ${failedMcp.get(server)}` }
        : {}),
      mcp: true,
    })
  }
  // What matched no family remains loadable by name — never
  // unreachable. `ORBIT_DEBUG_TOOLSET=1` lists those names so the table
  // above can be fixed.
  if (loose.length > 0) {
    families.push({
      id: 'outras',
      label: 'outras',
      description: 'Tools without a declared family (load them by name with tools_load).',
      tools: loose.sort(),
    })
  }
  return families
}

/** Every family declares what it is for the map. */
export function familyDescription(id: string): string {
  return FAMILIES.find((f) => f.id === id)?.description ?? FAMILIES.find((f) => `mcp:${f.id}` === id)?.description ?? ''
}

/**
 * Map budget: `min(ceiling, fraction of the context)`. A small fraction on
 * purpose — the map is an index, not a manual.
 */
/**
 * Handbrake (Phase 0): providers with a tool ceiling (Groq: 128) bring the
 * WHOLE request down when the ToolSet goes over. It cuts the MCP servers first —
 * the only unpredictable source of tools — from the largest to the smallest; if it still does not
 * fit, it cuts what is not core. What falls stays in the map marked as
 * unavailable, with the reason, instead of vanishing silently.
 *
 * Returns the labels of what was cut (empty = nothing happened).
 */
export function applyCeiling(
  tools: ToolSet,
  families: ToolFamily[],
  limit: number | undefined,
): string[] {
  if (!limit) return []
  let total = Object.keys(tools).length
  if (total <= limit) return []

  const cut: string[] = []
  const mcp = families.filter((f) => f.mcp).sort((a, b) => b.tools.length - a.tools.length)
  for (const family of mcp) {
    if (total <= limit) break
    for (const name of family.tools) delete tools[name]
    total -= family.tools.length
    cut.push(family.label)
  }

  if (total > limit) {
    for (const name of Object.keys(tools)) {
      if (total <= limit) break
      if (CORE_SET.has(name)) continue
      delete tools[name]
      total -= 1
    }
    cut.push('non-essential families')
  }

  // Reconciles the catalog with what is left: an empty family becomes "disabled".
  const reason = `cut by the provider's ${limit}-tool ceiling`
  for (const family of families) {
    const remaining = family.tools.filter((name) => name in tools)
    if (remaining.length === family.tools.length) continue
    family.tools = remaining
    if (remaining.length === 0 && !family.unavailable) family.unavailable = reason
  }
  return cut
}

export function mapBudget(contextLength: number, ceilingTokens = 700): number {
  return Math.max(120, Math.min(ceilingTokens, Math.floor(contextLength * 0.04)))
}

/**
 * The prompt's map, with per-family degradation when the budget overflows.
 *
 * Forms (reference: Hermes, `tools_search_catalog.py`): `full` (name + line)
 * → `names` (names only) → `groups` (count, "use the search"). The degradation is per
 * family, from the largest to the smallest, so a giant server does not cost the
 * listing of a small one.
 */
export function buildMap(
  families: readonly ToolFamily[],
  options: { budget?: number; active?: ReadonlySet<string> } = {},
): { text: string; tokens: number } {
  const budget = options.budget ?? 700
  const active = options.active ?? new Set<string>()
  const lines: string[] = []
  let remaining = budget

  const cost = (line: string) => estimateTokens(line)
  const marker = (family: ToolFamily) => {
    if (family.unavailable) return ` (disabled: ${family.unavailable})`
    if (active.has(family.id)) return ' (ACTIVE)'
    return ''
  }
  // A native family has predictable names (the model knows that `documents` has
  // doc_read); an MCP server is unknown vocabulary — there the names are what
  // decides. Too many names do not fit: it degrades to the count.
  const MAX_NAMES_IN_MAP = 12
  const fullLine = (family: ToolFamily) => {
    const names = family.mcp
      ? family.tools.slice(0, MAX_NAMES_IN_MAP).join(', ') +
        (family.tools.length > MAX_NAMES_IN_MAP ? ', …' : '')
      : family.description
    return `- ${family.label} — ${family.tools.length} tools: ${names}${marker(family)}`
  }

  // Degradation order: the largest ones lose detail first.
  const ordered = [...families].sort((a, b) => b.tools.length - a.tools.length)
  const form = new Map<string, 'full' | 'names' | 'groups'>()
  for (const family of ordered) {
    const full = fullLine(family)
    const namesOnly = `- ${family.label} — ${family.tools.join(', ')}${marker(family)}`
    const group = `- ${family.label} — ${family.tools.length} tools (names not listed; use tools_load)${marker(family)}`
    if (family.unavailable || family.tools.length === 0) {
      form.set(family.id, 'full')
      continue
    }
    if (cost(full) <= remaining) form.set(family.id, 'full')
    else if (cost(namesOnly) <= remaining) form.set(family.id, 'names')
    else form.set(family.id, 'groups')
    remaining -= cost(
      form.get(family.id) === 'full' ? full : form.get(family.id) === 'names' ? namesOnly : group,
    )
  }

  // Emission in the declared order (byte-stable), with the form decided above.
  for (const family of families) {
    const f = form.get(family.id) ?? 'full'
    if (family.unavailable || family.tools.length === 0) {
      lines.push(`- ${family.label} — 0 tools${marker(family)}`)
    } else if (f === 'full') {
      lines.push(fullLine(family))
    } else if (f === 'names') {
      lines.push(`- ${family.label} — ${family.tools.join(', ')}${marker(family)}`)
    } else {
      lines.push(`- ${family.label} — ${family.tools.length} tools (names not listed; use tools_load)${marker(family)}`)
    }
  }
  const text = lines.join('\n')
  return { text, tokens: estimateTokens(text) }
}
