import { stepCountIs, streamText, type ModelMessage, type ToolSet } from 'ai'
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
import { StorageKeys, normalizeOrchestrationSettings } from '@shared/chat'
import { getProvider } from './catalog'
import { abortChat, runChat, toModelMessages } from './chat-engine'
import { forwardChatEvent } from './companion-server'
import { classifyProviderError, errorToText, isRecoverableErrorKind } from './errors'
import { hasStreamedContent, resolveRotation } from './model-rotation'
import { conductorInput } from './orchestrator-conductor'
import { ORCHESTRATOR_PLAN_PROMPT, ORCHESTRATOR_SYNTHESIS_PROMPT } from './prompts'
import { resolveModel } from './providers'
import { withProviderSession } from './provider-session'
import { buildProviderOptions, interleavedReasoningField, normalizeMessages, reasoningPrepareStep } from './reasoning'
import { readJson, writeJson } from './storage'
import { createSubagentTool, createTaskTool } from './tools/orchestration'
import type { TaskModeCeiling } from './tools/orchestration'
import { createGlobTool, createGrepTool, createListTool, createReadTool } from './tools/files'
import { createQuestionTool } from './tools/question'
import { buildWorkersNotice, createWorkerTools, loadWorkers } from './tools/workers'
import type { ToolContext } from './tools/context'
import { addTokenUsage, toTokenUsage } from './usage'
import { getWorkerConfigCache } from './companion-http'
import { executarPlano } from './orquestra/execucao'
import { revisarComModelo } from './orquestra/revisor'
import { descobrirVerificacoes, rodarVerificacao } from './orquestra/verificacoes'
import {
  commitarTrabalho,
  criarWorktreeDoWorker,
  diffDoWorktree,
  juntarBranches,
  removerWorktreeDoWorker,
  repositorioDoChat,
} from './orquestra/worktrees'
import { raizDoRepositorio } from './worktrees/nucleo'

/**
 * OrchestratorEngine (modo Orchestra), em quatro fases:
 * 1. Triagem + planejamento: o orquestrador decide se o pedido é conversa
 *    (responde direto), ambiguidade (usa a tool question) ou trabalho — e só
 *    aí divide em create_task. O plano é proposto ao usuário (semi-auto).
 * 2. Execução: cada tarefa aprovada vira uma session filha real (persistida,
 *    aparece na sidebar/painel), sempre em modo código, com os modos que o
 *    orquestrador escolheu para ela dentro do teto da sessão do usuário.
 * 3. Acompanhamento (orquestra/execucao.ts): cada worker que termina é revisado
 *    pelo orquestrador enquanto os outros seguem; ele aceita, pede ajuste, marca
 *    falha ou cria worker extra, dentro do orçamento "ajustes por worker" das
 *    configurações da Orquestra. Dependências entre tarefas e, opcionalmente,
 *    um worktree por worker (juntado no fim).
 * 4. Síntese: o orquestrador consolida os resultados na resposta final.
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
/** Resposta do retry que diz "a primeira resposta já estava certa". */
const NO_PLAN_SENTINEL = '<<NO_PLAN>>'

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

/** Comparação de títulos de worker: "Tela de Login " e "tela de login" são o mesmo nome na sidebar. */
function normalizeTitle(title: string) {
  return title.trim().replace(/\s+/g, ' ').toLowerCase()
}

function newId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

/** Mesmo funil do chat-engine: janela + companions. Sem o forward, todo o
 *  fluxo de orquestracao (stream do planejamento, card do plano, progresso das
 *  tasks, status) so existia no desktop — no celular o card de aprovacao so
 *  aparecia se a conversa fosse reaberta, e nunca atualizava ao vivo. */
