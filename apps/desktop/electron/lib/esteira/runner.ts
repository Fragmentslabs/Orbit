import { stepCountIs, streamText, type ToolSet } from 'ai'
import type { Esteira, FaseConfig, Task } from '@shared/esteira'
import { getProvider, modelSupportsVision } from '../catalog'
import { classificarComando, mensagemBloqueio } from './command-policy'
import { extrairAnotacao, extrairCommit } from './contrato'
import { resolveModel } from '../providers'
import { buildProviderOptions, interleavedReasoningField, normalizeMessages } from '../reasoning'
import { createBashTool } from '../tools/shell'
import type { ToolContext } from '../tools/context'
import {
  createEditTool,
  createGlobTool,
  createGrepTool,
  createListTool,
  createReadTool,
  createWriteTool,
} from '../tools/files'
import { createPanelBrowserTools } from '../tools/panel-browser'
import { createBrowserScriptTools } from '../tools/browser-script'
import { createChatMemoryTools } from '../tools/memory'
import { createVerifyChangesTool } from '../tools/verify-changes'
import { toTokenUsage } from '../usage'
import type { SendMessageInput } from '@shared/chat'

/**
 * Execução de UMA fase da esteira, sem sessão de chat (D12).
 *
 * Não dá para reusar runChat: ele é ancorado numa sessão (persiste mensagens,
 * emite chat:event, aplica compactação e nudges do chat). Aqui o ciclo é
 * outro — montar contexto → rodar o agente → colher a anotação → avançar — e o
 * "histórico" da task são as anotações das fases, não uma conversa.
 *
 * Autonomia total (D5): nenhuma aprovação de tool é pedida. O guarda-corpo é o
 * conjunto de tools da fase + a política de comandos, aplicada por dentro do
 * bash.
 */

const MAX_STEPS = 60

export interface ContextoFase {
  esteira: Esteira
  task: Task
  fase: FaseConfig
  indiceFase: number
  /** Pastas de trabalho do projeto (a primeira é a principal) */
  pastas: string[]
  /** Tentativa atual (1-based) — >1 injeta o aviso da falha anterior */
  tentativa: number
  erroAnterior?: string
  /** A execução anterior desta fase foi abortada no meio (pausa forçada) */
  interrompidaAntes?: boolean
  abort: AbortSignal
  /** Feed ao vivo do texto do agente (UI mostra no card) */
  onTexto?: (delta: string) => void
}

export interface ResultadoFase {
  /** Anotação em markdown extraída da resposta — ausente = fase falhou */
  anotacao?: string
  /** Texto completo da resposta (fallback e diagnóstico) */
  texto: string
  comandosControlados: string[]
  commitHash?: string
  tokens: number
  custo: number
  erro?: string
}

/** Mapeia as capacidades da fase para as tools reais do engine. */
function montarTools(ctx: ContextoFase, toolCtx: ToolContext, registrarComando: (cmd: string) => void): ToolSet {
  const tools: ToolSet = {}
  const permitidas = new Set(ctx.fase.tools)

  // Leitura é sempre liberada: sem ler o repositório nenhuma fase consegue
  // fazer nada útil, nem sequer relatar o que encontrou.
  tools.read = createReadTool(toolCtx)
  tools.ls = createListTool(toolCtx)
  tools.glob = createGlobTool(toolCtx)
  tools.grep = createGrepTool(toolCtx)
  tools.verify_changes = createVerifyChangesTool(toolCtx)

  if (permitidas.has('edit')) {
    tools.write = createWriteTool(toolCtx)
    tools.edit = createEditTool(toolCtx)
  }
  if (permitidas.has('shell')) {
    tools.bash = comPoliticaDeComandos(createBashTool(toolCtx), ctx, registrarComando)
  }
  // Com prints ligados, a fase ganha browser mesmo sem ter pedido: a
  // instrução de capturar seria impossível de cumprir sem as tools.
  if (permitidas.has('browser') || ctx.esteira.printsDoResultado) {
    // O browser do painel é por sessão; a esteira usa o id sintético da task,
    // então cada task tem o seu e não disputa o painel de um chat aberto.
    Object.assign(tools, createPanelBrowserTools(toolCtx))
    Object.assign(tools, createBrowserScriptTools(toolCtx))
  }
  if (permitidas.has('memoria')) {
    Object.assign(tools, createChatMemoryTools(sendInputSintetico(ctx)))
  }
  return tools
}

