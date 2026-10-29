import { tool } from 'ai'
import { z } from 'zod'
import type { SendMessageInput } from '@shared/chat'
import type { Agenda, RotinaModos, RotinaPendente } from '@shared/rotinas'
import { parseHorario, proximaExecucaoDaRotina } from '@shared/rotinas'
import { atualizarRotinaCampos, executarAgora, removerRotinaCompleta } from '../rotinas'
import { listarRotinas } from '../rotinas/repo'
import { listarRotinasPendentes, novoIdProposta, proporRotina } from '../rotinas/pending'

/**
 * Tool rotinas_manage: o agente agenda pelo chat. A ação "criar" NÃO grava
 * direto: estagia uma proposta (rotinas-pending) e um card de confirmação
 * aparece na conversa — quem cria de verdade é a pessoa, no card (a mesma
 * regra do gerador do modal: nada vai para o disco sem revisão). As demais
 * ações (listar, executar, pausar, retomar, remover) são imediatas, como as
 * mesmas ações do painel de rotinas.
 */

const agendaSchema = z.object({
  horario: z.string().regex(/^\d{1,2}:\d{2}$/).describe('"HH:MM" (24h, local time)'),
  dias: z
    .array(z.number().int().min(0).max(6))
    .max(7)
    .optional()
    .describe('Weekdays (0 = Sunday). Omit for every day.'),
  intervaloDias: z.number().int().min(2).max(365).optional().describe('Alternative to dias: every N days.'),
  intervaloHoras: z.number().int().min(1).max(23).optional().describe('Alternative to dias: every N hours.'),
  umaVezData: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('One-time routine: "YYYY-MM-DD". Turns itself off after that single run.'),
})

const modosSchema = z.object({
  loop: z.boolean().optional(),
  subagents: z.boolean().optional(),
  orchestrate: z.boolean().optional(),
  brain: z.boolean().optional(),
  simple: z.boolean().optional(),
  plan: z.boolean().optional(),
  browser: z.boolean().optional(),
  search: z.boolean().optional(),
  vision: z.boolean().optional(),
  permissionMode: z.enum(['ask', 'approve', 'full']).optional(),
})

/** Frase curta da agenda, para os textos devolvidos ao modelo. */
function resumirAgenda(agenda: Agenda): string {
  if (agenda.umaVezData) return `${agenda.umaVezData} ${agenda.horario} (uma vez)`
  if (agenda.intervaloHoras) return `a cada ${agenda.intervaloHoras}h`
  if (agenda.intervaloDias) return `a cada ${agenda.intervaloDias} dias às ${agenda.horario}`
  if (agenda.dias?.length) return `às ${agenda.horario} nos dias ${agenda.dias.join(',')}`
  return `todo dia às ${agenda.horario}`
}

/** Normaliza a agenda do modelo: uma cadência só, na precedência do cálculo. */
function normalizarAgenda(agenda: Agenda): Agenda {
  if (agenda.umaVezData) return { horario: agenda.horario, umaVezData: agenda.umaVezData }
  if (agenda.intervaloHoras) {
    return { horario: agenda.horario, intervaloHoras: Math.max(1, Math.min(23, Math.floor(agenda.intervaloHoras))) }
  }
  if (agenda.intervaloDias) {
    return { horario: agenda.horario, intervaloDias: Math.max(2, Math.min(365, Math.floor(agenda.intervaloDias))) }
  }
  if (agenda.dias?.length) {
    const dias = [...new Set(agenda.dias)].sort((a, b) => a - b)
    // 7 dias = "todo dia": a UI prefere a frase curta aos sete chips.
    return dias.length === 7 ? { horario: agenda.horario } : { horario: agenda.horario, dias }
  }
  return { horario: agenda.horario }
}

/** Modos respeitando o modo da rotina (o chat não tem loop/orquestra/plano). */
function normalizarModos(modos: RotinaModos, mode: 'chat' | 'code', temVisao: boolean): RotinaModos {
  const base: RotinaModos = { permissionMode: modos.permissionMode ?? 'approve' }
  if (mode === 'chat') {
    if (modos.brain) base.brain = true
    if (modos.browser) base.browser = true
    if (modos.simple) base.simple = true
    if (modos.search) base.search = true
    if (modos.vision && temVisao) base.vision = true
    return base
  }
  if (modos.loop) base.loop = true
  if (modos.subagents) base.subagents = true
  if (modos.orchestrate) {
    // Orquestração implica loop + subagentes — a mesma regra do gerador.
    base.orchestrate = true
    base.loop = true
    base.subagents = true
  }
  if (modos.brain) base.brain = true
  if (modos.browser) base.browser = true
  if (modos.simple) base.simple = true
  if (modos.search) base.search = true
  if (modos.vision && temVisao) base.vision = true
  // Plano fica esperando aprovação — incompatível com rodar sozinha.
  if (modos.plan && !base.orchestrate) base.plan = true
  return base
}

