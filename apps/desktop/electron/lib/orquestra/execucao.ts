import type { OrchestrationPlan, OrchestrationSettings, OrchestrationTask, SendMessageOptions } from '@shared/chat'

/**
 * Execução de um plano aprovado — o orquestrador que ACOMPANHA.
 *
 * Antes: todos os workers em paralelo, espera do último, e só depois uma
 * revisão de no máximo 2 ações. Agora:
 *  - cada tarefa sai da fila quando as dependências foram ACEITAS, até
 *    MAX_PARALELO de uma vez;
 *  - cada worker que termina vai para a revisão (uma por vez — o orquestrador
 *    é um só, e decisões em paralelo se contradiriam), enquanto os outros
 *    seguem rodando;
 *  - a revisão aceita, pede ajuste (o mesmo worker volta a rodar), marca falha
 *    ou cria um worker extra, dentro do orçamento "ajustes por worker";
 *  - com tudo resolvido, a revisão de integração olha o conjunto e pode pedir
 *    mais ajustes (até 2 passadas).
 *
 * Tudo que fala com o modelo, o git ou o disco entra por `DepsExecucao`: a
 * coordenação é testável com workers e revisores falsos.
 */

export const MAX_PARALELO = 4
/** Passadas da revisão de integração (cada uma pode gerar ajustes). */
const PASSADAS_INTEGRACAO = 2
/** Teto de tarefas no plano, contando as extras criadas na revisão. */
const MAX_TAREFAS_TOTAL = 12
/** Quanto do resultado de uma dependência entra no prompt de quem depende dela. */
const RESUMO_DEPENDENCIA = 2500

export interface ResultadoWorker {
  text: string
  error?: string
  tokens?: unknown
}

/** O que o revisor pode fazer. As respostas em texto voltam para o modelo. */
export interface AcoesRevisao {
  aceitar(taskId: string, nota?: string): Promise<string>
  pedirAjuste(taskId: string, instrucao: string): string
  marcarFalha(taskId: string, motivo: string): string
  criarWorker(pedido: { titulo: string; prompt: string; dependeDe?: string[] }): string
}

export type PedidoRevisao =
  | { tipo: 'worker'; task: OrchestrationTask; resultado: ResultadoWorker }
  | { tipo: 'integracao'; resultados: Map<string, ResultadoWorker> }

export interface DepsExecucao {
  plan: OrchestrationPlan
  config: OrchestrationSettings
  signal: AbortSignal
  /** Roda um turno no worker da tarefa (criando a sessão, se for a primeira vez). */
  rodarWorker(task: OrchestrationTask, texto: string): Promise<ResultadoWorker>
  /** Revisão pelo orquestrador: decide usando `acoes`. Ausente = aceita tudo. */
  revisar?(pedido: PedidoRevisao, acoes: AcoesRevisao): Promise<void>
  /** Antes do PRIMEIRO turno de uma tarefa (ex.: criar o worktree dela). Devolve avisos para o prompt. */
  prepararTarefa?(task: OrchestrationTask): Promise<string[] | void>
  /** Ao aceitar (ex.: commitar o trabalho no worktree). */
  aoAceitar?(task: OrchestrationTask): Promise<void>
  /** Grava o plano e avisa a tela. */
  persistir(): Promise<void>
  /** Modos de um worker extra criado na revisão. */
  opcoesExtra?: SendMessageOptions
  novoId?(): string
}

function terminal(t: OrchestrationTask): boolean {
  return t.fase === 'aceita' || t.fase === 'falhou'
}

/** Prompt de quem depende de outras tarefas: o resumo delas vai junto. */
function promptComDependencias(task: OrchestrationTask, plan: OrchestrationPlan, resultados: Map<string, ResultadoWorker>, avisos: string[]): string {
  const partes = [task.prompt]
  if (task.arquivos?.length) {
    partes.push(
      '\n\n## Files this task owns\n' +
        task.arquivos.map((a) => `- ${a}`).join('\n') +
        '\nOther workers run at the same time on other files. Work within these; if you really must touch a file outside the list, keep that change minimal and say so in your summary.',
    )
  }
  const deps = (task.dependeDe ?? []).map((id) => plan.tasks.find((t) => t.id === id)).filter((t): t is OrchestrationTask => !!t)
  if (deps.length > 0) {
    partes.push(
      '\n\n## Context from the tasks this one depends on (already done and accepted)\n' +
        deps
          .map((d) => `### ${d.title}\n${(resultados.get(d.id)?.text ?? '(no summary)').slice(0, RESUMO_DEPENDENCIA)}`)
          .join('\n\n'),
    )
  }
  if (avisos.length > 0) partes.push(`\n\n## Notes from the orchestrator\n${avisos.map((a) => `- ${a}`).join('\n')}`)
  return partes.join('')
}