/**
 * Envolve o bash com a política de 3 camadas. A checagem fica AQUI, e não numa
 * regra de permissão, porque na esteira não existe usuário para aprovar: o
 * comando bloqueado precisa voltar como erro para o próprio agente contornar.
 */
function comPoliticaDeComandos(
  bashTool: ToolSet[string],
  ctx: ContextoFase,
  registrarComando: (cmd: string) => void,
): ToolSet[string] {
  const original = bashTool as { execute?: (args: unknown, opts: unknown) => Promise<unknown> }
  return {
    ...bashTool,
    execute: async (args: unknown, opts: unknown) => {
      const comando = String((args as { command?: unknown })?.command ?? '')
      const { camada, motivo } = classificarComando(comando, ctx.esteira.politicaComandos)
      if (camada === 'bloqueado') return mensagemBloqueio(comando, motivo)
      if (camada === 'controlado') registrarComando(comando)
      return original.execute?.(args, opts)
    },
  } as ToolSet[string]
}

/** SendMessageInput sintético — as tools de memória o exigem para saber a sessão/modo. */
function sendInputSintetico(ctx: ContextoFase): SendMessageInput {
  return {
    sessionId: `esteira_${ctx.task.id}`,
    text: ctx.task.descricao,
    providerId: ctx.fase.providerId,
    modelId: ctx.fase.modelId,
    mode: 'code',
    options: { permissionMode: 'full', brain: true },
    directory: ctx.pastas[0],
    extraDirectories: ctx.pastas.slice(1),
  }
}

/**
 * Contexto de entrada da fase (§7): descrição da task, anotações anteriores e
 * estado do repo. É o que substitui o histórico de conversa.
 */
function montarMensagem(ctx: ContextoFase): string {
  const partes: string[] = []
  partes.push(`# Task: ${ctx.task.titulo}`)
  if (ctx.task.descricao.trim()) partes.push(ctx.task.descricao.trim())

  partes.push(
    `\n## Pipeline\nPhase ${ctx.indiceFase + 1} of ${ctx.esteira.fases.length}: **${ctx.fase.nome}**.\n` +
      `Phases run in a fixed order and never go back. Everything the following phases will know about your work comes from your note.`,
  )

  const anteriores = ctx.task.anotacoes.filter((a) => a.status !== 'pulada')
  if (anteriores.length > 0) {
    partes.push('\n## Notes from previous phases')
    for (const a of anteriores) {
      partes.push(`### ${a.faseNome} (${a.status})\n${a.conteudo}`)
    }
  }
  const puladas = ctx.task.anotacoes.filter((a) => a.status === 'pulada')
  if (puladas.length > 0) {
    partes.push(
      `\n## Skipped phases\n${puladas.map((a) => `- ${a.faseNome}`).join('\n')}\nThe task was started directly at a later phase — do not assume that work was done.`,
    )
  }

  const repo: string[] = [`Working folders: ${ctx.pastas.join(', ') || '(none)'}`]
  if (ctx.esteira.branch) repo.push(`Branch: ${ctx.esteira.branch}`)
  if (ctx.esteira.worktree) repo.push(`Worktree: ${ctx.esteira.worktree}`)
  repo.push(
    `Push at the end: ${ctx.esteira.pushAoFinal ? 'yes — the engine runs git push when the last phase succeeds, do not push yourself' : 'no (local commits only)'}`,
  )
  partes.push(`\n## Repository\n${repo.join('\n')}`)

  const { bloqueados, controlados } = ctx.esteira.politicaComandos
  partes.push(
    `\n## Command policy (unsupervised run)\n` +
      `- Refused: ${bloqueados.join(', ') || '(none)'}\n` +
      `- Allowed but recorded: ${controlados.join(', ') || '(none)'}\n` +
      `- Anything else: free. A refused command counts as a phase failure — work around it.`,
  )

  // Prints do resultado: instrução explícita, senão o agente descreve a
  // mudança visual em texto e o usuário não vê o que saiu na tela. As regras
  // de limite existem porque captura em excesso é o maior desperdício de
  // tokens da esteira: a imagem entra no contexto (ver:true) e permanece no
  // histórico por todos os turnos seguintes da fase.
  if (ctx.esteira.printsDoResultado) {
    partes.push(
      `\n## Screenshots of the result (enabled for this pipeline)\n` +
        `If this task changed anything visible in a UI, capture the MINIMUM evidence needed (a few images, not a series):\n` +
        `- Static screens of known URLs/viewports: capture_batch — one call, the images stay out of your context.\n` +
        `- Timing/state (animations, waiting for a render, resizing): run_browser_script with waitFor/wait/resize — one call too.\n` +
        `- Interacting with the app (click, type, inspect): use the panel browser (panel_navigate / panel_read / panel_click / panel_type). panel_screenshot returns a media URL WITHOUT loading the image into your context; pass ver:true only when you must see the capture yourself, at most once or twice per phase.\n` +
        `- If a previous phase already attached screenshots of this change and nothing visible changed since, do NOT recapture — say so in your note.\n` +
        `Attach the screenshots to your note with their orbit-media:// URLs and say what each one shows. Keep it short — the user reads the note, not a photo album.\n` +
        `If the change is not visible in a UI, say so in the note instead of capturing something unrelated.`,
    )
  }

  // Retomada depois de uma pausa forçada: a fase recomeça do zero, mas o
  // repositório pode ter ficado no meio do caminho — esconder isso faria o
  // agente reimplementar por cima do que já existe.
  if (ctx.interrompidaAntes) {
    partes.push(
      `\n## Restarting this phase\nA previous run of THIS phase was interrupted before finishing. You are starting it over from the beginning.\n` +
        `The working tree may already contain partial changes from that attempt: check the current state of the files before writing anything, and continue from reality instead of assuming a clean start.`,
    )
  }

  if (ctx.tentativa > 1) {
    partes.push(
      `\n## Retry ${ctx.tentativa} of this phase\nThe previous attempt failed:\n${ctx.erroAnterior ?? '(no detail)'}\nFix the cause instead of repeating the same steps.`,
    )
  }
  return partes.join('\n')
}