export function createRotinasTool(input: SendMessageInput) {
  return tool({
    description:
      'Manages Orbit routines (rotinas): scheduled chats that run by themselves, in chat or code mode. Actions: "listar" lists existing routines; "criar" proposes a new routine (it shows a confirmation card in the conversation — the routine is only created when the user approves it in the card); "executar" runs a routine immediately; "pausar"/"retomar" pause/resume it; "remover" deletes it. For "criar": list first to avoid duplicates, write a self-contained prompt (the agent that runs it later has no memory of this conversation), keep the schedule exactly as the user asked (intervaloHoras for "every N hours", umaVezData for a one-time request), and suggest modes conservatively. After "criar", briefly explain what was proposed.',
    inputSchema: z.object({
      action: z.enum(['listar', 'criar', 'executar', 'pausar', 'retomar', 'remover']).describe('The action to perform.'),
      rotinaId: z.string().optional().describe('Routine id (from "listar"). Required for executar/pausar/retomar/remover.'),
      titulo: z.string().optional().describe('Routine title (action "criar").'),
      prompt: z.string().optional().describe('Self-contained prompt that runs at every execution (action "criar").'),
      agenda: agendaSchema.optional().describe('Schedule (action "criar").'),
      modos: modosSchema.optional().describe('Modes (action "criar"). Omit for safe defaults (approve, no extra modes).'),
    }),
    execute: async ({ action, rotinaId, titulo, prompt, agenda, modos }) => {
      const mode: 'chat' | 'code' = input.mode === 'chat' ? 'chat' : 'code'
      const pastas = [input.directory, ...(input.extraDirectories ?? [])].filter((p): p is string => Boolean(p))
      const modelo = { providerId: input.providerId, modelId: input.modelId }

      if (action === 'listar') {
        const rotinas = await listarRotinas()
        if (rotinas.length === 0) return 'Nenhuma rotina existe ainda.'
        return rotinas
          .map((r) => {
            const proxima = proximaExecucaoDaRotina(r)
            const quando = proxima ? new Date(proxima).toLocaleString('pt-BR') : ''
            return `- ${r.titulo} (id: ${r.id}) — ${r.mode}, ${resumirAgenda(r.agenda)}, ${r.ativa ? 'ativa' : 'pausada'}${quando ? `, próxima: ${quando}` : ''}`
          })
          .join('\n')
      }

      if (action === 'criar') {
        if (!titulo?.trim() || !prompt?.trim()) return 'Para criar uma rotina, informe titulo e prompt.'
        if (!agenda || !parseHorario(agenda.horario)) return 'A agenda precisa de um horario "HH:MM" válido.'
        if (mode === 'code' && pastas.length === 0) {
          return 'No modo código a rotina precisa de uma pasta de trabalho, e esta conversa não tem nenhuma aberta.'
        }
        const proposta: RotinaPendente = {
          id: novoIdProposta(),
          titulo: titulo.trim(),
          prompt: prompt.trim(),
          agenda: normalizarAgenda(agenda),
          modos: normalizarModos(modos ?? {}, mode, Boolean(input.visionModel)),
          mode,
          pastas: mode === 'chat' ? [] : pastas,
          modelo,
          visionModel: modos?.vision && input.visionModel ? input.visionModel : undefined,
          criadoEm: Date.now(),
        }
        await proporRotina(proposta)
        const pendentes = (await listarRotinasPendentes()).length
        return (
          `Proposta de rotina criada (id: ${proposta.id}) — aguardando aprovação no card da conversa (${pendentes} pendente(s)). ` +
          'A rotina só é criada quando o usuário clicar "Criar rotina" no card. ' +
          'Agora explique, em 1-2 frases, o que a rotina faz e quando roda.'
        )
      }

      if (!rotinaId) return 'Informe rotinaId (use "listar" para descobrir o id).'
      const rotina = (await listarRotinas()).find((r) => r.id === rotinaId)
      if (!rotina) return `Rotina ${rotinaId} não encontrada.`

      if (action === 'executar') {
        const sessionId = await executarAgora(rotinaId)
        return sessionId
          ? `Execução disparada na sessão ${sessionId}. O chat dela aparece no grupo "Rotinas" da sidebar.`
          : `A rotina "${rotina.titulo}" já está em execução ou não pôde rodar agora (sem pasta de trabalho).`
      }
      if (action === 'pausar' || action === 'retomar') {
        const ativa = action === 'retomar'
        await atualizarRotinaCampos(rotinaId, { ativa })
        return `Rotina "${rotina.titulo}" ${ativa ? 'reativada' : 'pausada'}.`
      }
      await removerRotinaCompleta(rotinaId)
      return `Rotina "${rotina.titulo}" removida. Os chats das execuções passadas permanecem na sidebar e podem ser apagados à mão.`
    },
  })
}
