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
} from '@shared/chat'
import { StorageKeys } from '@shared/chat'
import { getProvider } from './catalog'
import { abortChat, runChat, toModelMessages } from './chat-engine'
import { ORCHESTRATOR_PLAN_PROMPT, ORCHESTRATOR_SYNTHESIS_PROMPT } from './prompts'
import { resolveModel } from './providers'
import { buildProviderOptions } from './reasoning'
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
const PLAN_MAX_STEPS = 4

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
      ? `\n\nContexto: o usuário está no modo código com a pasta de trabalho ${input.directory}. Tarefas "code" terão acesso a essa pasta.`
      : '\n\nContexto: modo chat, sem pasta de trabalho — prefira tarefas "chat".'

    // Tool context para subagent durante planejamento (pasta de trabalho disponível)
    const planCtx: ToolContext | null = input.directory
      ? { sessionId: input.sessionId, directory: input.directory, extraDirectories: input.extraDirectories ?? [], abort: controller.signal }
      : null
    const subagentTool = createSubagentTool(input, planCtx)

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
        subagent: subagentTool,
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

    const provider = await getProvider(input.providerId)
    const plan: OrchestrationPlan = {
      id: newId('plan'),
      tasks,
      status: 'proposed',
      usage: toTokenUsage(result.usage, provider?.models[input.modelId]?.cost),
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
          mode: task.mode === 'code' && input.directory ? 'code' : 'chat',
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

    // Usage da síntese: registrado na própria mensagem e somado ao plano
    const provider = await getProvider(input.providerId)
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
              .trim() || '(sem retorno)'
            return { sessionId: wsId, title: info.title, text: text.slice(0, 2000), error: last?.error }
          }),
        )

        // Orquestrador decide o que fazer
        const workersBlock = workersStatus
          .map((w) => `## Worker "${w.title}" (sessionId: ${w.sessionId})\n${w.error ? `**ERRO**: ${w.error}\n` : ''}${w.text}`)
          .join('\n\n---\n\n')

        const { text: decisionText } = await generateText({
          model,
          system: `Você é o orquestrador do Orbit em modo loop. Revise os resultados dos workers e decida a próxima ação.`,
          messages: [
            { role: 'user', content: `## Pedido original\n${input.text}\n\n## Resultados dos workers\n${workersBlock}\n\n## Iteração atual\n${iteration + 1}/${lc.maxIterations}` },
            {
              role: 'user',
              content: `Analise se o objetivo foi atingido. Responda com JSON:
{
  "action": "done" | "message_worker" | "create_worker" | "create_test_worker",
  "reason": "explicação curta",
  "workerSessionId": "se action=message_worker, sessionId do worker a mensagem",
  "followUpPrompt": "se action=message_worker, nova instrução para o worker existente",
  "workerTitle": "se action=create_worker ou create_test_worker, título do novo worker",
  "workerPrompt": "se action=create_worker ou create_test_worker, prompt do novo worker",
  "workerMode": "chat ou code (se create_worker/create_test_worker)"
}

Regras:
- "done": objetivo atingido, finalizar
- "message_worker": reusar um worker existente com novas instruções (melhor que criar um novo quando o worker já tem contexto)
- "create_worker": criar worker adicional para continuar/expandir
- "create_test_worker": criar worker para TESTAR o que foi implementado; se encontrar erros, o loop seguinte pode delegar ao worker que implementou`,
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
            mode: wsInfo.title.toLowerCase().includes('test') ? 'code' : (input.directory ? 'code' : 'chat'),
            options: { simple: true, subagents: true, orchestrate: undefined, permissionMode: input.options.permissionMode },
            directory: input.directory,
            extraDirectories: input.extraDirectories,
            orchestrationRole: 'worker',
            parentSessionId: sessionId,
            workerTitle: wsInfo.title,
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
            mode: decision.workerMode === 'code' && input.directory ? 'code' : 'chat',
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
