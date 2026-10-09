import { stepCountIs, streamText, tool, type LanguageModel, type ToolSet } from 'ai'
import { z } from 'zod'
import { getProvider } from '../catalog'
import { errorToText } from '../errors'
import { reasoningPrepareStep } from '../reasoning'
import { createGlobTool, createGrepTool, createListTool, createReadTool } from '../tools/files'
import type { ToolContext } from '../tools/context'
import {
  createDraft,
  removeNode,
  renderDraft,
  retireExisting,
  SUMMARY_MAX,
  upsertNode,
  validateDraft,
  type Draft,
  type DraftCategory,
  type ExistingTree,
} from './draft'

/**
 * O coordenador do /init: um agente com o projeto inteiro na cabeça, que lê o
 * que precisa, decide a forma da árvore, chama exploradores quando uma parte
 * pede verificação no código e monta o rascunho das memórias.
 *
 * Nada aqui é fixo — nem as áreas, nem quantos exploradores, nem se haverá
 * algum. O código só impõe os limites (orçamento de exploradores, passos,
 * tempo) e a forma da árvore (draft.ts). Quem decide o conteúdo é o agente.
 */

/** Teto de exploradores por análise, somando todas as rodadas. */
export const DEFAULT_EXPLORER_BUDGET = 8
const MAX_TASKS_PER_CALL = 4
const COORDINATOR_MAX_STEPS = 90
const EXPLORER_MAX_STEPS = 20
const EXPLORER_TIMEOUT_MS = 5 * 60 * 1000
/** Relatório maior que isso é cortado antes de voltar ao coordenador. */
const REPORT_MAX_CHARS = 14_000

export interface CoordinatorHooks {
  /** Narração do coordenador (o acordeon de cima). */
  onMainDelta?: (delta: string) => void
  onAgentStart?: (key: string, label: string) => void
  onAgentDelta?: (key: string, delta: string) => void
  onAgentDone?: (key: string, ok: boolean) => void
  /** Exploradores concluídos / disparados até agora. */
  onProgress?: (done: number, total: number) => void
}

export interface CoordinatorInput {
  directory: string
  scanDescription: string
  /** Árvore já existente (re-init), como texto para o coordenador. */
  existingTreeText?: string
  existing: ExistingTree
  /** Subpasta de onde o /init foi pedido, quando o projeto já cobria a pasta. */
  focus?: string
  model: LanguageModel
  providerId: string
  modelId: string
  workerModel: LanguageModel
  workerProviderId: string
  workerModelId: string
  explorerBudget: number
  concurrency: number
  language: string
  hooks: CoordinatorHooks
  signal: AbortSignal
}

export interface CoordinatorResult {
  draft: Draft
  /** O coordenador chamou finish com o rascunho válido. */
  finished: boolean
  /** Palavra final do coordenador (por que gravou o que gravou, ou nada). */
  note?: string
  explorersUsed: number
}

function readOnlyTools(directory: string, abort: AbortSignal): ToolSet {
  const ctx: ToolContext = { sessionId: `init:${directory}`, directory, extraDirectories: [], abort }
  return {
    read: createReadTool(ctx),
    ls: createListTool(ctx),
    glob: createGlobTool(ctx),
    grep: createGrepTool(ctx),
  }
}

/** Linha curta de uma chamada de ferramenta, para a narração. */
function toolCallLine(toolName: string, input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>
  if (toolName === 'draft_node') return `\n\`→ rascunho: ${String(obj.title ?? obj.key ?? '')}\`\n\n`
  if (toolName === 'explore') {
    const tasks = Array.isArray(obj.tasks) ? obj.tasks.length : 0
    return `\n\`→ ${tasks} explorador(es)\`\n\n`
  }
  const arg = obj.filePath ?? obj.dirPath ?? obj.pattern ?? obj.query ?? obj.key ?? obj.id ?? ''
  const short = typeof arg === 'string' ? arg.split(/[\\/]/).slice(-2).join('/') : ''
  return `\n\`→ ${toolName}${short ? ` ${short}` : ''}\`\n\n`
}

function explorerSystem(language: string): string {
  return `You are an explorer subagent of Orbit's project onboarding. A coordinator who sees the whole project gave you ONE mission. Answer it by reading the real code and docs with your tools (read, ls, glob, grep) — the coordinator will turn your report into lasting project memory that future sessions rely on instead of re-reading the code, so accuracy matters more than coverage.

Rules:
- Verify in the files. Never present a guess as a fact; if you could not confirm something, say so explicitly.
- Cite real paths (and line numbers when useful) for every claim.
- Prefer what is specific to THIS project — its rules, flows, contracts, conventions, decisions and gotchas — over what any developer would infer from the stack in a glance. Skip generic statements ("uses React", "has a components folder").
- Be economical: open the right files, not every file.
- If you find a non-obvious workaround or gotcha that would also bite in OTHER projects with the same technology, put it on a line starting with "LEARNING:" (problem + solution, self-contained).

Report in ${language}, in markdown:
## Findings — the answers to the mission, each with its evidence (paths).
## Rules and conventions — only those you saw enforced or written down.
## Not confirmed — what you looked for and did not find, or could not verify.
Keep it under ~1200 words.`
}