function emit(win: BrowserWindow, event: ChatEvent) {
  if (!win.isDestroyed()) win.webContents.send('chat:event', event)
  forwardChatEvent(event)
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

/**
 * Um turno num worker que já existe: a mensagem entra no chat dele (que
 * lembra o que fez e o que o usuário disse lá) com os mesmos modos que ele
 * recebeu do plano. Usado pela revisão e pela tool message_worker.
 */
async function runWorkerTurn(
  win: BrowserWindow,
  input: SendMessageInput,
  worker: SessionInfo,
  text: string,
): Promise<{ text: string; error?: string; tokens?: ChatMessage['tokens'] }> {
  const orchestratorId = input.sessionId
  const workers = activeWorkers.get(orchestratorId) ?? []
  activeWorkers.set(orchestratorId, [...workers, worker.id])
  try {
    await runChat(win, {
      sessionId: worker.id,
      text,
      providerId: input.workerModel?.providerId ?? input.providerId,
      modelId: input.workerModel?.modelId ?? input.modelId,
      mode: 'code',
      options: {
        ...worker.orchestration?.options,
        reasoning: input.workerModel?.reasoning,
        // Worker nunca orquestra — seria recursão.
        orchestrate: undefined,
        // Gatekeeping: worker herda o modo de permissões do orquestrador (e se
        // segue o seletor global — a troca no meio vale para ele também)
        permissionMode: input.options.permissionMode,
        followGlobalPermission: input.options.followGlobalPermission,
      },
      directory: worker.directory ?? input.directory,
      extraDirectories: worker.extraDirectories ?? input.extraDirectories,
      visionModel: worker.orchestration?.vision ? input.visionModel : undefined,
      orchestrationRole: 'worker',
      parentSessionId: orchestratorId,
      workerTitle: worker.title,
      language: input.language,
    })
  } finally {
    const rest = (activeWorkers.get(orchestratorId) ?? []).filter((id) => id !== worker.id)
    if (rest.length > 0) activeWorkers.set(orchestratorId, rest)
    else activeWorkers.delete(orchestratorId)
  }
  const messages = await loadMessages(worker.id)
  const last = [...messages].reverse().find((m) => m.role === 'assistant')
  const reply = last?.parts
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim() ?? ''
  return { text: reply, error: last?.error, tokens: last?.tokens }
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
  return withProviderSession(input.sessionId, () => runOrchestrationTurn(win, input))
}

async function runOrchestrationTurn(win: BrowserWindow, input: SendMessageInput): Promise<void> {
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

  const conductor = conductorInput(input)
  const assistantMessage: ChatMessage = {
    id: newId('msg'),
    role: 'assistant',
    parts: [],
    createdAt: Date.now(),
    providerId: conductor.providerId,
    modelId: conductor.modelId,
  }
  history.push(assistantMessage)
  await saveMessages(sessionId, history)
  emit(win, { type: 'message', sessionId, message: assistantMessage })

  // Rotação de modelos (mesma regra do chat-engine): rotação escolhida no
  // seletor para este chat; senão o modelo pinado; senão o default — com o
  // primeiro modelo como ponto de partida do loop abaixo. Um modelo de
  // orquestra configurado vale por si: a rotação é do modelo do chat.
  const rotationSequence = input.orchestratorModel
    ? [{ providerId: conductor.providerId, modelId: conductor.modelId }]
    : resolveRotation(input.sessionId, {
        providerId: input.providerId,
        modelId: input.modelId,
      })
  const primaryModel = rotationSequence[0] ?? { providerId: conductor.providerId, modelId: conductor.modelId }

  // Aviso automático: workers que já existem e o que o usuário mandou direto
  // neles desde o último turno do orquestrador (a resposta anterior dele).
  const lastOrchestratorTurn = history.slice(0, -2).reverse().find((m) => m.role === 'assistant')
  const workersNotice = await buildWorkersNotice(sessionId, lastOrchestratorTurn?.createdAt ?? 0)
  const existingTitles = new Set((await loadWorkers(sessionId)).map((w) => normalizeTitle(w.title)))

  try {
    // Loop de tentativas do PLANEJAMENTO: falha recuperável antes do primeiro
    // token troca para o próximo modelo da sequência (os workers já herdam a
    // rotação pelo runChat; a síntese/revisão seguem o comportamento atual).
    let attemptIndex = 0
    for (;;) {
      const primary = rotationSequence[attemptIndex] ?? primaryModel
      assistantMessage.providerId = primary.providerId
      assistantMessage.modelId = primary.modelId
      assistantMessage.parts = []
      assistantMessage.error = undefined
      assistantMessage.errorKind = undefined
      emit(win, { type: 'message', sessionId, message: assistantMessage })
      try {
        const model = await resolveModel(primary.providerId, primary.modelId)
        emit(win, { type: 'status', sessionId, status: 'streaming' })

    const tasks: OrchestrationTask[] = []
    let workersMessaged = 0
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
      create_task: createTaskTool(
        (task) => {
          if (tasks.length >= MAX_TASKS) return false
          tasks.push(task)
          return true
        },
        ceiling,
        (title) => {
          const key = normalizeTitle(title)
          return existingTitles.has(key) || tasks.some((t) => normalizeTitle(t.title) === key)
        },
        (title) => tasks.find((t) => normalizeTitle(t.title) === normalizeTitle(title))?.id,
      ),
      // Perguntar antes de dividir: só vale quando a resposta muda o plano,
      // mas sem a tool ele não tinha como fazer isso nem quando valia.
      question: createQuestionTool(input, controller.signal),
      // Workers de qualquer plano desta conversa: ver, ler e continuar. Sem
      // isso o único caminho era create_task — sempre um worker novo, que
      // não sabe nada do que os anteriores fizeram.
      ...createWorkerTools(sessionId, async (worker, message) => {
        workersMessaged++
        return runWorkerTurn(win, input, worker, message)
      }),
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
    ].join('\n') + workersNotice
    const provider = await getProvider(primary.providerId)
    const baseMessages = normalizeMessages(
      toModelMessages(history.slice(0, -1)),
      interleavedReasoningField(provider, primary.modelId),
    )
    const providerOptions = await buildProviderOptions({ ...conductor, providerId: primary.providerId, modelId: primary.modelId })
    const cost = provider?.models[primary.modelId]?.cost

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
        prepareStep: reasoningPrepareStep(provider, primary.modelId),
        onError: () => { /* tratado no loop do fullStream */ },
      })
      let text = ''
      const reasoningStart = new Map<string, number>()
      // Ids de stream → id da part (mesma regra do chat-engine). O SDK reusa
      // "txt-0"/"reasoning-0" a cada passo E a cada passada: sem isso a
      // passada da cutucada sobrescrevia o texto da primeira (a resposta
      // "cortava" no meio) e o filtro de texto velho apagava as duas.
      const streamIds = new Map<string, string>()
      const startStreamPart = (sdkId: string): string => {
        let id = sdkId
        for (let n = 1; assistantMessage.parts.some((p) => p.id === id); n++) id = `${sdkId}~${n}`
        streamIds.set(sdkId, id)
        return id
      }
      const streamPartId = (sdkId: string): string => streamIds.get(sdkId) ?? sdkId
      for await (const part of stream.fullStream) {
        switch (part.type) {
          case 'text-start':
            upsertPart(win, sessionId, assistantMessage, { id: startStreamPart(part.id), type: 'text', text: '', state: 'streaming' })
            break
          case 'text-delta': {
            const existing = assistantMessage.parts.find((p) => p.id === streamPartId(part.id))
            if (existing?.type === 'text') {
              existing.text += part.text
              text += part.text
              emit(win, { type: 'part-delta', sessionId, messageId: assistantMessage.id, partId: existing.id, kind: 'text', delta: part.text })
            }
            break
          }
          case 'text-end': {
            const existing = assistantMessage.parts.find((p) => p.id === streamPartId(part.id))
            if (existing?.type === 'text') upsertPart(win, sessionId, assistantMessage, { ...existing, state: 'done' })
            break
          }
          case 'reasoning-start':
            reasoningStart.set(part.id, Date.now())
            upsertPart(win, sessionId, assistantMessage, { id: startStreamPart(part.id), type: 'reasoning', text: '', state: 'streaming' })
            break
          case 'reasoning-delta': {
            const existing = assistantMessage.parts.find((p) => p.id === streamPartId(part.id))
            if (existing?.type === 'reasoning') {
              existing.text += part.text
              emit(win, { type: 'part-delta', sessionId, messageId: assistantMessage.id, partId: existing.id, kind: 'reasoning', delta: part.text })
            }
            break
          }
          case 'reasoning-end': {
            const existing = assistantMessage.parts.find((p) => p.id === streamPartId(part.id))
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
    // Quem continuou a conversa de um worker já agiu — não é plano vazio.
    if (tasks.length === 0 && workersMessaged === 0 && firstPass.text && PROMISED_PLAN_RE.test(firstPass.text)) {
      const firstPassIds = new Set(assistantMessage.parts.map((p) => p.id))
      const nudgeMessages: ModelMessage[] = [
        ...baseMessages,
        { role: 'assistant', content: firstPass.text },
        {
          role: 'user',
          content:
            `[Engine check, not the user] Your reply mentioned splitting the work but no task was registered. If the request needs to be split, call create_task NOW for each subtask. If your previous reply was already the right answer (a question answered, or work only offered), reply with exactly ${NO_PLAN_SENTINEL} and nothing else. Otherwise, answer directly without promising a plan.`,
        },
      ]
      const retry = await runPlanningPass(nudgeMessages)
      planUsage = addTokenUsage(planUsage, toTokenUsage(retry.usage, cost))
      if (tasks.length === 0) {
        if (retry.text.includes(NO_PLAN_SENTINEL) || !retry.text) {
          // Falso positivo da regex: a primeira resposta vale. Descarta tudo
          // da cutucada (texto e raciocínio) — senão o usuário via o modelo
          // discutindo uma mensagem interna que ele nunca mandou.
          assistantMessage.parts = assistantMessage.parts.filter((p) => firstPassIds.has(p.id))
        } else {
          // A resposta final é a do retry — descarta a narração do primeiro
          // passe pra não duplicar texto na bolha final do usuário.
          assistantMessage.parts = assistantMessage.parts.filter((p) => p.type !== 'text' || !firstPassIds.has(p.id))
        }
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
        break
      } catch (err) {
        const aborted = controller.signal.aborted
        const { kind } = classifyProviderError(err)
        const nextIndex = attemptIndex + 1
        if (
          !aborted &&
          !hasStreamedContent(assistantMessage.parts) &&
          isRecoverableErrorKind(kind) &&
          nextIndex < rotationSequence.length
        ) {
          attemptIndex = nextIndex
          emit(win, {
            type: 'status',
            sessionId,
            status: 'fallback',
            fallback: { current: nextIndex + 1, total: rotationSequence.length },
          })
          continue
        }
        throw err
      }
    }
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
  return withProviderSession(sessionId, () => approvePlanTurn(win, sessionId, planId, taskIds))
}

async function approvePlanTurn(
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

    // Configuração vigente (diálogo da Orquestra, via cache que o renderer
    // empurra). Fica no plano: o card mostra o orçamento, e um plano em
    // andamento não muda de comportamento se o usuário mexer no diálogo.
    const config = normalizeOrchestrationSettings(getWorkerConfigCache().orchestration)
    plan.config = config
    // Worktree por worker só faz sentido num repositório git.
    const repoDoChat = config.worktrees ? await repositorioDoChat(input.directory!) : null

    // Tarefas fora da seleção não rodam — e dependência delas deixa de existir.
    const ids = new Set(selected.map((t) => t.id))
    for (const t of selected) if (t.dependeDe) t.dependeDe = t.dependeDe.filter((id) => ids.has(id))
    plan.tasks = selected

    // Sessões filhas dos workers. Registra cada worker em activeWorkers JÁ NA
    // CRIAÇÃO — um abort nesta janela precisa alcançá-los.
    activeWorkers.set(sessionId, [])
    const workerSessions = new Map<string, SessionInfo>()
    const criarSessao = async (task: OrchestrationTask): Promise<SessionInfo> => {
      const now = Date.now()
      const worker: SessionInfo = {
        id: newId('ses'),
        title: task.title,
        mode: 'code',
        pinned: false,
        archived: false,
        folderId: null,
        directory: input.directory,
        extraDirectories: input.extraDirectories,
        // Os modos vêm do plano: o orquestrador escolheu tarefa a tarefa,
        // dentro do teto da sessão. Ficam na sessão para quem continuar a
        // conversa depois (revisão, message_worker) usar os mesmos.
        orchestration: { role: 'worker', parentSessionId: sessionId, task: task.title, options: task.options, vision: task.vision },
        parentId: sessionId,
        createdAt: now,
        updatedAt: now,
      }
      await writeJson(StorageKeys.session(worker.id), worker)
      workerSessions.set(task.id, worker)
      task.workerSessionId = worker.id
      activeWorkers.get(sessionId)?.push(worker.id)
      emit(win, { type: 'session', sessionId: worker.id, session: worker })
      return worker
    }
    // Todos aparecem na sidebar desde já, mesmo os que esperam dependência.
    for (const task of selected) await criarSessao(task)

    plan.status = 'running'
    await persistPlan(win, sessionId, plan)
    emit(win, { type: 'status', sessionId, status: 'streaming' })

    // Gravações em fila: workers e revisões mudam o plano o tempo todo, e duas
    // escritas simultâneas no mesmo arquivo se atropelariam.
    let gravacoes = Promise.resolve()
    const persistir = () => {
      gravacoes = gravacoes.then(() => persistPlan(win, sessionId, plan)).catch(() => {})
      return gravacoes
    }

    // O revisor é o condutor (o mesmo modelo do planejamento e da síntese).
    const revisor = conductorInput(input)
    const revisorModel = await resolveModel(revisor.providerId, revisor.modelId)
    const revisorProvider = await getProvider(revisor.providerId)
    const revisorOptions = await buildProviderOptions(revisor)
    const raizRepo = await raizDoRepositorio(input.directory!).catch(() => undefined)

    const diffDaTarefa = async (task: OrchestrationTask): Promise<string> => {
      if (task.worktree) return diffDoWorktree(task.worktree)
      // Sem worktree: os snapshots dos turnos do worker. Na pasta compartilhada
      // podem incluir mudanças de outros workers rodando ao mesmo tempo — o
      // revisor é avisado disso no prompt.
      if (!task.workerSessionId) return ''
      const msgs = await loadMessages(task.workerSessionId)
      return msgs
        .filter((m) => m.role === 'assistant' && m.snapshot?.patch)
        .map((m) => `${(m.snapshot!.files ?? []).map((f) => `- ${f}`).join('\n')}\n${m.snapshot!.patch}`)
        .join('\n\n')
    }

    const workerResultados = await executarPlano({
      plan,
      config,
      signal: controller.signal,
      opcoesExtra: { subagents: input.options.subagents === true },
      persistir,
      rodarWorker: async (task, texto) => {
        const worker = workerSessions.get(task.id) ?? (await criarSessao(task))
        const r = await runWorkerTurn(win, input, worker, texto)
        // Cada turno (o primeiro e os ajustes) entra no custo do plano.
        if (r.tokens) plan.usage = addTokenUsage(plan.usage, r.tokens)
        return r
      },
      prepararTarefa: repoDoChat
        ? async (task) => {
            const worker = workerSessions.get(task.id) ?? (await criarSessao(task))
            const dependencias = (task.dependeDe ?? [])
              .map((id) => plan.tasks.find((t) => t.id === id)?.worktree)
              .filter((w): w is NonNullable<OrchestrationTask['worktree']> => !!w)
            const { worktree, avisos } = await criarWorktreeDoWorker({ pastaDoChat: input.directory!, planId: plan.id, task, dependencias })
            task.worktree = worktree
            // A sessão do worker passa a trabalhar no worktree dele.
            const next = { ...worker, directory: worktree.pasta, updatedAt: Date.now() }
            await writeJson(StorageKeys.session(next.id), next)
            workerSessions.set(task.id, next)
            emit(win, { type: 'session', sessionId: next.id, session: next })
            return [
              `You work in an isolated git worktree (${worktree.pasta}) on branch ${worktree.branch}, created from ${worktree.base}. Other workers have their own. You don't need to commit: the orchestrator commits your work when it is accepted and merges it at the end.`,
              ...avisos,
            ]
          }
        : undefined,
      aoAceitar: repoDoChat
        ? async (task) => {
            if (task.worktree) await commitarTrabalho(task.worktree, task.title).catch(() => {})
          }
        : undefined,
      revisar:
        config.comportamento === 'orquestrar'
          ? undefined
          : (pedido, acoes) =>
              revisarComModelo(
                {
                  model: revisorModel,
                  providerOptions: revisorOptions,
                  prepareStep: reasoningPrepareStep(revisorProvider, revisor.modelId),
                  pedidoOriginal: input.text,
                  plan,
                  config,
                  signal: controller.signal,
                  diff: diffDaTarefa,
                  verificacoes: (task) => descobrirVerificacoes(task.worktree?.pasta ?? input.directory!, task.worktree?.caminho ?? raizRepo),
                  rodarVerificacao: (_task, v) => rodarVerificacao(v, controller.signal),
                  aoUsar: (usage) => {
                    plan.usage = addTokenUsage(plan.usage, toTokenUsage(usage as Parameters<typeof toTokenUsage>[0], revisorProvider?.models[revisor.modelId]?.cost))
                  },
                },
                pedido,
                acoes,
              ),
    })
    activeWorkers.delete(sessionId)

    // Abort durante a execução: workers já pararam, não faz sentido sintetizar
    if (controller.signal.aborted) {
      plan.status = 'done'
      await persistPlan(win, sessionId, plan)
      emit(win, { type: 'status', sessionId, status: 'idle' })
      return
    }

    // Worktrees: junta no chat o trabalho aceito, dependências antes.
    if (repoDoChat) await juntarTrabalho(win, sessionId, plan, input.directory!)

    // Fase 3: síntese em streaming no chat principal
    const history = await loadMessages(sessionId)
    const conductor = conductorInput(input)
    const synthesisMessage: ChatMessage = {
      id: newId('msg'),
      role: 'assistant',
      parts: [],
      createdAt: Date.now(),
      providerId: conductor.providerId,
      modelId: conductor.modelId,
    }
    history.push(synthesisMessage)
    emit(win, { type: 'message', sessionId, message: synthesisMessage })

    const resultsText = plan.tasks
      .map((t) => {
        const estado = t.fase === 'aceita' ? 'accepted' : t.fase === 'falhou' ? 'FAILED' : t.fase ?? 'unknown'
        const nota = t.notaRevisao ? `\nOrchestrator note: ${t.notaRevisao}` : ''
        const texto = workerResultados.get(t.id)?.text || '(no reply)'
        return `## ${t.title}${t.extra ? ' (extra)' : ''} [${estado}${t.revisions ? `, ${t.revisions} adjustment(s)` : ''}]${nota}\n\n${texto}`
      })
      .join('\n\n---\n\n') + (plan.revisao?.merge ? `\n\n---\n\nMerge of the workers' branches: ${plan.revisao.merge.detalhe}` : '')

    const model = await resolveModel(conductor.providerId, conductor.modelId)
    const provider = await getProvider(conductor.providerId)
    const stream = streamText({
      model,
      system: ORCHESTRATOR_SYNTHESIS_PROMPT,
      messages: [
        ...normalizeMessages(
          toModelMessages(history.slice(0, -1)),
          interleavedReasoningField(provider, conductor.modelId),
        ),
        { role: 'user', content: `Worker results:\n\n${resultsText}` },
      ],
      abortSignal: controller.signal,
      providerOptions: await buildProviderOptions(conductor),
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
    synthesisMessage.tokens = toTokenUsage(await stream.usage, provider?.models[conductor.modelId]?.cost)
    plan.usage = addTokenUsage(plan.usage, synthesisMessage.tokens)
    await saveMessages(sessionId, history)

    const session = await readJson<SessionInfo>(StorageKeys.session(sessionId))
    if (session) await writeJson(StorageKeys.session(sessionId), { ...session, updatedAt: Date.now() })

    plan.status = 'done'
    await persistPlan(win, sessionId, plan)
    emit(win, { type: 'message', sessionId, message: synthesisMessage })

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

/** Tarefas em ordem de dependência (pré-requisitos antes) — a ordem do merge. */
function ordemDeDependencia(tasks: OrchestrationTask[]): OrchestrationTask[] {
  const ordem: OrchestrationTask[] = []
  const vistos = new Set<string>()
  const visitar = (t: OrchestrationTask) => {
    if (vistos.has(t.id)) return
    vistos.add(t.id)
    for (const id of t.dependeDe ?? []) {
      const dep = tasks.find((x) => x.id === id)
      if (dep) visitar(dep)
    }
    ordem.push(t)
  }
  for (const t of tasks) visitar(t)
  return ordem
}

/**
 * Junta no chat os branches das tarefas aceitas que ainda não entraram, em
 * ordem de dependência. O resultado fica no plano (card + síntese); se algo
 * ficou de fora (alteração não commitada no chat, conflito, erro do git), o
 * card oferece "Juntar de novo".
 */
async function juntarTrabalho(win: BrowserWindow, sessionId: string, plan: OrchestrationPlan, pastaDoChat: string): Promise<void> {
  const aceitas = ordemDeDependencia(plan.tasks).filter((t) => t.fase === 'aceita' && t.worktree && !t.juntada)
  if (aceitas.length === 0) return
  const revisao = plan.revisao ?? { ajustesUsados: 0, tetoAjustes: 0 }
  plan.revisao = { ...revisao, atividade: 'Juntando o trabalho dos workers' }
  await persistPlan(win, sessionId, plan)

  const r = await juntarBranches(pastaDoChat, aceitas.map((t) => ({ titulo: t.title, worktree: t.worktree! })))
  for (const t of aceitas) {
    if (!r.juntados.includes(t.title)) continue
    t.juntada = true
    await removerWorktreeDoWorker(t.worktree!, true).catch(() => {})
  }
  const faltam = aceitas.filter((t) => !t.juntada)
  const resumo = `${r.juntados.length} de ${aceitas.length} juntado(s)`
  const detalhe = r.bloqueio
    ? `Nada foi juntado: a pasta do chat tem alterações não commitadas em arquivos que os workers mudaram (${r.bloqueio.arquivos.join(', ')}). Commite ou guarde (git stash) e use "Juntar de novo".`
    : r.conflito
      ? `Conflito ao juntar "${r.conflito.titulo}"${r.conflito.arquivos.length ? ` (${r.conflito.arquivos.join(', ')})` : ''}. ${resumo}; o restante continua nos branches dos workers. Resolva no chat e use "Juntar de novo", ou junte os branches à mão.`
      : r.erro
        ? `O git recusou juntar "${r.erro.titulo}": ${r.erro.mensagem}. ${resumo}; use "Juntar de novo" depois de resolver.`
        : `${r.juntados.length} branch(es) juntado(s) no chat.`
  plan.revisao = { ...plan.revisao, atividade: undefined, merge: { ok: faltam.length === 0, detalhe, pendente: faltam.length > 0 } }
  await persistPlan(win, sessionId, plan)
}

/**
 * "Juntar de novo" (card da orquestração): tenta de novo juntar o trabalho
 * aceito que ficou de fora — depois de o usuário commitar/guardar as
 * alterações do chat ou resolver um conflito.
 */
export async function juntarDeNovo(win: BrowserWindow, sessionId: string): Promise<void> {
  if (controllers.has(sessionId)) return // o plano ainda está rodando
  const plan = await readJson<OrchestrationPlan>(StorageKeys.orchestration(sessionId))
  const session = await readJson<SessionInfo>(StorageKeys.session(sessionId))
  if (!plan || !session?.directory) return
  await juntarTrabalho(win, sessionId, plan, session.directory)
}
