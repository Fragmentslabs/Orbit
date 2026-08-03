import { generateText, stepCountIs, streamText, type ModelMessage } from 'ai'
import type { BrowserWindow } from 'electron'
import type {
  ChatEvent,
  ChatMessage,
  MessagePart,
  OrchestrationPlan,
  OrchestrationTask,
  SendMessageInput,
  SessionInfo,
  TextPart,
  ToolPart,
} from '@shared/chat'
import { StorageKeys } from '@shared/chat'
import { getProvider } from './catalog'
import { abortChat, runChat, toModelMessages } from './chat-engine'
import { ORCHESTRATOR_PLAN_PROMPT, ORCHESTRATOR_SYNTHESIS_PROMPT } from './prompts'
import { resolveModel } from './providers'
import { buildProviderOptions, interleavedReasoningField, normalizeMessages } from './reasoning'
import { readJson, writeJson } from './storage'
import { createSubagentTool, createTaskTool } from './tools/orchestration'
import type { ToolContext } from './tools/context'
import { addTokenUsage, toTokenUsage } from './usage'
import type { LoopEngineConfig } from './loop-engine'

/**
 * OrchestratorEngine (modo Orchestra), em três fases:
 * 1. Planejamento: o modelo orquestrador divide o pedido em create_task calls
 *    e o plano é proposto ao usuário (semi-auto).
 * 2. Execução: cada tarefa aprovada vira uma session filha real (persistida,
 *    aparece na sidebar/painel) rodando com o modelo worker em modo simples.
 * 3. Síntese: o orquestrador consolida os resultados na resposta final.
 */

const MAX_TASKS = 8
// Teto de passos do planejamento. Precisa acomodar pesquisa (subagent) +
// registro de várias tarefas (create_task) + o resumo final. Baixo demais
// (era 4) fazia a pesquisa consumir todo o orçamento e o plano nascer vazio.
const PLAN_MAX_STEPS = 16
// Pesquisa de planejamento é leve: embasa a divisão, não resolve a tarefa.
const PLAN_SUBAGENT_MAX_STEPS = 5
// Teto DURO de chamadas de subagent durante o planejamento (o prompt já pede
// "2-3 chamadas", mas isso é só sugestão — sem um limite de verdade em código
// o modelo pode ignorá-lo, como aconteceu (17 chamadas para montar um plano).
const PLAN_SUBAGENT_MAX_CALLS = 3

