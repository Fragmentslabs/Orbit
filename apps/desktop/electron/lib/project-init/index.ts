import { BrowserWindow } from 'electron'
import type { InitEvent, InitStage, Memory } from '@shared/memory'
import { normalizeDirectory } from '../memory/domain'
import * as memoryService from '../memory/service'
import { resolveModel } from '../providers'
import { withProviderSession } from '../provider-session'
import { commitDraft, type CommitResult } from './commit'
import { DEFAULT_EXPLORER_BUDGET, runCoordinator, type CoordinatorHooks } from './coordinator'
import { validateDraft, type ExistingTree } from './draft'
import { describeScan, scanProject } from './scanner'

/**
 * /init: um coordenador autônomo analisa o projeto e monta um RASCUNHO da
 * árvore de memórias (ver coordinator.ts e draft.ts); só no fim, com o
 * rascunho revisado, tudo é gravado de uma vez.
 *
 * A versão anterior era um pipeline fixo: um planejador que não lia nada
 * escolhia no mínimo três "áreas" por escopo, e o código repetia isso para a
 * raiz e para cada subprojeto — num monorepo, 20 a 30 agentes, e memórias
 * genéricas que custavam tokens em todo chat seguinte. Agora quem decide
 * forma, profundidade e quantos exploradores usar é um agente que viu o
 * projeto; o código só impõe os limites e a consistência da árvore.
 */

const running = new Set<string>()
/**
 * Controlador por pasta — é o que dá ao botão de parar algum efeito sobre a
 * análise. Sem ele, abortar a sessão de chat encerrava só a UI e os agentes
 * seguiam rodando até o fim.
 */
const initAborts = new Map<string, AbortController>()

/** Erro de cancelamento — distinguido do erro real para a UI não gritar falha. */
export class InitAbortedError extends Error {
  constructor() {
    super('Análise cancelada.')
    this.name = 'InitAbortedError'
  }
}

export function isInitAborted(err: unknown): boolean {
  return (
    err instanceof InitAbortedError ||
    (err instanceof Error && (err.name === 'AbortError' || err.name === 'InitAbortedError'))
  )
}

/** Cancela a análise em andamento de uma pasta. Idempotente. */
export function abortProjectInit(directory: string): boolean {
  const controller = initAborts.get(directory)
  if (!controller) return false
  controller.abort()
  return true
}

/** Nome do idioma (em inglês, ex.: "Portuguese") vindo da preferência do
 * usuário — cai em "Portuguese" quando ausente (comportamento histórico do
 * /init antes desse campo existir). */
function outputLanguage(language?: string): string {
  return language ?? 'Portuguese'
}

function emit(stage: InitStage, data: Partial<InitEvent>) {
  const event: InitEvent = { directory: '', stage, ...data } as InitEvent
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('init:event', event)
  }
}

/** Callbacks de UI: o chat-engine transforma em parts (acordeons) da mensagem. */
export type InitHooks = CoordinatorHooks

export interface RunInitInput {
  directory: string
  providerId: string
  modelId: string
  workerProviderId?: string
  workerModelId?: string
  /** Mantido por compatibilidade com "/init --force": a análise sempre parte da árvore existente. */
  force?: boolean
  /** Exploradores em paralelo (1-6, padrão 3). */
  concurrency?: number
  hooks?: InitHooks
  /** Idioma preferido do usuário (nome em inglês, ex.: "Portuguese"). */
  language?: string
  /**
   * Cancelamento externo. O /init roda dentro de uma sessão de chat, então o
   * botão de parar aborta o controller da sessão — este signal é o que leva
   * esse aborto até os agentes.
   */
  signal?: AbortSignal
}

export interface InitResult extends CommitResult {
  /** Palavra final do coordenador para o usuário. */
  note?: string
  explorers: number
  /** O coordenador parou sem chamar finish (limite de passos ou só parou) — o rascunho, se consistente, foi gravado assim mesmo. */
  unfinished: boolean
}

function treeText(nodes: memoryService.TreeNodeSummary[]): string {
  return nodes
    .map((n) => {
      const indent = '  '.repeat(Math.min(n.depth, 6))
      const tag = n.area ? `[${n.area}]` : n.category ? `[${n.category}]` : ''
      const sub = n.subproject ? ` (pasta ${n.subproject})` : ''
      const text = n.text.length > 160 ? `${n.text.slice(0, 160)}…` : n.text
      return `${indent}#${n.id} ${tag}${sub} ${text}`
    })
    .join('\n')
}

export async function runProjectInit(input: RunInitInput): Promise<InitResult> {
  return withProviderSession(`init:${input.directory}`, () => runProjectInitInterna(input))
}

