import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import {
  carregarTudo,
  criarEsteira,
  criarProjeto,
  criarTask,
  iniciarTask,
  listarEsteiras,
  listarTasks,
} from '../esteira'

/**
 * Tools de esteira no chat: permitem transformar o que foi discutido na
 * conversa (um plano, um bug encontrado) em task de um board, sem sair do chat.
 *
 * Regra de desambiguação: a tool NUNCA escolhe a esteira no chute. Quando o
 * pedido não determina uma e existe mais de uma, ela devolve a lista e manda o
 * modelo perguntar (tool `question`) — decidir sozinho colocaria a task num
 * board errado, que é justamente o tipo de erro que ninguém percebe na hora.
 */

interface EsteiraResumo {
  id: string
  nome: string
  projeto: string
  fases: string[]
  pastas: string[]
}

async function resumoEsteiras(): Promise<EsteiraResumo[]> {
  const { projetos, esteiras } = await carregarTudo()
  return esteiras.map((esteira) => {
    const projeto = projetos.find((p) => p.id === esteira.projetoId)
    return {
      id: esteira.id,
      nome: esteira.nome,
      projeto: projeto?.nome ?? '(projeto removido)',
      fases: esteira.fases.map((f) => f.nome),
      pastas: projeto?.pastas ?? [],
    }
  })
}

/** Casa o texto do usuário com o nome da esteira/projeto (match único = sem pergunta). */
function filtrarPorNome(esteiras: EsteiraResumo[], termo: string): EsteiraResumo[] {
  const alvo = termo.trim().toLowerCase()
  if (!alvo) return []
  return esteiras.filter(
    (e) => e.nome.toLowerCase().includes(alvo) || e.projeto.toLowerCase().includes(alvo),
  )
}

