import { generateText, stepCountIs, streamText, type ModelMessage } from 'ai'
import type { BrowserWindow } from 'electron'
import type {
  ChatEvent,
  ChatMessage,
  MessagePart,
  SendMessageInput,
  SessionInfo,
  ToolPart,
} from '../../shared/chat'
import { StorageKeys } from '../../shared/chat'
import { getProvider } from './catalog'
import { compactHistory, findLastSummaryIndex, shouldCompact } from './compaction'
import { createToolApproval, takeDenialReason } from './permission'
import { buildSystemPrompt } from './prompts'
import { buildProviderOptions } from './reasoning'
import { resolveModel } from './providers'
import { readJson, writeJson } from './storage'
import { buildToolSet, type ToolContext } from './tools'
import { toTokenUsage } from './usage'

/**
 * Motor de chat portado do processador de sessões do opencode: converte o
 * histórico persistido em mensagens de modelo, roda o loop de streamText com
 * ferramentas e emite eventos incrementais para o renderer via IPC.
 */

const MAX_STEPS = 50
const abortControllers = new Map<string, AbortController>()

function newId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

async function loadMessages(sessionId: string): Promise<ChatMessage[]> {
  return (await readJson<ChatMessage[]>(StorageKeys.messages(sessionId))) ?? []
}

async function saveMessages(sessionId: string, messages: ChatMessage[]) {
  await writeJson(StorageKeys.messages(sessionId), messages)
}

function partText(parts: MessagePart[], type: 'text'): string {
  return parts
    .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === type)
    .map((p) => p.text)
    .join('\n')
}

/**
 * Converte o histórico persistido em mensagens para o modelo (somente texto).
 * Havendo compactação, corta no último resumo: envia resumo + mensagens
 * posteriores; o histórico completo continua no storage e na UI.
 */
export function toModelMessages(history: ChatMessage[]): ModelMessage[] {
  const lastSummary = findLastSummaryIndex(history)
  const window = lastSummary >= 0 ? history.slice(lastSummary) : history
  const result: ModelMessage[] = []
  for (const message of window) {
    const text = partText(message.parts, 'text')
    if (!text.trim()) continue
    result.push({ role: message.role, content: text })
  }
  return result
}

