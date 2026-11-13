import type { ToolSet } from 'ai'
import type { SendMessageInput } from '@shared/chat'
import type { AllowedTool } from '@shared/pipeline'
import type { ToolFamily } from '../tools/catalog'
import type { ToolContext } from '../tools/context'

/**
 * The phase's tool set, assembled by the SAME builder the chat uses.
 *
 * A phase used to get a hand-picked list (read/grep/code + the capabilities),
 * which left it outside everything the catalog grew into: no families, no
 * tools_load, no run_tools, no MCP, no documents, no media. Here it inherits
 * the chat's code-mode set — and therefore the on-demand funnel — and the
 * phase's capabilities subtract from it.
 *
 * What is subtracted is what only makes sense with a person on the other side
 * or with the app as the subject: asking a question, creating agents, hooks,
 * routines, worktrees, subchats, artifacts. A phase writes code and a note; it
 * does not manage Orbit.
 *
 * The imports are dynamic on purpose: this module is reachable from the
 * pipeline tests through `runner`, and the tool barrel pulls Electron and the
 * companion server in at load time.
 */

/** Tools that belong to a conversation with the person, not to a phase. */
const CONVERSATION_ONLY = new Set([
  'question',
  'subagent',
  'suggest_subchat',
  'create_agent',
  'create_skill',
  'set_user_name',
  'routines_manage',
  'chat_list',
  'chat_search',
  'work_report',
  'read_open_panel',
  'show_image',
  'session_context',
  // A phase is already running inside a pipeline: it does not create or
  // inspect pipelines, and it does not edit the folder the pipeline gave it.
  'pipeline_create',
  'pipeline_list',
  'pipeline_create_task',
  'pipeline_task_status',
])

/** Prefixes of the same group (a family whose names share a stem). */
const CONVERSATION_ONLY_PREFIX = [
  'hook_',
  'worktree_',
  'artifact_',
  'fragment_',
  'mcp_connect',
  'mcp_update',
  'mcp_servers',
  'cu_',
  'computer_',
]

export interface PhaseToolSet {
  tools: ToolSet
  /** Catalog families over the final set — the input of `tools_load`. */
  families: ToolFamily[]
  /** Names that survived the capabilities, for the prompt's guides. */
  names: Set<string>
}

export async function buildPhaseTools(
  input: SendMessageInput,
  ctx: ToolContext,
  capabilities: ReadonlySet<AllowedTool>,
): Promise<PhaseToolSet> {
  const [{ buildToolSet }, { classifyFamilies }, { createToolBridgeTools }, { createPanelBrowserTools }, { createBrowserScriptTools }, mcp] =
    await Promise.all([
      import('../tools'),
      import('../tools/catalog'),
      import('../tools/load'),
      import('../tools/panel-browser'),
      import('../tools/browser-script'),
      import('../mcp'),
    ])

  const tools = buildToolSet(input, ctx)

  for (const name of Object.keys(tools)) {
    if (CONVERSATION_ONLY.has(name) || CONVERSATION_ONLY_PREFIX.some((prefix) => name.startsWith(prefix))) {
      delete tools[name]
    }
  }

  // Writing the repository is a capability, not a default.
  if (!capabilities.has('edit')) {
    delete tools.write
    delete tools.edit
  }
  // Shell: the command policy lives inside bash (see runner's withCommandPolicy).
  if (!capabilities.has('shell')) {
    delete tools.bash
    for (const name of Object.keys(tools)) {
      if (name.startsWith('background_')) delete tools[name]
    }
  }
  // The panel browser: the phase's capability is the permission. In the chat
  // the global switch (Settings → Browser) also gates it; here the phase was
  // written with "Browser" on it, which is the person's own decision.
  if (capabilities.has('browser')) {
    Object.assign(tools, createPanelBrowserTools(ctx))
    Object.assign(tools, createBrowserScriptTools(ctx))
  } else {
    for (const name of Object.keys(tools)) {
      if (
        name.startsWith('panel_') ||
        name.startsWith('browser_') ||
        name === 'run_browser_script' ||
        name === 'capture_batch'
      ) {
        delete tools[name]
      }
    }
  }

  const families = classifyFamilies(
    tools,
    input,
    mcp.listMcpServerPrefixes(),
    mcp.listUnavailableMcpServers(),
    mcp.listMcpServerInstructions(),
  )
  // The bridges come after the classification: they are core, never a family.
  Object.assign(tools, createToolBridgeTools({ families, tools }))

  return { tools, families, names: new Set(Object.keys(tools)) }
}
