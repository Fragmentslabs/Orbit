import type { ToolSet } from 'ai'
import type { ProfileBlocks } from '@shared/agents'
import type { ProfileDefinition } from './types'

/**
 * Which tools belong to which switch of a profile. A block that is off removes its tools
 * from the conversation; nothing here ever adds a tool.
 *
 * Memory, subagent and orchestra tools are already gated by the conversation's own options
 * (`brain`, `subagents`, `orchestrate`), which the profile clears — they are listed here only
 * so the Specialists page can say what each switch controls.
 */
const BLOCK_TOOLS: Partial<Record<keyof ProfileBlocks, string[]>> = {
  skills: ['skill_read', 'skill_search', 'create_skill'],
  subagents: ['subagent', 'suggest_subchat', 'open_subchat', 'read_subchat', 'send_to_subchat'],
}

/**
 * Orbit machinery that is not a craft: scheduling, the board of tasks, the history of other
 * chats, usage reports, hooks and the setup of connections. A profile that is not the general
 * chat does not get these; the person still reaches all of them from the general chat.
 */
const MACHINERY_TOOLS = [
  'set_user_name',
  'routines_manage',
  'pipeline_create',
  'pipeline_list',
  'pipeline_create_task',
  'pipeline_task_status',
  'pipeline_task_read',
  'pipeline_task_edit',
  'chat_list',
  'chat_archive',
  'chat_delete',
  'chat_search',
  'chat_read',
  'work_report',
  'usage_stats',
  'hook_create',
  'hook_list',
  'hook_remove',
  'mcp_connect',
  'mcp_update',
  'mcp_servers',
]

/**
 * Narrows a toolset to what the profile allows. It mutates and returns the SAME object on
 * purpose: `run_tools` reads the set lazily, and a filtered copy would leave it a path to
 * the tools that were removed.
 */
export function restrictTools(tools: ToolSet, profile: ProfileDefinition): ToolSet {
  const remove = new Set<string>(MACHINERY_TOOLS)
  for (const [block, names] of Object.entries(BLOCK_TOOLS) as Array<[keyof ProfileBlocks, string[]]>) {
    if (!profile.blocks[block]) for (const name of names) remove.add(name)
  }
  // A block switched on gives back the tools of its own group, but never the machinery.
  const allow = profile.allowedTools ? new Set(profile.allowedTools) : null
  for (const name of Object.keys(tools)) {
    if (remove.has(name) || (allow && !allow.has(name))) delete tools[name]
  }
  return tools
}
