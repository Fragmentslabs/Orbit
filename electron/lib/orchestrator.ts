import { generateText, stepCountIs, streamText } from 'ai'
import type { BrowserWindow } from 'electron'
import type {
  ChatEvent,
  ChatMessage,
  OrchestrationPlan,
  OrchestrationTask,
  SendMessageInput,
  SessionInfo,
  TextPart,
} from '../../shared/chat'
import { StorageKeys } from '../../shared/chat'
import { abortChat, runChat, toModelMessages } from './chat-engine'
import { ORCHESTRATOR_PLAN_PROMPT, ORCHESTRATOR_SYNTHESIS_PROMPT } from './prompts'
import { resolveModel } from './providers'
import { buildProviderOptions } from './reasoning'
import { readJson, writeJson } from './storage'
import { createTaskTool } from './tools/orchestration'

/**
 * OrchestratorEngine (modo Orchestra), em três fases:
 * 1. Planejamento: o modelo orquestrador divide o pedido em create_task calls
 *    e o plano é proposto ao usuário (semi-auto).
 * 2. Execução: cada tarefa aprovada vira uma session filha real (persistida,
 *    aparece na sidebar/painel) rodando com o modelo worker em modo simples.
 * 3. Síntese: o orquestrador consolida os resultados na resposta final.
 */

const MAX_TASKS = 8
const PLAN_MAX_STEPS = 4

interface PendingOrchestration {
  input: SendMessageInput
  plan: OrchestrationPlan
  assistantMessageId: string
}

// Planos aguardando aprovação/execução — em memória: se o app reiniciar entre
// proposta e aprovação, o plano persiste no storage mas não é mais executável.
const pending = new Map<string, PendingOrchestration>()
const controllers = new Map<string, AbortController>()
// Workers em execução por orquestrador — para propagar o abort do pai
const activeWorkers = new Map<string, string[]>()

function newId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

function emit(win: BrowserWindow, event: ChatEvent) {
  if (!win.isDestroyed()) win.webContents.send('chat:event', event)
}

async function loadMessages(sessionId: string): Promise<ChatMessage[]> {
  return (await readJson<ChatMessage[]>(StorageKeys.messages(sessionId))) ?? []
}

async function saveMessages(sessionId: string, messages: ChatMessage[]) {
  await writeJson(StorageKeys.messages(sessionId), messages)
}

async function persistPlan(win: BrowserWindow, sessionId: string, plan: OrchestrationPlan) {
  await writeJson(StorageKeys.orchestration(sessionId), plan)
  emit(win, { type: 'orchestration:plan', sessionId, plan })
}

export function abortOrchestration(sessionId: string) {
  controllers.get(sessionId)?.abort()
  // Abort transitivo: workers da fase 2 têm seus próprios controllers no chat-engine
  for (const workerId of activeWorkers.get(sessionId) ?? []) abortChat(workerId)
}

