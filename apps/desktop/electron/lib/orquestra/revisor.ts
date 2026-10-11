import { generateText, stepCountIs, tool, type LanguageModel, type ToolSet } from 'ai'
import { z } from 'zod'
import type { OrchestrationPlan, OrchestrationSettings, OrchestrationTask } from '@shared/chat'
import type { AcoesRevisao, PedidoRevisao, ResultadoWorker } from './execucao'
import type { Verificacao } from './verificacoes'

/**
 * O orquestrador revisando: um agente curto, com ferramentas, em vez do JSON
 * único de antes. Ele vê o resultado e o diff do worker, pode rodar as
 * verificações do projeto (no Rigoroso) e decide pelas ações da execução.
 */

const PASSOS_MAX = 12
const RESULTADO_MAX = 8000
const DIFF_MAX = 20_000

export interface DepsRevisor {
  model: LanguageModel
  providerOptions?: Parameters<typeof generateText>[0]['providerOptions']
  /** Raciocínio entre passos (modelos que exigem o raciocínio de volta, ex.: DeepSeek) */
  prepareStep?: Parameters<typeof generateText>[0]['prepareStep']
  pedidoOriginal: string
  plan: OrchestrationPlan
  config: OrchestrationSettings
  signal: AbortSignal
  /** Diff do trabalho do worker (worktree ou snapshots do chat dele) */
  diff(task: OrchestrationTask): Promise<string>
  /** Verificações disponíveis para a pasta do worker (só no Rigoroso) */
  verificacoes?(task: OrchestrationTask): Promise<Verificacao[]>
  rodarVerificacao?(task: OrchestrationTask, v: Verificacao): Promise<{ ok: boolean; saida: string }>
  /** Uso de tokens da revisão (somado ao plano) */
  aoUsar?(usage: unknown): void
}

const SISTEMA = (config: OrchestrationSettings) => `You are the Orbit orchestrator, reviewing the work of the workers you dispatched. Decide with your tools — your text reply is not read by anyone.

How to review:
- Judge the WORK, not the worker's story: look at the diff (ver_diff) before accepting anything that should have changed files. If the summary claims something the diff does not show, that is a problem.
- aceitar when the task is done well enough for the user's request. Do not chase perfection: every adjustment costs a full worker turn and comes out of a limited budget.
- pedir_ajuste with a concrete, actionable instruction (what is wrong, where, what to do) when something is missing or broken. The same worker continues in its own chat, so it remembers what it did.
- marcar_falha when the task cannot be fixed within the budget or went in a wrong direction — say why, so the final answer can tell the user.
- criar_worker only for work that is genuinely missing and belongs to no existing worker (it also costs budget).
${config.comportamento === 'rigoroso' ? '- RIGOROUS mode: before accepting a task that changed code, run at least one relevant verification with rodar_verificacao. A failing check means pedir_ajuste (or marcar_falha without budget), never aceitar.\n' : ''}- Workers may share the same folder: a diff can include changes from other workers running at the same time. Judge only what belongs to this task.`

function textoBudget(plan: OrchestrationPlan, config: OrchestrationSettings, task?: OrchestrationTask): string {
  const r = plan.revisao
  const geral = r ? `${r.tetoAjustes - r.ajustesUsados} of ${r.tetoAjustes} adjustments left in the plan` : ''
  const deste = task ? `; this worker used ${task.revisions ?? 0} of ${config.ajustesPorWorker}` : ''
  return `Budget: ${geral}${deste}.`
}

function resumoTarefas(plan: OrchestrationPlan): string {
  return plan.tasks
    .map((t) => `- ${t.title} [${t.fase ?? t.status}]${t.extra ? ' (extra)' : ''}${t.notaRevisao ? ` — ${t.notaRevisao.slice(0, 200)}` : ''}`)
    .join('\n')
}

function cortar(texto: string, max: number): string {
  return texto.length > max ? `${texto.slice(0, max)}\n…(cut, ${texto.length - max} more chars)` : texto
}

/** Acha a tarefa pelo título (integração) — o modelo não lida bem com ids. */
function tarefaPorTitulo(plan: OrchestrationPlan, titulo: string): OrchestrationTask | undefined {
  const alvo = titulo.trim().toLowerCase()
  return plan.tasks.find((t) => t.title.trim().toLowerCase() === alvo || t.id === titulo)
}