function coordinatorSystem(input: CoordinatorInput): string {
  const lang = input.language
  return `You are the coordinator of Orbit's project onboarding (/init). Your job: build the PROJECT MEMORY TREE that every future chat in this folder starts with, so the user never has to explain this project's context again and agents stop re-exploring the code. It is worth spending tokens now to save them later — but only knowledge that will actually be reused is worth saving.

WHAT DESERVES A MEMORY
- Specific, verified, non-obvious, and useful for future tasks: business rules, domain concepts, flows between parts, contracts (API, auth, data formats), architectural decisions and their reasons, conventions the project enforces, where key things live, commands that are not obvious, gotchas.
- NOT: generic facts any developer gets from a glance at the stack, lists of folders, restating file names, speculation. A memory with little or generic information is WORSE than no memory — it costs tokens in every future chat and buries what matters.
- There is NO required set of areas and NO minimum. A repo with only a docs/ folder may deserve a root plus three business-context nodes. A tiny repo may deserve only the root. Empty is acceptable if there is nothing worth keeping (then call finish with a note explaining why).

SHAPE OF THE TREE
- One root (parent null): what the project is, who it is for, how its parts fit together. Title it with the project name.
- One node per independent part (e.g. "front/", "backend/", "apps/mobile"), with "scope" set to its folder relative to the root. Knowledge specific to a part hangs under that part's node (and deeper when it helps: front > auth flow).
- Cross-cutting knowledge — business rules, the contract between front and back, shared conventions — hangs under the root and is linked with "related" to every part it touches.
- Each node: "summary" is 1–3 sentences (max ${SUMMARY_MAX} chars) that is useful on its own, because it is injected into future prompts; "document" holds the detail (paths, commands, rules, flows, examples) in markdown, opened on demand. A node without real detail in its document is usually not worth having.
- AGENTS.md / CLAUDE.md / CONTRIBUTING and similar files contain rules the project declared explicitly — capture the ones that matter as category "standard".

HOW TO WORK (you decide the order and depth; this is the usual path)
1. Orient yourself: the scan below, then read README, docs/, rule files and manifests with your own tools. Decide what the project is and how it is divided.
2. Delegate verification with "explore" when a part needs digging in the code that would cost you too much context — give each explorer a precise mission (questions to answer, where to start). Explorers only return reports; they never write memory. Run several in one call to parallelize. You may run another round after reading the reports to fill gaps. Budget: ${input.explorerBudget} explorers in total for the whole analysis — for a small project, do it yourself and use none.
3. Read every report critically. Merge what overlaps, drop what is generic or unverified, and notice what spans several parts (that becomes cross-cutting nodes).
4. Write the draft top-down with draft_node (parents before children). Use draft_learning only for technology-level lessons valid in OTHER projects.
5. Review with draft_view: for each node ask "would a future chat be worse off without it?". Remove or merge weak nodes, fix the tree, then call finish. If finish reports problems, fix them and call it again.

${input.existingTreeText ? `THIS PROJECT ALREADY HAS A MEMORY TREE (from an earlier analysis or from work sessions):
${input.existingTreeText}
Build on it. To rewrite an existing node, create a draft node with "updates" set to its id (keep what is still right). New nodes may hang from an existing node by using its id as "parent". Retire existing nodes that are obsolete, generic or duplicated with draft_retire_existing (never retire a specific decision the user recorded unless it is clearly wrong). Nodes you do not touch stay as they are.
` : ''}${input.focus ? `The user asked for this analysis from the subfolder "${input.focus}". Focus your effort on that part of the project, but keep it connected to the whole tree.
` : ''}
Language: write every memory text (titles, summaries, documents, learnings) in ${lang}. Narrate your progress to the user in ${lang}, one short line before each phase ("Lendo a documentação…", "Disparando 3 exploradores: …", "Montando a árvore…") — no long explanations in the narration.`
}

interface ExplorerTask {
  label: string
  mission: string
  folder?: string
}