/** Fase 1 — planejamento. Substitui runChat quando options.orchestrate está ativo. */
export async function runOrchestration(win: BrowserWindow, input: SendMessageInput): Promise<void> {
  const { sessionId } = input
  controllers.get(sessionId)?.abort()
  const controller = new AbortController()
  controllers.set(sessionId, controller)

  emit(win, { type: 'status', sessionId, status: 'submitted' })

  const history = await loadMessages(sessionId)
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
  }
  history.push(assistantMessage)
  await saveMessages(sessionId, history)
  emit(win, { type: 'message', sessionId, message: assistantMessage })

  try {
    const model = await resolveModel(input.providerId, input.modelId)
    emit(win, { type: 'status', sessionId, status: 'streaming' })

    const tasks: OrchestrationTask[] = []
    const contextNote = input.directory
      ? `\n\nContexto: o usuário está no modo código com a pasta de trabalho ${input.directory}. Tarefas "code" terão acesso a essa pasta.`
      : '\n\nContexto: modo chat, sem pasta de trabalho — prefira tarefas "chat".'

    const result = await generateText({
      model,
      system: ORCHESTRATOR_PLAN_PROMPT + contextNote,
      messages: toModelMessages(history.slice(0, -1)),
      tools: {
        create_task: createTaskTool(
          (task) => {
            if (tasks.length >= MAX_TASKS) return false
            tasks.push(task)
            return true
          },
          { allowCode: Boolean(input.directory) },
        ),
      },
      stopWhen: stepCountIs(PLAN_MAX_STEPS),
      abortSignal: controller.signal,
      providerOptions: await buildProviderOptions(input),
    })

    if (result.text.trim()) {
      const part: TextPart = { id: newId('prt'), type: 'text', text: result.text.trim(), state: 'done' }
      assistantMessage.parts.push(part)
      emit(win, { type: 'part', sessionId, messageId: assistantMessage.id, part })
    }
    await saveMessages(sessionId, history)

    if (tasks.length === 0) {
      // Pedido trivial: o orquestrador respondeu direto, sem plano
      emit(win, { type: 'message', sessionId, message: assistantMessage })
      emit(win, { type: 'status', sessionId, status: 'idle' })
      return
    }

    const plan: OrchestrationPlan = { id: newId('plan'), tasks, status: 'proposed' }
    pending.set(sessionId, { input, plan, assistantMessageId: assistantMessage.id })
    await persistPlan(win, sessionId, plan)
    emit(win, { type: 'message', sessionId, message: assistantMessage })
    emit(win, { type: 'status', sessionId, status: 'idle' })
  } catch (err) {
    const aborted = controller.signal.aborted
    const message = err instanceof Error ? err.message : String(err)
    assistantMessage.error = aborted ? undefined : message
    await saveMessages(sessionId, history)
    emit(win, { type: 'message', sessionId, message: assistantMessage })
    emit(win, {
      type: 'status',
      sessionId,
      status: aborted ? 'idle' : 'error',
      error: aborted ? undefined : message,
    })
  } finally {
    if (controllers.get(sessionId) === controller) controllers.delete(sessionId)
  }
}