export async function executarFase(ctx: ContextoFase): Promise<ResultadoFase> {
  const comandosControlados: string[] = []
  const provider = await getProvider(ctx.fase.providerId)
  const toolCtx: ToolContext = {
    sessionId: `esteira_${ctx.task.id}`,
    directory: ctx.esteira.worktree || ctx.pastas[0] || '',
    extraDirectories: ctx.pastas.slice(1),
    abort: ctx.abort,
    // Visão do modelo da fase: controla se o panel_screenshot oferece `ver`
    modelVision: modelSupportsVision(provider, ctx.fase.modelId),
  }
  if (!toolCtx.directory) {
    return { texto: '', comandosControlados, tokens: 0, custo: 0, erro: 'Projeto sem pasta de trabalho definida.' }
  }

  const input = sendInputSintetico(ctx)
  const model = await resolveModel(ctx.fase.providerId, ctx.fase.modelId)
  const tools = montarTools(ctx, toolCtx, (cmd) => comandosControlados.push(cmd))

  let texto = ''
  try {
    const stream = streamText({
      model,
      system: ctx.fase.prompt,
      messages: normalizeMessages(
        [{ role: 'user', content: montarMensagem(ctx) }],
        interleavedReasoningField(provider, ctx.fase.modelId),
      ),
      tools,
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: ctx.abort,
      providerOptions: await buildProviderOptions(input),
      onError: () => {
        /* tratado abaixo, pelo texto/erro acumulado */
      },
    })

    for await (const parte of stream.fullStream) {
      if (parte.type === 'text-delta') {
        texto += parte.text
        ctx.onTexto?.(parte.text)
      } else if (parte.type === 'error') {
        const detalhe = parte.error instanceof Error ? parte.error.message : String(parte.error)
        return { texto, comandosControlados, tokens: 0, custo: 0, erro: detalhe }
      }
    }

    const usage = toTokenUsage(await stream.usage, provider?.models[ctx.fase.modelId]?.cost)
    const tokens = usage.input + usage.output + usage.reasoning
    const anotacao = extrairAnotacao(texto)
    return {
      anotacao,
      texto,
      comandosControlados,
      commitHash: anotacao ? extrairCommit(anotacao) : undefined,
      tokens,
      custo: usage.cost ?? 0,
      // Anotação ausente é falha de contrato: a próxima fase receberia ruído
      // no lugar do relato, então vale retry (§7).
      erro: anotacao ? undefined : 'A fase terminou sem a anotação obrigatória (bloco ```anotacao).',
    }
  } catch (err) {
    const detalhe = err instanceof Error ? err.message : String(err)
    return { texto, comandosControlados, tokens: 0, custo: 0, erro: detalhe }
  }
}
