import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { computeAnalytics, computeWorkReport, type WorkReportProject } from '../analytics'

/**
 * Relatórios de uso para o agente — as mesmas contas da tela "Uso do Orbit",
 * só que em texto, para responder perguntas como "quantas horas trabalhei no
 * projeto X e o que foi feito em cada dia?".
 *
 * A contagem de horas é a do painel (tempo de geração + os intervalos entre
 * mensagens que passam nas regras de sessão), então os dois nunca divergem.
 * O que foi feito vem dos títulos das conversas e dos pedidos do usuário
 * naquele dia: é histórico real, não resumo inventado pelo modelo.
 */

const PERIODO = {
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('Start date, YYYY-MM-DD (inclusive). Omit to use "days".'),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('End date, YYYY-MM-DD (inclusive). Defaults to today.'),
  days: z
    .number()
    .int()
    .min(1)
    .max(3650)
    .optional()
    .describe('Last N days counting today, when from/to are not given. Default: 30.'),
}

/** Data local a partir de YYYY-MM-DD, ou null se o dia não existe. O formato
 *  passa no regex do schema mas "2026-13-01" e "2026-02-31" não são datas, e
 *  sem esta checagem viravam NaN — que compara falso com tudo e fazia o
 *  relatório responder "nenhuma atividade" em vez de acusar o erro. */
function lerData(texto: string): Date | null {
  const [ano, mes, dia] = texto.split('-').map(Number)
  const d = new Date(ano, mes - 1, dia)
  if (d.getFullYear() !== ano || d.getMonth() !== mes - 1 || d.getDate() !== dia) return null
  return d
}

type Periodo = { since: number; until: number }

function resolverPeriodo(input: { from?: string; to?: string; days?: number }): Periodo | string {
  const fim = input.to ? lerData(input.to) : new Date()
  if (!fim) return `Erro: "${input.to}" não é uma data válida (use YYYY-MM-DD).`
  fim.setHours(23, 59, 59, 999)

  if (input.from) {
    const inicio = lerData(input.from)
    if (!inicio) return `Erro: "${input.from}" não é uma data válida (use YYYY-MM-DD).`
    inicio.setHours(0, 0, 0, 0)
    if (inicio.getTime() > fim.getTime()) {
      return `Erro: o início (${input.from}) é depois do fim (${input.to ?? 'hoje'}).`
    }
    return { since: inicio.getTime(), until: fim.getTime() }
  }
  const inicio = new Date(fim)
  inicio.setDate(inicio.getDate() - ((input.days ?? 30) - 1))
  inicio.setHours(0, 0, 0, 0)
  return { since: inicio.getTime(), until: fim.getTime() }
}

const dataCurta = (ts: number) => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const hora = (ts: number) => {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const horas = (h: number) => `${h.toFixed(2)}h`
const dinheiro = (c: number) => (c > 0 ? `$${c.toFixed(c < 1 ? 4 : 2)}` : '$0')
const tokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n)

/**
 * Teto do que uma chamada devolve. Um ano de histórico detalhado passa de um
 * milhão de caracteres — o resultado sozinho estouraria a janela de contexto,
 * levando junto a conversa em que a pergunta foi feita. Cortar e DIZER que
 * cortou é melhor do que devolver tudo: o modelo reduz o período e pergunta
 * de novo.
 */
const LIMITE_SAIDA = 20_000

function cortarNoLimite(linhas: string[]): string {
  let total = 0
  for (let i = 0; i < linhas.length; i++) {
    total += linhas[i].length + 1
    if (total <= LIMITE_SAIDA) continue
    return [
      ...linhas.slice(0, i),
      '',
      `[relatório cortado em ${i} de ${linhas.length} linhas por tamanho. Reduza o período (from/to ou days), aponte um projeto (project) ou peça detail=false para ver só as horas.]`,
    ].join('\n')
  }
  return linhas.join('\n')
}

function escreverProjeto(proj: WorkReportProject, comDetalhe: boolean): string[] {
  const linhas: string[] = []
  const nome = proj.name || 'Sem projeto (chat)'
  linhas.push('')
  linhas.push(`## ${nome}${proj.directory ? ` — ${proj.directory}` : ''}`)
  linhas.push(
    `Total: ${horas(proj.hours)} · ${proj.days.length} dia(s) · ${proj.sessions} conversa(s) · ${tokens(proj.tokens)} tokens · ${dinheiro(proj.cost)}`,
  )

  for (const dia of proj.days) {
    linhas.push('')
    linhas.push(
      `### ${dia.date} — ${horas(dia.hours)} (${hora(dia.firstAt)}–${hora(dia.lastAt)}, ${dia.messages} resposta(s), ${dinheiro(dia.cost)})`,
    )
    for (const sessao of dia.sessions) {
      linhas.push(`- "${sessao.title}" — ${horas(sessao.hours)}`)
      if (!comDetalhe) continue
      for (const prompt of sessao.prompts) linhas.push(`  · ${prompt}`)
    }
  }
  return linhas
}