export async function runCoordinator(input: CoordinatorInput): Promise<CoordinatorResult> {
  const { hooks, signal, existing } = input
  const draft = createDraft()
  let finished = false
  let note: string | undefined
  let explorersUsed = 0
  let explorersDone = 0
  let explorerSeq = 0

  const runExplorer = async (task: ExplorerTask): Promise<string> => {
    const key = `explorer-${++explorerSeq}`
    hooks.onAgentStart?.(key, task.label)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), EXPLORER_TIMEOUT_MS)
    const onAbort = () => controller.abort()
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
    let buffer = ''
    try {
      const provider = await getProvider(input.workerProviderId)
      const result = streamText({
        model: input.workerModel,
        system: explorerSystem(input.language),
        prompt: `Mission: ${task.mission}${task.folder ? `\nStart in: ${task.folder}` : ''}\n\nProject scan (starting point, not a conclusion):\n${input.scanDescription}`,
        tools: readOnlyTools(input.directory, controller.signal),
        stopWhen: stepCountIs(EXPLORER_MAX_STEPS),
        abortSignal: controller.signal,
        prepareStep: reasoningPrepareStep(provider, input.workerModelId),
      })
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          buffer += part.text
          hooks.onAgentDelta?.(key, part.text)
        } else if (part.type === 'tool-call') {
          hooks.onAgentDelta?.(key, toolCallLine(part.toolName, part.input))
        } else if (part.type === 'error') {
          throw part.error instanceof Error ? part.error : new Error(errorToText(part.error))
        }
      }
      hooks.onAgentDone?.(key, true)
      return buffer.trim() || '(o explorador terminou sem relatório)'
    } catch (err) {
      if (signal.aborted) {
        hooks.onAgentDone?.(key, false)
        throw err
      }
      hooks.onAgentDelta?.(key, `\n_(interrompido: ${errorToText(err)})_`)
      hooks.onAgentDone?.(key, false)
      // Relatório parcial ainda serve: o coordenador decide o que aproveitar.
      return `${buffer.trim()}\n\n(EXPLORADOR INTERROMPIDO: ${errorToText(err)} — relatório incompleto)`
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
      explorersDone++
      hooks.onProgress?.(explorersDone, explorersUsed)
    }
  }

  // Sem "context": essa categoria EXPIRA (é para o estado passageiro de um
  // trabalho em andamento). O que o /init grava é para durar — o contexto de
  // negócio de um projeto só com docs/ sumiria meses depois.
  const categories = ['preference', 'convention', 'structure', 'decision', 'database', 'standard'] as const

  const tools: ToolSet = {
    ...readOnlyTools(input.directory, signal),

    explore: tool({
      description:
        `Runs explorer subagents IN PARALLEL and waits for all of them. Each gets one precise mission, reads the code with read-only tools and returns a report (it never writes memory). Up to ${MAX_TASKS_PER_CALL} per call; ${input.explorerBudget} in total for the whole analysis. Use it for parts that need real digging; do small checks yourself.`,
      inputSchema: z.object({
        tasks: z
          .array(
            z.object({
              label: z.string().describe('Short label shown to the user, e.g. "Backend · regras de cobrança"'),
              mission: z.string().describe('What to find out: concrete questions, what to verify, where to look'),
              folder: z.string().optional().describe('Folder (relative) where the explorer should start'),
            }),
          )
          .min(1)
          .max(MAX_TASKS_PER_CALL),
      }),
      execute: async ({ tasks }) => {
        const left = input.explorerBudget - explorersUsed
        if (left <= 0) return 'Orçamento de exploradores esgotado. Termine com o que já tem (ou verifique pontos pequenos você mesmo).'
        const accepted = tasks.slice(0, left)
        explorersUsed += accepted.length
        hooks.onProgress?.(explorersDone, explorersUsed)
        const reports: string[] = new Array(accepted.length)
        const queue = accepted.map((task, index) => ({ task, index }))
        const workers = Array.from({ length: Math.min(input.concurrency, queue.length) }, async () => {
          while (queue.length) {
            const { task, index } = queue.shift()!
            const report = await runExplorer(task)
            reports[index] =
              `## ${task.label}\n${report.length > REPORT_MAX_CHARS ? `${report.slice(0, REPORT_MAX_CHARS)}\n…(cortado)` : report}`
          }
        })
        await Promise.all(workers)
        const skipped = tasks.length - accepted.length
        return [
          ...reports,
          skipped > 0 ? `(${skipped} missão(ões) não rodaram: orçamento esgotado.)` : '',
          `Exploradores restantes: ${input.explorerBudget - explorersUsed}.`,
        ]
          .filter(Boolean)
          .join('\n\n')
      },
    }),

    draft_node: tool({
      description:
        'Creates or replaces (same key) a node of the memory tree draft. Nothing is saved until finish. Parents must exist before children (draft key or existing memory id).',
      inputSchema: z.object({
        key: z.string().describe('Unique id in the draft, e.g. "root", "front", "billing-rules"'),
        title: z.string().describe('Short name of the node, e.g. "Frontend", "Regras de cobrança"'),
        summary: z.string().describe(`1–3 sentences, max ${SUMMARY_MAX} chars, useful on its own in a prompt`),
        document: z.string().optional().describe('Markdown with the details: paths, commands, rules, flows'),
        category: z.enum(categories),
        parent: z.string().nullable().describe('Parent key or existing memory id; null only for the root'),
        related: z.array(z.string()).optional().describe('Cross links to other nodes (keys or existing ids)'),
        scope: z.string().optional().describe('Folder this node represents, relative to the root — only for part nodes like "front"'),
        tags: z.array(z.string()).optional().describe('3–6 lowercase keywords'),
        weight: z.number().min(0).max(1).optional().describe('Importance; default 0.7 (root 0.9, part nodes 0.85)'),
        updates: z.string().optional().describe('Id of an existing memory this node rewrites'),
      }),
      execute: async (node) => {
        const error = upsertNode(draft, existing, {
          key: node.key,
          title: node.title,
          summary: node.summary,
          document: node.document?.trim() || undefined,
          category: node.category as DraftCategory,
          parent: node.parent,
          related: node.related ?? [],
          scope: node.scope,
          tags: node.tags ?? [],
          weight: node.weight,
          updates: node.updates,
        })
        return error ? `Erro: ${error}` : `Nó "${node.key}" no rascunho (${draft.nodes.size} nós).`
      },
    }),

    draft_remove_node: tool({
      description: 'Removes a node from the draft (it must have no children in the draft).',
      inputSchema: z.object({ key: z.string() }),
      execute: async ({ key }) => removeNode(draft, key) ?? `Nó "${key}" removido.`,
    }),

    draft_learning: tool({
      description:
        'Records a technology-level lesson valid in OTHER projects too (framework gotcha, library workaround). Saved outside the project tree. Not for anything about this project domain.',
      inputSchema: z.object({
        text: z.string().describe('Self-contained: problem + solution'),
        tags: z.array(z.string()).describe('Technology names'),
      }),
      execute: async ({ text, tags }) => {
        if (text.trim().length < 20) return 'Erro: aprendizado curto demais para se sustentar sozinho.'
        draft.learnings.push({ text: text.trim(), tags: tags.map((t) => t.toLowerCase()) })
        return 'Aprendizado registrado no rascunho.'
      },
    }),

    ...(existing.ids.size > 0
      ? {
          draft_retire_existing: tool({
            description:
              'Marks an EXISTING memory of this project to be deleted when the draft is saved — for nodes that are obsolete, generic or duplicated by the new draft.',
            inputSchema: z.object({
              id: z.string(),
              reason: z.string().min(10),
            }),
            execute: async ({ id, reason }) =>
              retireExisting(draft, existing, id, reason) ?? `#${id} será aposentada ao gravar.`,
          }),
        }
      : {}),

    draft_view: tool({
      description: 'Shows the whole draft as an indented tree, to review before finishing.',
      inputSchema: z.object({}),
      execute: async () => renderDraft(draft, existing),
    }),

    finish: tool({
      description:
        'Validates the draft and, if it is consistent, ends the analysis; the draft is then saved as project memory. If it returns problems, fix them and call it again.',
      inputSchema: z.object({
        note: z
          .string()
          .describe('One or two sentences for the user: what was captured and why (or why nothing was worth saving)'),
      }),
      execute: async ({ note: finalNote }) => {
        const issues = validateDraft(draft, existing)
        if (issues.length) return `O rascunho tem problemas:\n${issues.map((i) => `- ${i}`).join('\n')}`
        finished = true
        note = finalNote.trim()
        return 'Rascunho aceito. Encerre aqui.'
      },
    }),
  }

  const provider = await getProvider(input.providerId)
  const result = streamText({
    model: input.model,
    system: coordinatorSystem(input),
    prompt: `Project scan:\n${input.scanDescription}`,
    tools,
    stopWhen: [() => finished, stepCountIs(COORDINATOR_MAX_STEPS)],
    abortSignal: signal,
    prepareStep: reasoningPrepareStep(provider, input.modelId),
  })
  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') hooks.onMainDelta?.(part.text)
    else if (part.type === 'tool-call') hooks.onMainDelta?.(toolCallLine(part.toolName, part.input))
    else if (part.type === 'error') {
      throw part.error instanceof Error ? part.error : new Error(errorToText(part.error))
    }
  }

  return { draft, finished, note, explorersUsed }
}
