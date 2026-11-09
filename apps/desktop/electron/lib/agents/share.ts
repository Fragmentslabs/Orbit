import { createHash } from 'node:crypto'
import path from 'node:path'
import {
  AGENT_FILE_EXTENSION,
  AGENT_FILE_FORMAT,
  AGENT_FILE_MAX_BYTES,
  type AgentFile,
  type AgentImportConfirmResult,
  type AgentImportPreviewResult,
  type SharedAgent,
} from '@shared/agent-share'
import { AGENT_FORMAT_VERSION, type AgentDefinition } from '@shared/agents'
import { createPendingStore } from '../share/pending'
import { importAgent } from './store'
import { agentInputProblem, sanitizeAgentInput } from './validate'

/**
 * Sharing an agent: the file it exports to, and the two-step import. The first step reads and
 * validates the file and WRITES NOTHING; the second saves exactly what the first returned
 * for the person to read, and only runs after they confirmed the card.
 *
 * Whatever the file says is data: it passes through the same `sanitizeAgentInput` as the
 * editor, it can never choose its own id or origin, and the machine-specific defaults (model,
 * thinking) are ignored — those are the person's choice, not a file's.
 */

interface Held {
  fileName: string
  agent: SharedAgent
}

const pending = createPendingStore<Held>()

/** The file for one agent. The id, dates, origin and machine-specific defaults stay behind. */
export function serializeAgent(agent: AgentDefinition): { text: string; suggestedName: string } {
  const { name, icon, prompt, features, allowedTools, whenToUse, pinnedSkills, craft } = agent
  const shared: SharedAgent = { name, icon, prompt, features, whenToUse, pinnedSkills, ...(allowedTools ? { allowedTools } : {}), ...(craft ? { craft } : {}) }
  const file: AgentFile = { format: AGENT_FILE_FORMAT, version: AGENT_FORMAT_VERSION, agent: shared }
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent'
  return { text: JSON.stringify(file, null, 2), suggestedName: `${slug}${AGENT_FILE_EXTENSION}` }
}

const basename = (name: unknown): string =>
  Array.from(path.basename(String(name ?? '').replace(/\\/g, '/')))
    .filter((ch) => ch.codePointAt(0)! >= 32 && ch.codePointAt(0) !== 127)
    .join('')
    .slice(0, 120) || `agent${AGENT_FILE_EXTENSION}`

/** Step one: parse, validate and hold. Nothing is saved. */
export function previewAgentImport(fileName: unknown, text: unknown): AgentImportPreviewResult {
  if (typeof text !== 'string') return { ok: false, code: 'not_json' }
  if (Buffer.byteLength(text, 'utf8') > AGENT_FILE_MAX_BYTES) return { ok: false, code: 'too_large' }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, code: 'not_json' }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: 'bad_format' }
  const file = raw as Record<string, unknown>
  if (file.format !== AGENT_FILE_FORMAT) return { ok: false, code: 'bad_format' }
  if (typeof file.version !== 'number' || !Number.isInteger(file.version) || file.version < 1) return { ok: false, code: 'bad_format' }
  if (file.version > AGENT_FORMAT_VERSION) return { ok: false, code: 'unsupported_version' }
  if (!file.agent || typeof file.agent !== 'object' || Array.isArray(file.agent)) return { ok: false, code: 'bad_agent' }

  const source = file.agent as Record<string, unknown>
  const input = sanitizeAgentInput(source)
  if (agentInputProblem(input)) return { ok: false, code: 'bad_agent' }
  const ignored: Array<'defaultModel' | 'thinking'> = []
  if (input.defaultModel) ignored.push('defaultModel')
  if (input.thinking !== undefined) ignored.push('thinking')
  const { defaultModel: _model, thinking: _thinking, ...agent } = input

  const name = basename(fileName)
  const token = pending.put({ fileName: name, agent })
  return { ok: true, preview: { token, fileName: name, sha256: createHash('sha256').update(text).digest('hex'), agent, ignored } }
}

export function cancelAgentImport(token: unknown): void {
  if (typeof token === 'string') pending.drop(token)
}

/** Step two: saves what the card showed, as `origin: 'imported'`. Features and tools are exactly the ones shown. */
export async function confirmAgentImport(token: unknown): Promise<AgentImportConfirmResult> {
  const held = typeof token === 'string' ? pending.take(token) : null
  if (!held) return { ok: false, code: 'expired' }
  const saved = await importAgent(held.agent)
  if (saved.ok) return { ok: true, agentId: saved.agent.id }
  return { ok: false, code: saved.reason === 'limit' ? 'limit' : 'failed' }
}