export function createUsageTools(): ToolSet {
  return {
    work_report: tool({
      description: [
        'Hours worked per day, taken from the real conversation history, optionally narrowed to one project.',
        'This is the tool for questions like "how many hours did I work on project X?" or',
        '"write me a report of what was done each day". It returns, per day: hours worked, the',
        'start and end time, which conversations were active, and what the user actually asked in them —',
        'so the day-by-day summary describes real work instead of being made up.',
        'Hours are the same ones shown on the Orbit Usage screen (generation time plus the gaps',
        'between messages that still count as working), so never recompute them by hand.',
        'If the project name matches nothing, the result lists the projects that do exist.',
      ].join(' '),
      inputSchema: z.object({
        project: z
          .string()
          .optional()
          .describe(
            'Project folder name or part of its path. Omit for every project. Use "sem projeto" for chats with no working folder.',
          ),
        ...PERIODO,
        detail: z
          .boolean()
          .optional()
          .describe(
            'Default true: include what the user asked in each conversation. Pass false for hours only.',
          ),
      }),
      execute: async ({ project, from, to, days, detail }) => {
        const periodo = resolverPeriodo({ from, to, days })
        if (typeof periodo === 'string') return periodo
        const { since, until } = periodo
        const comDetalhe = detail !== false
        const relatorio = await computeWorkReport({
          since,
          until,
          project,
          promptsPerDay: comDetalhe ? 6 : 0,
        })

        const cabecalho = `Período: ${dataCurta(since)} a ${dataCurta(until)}`
        if (relatorio.projects.length === 0) {
          if (project) {
            return [
              `${cabecalho}. Nenhuma atividade em um projeto que case com "${project}".`,
              relatorio.knownProjects.length
                ? `Projetos com atividade no período: ${relatorio.knownProjects.join(', ')}.`
                : 'Não houve atividade nenhuma nesse período.',
            ].join('\n')
          }
          return `${cabecalho}. Nenhuma atividade registrada.`
        }

        const linhas = [
          cabecalho,
          `Total: ${horas(relatorio.totalHours)} · ${tokens(relatorio.totalTokens)} tokens · ${dinheiro(relatorio.totalCost)}`,
        ]
        for (const proj of relatorio.projects) linhas.push(...escreverProjeto(proj, comDetalhe))
        return cortarNoLimite(linhas)
      },
    }),

    usage_stats: tool({
      description: [
        'Token, cost and hour totals for a period, broken down by model, by project or by day.',
        'Use it for "how much did I spend", "which model did I use most", "cost per project".',
        'For what was DONE, or a day-by-day narrative, use work_report instead.',
      ].join(' '),
      inputSchema: z.object({
        groupBy: z.enum(['model', 'project', 'day']).optional().describe('Default: model'),
        ...PERIODO,
      }),
      execute: async ({ groupBy, from, to, days }) => {
        const periodo = resolverPeriodo({ from, to, days })
        if (typeof periodo === 'string') return periodo
        const { since, until } = periodo
        const data = await computeAnalytics({ type: 'custom', from: since, to: until })
        const cabecalho = [
          `Período: ${dataCurta(since)} a ${dataCurta(until)}`,
          `Total: ${tokens(data.totalTokens)} tokens · ${horas(data.totalHours)} · ${dinheiro(data.totalCost)} · ${data.totalSessions} conversa(s) · ${data.totalMessages} resposta(s)`,
        ]

        if (groupBy === 'project') {
          if (data.byProject.length === 0) return `${cabecalho.join('\n')}\nSem projetos no período.`
          return [
            ...cabecalho,
            'Por projeto (nome · horas · tokens · custo · conversas):',
            ...data.byProject.map(
              (p) =>
                `- ${p.name || 'Sem projeto (chat)'} · ${horas(p.hours)} · ${tokens(p.tokens)} · ${dinheiro(p.cost)} · ${p.sessions}`,
            ),
          ].join('\n')
        }

        if (groupBy === 'day') {
          if (data.days.length === 0) return `${cabecalho.join('\n')}\nSem dias com atividade.`
          return [
            ...cabecalho,
            'Por dia (data · horas · tokens · custo):',
            ...data.days.map(
              (d) =>
                `- ${d.date} · ${horas(d.totalHours)} · ${tokens(d.totalTokens)} · ${dinheiro(d.totalCost)}`,
            ),
          ].join('\n')
        }

        if (data.byModel.length === 0) return `${cabecalho.join('\n')}\nSem modelos no período.`
        return [
          ...cabecalho,
          'Por modelo (provider/modelo · tokens · horas · custo):',
          ...data.byModel.map(
            (m) =>
              `- ${m.providerId}/${m.modelId} · ${tokens(m.tokens)} · ${horas(m.hours)} · ${dinheiro(m.cost)}`,
          ),
        ].join('\n')
      },
    }),
  }
}