interface PendingOrchestration {
  input: SendMessageInput
  plan: OrchestrationPlan
  assistantMessageId: string
  loopConfig?: LoopEngineConfig
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

/** Insere ou atualiza uma part na mensagem e emite o evento 'part' — usado
 * para renderizar o streaming do planejamento (texto, raciocínio, tool-calls)
 * na mensagem do orquestrador. */
function upsertPart(win: BrowserWindow, sessionId: string, message: ChatMessage, part: MessagePart) {
  const idx = message.parts.findIndex((p) => p.id === part.id)
  if (idx >= 0) message.parts[idx] = part
  else message.parts.push(part)
  emit(win, { type: 'part', sessionId, messageId: message.id, part })
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
  // Plano pendente de aprovação deixa de ser executável (ex: sessão deletada)
  pending.delete(sessionId)
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
      ? `\n\nContext: the user is in code mode with working folder ${input.directory}. "code" tasks will have access to that folder.`
      : '\n\nContext: chat mode, no working folder — prefer "chat" tasks.'

    // Tool context para subagent durante planejamento (pasta de trabalho disponível)
    const planCtx: ToolContext | null = input.directory
      ? { sessionId: input.sessionId, directory: input.directory, extraDirectories: input.extraDirectories ?? [], abort: controller.signal }
      : null
    const subagentTool = createSubagentTool(input, planCtx, PLAN_SUBAGENT_MAX_STEPS, PLAN_SUBAGENT_MAX_CALLS)
    const planTools = {
      create_task: createTaskTool(
        (task) => {
          if (tasks.length >= MAX_TASKS) return false
          tasks.push(task)
          return true
        },
        { allowCode: Boolean(input.directory) },
      ),
      subagent: subagentTool,
    }
    const provider = await getProvider(input.providerId)
    const baseMessages = normalizeMessages(
      toModelMessages(history.slice(0, -1)),
      interleavedReasoningField(provider, input.modelId),
    )
    const providerOptions = await buildProviderOptions(input)
    const cost = provider?.models[input.modelId]?.cost

    // Consome o stream de uma passada de planejamento, emitindo parts (texto,
    // raciocínio, tool-calls) para a UI mostrar o orquestrador trabalhando —
    // pesquisando com subagent e planejando — em vez de um "Analisando" mudo.
    const runPlanningPass = async (messages: ModelMessage[]) => {
      const stream = streamText({
        model,
        system: ORCHESTRATOR_PLAN_PROMPT + contextNote,
        messages,
        tools: planTools,
        stopWhen: stepCountIs(PLAN_MAX_STEPS),
        abortSignal: controller.signal,
        providerOptions,
        onError: () => { /* tratado no loop do fullStream */ },
      })
      let text = ''
      const reasoningStart = new Map<string, number>()
      for await (const part of stream.fullStream) {
        switch (part.type) {
          case 'text-start':
            upsertPart(win, sessionId, assistantMessage, { id: part.id, type: 'text', text: '', state: 'streaming' })
            break
          case 'text-delta': {
            const existing = assistantMessage.parts.find((p) => p.id === part.id)
            if (existing?.type === 'text') {
              existing.text += part.text
              text += part.text
              emit(win, { type: 'part-delta', sessionId, messageId: assistantMessage.id, partId: part.id, kind: 'text', delta: part.text })
            }
            break
          }
          case 'text-end': {
            const existing = assistantMessage.parts.find((p) => p.id === part.id)
            if (existing?.type === 'text') upsertPart(win, sessionId, assistantMessage, { ...existing, state: 'done' })
            break
          }
          case 'reasoning-start':
            reasoningStart.set(part.id, Date.now())
            upsertPart(win, sessionId, assistantMessage, { id: part.id, type: 'reasoning', text: '', state: 'streaming' })
            break
          case 'reasoning-delta': {
            const existing = assistantMessage.parts.find((p) => p.id === part.id)
            if (existing?.type === 'reasoning') {
              existing.text += part.text
              emit(win, { type: 'part-delta', sessionId, messageId: assistantMessage.id, partId: part.id, kind: 'reasoning', delta: part.text })
            }
            break
          }
          case 'reasoning-end': {
            const existing = assistantMessage.parts.find((p) => p.id === part.id)
            if (existing?.type === 'reasoning') {
              const started = reasoningStart.get(part.id)
              upsertPart(win, sessionId, assistantMessage, { ...existing, state: 'done', durationMs: started ? Date.now() - started : undefined })
            }
            break
          }
          case 'tool-call':
            upsertPart(win, sessionId, assistantMessage, { id: part.toolCallId, type: 'tool', tool: part.toolName, state: 'running', input: part.input as Record<string, unknown> })
            break
          case 'tool-result': {
            const existing = assistantMessage.parts.find((p) => p.id === part.toolCallId) as ToolPart | undefined
            upsertPart(win, sessionId, assistantMessage, {
              id: part.toolCallId,
              type: 'tool',
              tool: part.toolName,
              state: 'done',
              input: existing?.input,
              output: typeof part.output === 'string' ? part.output : JSON.stringify(part.output, null, 2),
            })
            break
          }
          case 'error':
            throw part.error instanceof Error ? part.error : new Error(String(part.error))
        }
      }
      return { text: text.trim(), usage: await stream.usage }
    }

    const firstPass = await runPlanningPass(baseMessages)
    let planUsage = toTokenUsage(firstPass.usage, cost)

    // Rede de segurança: o orquestrador às vezes narra "vou dividir em tarefas"
    // e para sem chamar create_task (plano vazio). Damos UMA cutucada explícita
    // antes de desistir e tratar como resposta trivial.
    if (tasks.length === 0 && firstPass.text) {
      const staleTextIds = new Set(assistantMessage.parts.filter((p) => p.type === 'text').map((p) => p.id))
      const nudgeMessages: ModelMessage[] = [
        ...baseMessages,
        { role: 'assistant', content: firstPass.text },
        {
          role: 'user',
          content:
            'You described the plan but registered no tasks. If the request needs to be split, call create_task NOW for each subtask. If it genuinely doesn\'t need splitting, answer directly without promising a plan.',
        },
      ]
      const retry = await runPlanningPass(nudgeMessages)
      planUsage = addTokenUsage(planUsage, toTokenUsage(retry.usage, cost))
      // Ainda sem tarefas: a resposta final é a do retry — descarta a narração
      // do primeiro passe pra não duplicar texto na bolha final do usuário.
      if (tasks.length === 0) {
        assistantMessage.parts = assistantMessage.parts.filter((p) => !staleTextIds.has(p.id))
      }
    }

    await saveMessages(sessionId, history)

    if (tasks.length === 0) {
      // Pedido trivial: o orquestrador respondeu direto, sem plano
      emit(win, { type: 'message', sessionId, message: assistantMessage })
      emit(win, { type: 'status', sessionId, status: 'idle' })
      return
    }

    const plan: OrchestrationPlan = {
      id: newId('plan'),
      tasks,
      status: 'proposed',
      usage: planUsage,
    }
    // Loop ativado por padrão no modo orquestração (o orquestrador decide quando parar).
    // Se o usuário explicitamente desativou loop, respeitamos.
    const effectiveLoop = input.options.loop !== false
    pending.set(sessionId, { input, plan, assistantMessageId: assistantMessage.id, loopConfig: effectiveLoop ? input.loopConfig ?? { maxIterations: 5, maxTokensPerIter: 8000, autoReview: true } : undefined })
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

    // Cria as sessions filhas dos workers. Registra cada worker em activeWorkers
    // JÁ NA CRIAÇÃO — um abort nesta janela precisa alcançá-los (antes o registro
    // só acontecia depois de criar todas as sessions e persistir o plano).
    activeWorkers.set(sessionId, [])
    const now = Date.now()
    for (const task of selected) {
      const worker: SessionInfo = {
        id: newId('ses'),
        title: task.title,
        mode: 'code',
        pinned: false,
        archived: false,
        folderId: null,
        directory: input.directory,
        extraDirectories: input.extraDirectories,
        orchestration: { role: 'worker', parentSessionId: sessionId, task: task.title },
        parentId: sessionId,
        createdAt: now,
        updatedAt: now,
      }
      await writeJson(StorageKeys.session(worker.id), worker)
      task.workerSessionId = worker.id
      task.status = 'submitted'
      activeWorkers.get(sessionId)?.push(worker.id)
      emit(win, { type: 'session', sessionId: worker.id, session: worker })
    }

    plan.status = 'running'
    await persistPlan(win, sessionId, plan)
    emit(win, { type: 'status', sessionId, status: 'streaming' })

    // Fase 2: workers em paralelo, cada um emitindo ChatEvents no próprio sessionId
    const workerModel = input.workerModel
    const results = await Promise.all(
      selected.map(async (task) => {
        const workerInput: SendMessageInput = {
          sessionId: task.workerSessionId!,
          text: task.prompt,
          providerId: workerModel?.providerId ?? input.providerId,
          modelId: workerModel?.modelId ?? input.modelId,
          mode: 'code',
          options: {
            ...task.options,
            brain: task.options.brain ?? true,
            simple: task.options.simple ?? true,
            reasoning: workerModel?.reasoning,
            // Workers podem usar subagentes (com limite de profundidade — o subagent tool
            // herda orchestrationRole='worker', que bloqueia sub-orquestração)
            subagents: true,
            orchestrate: undefined,
            // Gatekeeping: worker herda o modo de permissões do orquestrador
            permissionMode: input.options.permissionMode,
          },
          directory: input.directory,
          extraDirectories: input.extraDirectories,
          orchestrationRole: 'worker',
          parentSessionId: sessionId,
          workerTitle: task.title,
          language: input.language,
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
          tokens: last?.tokens,
        }
      }),
    )
    activeWorkers.delete(sessionId)
    // Acumula o custo dos workers no plano (planejamento já está em plan.usage)
    plan.usage = results.reduce((acc, r) => (r.tokens ? addTokenUsage(acc, r.tokens) : acc), plan.usage)
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
      .map((r) => `## ${r.task.title} [${r.task.status === 'error' ? 'FAILED' : 'ok'}]\n\n${r.text}`)
      .join('\n\n---\n\n')

    const model = await resolveModel(input.providerId, input.modelId)
    const provider = await getProvider(input.providerId)
    const stream = streamText({
      model,
      system: ORCHESTRATOR_SYNTHESIS_PROMPT,
      messages: [
        ...normalizeMessages(
          toModelMessages(history.slice(0, -1)),
          interleavedReasoningField(provider, input.modelId),
        ),
        { role: 'user', content: `Worker results:\n\n${resultsText}` },
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

    // Usage da síntese: registrado na própria mensagem e somado ao plano
    synthesisMessage.tokens = toTokenUsage(await stream.usage, provider?.models[input.modelId]?.cost)
    plan.usage = addTokenUsage(plan.usage, synthesisMessage.tokens)
    await saveMessages(sessionId, history)

    const session = await readJson<SessionInfo>(StorageKeys.session(sessionId))
    if (session) await writeJson(StorageKeys.session(sessionId), { ...session, updatedAt: Date.now() })

    plan.status = 'done'
    await persistPlan(win, sessionId, plan)
    emit(win, { type: 'message', sessionId, message: synthesisMessage })

    // ─── Loop de revisão inteligente pós-síntese ──────────────────────
    // O orquestrador é chamado a cada iteração para decidir a ação:
    //   - "message_worker": envia follow-up a um worker existente
    //   - "create_worker": cria novo worker (continuação, teste, etc.)
    //   - "done": finaliza
    if (entry.loopConfig) {
      const lc = entry.loopConfig
      let iteration = 0
      // Rastreia workers existentes para reuso
      const workerSessions = new Map(selected.map((t) => [t.workerSessionId!, { title: t.title, taskId: t.id }]))

      while (iteration < lc.maxIterations) {
        if (controller.signal.aborted) break

        const hist = await loadMessages(sessionId)
        // Coleta resultados atuais de todos os workers do plano
        const workersStatus = await Promise.all(
          [...workerSessions.entries()].map(async ([wsId, info]) => {
            const msgs = await loadMessages(wsId)
            const last = [...msgs].reverse().find((m) => m.role === 'assistant')
            const text = last?.parts
              .filter((p): p is TextPart => p.type === 'text')
              .map((p) => p.text)
              .join('\n')
              .trim() || '(no output)'
            return { sessionId: wsId, title: info.title, text: text.slice(0, 2000), error: last?.error }
          }),
        )

        // Orquestrador decide o que fazer
        const workersBlock = workersStatus
          .map((w) => `## Worker "${w.title}" (sessionId: ${w.sessionId})\n${w.error ? `**ERROR**: ${w.error}\n` : ''}${w.text}`)
          .join('\n\n---\n\n')

        const { text: decisionText } = await generateText({
          model,
          system: `You are the Orbit orchestrator in loop mode. Review the worker results and decide the next action.`,
          messages: [
            { role: 'user', content: `## Original request\n${input.text}\n\n## Worker results\n${workersBlock}\n\n## Current iteration\n${iteration + 1}/${lc.maxIterations}` },
            {
              role: 'user',
              content: `Analyze whether the goal was achieved. Reply with JSON:
{
  "action": "done" | "message_worker" | "create_worker" | "create_test_worker",
  "reason": "short explanation",
  "workerSessionId": "if action=message_worker, sessionId of the worker to message",
  "followUpPrompt": "if action=message_worker, new instruction for the existing worker",
  "workerTitle": "if action=create_worker or create_test_worker, title of the new worker",
  "workerPrompt": "if action=create_worker or create_test_worker, prompt for the new worker",
  "workerMode": "chat or code (if create_worker/create_test_worker)"
}

Rules:
- "done": goal achieved, finish
- "message_worker": reuse an existing worker with new instructions (better than creating a new one when the worker already has context)
- "create_worker": create an additional worker to continue/expand
- "create_test_worker": create a worker to TEST what was implemented; if it finds errors, the next loop iteration can delegate to the worker that implemented it`,
            },
          ],
          abortSignal: controller.signal,
        })

        interface LoopDecision {
          action: 'done' | 'message_worker' | 'create_worker' | 'create_test_worker'
          reason: string
          workerSessionId?: string
          followUpPrompt?: string
          workerTitle?: string
          workerPrompt?: string
          workerMode?: 'chat' | 'code'
        }

        let decision: LoopDecision = { action: 'done', reason: 'Falha ao interpretar decisão.' }
        try {
          const j = decisionText.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
          const start = j.indexOf('{')
          const end = j.lastIndexOf('}')
          decision = JSON.parse(j.slice(start, end + 1)) as LoopDecision
        } catch { decision = { action: 'done', reason: 'Erro ao parsear JSON da decisão.' } }

        if (decision.action === 'done' || !['message_worker', 'create_worker', 'create_test_worker'].includes(decision.action)) {
          // Anexa o veredito à síntese
          const verdictPart: TextPart = { id: newId('prt'), type: 'text', text: `\n\n---\n### Loop ${iteration + 1}: ${decision.action === 'done' ? '✓ Concluído' : 'Encerrado'}\n\n${decision.reason}`, state: 'done' }
          synthesisMessage.parts.push(verdictPart)
          emit(win, { type: 'part', sessionId, messageId: synthesisMessage.id, part: verdictPart })
          break
        }

        iteration++

        if (decision.action === 'message_worker' && decision.workerSessionId && workerSessions.has(decision.workerSessionId)) {
          // Reuso: envia nova instrução ao worker existente
          const wsInfo = workerSessions.get(decision.workerSessionId)!
          const followUp: ChatMessage = {
            id: newId('msg'),
            role: 'user',
            parts: [{ id: newId('prt'), type: 'text', text: `[Loop ${iteration}/${lc.maxIterations}] ${decision.reason}\n\n${decision.followUpPrompt ?? 'Continue o trabalho.'}`, state: 'done' }],
            createdAt: Date.now(),
          }
          const wsMsgs = await loadMessages(decision.workerSessionId)
          wsMsgs.push(followUp)
          await saveMessages(decision.workerSessionId, wsMsgs)
          emit(win, { type: 'message', sessionId: decision.workerSessionId, message: followUp })

          const reuseInput: SendMessageInput = {
            sessionId: decision.workerSessionId,
            text: decision.followUpPrompt ?? '',
            providerId: input.workerModel?.providerId ?? input.providerId,
            modelId: input.workerModel?.modelId ?? input.modelId,
            mode: 'code',
            options: { simple: true, subagents: true, orchestrate: undefined, permissionMode: input.options.permissionMode },
            directory: input.directory,
            extraDirectories: input.extraDirectories,
            orchestrationRole: 'worker',
            parentSessionId: sessionId,
            workerTitle: wsInfo.title,
            language: input.language,
          }
          await runChat(win, reuseInput)

          // Atualiza o resultado no plano
          const updatedMsgs = await loadMessages(decision.workerSessionId)
          const lastUp = [...updatedMsgs].reverse().find((m) => m.role === 'assistant')
          const upText = lastUp?.parts.filter((p): p is TextPart => p.type === 'text').map((p) => p.text).join('\n').trim() || '(sem retorno)'
          const loopPart: TextPart = { id: newId('prt'), type: 'text', text: `\n\n---\n### Loop ${iteration}: reuso de "${wsInfo.title}"\n\n${decision.reason}\n\n${upText}`, state: 'done' }
          synthesisMessage.parts.push(loopPart)
          emit(win, { type: 'part', sessionId, messageId: synthesisMessage.id, part: loopPart })
        } else if ((decision.action === 'create_worker' || decision.action === 'create_test_worker') && decision.workerTitle) {
          const isTest = decision.action === 'create_test_worker'
          const loopWorker: SessionInfo = {
            id: newId('ses'),
            title: isTest ? `🧪 ${decision.workerTitle}` : decision.workerTitle!,
            mode: 'code',
            pinned: false,
            archived: false,
            folderId: null,
            directory: input.directory,
            extraDirectories: input.extraDirectories,
            orchestration: { role: 'worker', parentSessionId: sessionId, task: decision.reason },
            parentId: sessionId,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }
          await writeJson(StorageKeys.session(loopWorker.id), loopWorker)
          activeWorkers.get(sessionId)?.push(loopWorker.id)
          workerSessions.set(loopWorker.id, { title: loopWorker.title, taskId: '' })
          emit(win, { type: 'session', sessionId: loopWorker.id, session: loopWorker })

          const wm = input.workerModel
          const lwInput: SendMessageInput = {
            sessionId: loopWorker.id,
            text: decision.workerPrompt ?? decision.reason,
            providerId: wm?.providerId ?? input.providerId,
            modelId: wm?.modelId ?? input.modelId,
            mode: loopWorker.mode,
            options: { simple: true, subagents: true, orchestrate: undefined, permissionMode: input.options.permissionMode },
            directory: input.directory,
            extraDirectories: input.extraDirectories,
            orchestrationRole: 'worker',
            parentSessionId: sessionId,
            workerTitle: loopWorker.title,
            language: input.language,
          }
          await runChat(win, lwInput)

          const lwMsgs = await loadMessages(loopWorker.id)
          const lastLw = [...lwMsgs].reverse().find((m) => m.role === 'assistant')
          const lwText = lastLw?.parts.filter((p): p is TextPart => p.type === 'text').map((p) => p.text).join('\n').trim() || '(sem retorno)'
          // Se é worker de teste e encontrou erro, o orquestrador na próxima iteração pode delegar ao worker original
          const label = isTest ? `🧪 Teste` : `Worker adicional`
          const loopPart: TextPart = { id: newId('prt'), type: 'text', text: `\n\n---\n### ${label} (loop ${iteration}): "${loopWorker.title}"\n\n${decision.reason}\n\n${lwText}`, state: 'done' }
          synthesisMessage.parts.push(loopPart)
          emit(win, { type: 'part', sessionId, messageId: synthesisMessage.id, part: loopPart })
        }

        await saveMessages(sessionId, hist)
      }
      activeWorkers.delete(sessionId)
    }

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
