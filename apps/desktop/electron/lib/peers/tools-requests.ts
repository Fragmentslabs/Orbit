import type { HookInput } from '@shared/hooks'
import { HOOK_EVENTS } from '@shared/hooks'
import type { McpConfig, McpServerConfig } from '@shared/mcp'
import { maskMcpConfig, maskMcpStatus, restoreMcpSecrets } from '@shared/tools-remote'
import { addHook, listHooks, removeHook, setHookEnabled, updateHook } from '../hooks/store'
import { mcpDescriptionsState, listMcpStatus, optimizeMcpServer, readMcpConfig, reconnectMcp, saveMcpConfig } from '../mcp'
import { removeTrust } from '../permission/trust-rules'
import { loadSkills } from '../skills'
import { approveSkill, discardSkill, optimizeSkillBySlug, removeSkill, saveSkill, setSkillPref, skillMeta } from '../skills/actions'
import { listPendingSkills } from '../skills/pending'

/**
 * Another desktop's view of THIS machine's Tools screen (MCP servers, skills, hooks): the
 * same operations the local IPC handlers run, reached through the companion API. The
 * permission check (`control`) already ran in permissions.ts; what is left here is
 * validating what a peer sends and never letting an MCP secret travel (see tools-remote.ts).
 *
 * Not offered: the OAuth flow, importing a skill from a file dialog, the Nodara/Fracta
 * integrations and the model-written drafts — they depend on this computer's browser,
 * dialogs or apps.
 */

type Req = { type: string; [key: string]: unknown }

const str = (v: unknown, max = 4096): string | undefined =>
  typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined

function need(v: unknown, max?: number): string {
  const s = str(v, max)
  if (!s) throw new Error('invalid')
  return s
}

const plainRecord = (v: unknown): Record<string, string> | undefined => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(v)) if (typeof value === 'string') out[key] = value
  return out
}

function cleanServer(raw: unknown): McpServerConfig {
  const r = (raw ?? {}) as Record<string, unknown>
  const name = need(r.name, 200)
  if (r.type !== 'http' && r.type !== 'stdio') throw new Error('invalid')
  const server: McpServerConfig = { name, type: r.type }
  if (typeof r.url === 'string') server.url = r.url
  if (typeof r.command === 'string') server.command = r.command
  if (Array.isArray(r.args)) server.args = r.args.filter((a): a is string => typeof a === 'string')
  if (typeof r.enabled === 'boolean') server.enabled = r.enabled
  const env = plainRecord(r.env)
  if (env) server.env = env
  const headers = plainRecord(r.headers)
  if (headers) server.headers = headers
  if (typeof r.cwd === 'string') server.cwd = r.cwd
  if (r.permissionMode === 'ask' || r.permissionMode === 'approve' || r.permissionMode === 'full') server.permissionMode = r.permissionMode
  if (typeof r.autoReconnect === 'boolean') server.autoReconnect = r.autoReconnect
  if (r.oauth && typeof r.oauth === 'object') {
    const o = r.oauth as Record<string, unknown>
    const oauth: NonNullable<McpServerConfig['oauth']> = {}
    for (const key of ['clientId', 'clientSecret', 'clientName', 'scope'] as const) if (typeof o[key] === 'string') oauth[key] = o[key] as string
    if (Object.keys(oauth).length) server.oauth = oauth
  }
  return server
}

export function cleanMcpConfig(raw: unknown): McpConfig {
  const servers = (raw as { servers?: unknown } | undefined)?.servers
  if (!Array.isArray(servers) || servers.length > 200) throw new Error('invalid')
  const clean = servers.map(cleanServer)
  if (new Set(clean.map((s) => s.name)).size !== clean.length) throw new Error('invalid')
  return { servers: clean }
}

export function cleanHookInput(raw: unknown): HookInput {
  const r = (raw ?? {}) as Record<string, unknown>
  const event = HOOK_EVENTS.find((e) => e === r.event)
  if (!event || typeof r.command !== 'string') throw new Error('invalid')
  return {
    event,
    match: typeof r.match === 'string' ? r.match.slice(0, 500) : '',
    command: r.command.slice(0, 20_000),
    ...(typeof r.description === 'string' ? { description: r.description.slice(0, 1000) } : {}),
    ...(typeof r.directory === 'string' && r.directory ? { directory: r.directory.slice(0, 4096) } : {}),
    ...(typeof r.timeoutMs === 'number' && Number.isFinite(r.timeoutMs) ? { timeoutMs: r.timeoutMs } : {}),
  }
}

export async function handleToolsRequest(req: Req): Promise<unknown> {
  switch (req.type) {
    // MCP: the config and the status leave masked, the save takes the masks back.
    case 'mcp:config':
      return maskMcpConfig(await readMcpConfig())
    case 'mcp:status':
      return maskMcpStatus(listMcpStatus())
    case 'mcp:save': {
      const incoming = cleanMcpConfig(req.config)
      return maskMcpStatus(await saveMcpConfig(restoreMcpSecrets(incoming, await readMcpConfig())))
    }
    case 'mcp:reconnect':
      return maskMcpStatus(await reconnectMcp(str(req.name, 200)))
    case 'mcp:descriptions':
      return mcpDescriptionsState(need(req.name, 200))
    case 'mcp:optimize':
      return optimizeMcpServer(need(req.name, 200))
    case 'mcp:revoke-trust':
      return removeTrust(`mcp:${need(req.name, 200)}`)

    case 'skills:list':
      return loadSkills(str(req.directory))
    case 'skills:meta':
      return skillMeta(str(req.directory))
    case 'skills:create': {
      const d = (req.data ?? {}) as Record<string, unknown>
      return saveSkill({
        name: need(d.name, 500),
        content: typeof d.content === 'string' ? d.content : '',
        ...(typeof d.description === 'string' ? { description: d.description } : {}),
        ...(str(d.slug, 200) ? { slug: str(d.slug, 200) } : {}),
        ...(str(d.oldSlug, 200) ? { oldSlug: str(d.oldSlug, 200) } : {}),
      })
    }
    case 'skills:remove':
      return removeSkill(need(req.slug, 200))
    case 'skills:set-pref': {
      const patch = (req.patch ?? {}) as Record<string, unknown>
      return setSkillPref(need(req.slug, 200), {
        ...(typeof patch.pin === 'boolean' ? { pin: patch.pin } : {}),
        ...(typeof patch.never === 'boolean' ? { never: patch.never } : {}),
      })
    }
    case 'skills:optimize':
      return optimizeSkillBySlug(need(req.slug, 200), str(req.directory), str(req.language, 100))
    case 'skills:pending':
      return listPendingSkills()
    case 'skills:approve':
      return approveSkill(need(req.slug, 200))
    case 'skills:discard':
      return discardSkill(need(req.slug, 200))

    case 'hooks:list':
      return listHooks()
    // What a peer writes is the user's own, like on the local screen: its card is that screen.
    case 'hooks:add':
      return addHook(cleanHookInput(req.input), 'user')
    case 'hooks:update':
      return updateHook(need(req.id, 200), cleanHookInput(req.input))
    case 'hooks:toggle':
      return setHookEnabled(need(req.id, 200), req.enabled === true)
    case 'hooks:remove':
      await removeHook(need(req.id, 200))
      return undefined
    default:
      throw new Error('unknown_request')
  }
}