/** Fase 2 (execução dos workers) + Fase 3 (síntese). */
export async function approvePlan(
  win: BrowserWindow,
  sessionId: string,
  planId: string,
  taskIds?: string[],
): Promise<void> {
  const entry = pending.get(sessionId)
  if (!entry || entry.plan.id !== planId) {
    emit(win, {
      type: 'status',
      sessionId,
      status: 'error',
      error: 'Este plano não está mais disponível para execução (o app foi reiniciado?). Envie o pedido novamente.',
    })
    return
  }
  pending.delete(sessionId)
  const { input, plan } = entry
  const controller = new AbortController()
  controllers.set(sessionId, controller)

  const selected = taskIds ? plan.tasks.filter((t) => taskIds.includes(t.id)) : plan.tasks
  if (selected.length === 0) {
    plan.status = 'rejected'
    await persistPlan(win, sessionId, plan)
    return
  }

  try {
    // Marca a sessão principal como orquestradora (vira nó-pai na sidebar)
    const parent = await readJson<SessionInfo>(StorageKeys.session(sessionId))
    if (parent && parent.orchestration?.role !== 'orchestrator') {
      const next = { ...parent, orchestration: { role: 'orchestrator' as const }, updatedAt: Date.now() }
      await writeJson(StorageKeys.session(sessionId), next)
      emit(win, { type: 'session', sessionId, session: next })
    }

    // Cria as sessions filhas dos workers
    const now = Date.now()
    for (const task of selected) {
      const worker: SessionInfo = {
        id: newId('ses'),
        title: task.title,
        mode: task.mode === 'code' && input.directory ? 'code' : 'chat',
        pinned: false,
        archived: false,
        folderId: null,
        directory: task.mode === 'code' ? input.directory : undefined,
        extraDirectories: task.mode === 'code' ? input.extraDirectories : undefined,
        orchestration: { role: 'worker', parentSessionId: sessionId, task: task.title },
        parentId: sessionId,
        createdAt: now,
        updatedAt: now,
      }
      await writeJson(StorageKeys.session(worker.id), worker)
      task.workerSessionId = worker.id
      task.status = 'submitted'
      emit(win, { type: 'session', sessionId: worker.id, session: worker })
    }

    plan.status = 'running'
    await persistPlan(win, sessionId, plan)
    emit(win, { type: 'status', sessionId, status: 'streaming' })

    // Fase 2: workers em paralelo, cada um emitindo ChatEvents no próprio sessionId
    activeWorkers.set(sessionId, selected.map((t) => t.workerSessionId!))
    const workerModel = input.workerModel
    const results = await Promise.all(
      selected.map(async (task) => {
        const workerInput: SendMessageInput = {
          sessionId: task.workerSessionId!,
          text: task.prompt,
          providerId: workerModel?.providerId ?? input.providerId,
          modelId: workerModel?.modelId ?? input.modelId,
          mode: task.mode === 'code' && input.directory ? 'code' : 'chat',
          options: {
            ...task.options,
            simple: task.options.simple ?? true,
            reasoning: workerModel?.reasoning,
            subagents: false,
            orchestrate: undefined,
          },
          directory: input.directory,
          extraDirectories: input.extraDirectories,
          orchestrationRole: 'worker',
        }
        await runChat(win, workerInput)

        const messages = await loadMessages(task.workerSessionId!)
        const last = [...messages].reverse().find((m) => m.role === 'assistant')
        const text = last?.parts
          .filter((p): p is TextPart => p.type === 'text')
          .map((p) => p.text)
          .join('\n')
          .trim()
        task.status = last?.error ? 'error' : 'idle'
        return {
          task,
          text: text || (last?.error ? `O worker falhou: ${last.error}` : '(o worker não retornou texto)'),
        }
      }),
    )
    activeWorkers.delete(sessionId)
    await persistPlan(win, sessionId, plan)

    // Abort durante a fase 2: workers já pararam, não faz sentido sintetizar
    if (controller.signal.aborted) {
      plan.status = 'done'
      await persistPlan(win, sessionId, plan)
      emit(win, { type: 'status', sessionId, status: 'idle' })
      return
    }

    // Fase 3: síntese em streaming no chat principal
    const history = await loadMessages(sessionId)
    const synthesisMessage: ChatMessage = {
      id: newId('msg'),
      role: 'assistant',
      parts: [],
      createdAt: Date.now(),
      providerId: input.providerId,
      modelId: input.modelId,
    }
    history.push(synthesisMessage)
    emit(win, { type: 'message', sessionId, message: synthesisMessage })

    const resultsText = results
      .map((r) => `## ${r.task.title} [${r.task.status === 'error' ? 'FALHOU' : 'ok'}]\n\n${r.text}`)
      .join('\n\n---\n\n')

    const model = await resolveModel(input.providerId, input.modelId)
    const stream = streamText({
      model,
      system: ORCHESTRATOR_SYNTHESIS_PROMPT,
      messages: [
        ...toModelMessages(history.slice(0, -1)),
        { role: 'user', content: `Resultados dos workers:\n\n${resultsText}` },
      ],
      abortSignal: controller.signal,
      providerOptions: await buildProviderOptions(input),
    })

    const part: TextPart = { id: newId('prt'), type: 'text', text: '', state: 'streaming' }
    let started = false
    for await (const delta of stream.textStream) {
      if (!started) {
        started = true
        synthesisMessage.parts.push(part)
        emit(win, { type: 'part', sessionId, messageId: synthesisMessage.id, part })
      }
      part.text += delta
      emit(win, {
        type: 'part-delta',
        sessionId,
        messageId: synthesisMessage.id,
        partId: part.id,
        kind: 'text',
        delta,
      })
    }
    part.state = 'done'
    if (started) emit(win, { type: 'part', sessionId, messageId: synthesisMessage.id, part })
    await saveMessages(sessionId, history)

    const session = await readJson<SessionInfo>(StorageKeys.session(sessionId))
    if (session) await writeJson(StorageKeys.session(sessionId), { ...session, updatedAt: Date.now() })

    plan.status = 'done'
    await persistPlan(win, sessionId, plan)
    emit(win, { type: 'message', sessionId, message: synthesisMessage })
    emit(win, { type: 'status', sessionId, status: 'idle' })
  } catch (err) {
    const aborted = controller.signal.aborted
    const message = err instanceof Error ? err.message : String(err)
    plan.status = 'done'
    await persistPlan(win, sessionId, plan)
    emit(win, {
      type: 'status',
      sessionId,
      status: aborted ? 'idle' : 'error',
      error: aborted ? undefined : message,
    })
  } finally {
    activeWorkers.delete(sessionId)
    if (controllers.get(sessionId) === controller) controllers.delete(sessionId)
  }
}

export async function rejectPlan(win: BrowserWindow, sessionId: string): Promise<void> {
  const entry = pending.get(sessionId)
  if (!entry) return
  pending.delete(sessionId)
  entry.plan.status = 'rejected'
  await persistPlan(win, sessionId, entry.plan)
  emit(win, { type: 'status', sessionId, status: 'idle' })
}
