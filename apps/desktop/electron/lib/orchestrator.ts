import { generateText, stepCountIs, streamText, type ModelMessage, type ToolSet } from 'ai'
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
import { classifyProviderError, errorToText } from './errors'
import { ORCHESTRATOR_PLAN_PROMPT, ORCHESTRATOR_SYNTHESIS_PROMPT } from './prompts'
import { resolveModel } from './providers'
import { buildProviderOptions, interleavedReasoningField, normalizeMessages, reasoningPrepareStep } from './reasoning'
import { readJson, writeJson } from './storage'
import { createSubagentTool, createTaskTool } from './tools/orchestration'
import type { TaskModeCeiling } from './tools/orchestration'
import { createGlobTool, createGrepTool, createListTool, createReadTool } from './tools/files'
import { createQuestionTool } from './tools/question'
import type { ToolContext } from './tools/context'
import { addTokenUsage, toTokenUsage } from './usage'

/**
 * OrchestratorEngine (modo Orchestra), em quatro fases:
 * 1. Triagem + planejamento: o orquestrador decide se o pedido é conversa
 *    (responde direto), ambiguidade (usa a tool question) ou trabalho — e só
 *    aí divide em create_task. O plano é proposto ao usuário (semi-auto).
 * 2. Execução: cada tarefa aprovada vira uma session filha real (persistida,
 *    aparece na sidebar/painel), sempre em modo código, com os modos que o
 *    orquestrador escolheu para ela dentro do teto da sessão do usuário.
 * 3. Síntese: o orquestrador consolida os resultados na resposta final.
 * 4. Revisão: espera todos terminarem, relê o resultado de cada worker e manda
 *    outra rodada para quem precisa, dentro de um orçamento GLOBAL de rodadas
 *    (ver ORCHESTRATION_REVIEW_ROUNDS).
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
/**
 * Ele prometeu um plano e não registrou tarefa? Só então vale a cutucada.
 * Português e inglês porque a resposta segue o idioma do usuário.
 */