async function runProjectInitInterna(input: RunInitInput): Promise<InitResult> {
  const { directory } = input
  const hooks = input.hooks ?? {}
  const main = (text: string) => hooks.onMainDelta?.(text)

  // Pasta já coberta por um projeto acima: a análise trabalha na árvore dele,
  // com foco na subpasta. Criar uma árvore separada para "front" esconderia
  // a da pasta mãe (o projeto mais próximo vence) e partiria o contexto.
  const scope = await memoryService.resolveProjectScope(directory)
  const rootDirectory = scope.directory
  const runKey = normalizeDirectory(rootDirectory)
  if (running.has(runKey)) {
    throw new Error('Já existe uma análise em andamento para este projeto.')
  }
  running.add(runKey)

  // Um controller próprio por pasta, encadeado ao signal externo quando existe.
  // O externo cobre o /init disparado dentro de uma sessão de chat (o botão de
  // parar aborta a sessão); o registro cobre o init:stop vindo do card, que
  // roda fora de qualquer sessão.
  const controller = new AbortController()
  const signal = controller.signal
  initAborts.set(directory, controller)
  const onExternalAbort = () => controller.abort()
  if (input.signal) {
    if (input.signal.aborted) controller.abort()
    else input.signal.addEventListener('abort', onExternalAbort, { once: true })
  }

  try {
    emit('scanning', { directory })
    main('Escaneando a estrutura do projeto…\n')
    const scan = await scanProject(rootDirectory)
    const scanDescription = describeScan(scan)
    if (signal.aborted) throw new InitAbortedError()

    const model = await resolveModel(input.providerId, input.modelId)
    const workerProviderId = input.workerProviderId ?? input.providerId
    const workerModelId = input.workerModelId ?? input.modelId
    const workerModel = await resolveModel(workerProviderId, workerModelId)

    const members = (await memoryService.list()).filter(
      (m: Memory) => m.kind === 'project' && m.projectId === scope.projectId && (m.expiresAt == null || m.expiresAt > Date.now()),
    )
    const existing: ExistingTree = {
      ids: new Set(members.map((m) => m.id)),
      // Só um overview de verdade é raiz: sem ele, a árvore nova nasce com raiz
      // própria em vez de "atualizar" uma memória qualquer de maior peso.
      rootId: members.find((m) => m.area === 'overview' && !m.subproject)?.id,
    }
    const existingTreeText = members.length ? treeText(await memoryService.tree(scope.projectId)) : undefined
    if (members.length) main(`O projeto já tem ${members.length} memória(s); a análise parte delas.\n`)

    emit('exploring', { directory, progress: { done: 0, total: 0 } })
    const coordination = await runCoordinator({
      directory: rootDirectory,
      scanDescription,
      existingTreeText,
      existing,
      focus: scope.covered ? scope.subproject : undefined,
      model,
      providerId: input.providerId,
      modelId: input.modelId,
      workerModel,
      workerProviderId,
      workerModelId,
      explorerBudget: DEFAULT_EXPLORER_BUDGET,
      concurrency: Math.max(1, Math.min(input.concurrency ?? 3, 6)),
      language: outputLanguage(input.language),
      hooks: {
        ...hooks,
        onProgress: (done, total) => {
          hooks.onProgress?.(done, total)
          emit('exploring', { directory, progress: { done, total } })
        },
      },
      signal,
    })
    if (signal.aborted) throw new InitAbortedError()

    const { draft } = coordination
    const empty = draft.nodes.size === 0 && draft.learnings.length === 0 && draft.retired.size === 0
    const issues = validateDraft(draft, existing)
    if (empty || issues.length) {
      if (issues.length) {
        main(`\nO rascunho não ficou consistente, então nada foi gravado:\n${issues.map((i) => `- ${i}`).join('\n')}\n`)
      }
      emit('done', { directory, areas: [] })
      return {
        saved: false,
        created: 0,
        updated: 0,
        retired: 0,
        learnings: 0,
        titles: [],
        note: coordination.note,
        explorers: coordination.explorersUsed,
        unfinished: !coordination.finished,
      }
    }

    emit('saving', { directory })
    main('\nGravando a árvore de memórias…\n')
    const committed = await commitDraft(draft, { rootDirectory, existing })
    emit('done', { directory, areas: committed.saved ? ['overview'] : [] })
    return {
      ...committed,
      note: coordination.note,
      explorers: coordination.explorersUsed,
      unfinished: !coordination.finished,
    }
  } catch (err) {
    // Cancelar não é falhar: o evento sai como "done" sem áreas para a UI
    // encerrar o progresso em vez de exibir um erro que o usuário provocou.
    if (isInitAborted(err) || signal.aborted) {
      emit('done', { directory, areas: [] })
      throw new InitAbortedError()
    }
    emit('error', { directory, error: err instanceof Error ? err.message : String(err) })
    throw err
  } finally {
    running.delete(runKey)
    if (initAborts.get(directory) === controller) initAborts.delete(directory)
    input.signal?.removeEventListener('abort', onExternalAbort)
  }
}

export async function getInitStatus(directory: string): Promise<{ directory: string; initialized: boolean; running: boolean }> {
  const scope = await memoryService.resolveProjectScope(directory)
  return {
    directory,
    // Coberta por uma árvore nela ou numa pasta acima: o card não oferece
    // analisar "front" de novo quando a pasta mãe já foi analisada.
    initialized: scope.covered,
    running: running.has(normalizeDirectory(scope.directory)),
  }
}
