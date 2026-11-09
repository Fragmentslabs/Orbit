import type { AgentInput } from './agents'

/**
 * Sharing an agent: one small JSON file (`.orbitagent`) holding the definition and nothing
 * tied to an installation — no id, no dates, no origin, no model, no keys. Importing it
 * always goes through a consent card that shows what the agent will do; the version is
 * `AGENT_FORMAT_VERSION`.
 */

export const AGENT_FILE_FORMAT = 'orbit-agent'
export const AGENT_FILE_EXTENSION = '.orbitagent'
export const AGENT_FILE_MAX_BYTES = 256 * 1024

/** What the file holds: the editable part of an agent, minus what only makes sense on one machine. */
export type SharedAgent = Omit<AgentInput, 'defaultModel' | 'thinking'>

export interface AgentFile {
  format: typeof AGENT_FILE_FORMAT
  version: number
  agent: SharedAgent
}

export type AgentImportErrorCode = 'too_large' | 'not_json' | 'bad_format' | 'unsupported_version' | 'bad_agent'

/** Everything the agent will do, shown before it is saved. Nothing here is hidden behind the file. */
export interface AgentImportPreview {
  /** Hands the confirmation back to the main process, which holds the validated definition. */
  token: string
  fileName: string
  sha256: string
  agent: SharedAgent
  /** What the file carried that Orbit ignores (a model or thinking default are the person's choice). */
  ignored: Array<'defaultModel' | 'thinking'>
}

export type AgentImportPreviewResult = { ok: true; preview: AgentImportPreview } | { ok: false; code: AgentImportErrorCode }
export type AgentImportConfirmResult = { ok: true; agentId: string } | { ok: false; code: 'expired' | 'limit' | 'failed' }
export type AgentExportResult = { ok: true; path: string } | { ok: false; canceled?: boolean }

export const AGENT_SHARE_CHANNELS = {
  export: 'agents:export',
  importPreview: 'agents:import-preview',
  importConfirm: 'agents:import-confirm',
  importCancel: 'agents:import-cancel',
} as const