const PROMISED_PLAN_RE =
  /\b(create_task|vou (dividir|criar|planejar)|dividir em (tarefas|workers)|criar (as )?tarefas|I(’|')?ll (split|create|plan)|going to (split|create)|split .{0,20}into (tasks|workers))\b/i
/**
 * Rodadas de revisão pós-síntese, no TOTAL (não por worker) — quem decide onde
 * gastá-las é o orquestrador, que é o único que vê o conjunto. Por worker, "3"
 * viraria 15 rodadas num plano de 5, um multiplicador que o usuário não
 * escolheu.
 *
 * Este é o teto de quem NÃO ligou o modo Loop: existe para o erro óbvio ser
 * corrigido sem virar uma segunda rodada de trabalho. Com o Loop ligado vale o
 * maxIterations do diálogo de Loop, que por padrão é maior.
 */
const ORCHESTRATION_REVIEW_ROUNDS = 2

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

/** Sessões com orquestração em andamento (planejamento/síntese). */
export function getOrchestrationRunningSessionIds(): string[] {
  return [...controllers.keys()]
}

/** Fase 1 — planejamento. Substitui runChat quando options.orchestrate está ativo. */
export async function runOrchestration(win: BrowserWindow, input: SendMessageInput): Promise<void> {
  // Todo worker roda em modo código na pasta de trabalho — sem pasta não há o
  // que orquestrar. A UI do desktop já bloqueia o envio sem pasta, mas rotina
  // agendada e companion não: antes o create_task rebaixava a tarefa para chat,
  // e agora que o worker é sempre de código isso geraria sessões filhas sem
  // ferramenta nenhuma. Cai no turno normal, que ao menos funciona.
  if (!input.directory) {
    await runChat(win, input)
    return
  }
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
    // Tool context do planejamento (leitura do projeto + subagent). Sempre
    // existe: a guarda no topo garante a pasta de trabalho.
    const planCtx: ToolContext = {
      sessionId: input.sessionId,
      directory: input.directory,
      extraDirectories: input.extraDirectories ?? [],
      abort: controller.signal,
    }
    // Teto de modos dos workers: o que a sessão do usuário permite. O
    // orquestrador escolhe dentro disso, tarefa a tarefa.
    const ceiling: TaskModeCeiling = {
      research: input.options.research === true,
      browser: input.options.browser === true,
      vision: Boolean(input.visionModel),
      subagents: input.options.subagents === true,
    }
    const planTools: ToolSet = {
      create_task: createTaskTool((task) => {
        if (tasks.length >= MAX_TASKS) return false
        tasks.push(task)
        return true
      }, ceiling),
      // Perguntar antes de dividir: só vale quando a resposta muda o plano,
      // mas sem a tool ele não tinha como fazer isso nem quando valia.
      question: createQuestionTool(input, controller.signal),
    }
    // Leitura direta do projeto. Antes o planejamento não tinha NENHUMA tool de
    // arquivo, então a única forma de olhar o código era gastar um subagente
    // inteiro — daí a enxurrada de chamadas. Ler não é delegar: continua
    // disponível mesmo com o modo Subagentes desligado.
    planTools.read = createReadTool(planCtx)
    planTools.ls = createListTool(planCtx)
    planTools.glob = createGlobTool(planCtx)
    planTools.grep = createGrepTool(planCtx)
    // Delegar pesquisa a outro modelo é o que o modo Subagentes controla no
    // resto do app (allowDelegation em tools/index) — a orquestração era a
    // única exceção. Agora segue a mesma regra.
    if (ceiling.subagents) {
      planTools.subagent = createSubagentTool(input, planCtx, PLAN_SUBAGENT_MAX_STEPS, PLAN_SUBAGENT_MAX_CALLS)
    }

    // O teto entra no prompt: sem isso o modelo pede research/browser e só
    // descobre que não tem no retorno da tool, tarefa por tarefa.
    const enabled = Object.entries(ceiling).filter(([, v]) => v).map(([k]) => k)
    const contextNote = [
      `\n\nWorking folder: ${input.directory}. Every worker runs there, in code mode.`,
      enabled.length > 0
        ? `Modes the user enabled — workers may only use these: ${enabled.join(', ')}.`
        : 'The user enabled no optional modes: workers get the working folder and nothing else. Do not request research, browser, vision or subagents.',
      ceiling.subagents
        ? 'You also have the subagent tool for research while planning (3 calls max).'
        : 'You do NOT have subagents: research the project yourself with read/ls/glob/grep before splitting.',
    ].join('\n')
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
        prepareStep: reasoningPrepareStep(provider, input.modelId),
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
            throw part.error instanceof Error ? part.error : new Error(errorToText(part.error))
        }
      }
      return { text: text.trim(), usage: await stream.usage }
    }

    const firstPass = await runPlanningPass(baseMessages)
    let planUsage = toTokenUsage(firstPass.usage, cost)

    // Rede de segurança: o orquestrador às vezes narra "vou dividir em tarefas"
    // e para sem chamar create_task (plano vazio). Damos UMA cutucada explícita
    // antes de desistir e tratar como resposta trivial.
    //
    // Só cutuca quando ele REALMENTE prometeu um plano. Responder sem tarefas
    // agora é resultado legítimo — é o caminho 1 do prompt (pergunta simples,
    // ou oferta de "quer que eu implemente?"). Cutucar isso transformaria toda
    // conversa em plano, que é exatamente o que estamos consertando.
    if (tasks.length === 0 && firstPass.text && PROMISED_PLAN_RE.test(firstPass.text)) {
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
    // Sem loopConfig: a revisão não é mais um modo à parte com iterações
    // próprias — ela sempre roda, e o toggle Loop só decide o TAMANHO do
    // orçamento global de rodadas (ver a fase de revisão em approvePlan).
    pending.set(sessionId, { input, plan, assistantMessageId: assistantMessage.id })
    await persistPlan(win, sessionId, plan)
    emit(win, { type: 'message', sessionId, message: assistantMessage })
    emit(win, { type: 'status', sessionId, status: 'idle' })
  } catch (err) {
    const aborted = controller.signal.aborted
    const { kind, detail: message } = classifyProviderError(err)
    assistantMessage.error = aborted ? undefined : message
    assistantMessage.errorKind = aborted || kind === 'unknown' ? undefined : kind
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
            // Os modos vêm do plano: o orquestrador escolheu tarefa a tarefa,
            // dentro do teto da sessão. Antes `subagents: true` era fixo aqui,
            // ignorando tanto a escolha dele quanto o toggle do usuário.
            ...task.options,
            reasoning: workerModel?.reasoning,
            // Worker nunca orquestra — seria recursão.
            orchestrate: undefined,
            // Gatekeeping: worker herda o modo de permissões do orquestrador
            permissionMode: input.options.permissionMode,
          },
          directory: input.directory,
          extraDirectories: input.extraDirectories,
          // Visão só quando a tarefa pediu (e o usuário tinha modelo de visão)
          visionModel: task.vision ? input.visionModel : undefined,
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

    // ─── Fase 4: revisão pós-síntese ───────────────────────────────────
    // O orquestrador é chamado a cada iteração para decidir a ação:
    //   - "message_worker": envia follow-up a um worker existente
    //   - "create_worker": cria novo worker (continuação, teste, etc.)
    //   - "done": finaliza
    // Revisar passou a ser sempre parte do trabalho do orquestrador — antes só
    // acontecia com loopConfig. O que o modo Loop muda agora é o TAMANHO do
    // orçamento: desligado vale ORCHESTRATION_REVIEW_ROUNDS, ligado vale o
    // maxIterations do diálogo de Loop. Em ambos o orçamento é global, e
    // esperamos todos os workers terminarem antes de revisar — as revisões que
    // valem são as de integração, e essas só existem com tudo pronto.
    {
      // Com o modo Loop ligado o orçamento vem do diálogo de Loop (default 5);
      // sem ele, do teto próprio da orquestração (2).
      const reviewRounds =
        input.options.loop === true
          ? (input.loopConfig?.maxIterations ?? ORCHESTRATION_REVIEW_ROUNDS)
          : ORCHESTRATION_REVIEW_ROUNDS
      let iteration = 0
      // Rastreia workers existentes para reuso; a task carrega quantas rodadas
      // já foram gastas nele — o orçamento é global, mas mostrar o gasto por
      // worker evita que o orquestrador martele sempre o mesmo.
      const workerSessions = new Map(selected.map((t) => [t.workerSessionId!, { title: t.title, task: t }]))

      while (iteration < reviewRounds) {
        if (controller.signal.aborted) break

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
            return {
              sessionId: wsId,
              title: info.title,
              text: text.slice(0, 2000),
              error: last?.error,
              spent: info.task.revisions ?? 0,
            }
          }),
        )

        // Orquestrador decide o que fazer
        const workersBlock = workersStatus
          .map((w) => `## Worker "${w.title}" (sessionId: ${w.sessionId}, rounds already spent here: ${w.spent})\n${w.error ? `**ERROR**: ${w.error}\n` : ''}${w.text}`)
          .join('\n\n---\n\n')

        const { text: decisionText } = await generateText({
          model,
          system: `You are the Orbit orchestrator. The workers have finished. Review their results and decide the next action.`,
          messages: [
            { role: 'user', content: `## Original request\n${input.text}\n\n## Worker results\n${workersBlock}\n\n## Review round\n${iteration + 1} of ${reviewRounds} (budget shared across all workers)` },
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
- "message_worker": reuse an existing worker with new instructions — always prefer this over a new worker when the worker already has the context. It continues inside that worker's own chat, so it remembers what it did.
- "create_worker": create an additional worker to continue/expand
- "create_test_worker": create a worker to TEST what was implemented; if it finds errors, the next round can delegate the fix to the worker that implemented it
- You have a TOTAL budget of review rounds shared across all workers, and you decide where to spend it. "rounds already spent here" tells you how many went to each one — if a worker already took several and still isn't right, messaging it again is probably not the answer.
- Don't invent work to look busy. If the request was met, say "done" — an extra round costs the user money.`,
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
          // O orçamento é global (a condição do while) — aqui só registramos
          // onde ele foi gasto, para o orquestrador ver na próxima decisão que
          // já bateu neste worker N vezes e considerar outro caminho.
          wsInfo.task.revisions = (wsInfo.task.revisions ?? 0) + 1
          const followUp: ChatMessage = {
            id: newId('msg'),
            role: 'user',
            parts: [{ id: newId('prt'), type: 'text', text: `[Revisão ${iteration}] ${decision.reason}\n\n${decision.followUpPrompt ?? 'Continue o trabalho.'}`, state: 'done' }],
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
            // Mesmos modos que a tarefa recebeu no plano: a revisao continua a
            // conversa do worker, nao comeca outra. Antes era simple/subagents
            // fixos aqui, entao o worker trocava de modo no meio do proprio chat.
            options: {
              ...wsInfo.task.options,
              reasoning: input.workerModel?.reasoning,
              orchestrate: undefined,
              permissionMode: input.options.permissionMode,
            },
            directory: input.directory,
            extraDirectories: input.extraDirectories,
            visionModel: wsInfo.task.vision ? input.visionModel : undefined,
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
          // Task sintetica: existe para o worker do loop ter o mesmo contador de
          // revisoes dos workers do plano.
          const loopTask: OrchestrationTask = {
            id: newId('task'),
            title: loopWorker.title,
            prompt: decision.workerPrompt ?? decision.reason,
            options: {
              subagents: input.options.subagents === true,
              permissionMode: input.options.permissionMode,
            },
            status: 'idle',
            workerSessionId: loopWorker.id,
            revisions: 0,
          }
          workerSessions.set(loopWorker.id, { title: loopWorker.title, task: loopTask })
          emit(win, { type: 'session', sessionId: loopWorker.id, session: loopWorker })

          const wm = input.workerModel
          const lwInput: SendMessageInput = {
            sessionId: loopWorker.id,
            text: decision.workerPrompt ?? decision.reason,
            providerId: wm?.providerId ?? input.providerId,
            modelId: wm?.modelId ?? input.modelId,
            mode: loopWorker.mode,
            // Sem modos extras alem do que a sessao permite — `subagents: true`
            // fixo aqui ignorava o toggle do usuario, o mesmo problema que os
            // workers do plano tinham.
            options: {
              ...loopTask.options,
              reasoning: wm?.reasoning,
              orchestrate: undefined,
              permissionMode: input.options.permissionMode,
            },
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

        // Salva `history`, nao um reload: as parts da revisao sao empurradas
        // no synthesisMessage em memoria, e esse objeto vive dentro de
        // `history`. Um loadMessages aqui traria uma COPIA sem elas, e gravar
        // essa copia apagava do disco tudo que a revisao escreveu.
        await saveMessages(sessionId, history)
      }
      activeWorkers.delete(sessionId)
    }

    emit(win, { type: 'status', sessionId, status: 'idle' })
  } catch (err) {
    const aborted = controller.signal.aborted
    const message = errorToText(err)
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