async function generateTitle(input: SendMessageInput, win: BrowserWindow) {
  try {
    const model = await resolveModel(input.providerId, input.modelId)
    const { text } = await generateText({
      model,
      system:
        'Gere um título curto (máximo 50 caracteres) para a conversa com base na mensagem do usuário. Responda APENAS com o título, sem aspas, no idioma da mensagem.',
      prompt: input.text.slice(0, 2000),
    })
    const title = text.trim().replace(/^["']|["']$/g, '').slice(0, 60)
    if (!title) return

    const session = await readJson<SessionInfo>(StorageKeys.session(input.sessionId))
    if (session) {
      await writeJson(StorageKeys.session(input.sessionId), { ...session, title, updatedAt: Date.now() })
    }
    emit(win, { type: 'title', sessionId: input.sessionId, title })
  } catch {
    // título é cosmético; falha silenciosa
  }
}

function emit(win: BrowserWindow, event: ChatEvent) {
  if (!win.isDestroyed()) win.webContents.send('chat:event', event)
}

export function abortChat(sessionId: string) {
  abortControllers.get(sessionId)?.abort()
}

export async function runChat(win: BrowserWindow, input: SendMessageInput): Promise<void> {
  const { sessionId } = input
  abortControllers.get(sessionId)?.abort()
  const controller = new AbortController()
  abortControllers.set(sessionId, controller)

  emit(win, { type: 'status', sessionId, status: 'submitted' })

  const history = await loadMessages(sessionId)
  const isFirstExchange = history.length === 0

  const userMessage: ChatMessage = {
    id: newId('msg'),
    role: 'user',
    parts: [{ id: newId('prt'), type: 'text', text: input.text, state: 'done' }],
    createdAt: Date.now(),
  }
  history.push(userMessage)
  emit(win, { type: 'message', sessionId, message: userMessage })

  const assistantMessage: ChatMessage = {
    id: newId('msg'),
    role: 'assistant',
    parts: [],
    createdAt: Date.now(),
    providerId: input.providerId,
    modelId: input.modelId,
    simple: input.options.simple || undefined,
  }
  history.push(assistantMessage)
  await saveMessages(sessionId, history)
  emit(win, { type: 'message', sessionId, message: assistantMessage })

  const upsertPart = (part: MessagePart) => {
    const idx = assistantMessage.parts.findIndex((p) => p.id === part.id)
    if (idx >= 0) assistantMessage.parts[idx] = part
    else assistantMessage.parts.push(part)
    emit(win, { type: 'part', sessionId, messageId: assistantMessage.id, part })
  }

  try {
    const model = await resolveModel(input.providerId, input.modelId)
    const provider = await getProvider(input.providerId)
    const supportsTools = provider?.models[input.modelId]?.tool_call !== false

    // Compactação automática: os tokens reais da última resposta indicam que o
    // contexto está perto do limite → resume o trecho antigo uma única vez
    const lastTokens = [...history].reverse().find((m) => m.role === 'assistant' && m.tokens)?.tokens
    if (shouldCompact(lastTokens, provider?.models[input.modelId])) {
      try {
        const summary = await compactHistory(history, model)
        if (summary) {
          await saveMessages(sessionId, history)
          emit(win, { type: 'messages', sessionId, messages: history })
        }
      } catch (err) {
        // compactação é otimização — nunca derruba o turno
        console.error('[compaction] falhou:', err)
      }
    }

    const toolContext: ToolContext | null =
      input.mode === 'code' && input.directory
        ? {
            sessionId,
            directory: input.directory,
            extraDirectories: input.extraDirectories ?? [],
            abort: controller.signal,
          }
        : null

    const result = streamText({
      model,
      system: await buildSystemPrompt(input),
      messages: toModelMessages(history.slice(0, -1)),
      tools: supportsTools ? buildToolSet(input, toolContext) : undefined,
      toolApproval: supportsTools ? createToolApproval(input, toolContext, controller.signal) : undefined,
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: controller.signal,
      providerOptions: await buildProviderOptions(input),
      onError: () => {
        // erros são tratados no loop do fullStream
      },
    })

    let streaming = false
    let lastSave = Date.now()
    const reasoningStart = new Map<string, number>()

    for await (const part of result.fullStream) {
      if (!streaming) {
        streaming = true
        emit(win, { type: 'status', sessionId, status: 'streaming' })
      }

      switch (part.type) {
        case 'text-start':
          upsertPart({ id: part.id, type: 'text', text: '', state: 'streaming' })
          break
        case 'text-delta': {
          const existing = assistantMessage.parts.find((p) => p.id === part.id)
          if (existing?.type === 'text') {
            existing.text += part.text
            emit(win, {
              type: 'part-delta',
              sessionId,
              messageId: assistantMessage.id,
              partId: part.id,
              kind: 'text',
              delta: part.text,
            })
          }
          break
        }
        case 'text-end': {
          const existing = assistantMessage.parts.find((p) => p.id === part.id)
          if (existing?.type === 'text') upsertPart({ ...existing, state: 'done' })
          break
        }
        case 'reasoning-start':
          reasoningStart.set(part.id, Date.now())
          upsertPart({ id: part.id, type: 'reasoning', text: '', state: 'streaming' })
          break
        case 'reasoning-delta': {
          const existing = assistantMessage.parts.find((p) => p.id === part.id)
          if (existing?.type === 'reasoning') {
            existing.text += part.text
            emit(win, {
              type: 'part-delta',
              sessionId,
              messageId: assistantMessage.id,
              partId: part.id,
              kind: 'reasoning',
              delta: part.text,
            })
          }
          break
        }
        case 'reasoning-end': {
          const existing = assistantMessage.parts.find((p) => p.id === part.id)
          if (existing?.type === 'reasoning') {
            const started = reasoningStart.get(part.id)
            upsertPart({
              ...existing,
              state: 'done',
              durationMs: started ? Date.now() - started : undefined,
            })
          }
          break
        }
        case 'tool-call':
          upsertPart({
            id: part.toolCallId,
            type: 'tool',
            tool: part.toolName,
            state: 'running',
            input: part.input as Record<string, unknown>,
          })
          break
        case 'tool-result': {
          const existing = assistantMessage.parts.find((p) => p.id === part.toolCallId) as
            | ToolPart
            | undefined
          upsertPart({
            id: part.toolCallId,
            type: 'tool',
            tool: part.toolName,
            state: 'done',
            input: existing?.input,
            output: typeof part.output === 'string' ? part.output : JSON.stringify(part.output, null, 2),
          })
          // show_image: a imagem vira parte da resposta (renderizada pelo ai/image)
          if (part.toolName === 'show_image') {
            const output = part.output as { mediaUrl?: string; alt?: string } | string
            if (typeof output === 'object' && output?.mediaUrl) {
              upsertPart({
                id: `${part.toolCallId}-img`,
                type: 'image',
                src: output.mediaUrl,
                alt: output.alt || undefined,
              })
            }
          }
          break
        }
        case 'tool-output-denied': {
          // Execução negada pelo gate de permissões (política ou usuário)
          const existing = assistantMessage.parts.find((p) => p.id === part.toolCallId) as
            | ToolPart
            | undefined
          upsertPart({
            id: part.toolCallId,
            type: 'tool',
            tool: part.toolName,
            state: 'error',
            input: existing?.input,
            error: takeDenialReason(part.toolCallId) ?? 'Ação negada pela política de permissões.',
          })
          break
        }
        case 'tool-error': {
          const existing = assistantMessage.parts.find((p) => p.id === part.toolCallId) as
            | ToolPart
            | undefined
          upsertPart({
            id: part.toolCallId,
            type: 'tool',
            tool: part.toolName,
            state: 'error',
            input: existing?.input,
            error: part.error instanceof Error ? part.error.message : String(part.error),
          })
          break
        }
        case 'finish':
          // Usage agregado da geração (todos os steps) + custo via catálogo
          assistantMessage.tokens = toTokenUsage(
            part.totalUsage,
            provider?.models[input.modelId]?.cost,
          )
          break
        case 'error':
          throw part.error instanceof Error ? part.error : new Error(String(part.error))
        default:
          break
      }

      // Persistência incremental: garante que um crash não perca a resposta
      if (assistantMessage.parts.length > 0 && Date.now() - lastSave > 2000) {
        lastSave = Date.now()
        await saveMessages(sessionId, history)
      }
    }

    // Finaliza partes que ficaram em streaming (ex.: abort)
    for (const part of assistantMessage.parts) {
      if ((part.type === 'text' || part.type === 'reasoning') && part.state === 'streaming') {
        part.state = 'done'
      }
    }
    await saveMessages(sessionId, history)

    const session = await readJson<SessionInfo>(StorageKeys.session(sessionId))
    if (session) await writeJson(StorageKeys.session(sessionId), { ...session, updatedAt: Date.now() })

    emit(win, { type: 'message', sessionId, message: assistantMessage })
    emit(win, { type: 'status', sessionId, status: 'idle' })

    // Workers já nascem com título (task.title) — não sobrescrever
    if (isFirstExchange && input.orchestrationRole !== 'worker') void generateTitle(input, win)
  } catch (err) {
    const aborted = controller.signal.aborted
    const message = err instanceof Error ? err.message : String(err)
    assistantMessage.error = aborted ? undefined : message
    for (const part of assistantMessage.parts) {
      if ((part.type === 'text' || part.type === 'reasoning') && part.state === 'streaming') {
        part.state = 'done'
      }
    }
    await saveMessages(sessionId, history)
    emit(win, { type: 'message', sessionId, message: assistantMessage })
    emit(win, {
      type: 'status',
      sessionId,
      status: aborted ? 'idle' : 'error',
      error: aborted ? undefined : message,
    })
  } finally {
    if (abortControllers.get(sessionId) === controller) abortControllers.delete(sessionId)
  }
}
