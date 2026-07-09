/**
 * Tipos compartilhados entre o main process (Electron) e o renderer.
 * Modelo de dados inspirado no opencode: sessões + mensagens compostas por "parts"
 * (texto, reasoning e chamadas de ferramenta).
 */

export type SessionMode = "chat" | "code"

export type ChatStatus = "idle" | "submitted" | "streaming" | "error"

export interface SessionInfo {
  id: string
  title: string
  mode: SessionMode
  pinned: boolean
  archived: boolean
  folderId: string | null
  /** Pasta principal de trabalho (modo código) */
  directory?: string
  /** Pastas adicionais anexadas (modo código) */
  extraDirectories?: string[]
  createdAt: number
  updatedAt: number
}

export interface FolderInfo {
  id: string
  name: string
  mode: SessionMode
  pinned: boolean
  createdAt: number
}

export type TextPartState = "streaming" | "done"

export interface TextPart {
  id: string
  type: "text"
  text: string
  state: TextPartState
}

export interface ReasoningPart {
  id: string
  type: "reasoning"
  text: string
  state: TextPartState
  durationMs?: number
}

export type ToolPartState = "running" | "done" | "error"

export interface ToolPart {
  id: string
  type: "tool"
  tool: string
  state: ToolPartState
  title?: string
  input?: Record<string, unknown>
  output?: string
  error?: string
}

export type MessagePart = TextPart | ReasoningPart | ToolPart

export interface ChatMessage {
  id: string
  role: "user" | "assistant"
  parts: MessagePart[]
  createdAt: number
  providerId?: string
  modelId?: string
  error?: string
}

export interface ModelVariant {
  /** ID único usado na comunicação (ex: "high", "max", "medium") */
  id: string
  /** Label de exibição no dropdown */
  label: string
  /** Descrição curta para tooltip (opcional) */
  description?: string
}

export interface ReasoningConfig {
  /** Toggle on/off do thinking */
  enabled: boolean
  /** ID da variant selecionada — undefined usa o baseline do modelo */
  variantId?: string
}

export interface SendMessageOptions {
  /** Modo pesquisa aprofundada (prompt de deep research + ferramentas web) */
  research?: boolean
  /** Habilita ferramentas de browser nativo */
  browser?: boolean
  /** Modo plano: apenas ferramentas de leitura, saída em formato de plano */
  plan?: boolean
  /** Configuração de reasoning/thinking do modelo quando suportado */
  reasoning?: ReasoningConfig
}

export interface SendMessageInput {
  sessionId: string
  text: string
  providerId: string
  modelId: string
  mode: SessionMode
  options: SendMessageOptions
  directory?: string
  extraDirectories?: string[]
}

export type ChatEvent =
  | { type: "status"; sessionId: string; status: ChatStatus; error?: string }
  | { type: "message"; sessionId: string; message: ChatMessage }
  | { type: "part"; sessionId: string; messageId: string; part: MessagePart }
  | {
      type: "part-delta"
      sessionId: string
      messageId: string
      partId: string
      kind: "text" | "reasoning"
      delta: string
    }
  | { type: "title"; sessionId: string; title: string }

/** Modelo do catálogo models.dev (mesmo formato usado pelo opencode) */
export interface CatalogModel {
  id: string
  name: string
  reasoning: boolean
  /** Modelo sempre pensa (não há controle de nível) — ex: DeepSeek R1 */
  reasoningAlwaysOn?: boolean
  /** Níveis de reasoning disponíveis (metadados gerados no main process) */
  variants?: ModelVariant[]
  tool_call: boolean
  attachment: boolean
  release_date?: string
  limit?: { context: number; output: number }
  cost?: { input: number; output: number }
}

export interface CatalogProvider {
  id: string
  name: string
  env: string[]
  npm?: string
  api?: string
  models: Record<string, CatalogModel>
}

export type Catalog = Record<string, CatalogProvider>

export interface ProviderCredential {
  type: "api"
  key: string
}

/** Chaves usadas no storage genérico (main process) */
export const StorageKeys = {
  session: (id: string) => `session/${id}`,
  sessionPrefix: "session/",
  messages: (sessionId: string) => `messages/${sessionId}`,
  folders: "folders",
} as const