export async function executarPlano(d: DepsExecucao): Promise<Map<string, ResultadoWorker>> {
  const { plan, config } = d
  const acompanha = config.comportamento !== 'orquestrar' && !!d.revisar
  const resultados = new Map<string, ResultadoWorker>()
  const executando = new Map<string, Promise<void>>()
  const filaRevisao: string[] = []
  const ajustesPendentes = new Map<string, string>()
  const preparadas = new Set<string>()
  const avisosPorTarefa = new Map<string, string[]>()
  const novoId = d.novoId ?? (() => `task_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`)

  plan.revisao = { ajustesUsados: 0, tetoAjustes: config.ajustesPorWorker * plan.tasks.length }
  // `status` acompanha a etapa para quem só lê ele (o app do celular conta
  // "idle" como concluída): aberta = submitted/streaming, aceita = idle,
  // falhou = error.
  for (const t of plan.tasks) {
    t.fase = 'fila'
    t.status = 'submitted'
  }
  const revisao = plan.revisao
  const porId = (id: string) => plan.tasks.find((t) => t.id === id)

  const iniciar = (task: OrchestrationTask, texto: string, ajuste: boolean) => {
    task.fase = ajuste ? 'ajuste' : 'rodando'
    task.status = 'streaming'
    const execucao = (async () => {
      if (!preparadas.has(task.id)) {
        preparadas.add(task.id)
        const avisos = (await d.prepararTarefa?.(task)) ?? []
        if (avisos.length > 0) avisosPorTarefa.set(task.id, avisos)
        if (!ajuste) texto = promptComDependencias(task, plan, resultados, avisos)
      }
      const r = await d.rodarWorker(task, texto)
      resultados.set(task.id, r)
      if (acompanha) {
        // Ainda não está pronta: falta a revisão.
        task.fase = 'revisao'
        filaRevisao.push(task.id)
      } else if (r.error) {
        task.fase = 'falhou'
        task.status = 'error'
        task.notaRevisao = r.error
      } else {
        task.fase = 'aceita'
        task.status = 'idle'
        await d.aoAceitar?.(task)
      }
    })()
      .catch((err) => {
        task.fase = 'falhou'
        task.status = 'error'
        task.notaRevisao = err instanceof Error ? err.message : String(err)
      })
      .finally(() => {
        executando.delete(task.id)
      })
    executando.set(task.id, execucao)
  }

  const acoes: AcoesRevisao = {
    async aceitar(taskId, nota) {
      const t = porId(taskId)
      if (!t) return `Tarefa ${taskId} não existe.`
      t.fase = 'aceita'
      t.status = 'idle'
      if (nota) t.notaRevisao = nota
      await d.aoAceitar?.(t)
      return `"${t.title}" aceita.`
    },
    pedirAjuste(taskId, instrucao) {
      const t = porId(taskId)
      if (!t) return `Tarefa ${taskId} não existe.`
      if (executando.has(t.id)) return `"${t.title}" ainda está rodando — espere ela terminar.`
      if ((t.revisions ?? 0) >= config.ajustesPorWorker) {
        return `Sem orçamento para "${t.title}": ela já recebeu ${t.revisions ?? 0} ajuste(s), o máximo por worker. Aceite como está ou marque falha, explicando o que ficou pendente.`
      }
      if (revisao.ajustesUsados >= revisao.tetoAjustes) {
        return 'Sem orçamento: o total de ajustes deste plano acabou. Aceite ou marque falha, explicando o que ficou pendente.'
      }
      t.revisions = (t.revisions ?? 0) + 1
      revisao.ajustesUsados++
      t.fase = 'ajuste'
      t.status = 'submitted'
      t.notaRevisao = instrucao
      ajustesPendentes.set(t.id, instrucao)
      return `Ajuste pedido a "${t.title}" (${t.revisions}/${config.ajustesPorWorker}). Ela volta a rodar e será revisada de novo.`
    },
    marcarFalha(taskId, motivo) {
      const t = porId(taskId)
      if (!t) return `Tarefa ${taskId} não existe.`
      t.fase = 'falhou'
      t.status = 'error'
      t.notaRevisao = motivo
      return `"${t.title}" marcada como falha.`
    },
    criarWorker({ titulo, prompt, dependeDe }) {
      if (plan.tasks.length >= MAX_TAREFAS_TOTAL) return `Limite de ${MAX_TAREFAS_TOTAL} workers no plano atingido.`
      if (revisao.ajustesUsados >= revisao.tetoAjustes) return 'Sem orçamento: um worker novo conta como ajuste, e o total acabou.'
      const chave = titulo.trim().toLowerCase()
      if (plan.tasks.some((t) => t.title.trim().toLowerCase() === chave)) return `Já existe um worker "${titulo}" — use pedir_ajuste nele.`
      const deps: string[] = []
      for (const ref of dependeDe ?? []) {
        const dep = plan.tasks.find((t) => t.id === ref || t.title.trim().toLowerCase() === ref.trim().toLowerCase())
        if (!dep) return `"${ref}" não é uma tarefa deste plano.`
        deps.push(dep.id)
      }
      revisao.ajustesUsados++
      plan.tasks.push({
        id: novoId(),
        title: titulo,
        prompt,
        options: { ...d.opcoesExtra },
        status: 'submitted',
        fase: 'fila',
        extra: true,
        ...(deps.length > 0 ? { dependeDe: deps } : {}),
      })
      return `Worker "${titulo}" criado — entra na fila${deps.length > 0 ? ' depois das dependências' : ''}.`
    },
  }

  let passadasIntegracao = 0
  for (;;) {
    if (d.signal.aborted) break

    // Dependência que falhou derruba quem depende dela — esperar não adianta.
    for (const t of plan.tasks) {
      if (t.fase !== 'fila') continue
      const falhou = (t.dependeDe ?? []).map(porId).find((dep) => dep?.fase === 'falhou')
      if (falhou) {
        t.fase = 'falhou'
        t.status = 'error'
        t.notaRevisao = `Não começou: depende de "${falhou.title}", que falhou.`
      }
    }

    // Ajustes primeiro (o worker já tem contexto), depois as tarefas prontas.
    for (const [id, instrucao] of ajustesPendentes) {
      if (executando.size >= MAX_PARALELO) break
      ajustesPendentes.delete(id)
      const t = porId(id)
      if (t) iniciar(t, `[Ajuste pedido pelo orquestrador]\n${instrucao}`, true)
    }
    for (const t of plan.tasks) {
      if (executando.size >= MAX_PARALELO) break
      if (t.fase !== 'fila') continue
      if (!(t.dependeDe ?? []).every((id) => porId(id)?.fase === 'aceita')) continue
      iniciar(t, t.prompt, false)
    }
    await d.persistir()

    if (filaRevisao.length > 0 && d.revisar) {
      const t = porId(filaRevisao.shift()!)
      if (!t) continue
      revisao.atividade = `Revisando: ${t.title}`
      await d.persistir()
      try {
        await d.revisar({ tipo: 'worker', task: t, resultado: resultados.get(t.id) ?? { text: '' } }, acoes)
      } catch (err) {
        // Revisor fora do ar não pode travar o plano: o trabalho do worker vale.
        t.notaRevisao = `Revisão indisponível: ${err instanceof Error ? err.message : String(err)}`
      }
      // Sem decisão (o modelo não chamou nenhuma ação): aceita como está.
      if (t.fase === 'revisao') {
        const r = resultados.get(t.id)
        if (r?.error) {
          t.fase = 'falhou'
          t.status = 'error'
          t.notaRevisao ??= r.error
        } else {
          await acoes.aceitar(t.id)
        }
      }
      revisao.atividade = undefined
      continue
    }

    if (executando.size > 0) {
      await Promise.race(executando.values())
      continue
    }
    if (ajustesPendentes.size > 0) continue

    if (plan.tasks.some((t) => t.fase === 'fila')) {
      // Na fila sem nada rodando e sem como sair: dependência que nunca será aceita.
      for (const t of plan.tasks) {
        if (t.fase !== 'fila') continue
        t.fase = 'falhou'
        t.status = 'error'
        t.notaRevisao = 'Não começou: as tarefas de que depende não foram aceitas.'
      }
      continue
    }

    // Tudo resolvido: revisão de integração (o conjunto atende ao pedido?).
    if (acompanha && passadasIntegracao < PASSADAS_INTEGRACAO && plan.tasks.every(terminal)) {
      passadasIntegracao++
      const antes = revisao.ajustesUsados
      revisao.atividade = 'Revisão de integração'
      await d.persistir()
      try {
        await d.revisar!({ tipo: 'integracao', resultados }, acoes)
      } catch {
        // idem: sem revisor, o conjunto fica como está
      }
      revisao.atividade = undefined
      // Nada novo para rodar: terminou.
      if (revisao.ajustesUsados === antes && ajustesPendentes.size === 0) break
      continue
    }
    break
  }

  // Abort: espera os turnos em andamento se encerrarem (eles recebem o abort).
  await Promise.allSettled(executando.values())
  revisao.atividade = undefined
  await d.persistir()
  return resultados
}