export function createEsteiraTools(
  sessionId: string,
  /** Modelo da conversa — vira o padrão das fases da esteira criada pelo agente */
  modeloPadrao: { providerId: string; modelId: string },
): ToolSet {
  return {
    esteira_create: tool({
      description: [
        'Creates a NEW esteira (task board): a fixed pipeline of phases that runs tasks autonomously, without chats.',
        'Ask the user for the main repository folder before calling — the pipeline has nowhere to work without it.',
        'Phases come from system templates; the default pipeline is desenvolvimento → validacao → pronto. Only pass other ids if the user asked for something different.',
      ].join(' '),
      inputSchema: z.object({
        nome: z.string().describe('Pipeline name, e.g. "Features"'),
        pastas: z
          .array(z.string())
          .min(1)
          .describe('Absolute paths; the FIRST one is the main repository'),
        templateIds: z
          .array(z.enum(['desenvolvimento', 'validacao', 'pronto', 'seguranca', 'revisao', 'infra']))
          .optional()
          .describe('Phases in order (default: desenvolvimento, validacao, pronto)'),
        branch: z.string().optional().describe('Branch the pipeline works on (default: current)'),
      }),
      execute: async ({ nome, pastas, templateIds, branch }) => {
        // O projeto (dono das pastas) nasce junto: o usuário pensa em "esteira
        // no repositório X", não em cadastrar um projeto antes.
        const projeto = await criarProjeto(nome, pastas)
        const esteira = await criarEsteira({
          projetoId: projeto.id,
          nome,
          templateIds: templateIds ?? ['desenvolvimento', 'validacao', 'pronto'],
          providerId: modeloPadrao.providerId,
          modelId: modeloPadrao.modelId,
          branch,
        })
        return [
          `Esteira "${esteira.nome}" created — id: ${esteira.id}`,
          `phases: ${esteira.fases.map((f) => f.nome).join(' → ')}`,
          `main repository: ${pastas[0]}`,
          'It shows up on the Esteira page (code mode sidebar). Use esteira_create_task to add tasks.',
        ].join('\n')
      },
    }),

    esteira_list: tool({
      description:
        'Lists the available esteiras (task boards): id, name, project, phases and working folders. Use it before creating a task when you are not sure which board the user means.',
      inputSchema: z.object({}),
      execute: async () => {
        const esteiras = await resumoEsteiras()
        if (esteiras.length === 0) {
          return 'No esteira configured. The user needs to create a project and an esteira in the Esteira tab before it can receive tasks.'
        }
        return esteiras
          .map(
            (e) =>
              `- ${e.nome} (project: ${e.projeto}) — id: ${e.id}\n  phases: ${e.fases.join(' → ')}\n  folders: ${e.pastas.join(', ') || '(none)'}`,
          )
          .join('\n')
      },
    }),

    esteira_create_task: tool({
      description: [
        'Creates a task in an esteira (task board) — use it when the user asks to turn what was discussed into work for a board.',
        'Write `descricao` as the full brief for an agent that did NOT see this conversation: goal, context, files involved, acceptance criteria and constraints. Everything the pipeline knows comes from it.',
        'Choosing the board: pass `esteiraId` when you know it, or `esteira` with a name/fragment. If neither is given and there is more than one esteira, the tool returns the list and you MUST ask the user with the `question` tool — never guess the board.',
        'By default the task is created as pending; the user starts it. Only pass `iniciar: true` when the user explicitly asked to start it now.',
      ].join(' '),
      inputSchema: z.object({
        titulo: z.string().describe('Short title (one line)'),
        descricao: z.string().describe('Full brief for an agent with no access to this conversation'),
        esteiraId: z.string().optional().describe('Exact id of the esteira, from esteira_list'),
        esteira: z.string().optional().describe('Name (or fragment) of the esteira/project, when the id is unknown'),
        iniciar: z.boolean().optional().describe('Start the task right away (default: false)'),
      }),
      execute: async ({ titulo, descricao, esteiraId, esteira, iniciar }) => {
        const disponiveis = await resumoEsteiras()
        if (disponiveis.length === 0) {
          return 'No esteira configured — there is nowhere to create the task. Ask the user to create a project and an esteira in the Esteira tab.'
        }

        let alvo = esteiraId ? disponiveis.find((e) => e.id === esteiraId) : undefined
        if (!alvo && esteiraId) {
          return `Esteira "${esteiraId}" not found. Available esteiras:\n${disponiveis
            .map((e) => `- ${e.nome} (${e.projeto}) — id: ${e.id}`)
            .join('\n')}`
        }

        if (!alvo && esteira) {
          const candidatas = filtrarPorNome(disponiveis, esteira)
          if (candidatas.length === 1) alvo = candidatas[0]
          else if (candidatas.length > 1) {
            return `More than one esteira matches "${esteira}". Ask the user which one (question tool) and call again with esteiraId:\n${candidatas
              .map((e) => `- ${e.nome} (${e.projeto}) — id: ${e.id}`)
              .join('\n')}`
          } else {
            return `No esteira matches "${esteira}". Available:\n${disponiveis
              .map((e) => `- ${e.nome} (${e.projeto}) — id: ${e.id}`)
              .join('\n')}`
          }
        }

        // Sem indicação nenhuma: uma esteira só é escolha óbvia; mais de uma
        // exige perguntar — errar o board é um erro silencioso.
        if (!alvo) {
          if (disponiveis.length === 1) alvo = disponiveis[0]
          else {
            return `There are ${disponiveis.length} esteiras — ask the user which one to create the task in (question tool) and call again with esteiraId:\n${disponiveis
              .map((e) => `- ${e.nome} (${e.projeto}) — id: ${e.id}\n  phases: ${e.fases.join(' → ')}`)
              .join('\n')}`
          }
        }

        const task = await criarTask({
          esteiraId: alvo.id,
          titulo,
          descricao,
          origemSessionId: sessionId,
        })
        if (iniciar) await iniciarTask(alvo.id, task.id, 0)

        return [
          `Task created in esteira "${alvo.nome}" (project ${alvo.projeto}).`,
          `id: ${task.id} · title: ${task.titulo}`,
          `phases: ${alvo.fases.join(' → ')}`,
          iniciar ? 'The task has already been started.' : 'The task is pending — the user starts it from the board.',
        ].join('\n')
      },
    }),

    esteira_task_status: tool({
      description:
        'Reads the current state of the tasks in an esteira (status, current phase, errors). Use it to answer questions about how the board is doing.',
      inputSchema: z.object({
        esteiraId: z.string().optional().describe('Esteira id; omit when there is only one'),
      }),
      execute: async ({ esteiraId }) => {
        const esteiras = await listarEsteiras()
        if (esteiras.length === 0) return 'No esteira configured.'
        const alvo = esteiraId ? esteiras.find((e) => e.id === esteiraId) : esteiras.length === 1 ? esteiras[0] : undefined
        if (!alvo) {
          return `Specify the esteira. Available:\n${esteiras.map((e) => `- ${e.nome} — id: ${e.id}`).join('\n')}`
        }
        const tasks = await listarTasks(alvo.id)
        if (tasks.length === 0) return `Esteira "${alvo.nome}" has no tasks.`
        return tasks
          .map((t) => {
            const fase = t.faseAtual != null ? alvo.fases[t.faseAtual]?.nome ?? `phase ${t.faseAtual}` : '—'
            const erro = t.pausaMotivo === 'erro' ? ` · error: ${t.erro ?? 'no details'}` : ''
            return `- [${t.status}] ${t.titulo} (phase: ${fase})${erro}`
          })
          .join('\n')
      },
    }),
  }
}