export async function revisarComModelo(d: DepsRevisor, pedido: PedidoRevisao, acoes: AcoesRevisao): Promise<void> {
  const { plan, config } = d
  const umaSo = pedido.tipo === 'worker' ? pedido.task : undefined
  const alvo = (titulo?: string): OrchestrationTask | string => {
    if (umaSo) return umaSo
    const t = titulo ? tarefaPorTitulo(plan, titulo) : undefined
    return t ?? `No task titled "${titulo}". Tasks: ${plan.tasks.map((x) => x.title).join(', ')}`
  }
  // Revisando um worker só, a ação vale para ele; na integração, para a tarefa
  // nomeada. Sempre opcional no schema para os dois casos terem o mesmo formato.
  const campoTarefa = {
    tarefa: z
      .string()
      .optional()
      .describe(umaSo ? 'Leave empty: this review is about one task' : 'Exact title of the task'),
  }

  const tools: ToolSet = {
    ver_diff: tool({
      description: 'Shows the files and patch the worker changed.',
      inputSchema: z.object({ ...campoTarefa }),
      execute: async (args: { tarefa?: string }) => {
        const t = alvo(args.tarefa)
        if (typeof t === 'string') return t
        const diff = await d.diff(t)
        return diff ? cortar(diff, DIFF_MAX) : '(no changes found)'
      },
    }),
    aceitar: tool({
      description: 'Accepts the task as done.',
      inputSchema: z.object({ ...campoTarefa, nota: z.string().optional().describe('Short note on what was verified') }),
      execute: async (args: { tarefa?: string; nota?: string }) => {
        const t = alvo(args.tarefa)
        return typeof t === 'string' ? t : acoes.aceitar(t.id, args.nota)
      },
    }),
    pedir_ajuste: tool({
      description: 'Sends the worker back to work with a concrete instruction. Costs one adjustment from the budget.',
      inputSchema: z.object({ ...campoTarefa, instrucao: z.string().describe('What is wrong and exactly what to do') }),
      execute: async (args: { tarefa?: string; instrucao: string }) => {
        const t = alvo(args.tarefa)
        return typeof t === 'string' ? t : acoes.pedirAjuste(t.id, args.instrucao)
      },
    }),
    marcar_falha: tool({
      description: 'Marks the task as failed (it will not run again).',
      inputSchema: z.object({ ...campoTarefa, motivo: z.string() }),
      execute: async (args: { tarefa?: string; motivo: string }) => {
        const t = alvo(args.tarefa)
        return typeof t === 'string' ? t : acoes.marcarFalha(t.id, args.motivo)
      },
    }),
    criar_worker: tool({
      description: 'Creates an additional worker for missing work that belongs to no existing worker. Costs one adjustment from the budget.',
      inputSchema: z.object({
        titulo: z.string().describe("2-5 words naming the area or deliverable, in the user's language"),
        prompt: z.string().describe('Self-contained prompt — the worker does not see this conversation'),
        dependeDe: z.array(z.string()).optional().describe('Titles of tasks that must be accepted before it starts'),
      }),
      execute: async (args: { titulo: string; prompt: string; dependeDe?: string[] }) => acoes.criarWorker(args),
    }),
  }

  if (config.comportamento === 'rigoroso' && d.verificacoes && d.rodarVerificacao) {
    const verificacoes = d.verificacoes
    const rodar = d.rodarVerificacao
    tools.rodar_verificacao = tool({
      description: "Runs one of the project's own checks (typecheck, tests, lint) in the worker's folder. Call without `verificacao` to list them.",
      inputSchema: z.object({ ...campoTarefa, verificacao: z.string().optional().describe('Name from the list') }),
      execute: async (args: { tarefa?: string; verificacao?: string }) => {
        const t = alvo(args.tarefa)
        if (typeof t === 'string') return t
        const lista = await verificacoes(t)
        if (lista.length === 0) return 'This project declares no checks (no typecheck/test/lint scripts). Review the diff instead.'
        const v = lista.find((x) => x.nome === args.verificacao)
        if (!v) return `Available checks: ${lista.map((x) => x.nome).join(', ')}`
        const r = await rodar(t, v)
        return `${v.nome}: ${r.ok ? 'PASSED' : 'FAILED'}\n${r.saida}`
      },
    })
  }

  const conteudo =
    pedido.tipo === 'worker'
      ? [
          `## Original request\n${d.pedidoOriginal}`,
          `## Task under review: ${pedido.task.title}\n${pedido.task.prompt}`,
          pedido.task.revisions ? `## Last adjustment you asked for\n${pedido.task.notaRevisao ?? ''}` : '',
          `## Worker's reply${pedido.resultado.error ? ` (ERROR: ${pedido.resultado.error})` : ''}\n${cortar(pedido.resultado.text || '(no reply)', RESULTADO_MAX)}`,
          `## Other tasks\n${resumoTarefas(plan)}`,
          textoBudget(plan, config, pedido.task),
          'Review this task and decide: aceitar, pedir_ajuste or marcar_falha (and criar_worker if something is missing).',
        ]
      : [
          `## Original request\n${d.pedidoOriginal}`,
          `## Every task, after its own review\n${resumoTarefas(plan)}`,
          `## Worker replies\n${plan.tasks
            .map((t) => `### ${t.title}\n${cortar(resultadoDe(pedido.resultados, t)?.text || '(no reply)', 2500)}`)
            .join('\n\n')}`,
          textoBudget(plan, config),
          'INTEGRATION review: do the parts, together, deliver what the user asked? Look for gaps between tasks, contradictions and missing glue. If everything is fine, do nothing (or aceitar). Otherwise use pedir_ajuste / criar_worker on what is missing.',
        ]

  const { usage } = await generateText({
    model: d.model,
    system: SISTEMA(config),
    messages: [{ role: 'user', content: conteudo.filter(Boolean).join('\n\n') }],
    tools,
    stopWhen: stepCountIs(PASSOS_MAX),
    abortSignal: d.signal,
    providerOptions: d.providerOptions,
    prepareStep: d.prepareStep,
  })
  d.aoUsar?.(usage)
}

function resultadoDe(resultados: Map<string, ResultadoWorker>, t: OrchestrationTask): ResultadoWorker | undefined {
  return resultados.get(t.id)
}
